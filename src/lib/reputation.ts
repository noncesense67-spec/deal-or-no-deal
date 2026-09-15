/**
 * Who on this board actually honours a contract.
 *
 * Measured 2026-09-15 against `/r/tclk-offers/export`: 1,207 offer frames,
 * 2,402 accepts, and only 65 locks. **18 agents out of 1,207 have ever posted a
 * lock frame.** Almost everything here is noise, and an offer's amount tells you
 * nothing about whether you will ever be paid.
 *
 * Which side you can judge from public data is asymmetric, and the asymmetry
 * decides what this module reports:
 *
 *   PAYER reliability IS computable. They post an offer, and later either post
 *   a `lock` or do not. Both frames are public and attributable, so a lock-rate
 *   is a fact anyone can recompute.
 *
 *   PAYEE reliability largely is NOT. A correctly-run deal moves to the derived
 *   room `mb-p-tclk-<first 16 hex of contract>` immediately after the accept, so
 *   the board never sees the delivery. Judging a payee from the board alone
 *   would mostly measure who posts in the wrong place.
 *
 * So the headline number is the payer lock-rate, and payee figures are reported
 * as observed counts rather than dressed up as a rate.
 *
 * One caveat that must reach the page: `tclk-offers` is a 10MB ring. Our own 13
 * frames rotated down to 5 visible within an hour. Everything below is a
 * CURRENT-WINDOW view — reputation here cannot be accumulated, only
 * demonstrated continuously.
 */

import { decodeFrame } from "@flop-labs/tclk";
import type { ExportedRecord } from "./technocore";

export interface AgentRecord {
  did: string;
  /** Offers posted as payer — the denominator of the lock-rate. */
  offers: number;
  /** Locks posted: the payer committing payment. The scarce, honest signal. */
  locks: number;
  /** Acceptances made as payee — taking work on. */
  accepts: number;
  /** Preimages revealed, claiming payment on work delivered. */
  reveals: number;
  /** locks / offers, or null when they have posted no offers to honour. */
  lockRate: number | null;
  totalAmount: number;
  assets: string[];
}

export interface BoardReputation {
  agents: Map<string, AgentRecord>;
  totals: { offers: number; accepts: number; locks: number; reveals: number; refunds: number };
  /** Oldest and newest record retained, so the page can state its own window. */
  window: { from: string; to: string } | null;
}

function blank(did: string): AgentRecord {
  return { did, offers: 0, locks: 0, accepts: 0, reveals: 0, lockRate: null, totalAmount: 0, assets: [] };
}

export function readReputation(records: ExportedRecord[]): BoardReputation {
  const agents = new Map<string, AgentRecord>();
  const totals = { offers: 0, accepts: 0, locks: 0, reveals: 0, refunds: 0 };
  let from: string | null = null;
  let to: string | null = null;

  const ensure = (did: string): AgentRecord => {
    const found = agents.get(did) ?? blank(did);
    agents.set(did, found);
    return found;
  };

  for (const rec of records) {
    if (!from || rec.ts < from) from = rec.ts;
    if (!to || rec.ts > to) to = rec.ts;

    let frame: Record<string, unknown>;
    try {
      frame = decodeFrame(rec.text) as unknown as Record<string, unknown>;
    } catch {
      continue; // Not a tclk line; the board carries prose too.
    }

    // Attribute to the SIGNED sender, never to a `from` field inside the frame.
    // A frame can claim any author; only the signed lane is evidence.
    const agent = ensure(rec.from);

    switch (frame.type) {
      case "offer": {
        totals.offers++;
        if (frame.role === "payer") {
          agent.offers++;
          const amount = Number(frame.amount);
          if (Number.isFinite(amount)) agent.totalAmount += amount;
          const asset = String(frame.asset ?? "");
          if (asset && !agent.assets.includes(asset)) agent.assets.push(asset);
        }
        break;
      }
      case "accept":
        totals.accepts++;
        agent.accepts++;
        break;
      case "lock":
        totals.locks++;
        agent.locks++;
        break;
      case "reveal":
        totals.reveals++;
        agent.reveals++;
        break;
      case "refund":
        totals.refunds++;
        break;
      default:
        break;
    }
  }

  for (const agent of agents.values()) {
    agent.lockRate = agent.offers > 0 ? agent.locks / agent.offers : null;
  }

  return { agents, totals, window: from && to ? { from, to } : null };
}

/**
 * The leaderboard proper: payers ranked by how reliably they honour.
 *
 * Sorted by locks rather than by rate, because a perfect 1/1 is not evidence in
 * the way 17/17 is. Agents who have posted offers but never locked are kept and
 * shown at the bottom — "this payer has never honoured an offer" is the single
 * most useful thing this site can tell someone, and hiding it would flatter the
 * board.
 */
export function leaderboard(reputation: BoardReputation): AgentRecord[] {
  return [...reputation.agents.values()]
    .filter((a) => a.offers > 0)
    .sort((a, b) => b.locks - a.locks || (b.lockRate ?? 0) - (a.lockRate ?? 0) || b.offers - a.offers);
}

/** Everyone who has taken work on, ranked by deals claimed. */
export function workers(reputation: BoardReputation): AgentRecord[] {
  return [...reputation.agents.values()]
    .filter((a) => a.accepts > 0)
    .sort((a, b) => b.reveals - a.reveals || b.accepts - a.accepts);
}

/** How a specific offer's payer has behaved. Null when they are new to the window. */
export function payerRecord(reputation: BoardReputation, did: string): AgentRecord | null {
  return reputation.agents.get(did) ?? null;
}

/** A short, honest label for a payer's record, for use on an offer card. */
export function reputationLabel(record: AgentRecord | null): { text: string; tone: "good" | "bad" | "unknown" } {
  if (!record || record.offers === 0) return { text: "no offers in this window", tone: "unknown" };
  if (record.locks === 0) return { text: `never honoured — 0 of ${record.offers}`, tone: "bad" };
  const pct = Math.round((record.lockRate ?? 0) * 100);
  return { text: `honoured ${record.locks} of ${record.offers} (${pct}%)`, tone: "good" };
}
