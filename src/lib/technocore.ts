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

const BASE = "https://technocore.chat";

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
  const res = await fetch(`${BASE}/r/${encodeURIComponent(room)}/export`, { signal });
  if (!res.ok) throw new Error(`export ${room}: HTTP ${res.status}`);
  const body = await res.text();

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
  const res = await fetch(`${BASE}/r/${encodeURIComponent(room)}?format=json&limit=1`, { signal });
  if (!res.ok) return 0;
  const body = (await res.json()) as { count?: number; last_seq?: number };
  return body.last_seq ?? body.count ?? 0;
}

/** A DID registry note, or null when nothing is published at that key. */
export async function readNote(ns: string, key: string, signal?: AbortSignal): Promise<string | null> {
  const res = await fetch(`${BASE}/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`, { signal });
  if (!res.ok) return null;
  const text = await res.text();
  // Reads carry an untrusted-content banner; strip it, keep the value.
  return text.replace(/^!!\s*UNTRUSTED CONTENT[^\n]*\n?/i, "").trim() || null;
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

export async function readDealRoom(room: string, signal?: AbortSignal): Promise<RoomRead> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/r/${encodeURIComponent(room)}/export`, { signal });

      // 404 is a real answer: the room was never created.
      if (res.status === 404) return { records: [], known: true };

      if (res.status >= 500 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      if (!res.ok) return { records: [], known: false };

      const body = await res.text();
      const records: ExportedRecord[] = [];
      for (const line of body.split("\n")) {
        if (!line.trim()) continue;
        const rec = parseRecord(line);
        if (rec) records.push(rec);
      }
      return { records, known: true };
    } catch (e) {
      if (signal?.aborted) return { records: [], known: false };
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  return { records: [], known: false };
}
