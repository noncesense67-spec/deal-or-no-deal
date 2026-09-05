/**
 * One shared request budget for the whole page.
 *
 * Written after a full-population scan at concurrency 20 walked into HTTP 429
 * and stayed there. Per-request retry did not help and could not: every retry
 * was itself a request against the same exhausted budget, so backoff on one
 * call was cancelled out by twenty siblings still firing. The limit is a
 * property of the client, not of any single call, so the pacing has to live
 * where the calls are counted — here.
 *
 * Token bucket, refilled continuously. `RATE` is deliberately under the
 * server's published ceiling: a visitor's IP may already be spending some of
 * that budget on their own agent, and the site should be the polite tenant.
 */

const RATE = 6;      // requests per second, sustained
const BURST = 12;    // allowed instantaneous burst

let tokens = BURST;
let last = Date.now();

/** Set when the server tells us it has had enough; blocks everyone until then. */
let penaltyUntil = 0;

/**
 * Foreground callers outrank background ones.
 *
 * Both share one budget, so without this the board-wide stats scan — thousands
 * of deal-room reads queued at once — starves the sixty descriptions the
 * visitor is actually looking at. Measured: 7 of 60 cards resolved in 25s while
 * the scan ran. Background work yields whenever anything on screen is waiting.
 */
let foregroundWaiting = 0;

function refill(): void {
  const now = Date.now();
  tokens = Math.min(BURST, tokens + ((now - last) / 1000) * RATE);
  last = now;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until this caller may spend one request. `background` marks work the
 * visitor is not waiting on, which yields to anything on screen.
 */
export async function take(signal?: AbortSignal, background = false): Promise<void> {
  if (!background) foregroundWaiting++;
  try {
    await acquire(signal, background);
  } finally {
    if (!background) foregroundWaiting--;
  }
}

async function acquire(signal: AbortSignal | undefined, background: boolean): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");

    if (background && foregroundWaiting > 0) {
      await sleep(120);
      continue;
    }

    const now = Date.now();
    if (now < penaltyUntil) {
      await sleep(Math.min(penaltyUntil - now, 500));
      continue;
    }

    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    // Time until one whole token exists, so callers wake when they can proceed
    // rather than spinning.
    await sleep(Math.max(50, ((1 - tokens) / RATE) * 1000));
  }
}

/**
 * A 429 is information, not just a failure: it says the budget is gone for
 * everyone, so every caller stops rather than each discovering it separately.
 */
export function backOff(retryAfterSeconds?: number): void {
  const ms = Math.min(30_000, Math.max(2_000, (retryAfterSeconds ?? 5) * 1000));
  penaltyUntil = Math.max(penaltyUntil, Date.now() + ms);
  tokens = 0;
}

/** Seconds until the page expects to be allowed to read again; 0 when clear. */
export function pausedFor(): number {
  return Math.max(0, Math.ceil((penaltyUntil - Date.now()) / 1000));
}
