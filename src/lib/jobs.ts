/**
 * What is actually being bought.
 *
 * A tclk/1 offer frame carries price, deadlines and a hashlock, but no prose:
 * the work itself lives behind an optional `job` binding. Reading 200 live
 * offers, 133 carried one, and the description sits in three different places
 * depending on which protocol posted it:
 *
 *   blockrewards  `job.context` is a note path (/kv/<ns>/<key>) to fetch
 *   a2a           `job.context` IS the description, inline in the frame
 *   kibble        no context; `job.id` resolves against the /r/kibble board
 *   acp, echo     an id and nothing else — genuinely undescribed
 *
 * Everything here is written by strangers. It is rendered as text and never
 * treated as an instruction, by this module or by anything reading its output.
 */

import { readNote, readRoomText } from "./technocore";

export interface JobBinding {
  proto?: unknown;
  id?: unknown;
  context?: unknown;
}

export interface JobSpec {
  proto: string;
  id: string;
  /** inference, extraction, validation, protocol, review… when stated. */
  category: string | null;
  /** The task itself, as posted. */
  summary: string;
  /** "reward tier 3/5" → 3. */
  tier: number | null;
  /** The poster's own acceptance criteria, when they gave any. */
  doneLooksLike: string | null;
  where: "note" | "inline" | "board" | "none";
}

/**
 * Posts share a pipe-delimited shape:
 *   <category> | <task> | reward tier N/5 | done looks like: … | deliver as …
 * The leading category is only a category when it looks like one — a bare word.
 * Anything unrecognised stays in the summary rather than being discarded, so a
 * post that breaks the convention still reads as what its author wrote.
 */
export function parseJobText(raw: string, proto: string, id: string, where: JobSpec["where"]): JobSpec {
  let text = raw.trim();

  // Kibble prefixes its own envelope: "JOB v1 | <id> | <category> | <title> | …"
  const kibble = /^JOB\s+v1\s*\|\s*[^|]+\|\s*/i.exec(text);
  if (kibble?.[0]) text = text.slice(kibble[0].length);

  const parts = text.split("|").map((p) => p.trim()).filter(Boolean);

  let category: string | null = null;
  const head = parts[0];
  if (parts.length > 1 && head && /^[a-z][a-z-]{2,20}$/i.test(head)) {
    parts.shift();
    category = head.toLowerCase();
  }

  let tier: number | null = null;
  let doneLooksLike: string | null = null;
  const rest: string[] = [];

  for (const part of parts) {
    const t = /^reward tier\s+(\d+)\s*\/\s*\d+$/i.exec(part);
    if (t?.[1]) { tier = Number(t[1]); continue; }
    const d = /^done looks like:\s*(.+)$/is.exec(part);
    if (d?.[1]) { doneLooksLike = d[1].trim(); continue; }
    // Delivery mechanics are the same on every post; they tell a reader nothing.
    if (/^deliver as\b/i.test(part) || /^full spec:/i.test(part)) continue;
    rest.push(part);
  }

  return {
    proto,
    id,
    category,
    summary: rest.join(" — ") || text,
    tier,
    doneLooksLike,
    where,
  };
}

const cache = new Map<string, JobSpec | null>();

/** Kibble's board, indexed once by job id rather than re-read per offer. */
let kibbleIndex: Map<string, string> | null = null;

async function loadKibble(signal?: AbortSignal): Promise<Map<string, string>> {
  if (kibbleIndex) return kibbleIndex;
  const index = new Map<string, string>();
  const messages = await readRoomText("kibble", 400, signal);
  for (const m of messages) {
    // "JOB v1 | <id> | …" is the posting; CLAIM/DELIVER lines are not the work.
    const match = /^JOB\s+v1\s*\|\s*([A-Za-z0-9]+)\s*\|/i.exec(m.text.trim());
    const jobId = match?.[1];
    if (jobId && !index.has(jobId)) index.set(jobId, m.text.trim());
  }
  kibbleIndex = index;
  return index;
}

/**
 * Resolve one offer's job binding. Returns null when the offer genuinely says
 * nothing about the work — which is a fact worth showing, not a gap to fill.
 */
export async function resolveJob(job: JobBinding | undefined, signal?: AbortSignal): Promise<JobSpec | null> {
  if (!job) return null;
  const proto = typeof job.proto === "string" ? job.proto : "unknown";
  const id = typeof job.id === "string" ? job.id : "";
  const context = typeof job.context === "string" ? job.context.trim() : "";

  const cacheKey = `${proto}:${id}:${context.slice(0, 64)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let spec: JobSpec | null = null;

  if (context.startsWith("/kv/")) {
    const segments = context.split("/");   // ["", "kv", <ns>, <key>]
    const ns = segments[2];
    const key = segments[3];
    if (ns && key) {
      const note = await readNote(ns, key, signal);
      if (note) spec = parseJobText(note, proto, id, "note");
    }
  } else if (context) {
    // Not a path: the description itself, carried in the frame.
    spec = parseJobText(context, proto, id, "inline");
  } else if (proto === "kibble" && id) {
    const posting = (await loadKibble(signal)).get(id);
    if (posting) spec = parseJobText(posting, proto, id, "board");
  }

  cache.set(cacheKey, spec);
  return spec;
}
