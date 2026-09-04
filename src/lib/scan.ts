/**
 * Resolve every contract on the board, not a sample of them.
 *
 * A verdict needs one deal-room read, and there are a couple of thousand
 * contracts in the retained ring — roughly four minutes against the service's
 * 600 reads/minute budget. That is slow for a first paint but perfectly fine as
 * a background pass, so results stream in and the figures converge on the whole
 * population instead of stopping at a sample.
 *
 * The one honest caveat that survives a complete scan: the board is a ring, so
 * "every contract" means every contract still retained. Anything older is gone
 * from the venue and cannot be judged by anyone.
 */

import { readDealRoom } from "./technocore";
import { resolve, type Contract } from "./verify";

/*
 * The venue allows 600 reads/minute per IP — ten a second — but a single
 * deal-room read takes a couple of seconds against a service under load. At
 * concurrency 8 that yields well under one per second: latency-bound, nowhere
 * near the budget, and a complete scan would take over an hour.
 *
 * Twenty in flight with a small pace lands around eight per second, which uses
 * the budget without tripping it and finishes the whole board in minutes.
 */
const CONCURRENCY = 20;
const PACE_MS = 40;

export interface ScanProgress {
  done: number;
  total: number;
  finished: boolean;
}

/**
 * Walk the pending contracts, emitting resolved batches as they land so the UI
 * can update while the scan is still running.
 */
export async function scanAll(
  pending: Contract[],
  onBatch: (resolved: Contract[], progress: ScanProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = pending.length;
  let done = 0;

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    if (signal?.aborted) return;

    const batch = pending.slice(i, i + CONCURRENCY);
    // A contract whose deal room could not be read stays unresolved rather
    // than being judged on a failed request.
    const settledBatch = await Promise.all(
      batch.map(async (c) => {
        const read = await readDealRoom(c.dealRoomName, signal);
        return read.known ? resolve(c, read.records) : null;
      }),
    );
    const resolved = settledBatch.filter((c): c is Contract => c !== null);
    if (signal?.aborted) return;

    done += batch.length;
    onBatch(resolved, { done, total, finished: done >= total });

    // Pace deliberately: a client that empties its read bucket gets 429s and
    // finishes later than one that never trips the limit.
    if (i + CONCURRENCY < pending.length) await new Promise((r) => setTimeout(r, PACE_MS));
  }
}
