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

import { readNoteChecked, exportRoom } from "./technocore";

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

/**
 * Thrown when the description could not be fetched, as distinct from an offer
 * that carries none. The caller retries these; a null result is final.
 */
export class JobUnavailableError extends Error {}

/**
 * Only settled outcomes are cached. Caching a failed read as `null` turns one
 * bad minute into a permanent "No description posted" on that card, which is
 * exactly what happened after the rate limit was exhausted: the descriptions
 * resolved fine on a direct call while the grid insisted 55 of 60 offers had
 * none.
 */
const cache = new Map<string, JobSpec | null>();

/**
 * The answer when no request is needed.
 *
 * Half the open board (966 of 1,934 offers) carries its description inline in
 * the frame, and a further 165 carry none at all. Both are known the moment the
 * board is parsed, so making them wait in a network queue behind note fetches
 * showed "Loading the work…" on cards whose text was already in hand.
 *
 * Returns `undefined` when the answer genuinely requires a request.
 */
export function resolveJobLocal(job: JobBinding | undefined): JobSpec | null | undefined {
  if (!job) return null;
  const proto = typeof job.proto === "string" ? job.proto : "unknown";
  const id = typeof job.id === "string" ? job.id : "";
  const context = typeof job.context === "string" ? job.context.trim() : "";

  if (context && !context.startsWith("/kv/")) return parseJobText(context, proto, id, "inline");
  if (!context && proto !== "kibble") return null;   // an id and nothing else
  return undefined;
}

/**
 * Kibble's board, indexed once by job id rather than re-read per offer.
 *
 * Read from `/export` rather than a recent-messages window: the board holds
 * 12,428 messages carrying 924 job postings, and a 400-message window missed
 * most of the ids being offered against — those listings then showed "No
 * description posted" for work that was in fact fully described. One request
 * covers all of them, and it is only made when a kibble offer is on screen.
 */
let kibbleIndex: Map<string, string> | null = null;
/** Shared so concurrent workers await one export rather than starting five. */
let kibbleLoading: Promise<Map<string, string> | null> | null = null;

async function loadKibble(signal?: AbortSignal): Promise<Map<string, string> | null> {
  if (kibbleIndex) return kibbleIndex;
  if (kibbleLoading) return kibbleLoading;
  kibbleLoading = buildKibbleIndex(signal).finally(() => {
    kibbleLoading = null;
  });
  return kibbleLoading;
}

async function buildKibbleIndex(signal?: AbortSignal): Promise<Map<string, string> | null> {
  const index = new Map<string, string>();
  const records = await exportRoom("kibble", signal).catch(() => null);
  // A failed read must not be memoised as an empty index; that would strand
  // every kibble-sourced offer for the rest of the page's life.
  if (!records || records.length === 0) return null;
  for (const r of records) {
    // "JOB v1 | <id> | …" is the posting; CLAIM/DELIVER lines are not the work.
    const match = /^JOB\s+v1\s*\|\s*([A-Za-z0-9]+)\s*\|/i.exec(r.text.trim());
    const jobId = match?.[1];
    if (jobId && !index.has(jobId)) index.set(jobId, r.text.trim());
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
      const note = await readNoteChecked(ns, key, signal);
      if (!note.known) throw new JobUnavailableError(`could not read ${context}`);
      if (note.text) spec = parseJobText(note.text, proto, id, "note");
    }
  } else if (context) {
    // Not a path: the description itself, carried in the frame.
    spec = parseJobText(context, proto, id, "inline");
  } else if (proto === "kibble" && id) {
    const index = await loadKibble(signal);
    if (index === null) throw new JobUnavailableError("could not read the kibble board");
    const posting = index.get(id);
    if (posting) spec = parseJobText(posting, proto, id, "board");
  }

  cache.set(cacheKey, spec);
  return spec;
}
