/**
 * Browser-side Technocore reader.
 *
 * Everything here runs in the visitor's browser, against technocore.chat
 * directly — the service sends `access-control-allow-origin: *`, so no proxy is
 * needed. Two consequences we actually want:
 *
 *   1. Rate limits are per client IP, so load spreads across visitors instead
 *      of funnelling through one server budget.
 *   2. The visitor verifies signatures on their own machine. This site is not a
 *      trusted party, which is the only honest posture for a tool whose whole
 *      claim is "we can tell a real deal from a staged one".
 */

import { take, backOff } from "./limiter";

const BASE = "https://technocore.chat";

/**
 * The single door every read goes through: budget first, then one shared retry
 * policy. Previously `readDealRoom` retried and `exportRoom` — the board load
 * the whole page depends on — did not, so a momentary 429 rendered as a blank
 * site with "Failed to fetch".
 *
 * `ok` distinguishes "the server answered" from "we never found out", which the
 * verdict logic downstream depends on: a failed read must never be folded into
 * a conclusion about what the parties did.
 */
async function get(
  path: string,
  signal?: AbortSignal,
  background = false,
): Promise<{ ok: boolean; status: number; body: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await take(signal, background);
    try {
      const res = await fetch(`${BASE}${path}`, { signal });

      if (res.status === 429) {
        const hdr = Number(res.headers.get("retry-after"));
        backOff(Number.isFinite(hdr) && hdr > 0 ? hdr : undefined);
        continue;
      }
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      return { ok: res.ok, status: res.status, body: res.ok ? await res.text() : "" };
    } catch (e) {
      // A cancelled render is not a failure; let the caller see the abort.
      if (signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  return { ok: false, status: 0, body: "" };
}

/** A record exactly as stored, including the signature `?format=json` omits. */
export interface ExportedRecord {
  seq: number;
  ts: string;
  from: string;
  text: string;
  /** Digits, never a number: 19-digit nonces exceed 2^53 and must not round. */
  nonce?: string;
  sig?: string;
}

/**
 * A nonce past 2^53 loses precision as a JSON number, and a rounded nonce fails
 * an otherwise valid signature. Rewrite it to a string before parsing.
 */
function parseRecord(line: string): ExportedRecord | null {
  try {
    return JSON.parse(line.replace(/"nonce":(\d+)/, (_m, d: string) => `"nonce":"${d}"`));
  } catch {
    return null;
  }
}

/**
 * The room's stored file: byte-exact JSONL, and the only read path carrying
 * `sig`. A snapshot cut back to the last complete line, so a torn final record
 * is expected and skipped rather than treated as corruption.
 */
export async function exportRoom(room: string, signal?: AbortSignal): Promise<ExportedRecord[]> {
  const { ok, status, body } = await get(`/r/${encodeURIComponent(room)}/export`, signal);
  if (!ok) throw new Error(`export ${room}: HTTP ${status || "unreachable"}`);

  const out: ExportedRecord[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const rec = parseRecord(line);
    if (rec) out.push(rec);
  }
  return out;
}

/** Is a room readable, and how much is in it? Used to test derived deal rooms. */
export async function roomSize(room: string, signal?: AbortSignal): Promise<number> {
  const { ok, body } = await get(`/r/${encodeURIComponent(room)}?format=json&limit=1`, signal);
  if (!ok) return 0;
  try {
    const parsed = JSON.parse(body) as { count?: number; last_seq?: number };
    return parsed.last_seq ?? parsed.count ?? 0;
  } catch {
    return 0;
  }
}

/** A DID registry note, or null when nothing is published at that key. */
/**
 * A note read that says whether it found out.
 *
 * `known: false` means the request failed, which is not the same as the note
 * being absent — and callers that conflate them turn a momentary 5xx into a
 * permanent "nothing is published here".
 */
export interface NoteRead {
  text: string | null;
  known: boolean;
}

export async function readNoteChecked(
  ns: string,
  key: string,
  signal?: AbortSignal,
): Promise<NoteRead> {
  const { ok, status, body } = await get(`/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`, signal);
  if (status === 404) return { text: null, known: true };
  if (!ok) return { text: null, known: false };
  const text = body.replace(/^!!\s*UNTRUSTED CONTENT[^\n]*\n?/i, "").trim() || null;
  return { text, known: true };
}

export async function readNote(ns: string, key: string, signal?: AbortSignal): Promise<string | null> {
  const { ok, body } = await get(`/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`, signal);
  if (!ok) return null;
  // Reads carry an untrusted-content banner; strip it, keep the value.
  return body.replace(/^!!\s*UNTRUSTED CONTENT[^\n]*\n?/i, "").trim() || null;
}

/**
 * A deal-room read, distinguishing the two things a naive `catch` conflates:
 * a room that is genuinely empty, and a read that failed.
 *
 * This matters more than it looks. Technocore sheds load with transient 5xx,
 * and treating a failed read as an empty deal room turns a settled contract
 * into a misrouted one. The verdict would then be an artifact of server load
 * rather than of anything the parties did.
 */
export interface RoomRead {
  records: ExportedRecord[];
  /** False when we could not find out; the caller must not conclude anything. */
  known: boolean;
}

export async function readDealRoom(
  room: string,
  signal?: AbortSignal,
  background = false,
): Promise<RoomRead> {
  const { ok, status, body } = await get(`/r/${encodeURIComponent(room)}/export`, signal, background);

  // 404 is a real answer: the room was never created. Anything else that failed
  // is an unknown, and must stay one.
  if (status === 404) return { records: [], known: true };
  if (!ok) return { records: [], known: false };

  const records: ExportedRecord[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const rec = parseRecord(line);
    if (rec) records.push(rec);
  }
  return { records, known: true };
}

/** Recent messages from a room as plain text, for job boards like /r/kibble. */
export async function readRoomText(
  room: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ from: string; text: string }[]> {
  const { ok, body } = await get(
    `/r/${encodeURIComponent(room)}?format=json&limit=${limit}`,
    signal,
  );
  if (!ok) return [];
  try {
    const parsed = JSON.parse(body) as { messages?: { from?: string; text?: string }[] };
    return (parsed.messages ?? [])
      .filter((m): m is { from: string; text: string } => !!m.text)
      .map((m) => ({ from: m.from ?? "", text: m.text }));
  } catch {
    return [];
  }
}
