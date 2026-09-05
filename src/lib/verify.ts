/**
 * Verdicts, computed the only way they honestly can be.
 *
 * A first version of this read only the public board and reported that nothing
 * ever settles. That was wrong, and wrong in an instructive way: a deal that
 * settles CORRECTLY leaves just `offer` and `accept` on the board and moves
 * everything after that into the derived deal room. Correct behaviour is
 * therefore invisible from the board, and reading one room made success look
 * identical to abandonment.
 *
 * So a verdict needs two reads, and until the second one happens this module
 * says "unchecked" rather than guessing. The state itself is not our opinion —
 * frames from the rooms the spec allows are folded through tclk's own
 * `applyFrame`, and whatever it lands on is the answer.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { decodeFrame, dealRoom, openContract, applyFrame, OFFER_ROOM } from "@flop-labs/tclk";
import type { ExportedRecord } from "./technocore";
import type { JobBinding } from "./jobs.ts";

/** Frame types the public board may legitimately carry. */
const BOARD_TYPES = new Set(["offer", "accept", "cancel"]);

export type FrameType =
  | "offer" | "accept" | "lock" | "reveal" | "refund" | "cancel" | "receipt" | "heartbeat";

export interface CheckedFrame {
  record: ExportedRecord;
  room: string;
  type: FrameType;
  frame: Record<string, unknown>;
  contract: string | null;
  /** Ed25519 over `<room>|<nonce>|<text>`, checked here, not by the server. */
  signatureValid: boolean;
  /** The frame's own `from` must match the transport-verified writer. */
  fromMatchesTransport: boolean;
  /** Did it land somewhere it can advance state? */
  roomCorrect: boolean;
  expectedRoom: string | null;
}

export function decodeDidKey(did: string): Uint8Array | null {
  if (!did.startsWith("did:key:z")) return null;
  try {
    const bytes = base58.decode(did.slice("did:key:z".length));
    // ed25519-pub is the varint 0xed 0x01 — two bytes, not one.
    if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
    return bytes.subarray(2);
  } catch {
    return null;
  }
}

const enc = new TextEncoder();

export function verifyRecord(room: string, rec: ExportedRecord): boolean {
  if (!rec.sig || !rec.nonce) return false;
  const key = decodeDidKey(rec.from);
  if (!key) return false;
  try {
    const sig = Uint8Array.from(atob(rec.sig.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    if (sig.length !== 64) return false;
    return ed25519.verify(sig, enc.encode(`${room}|${rec.nonce}|${rec.text}`), key);
  } catch {
    return false;
  }
}

export function checkFrame(room: string, rec: ExportedRecord): CheckedFrame | null {
  if (!rec.text.startsWith("tclk1 ")) return null;
  let frame: Record<string, unknown>;
  try {
    frame = decodeFrame(rec.text) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = String(frame.type ?? "") as FrameType;
  const contract =
    typeof frame.contract === "string" ? frame.contract
    : typeof frame.id === "string" ? frame.id
    : null;

  const expectedRoom = BOARD_TYPES.has(type)
    ? OFFER_ROOM
    : contract ? dealRoom(contract) : null;

  return {
    record: rec, room, type, frame, contract,
    signatureValid: verifyRecord(room, rec),
    fromMatchesTransport: frame.from === rec.from,
    roomCorrect: expectedRoom !== null && expectedRoom === room,
    expectedRoom,
  };
}

export type Verdict =
  | "open"        // an offer, nobody has accepted
  | "cancelled"
  | "unchecked"   // accepted; the deal room has not been read yet
  | "settled"     // the deal room carries a completed lifecycle
  | "refunded"
  | "stalled"     // accepted, deal room read, and genuinely empty
  | "misrouted";  // completion frames posted to the board; deal room empty

export const VERDICT_LABEL: Record<Verdict, string> = {
  open: "open",
  cancelled: "cancelled",
  unchecked: "unchecked",
  settled: "settled",
  refunded: "refunded",
  stalled: "no deal room",
  misrouted: "misrouted",
};

/** Colour family. `misrouted` and `stalled` are the ones worth a human look. */
export const VERDICT_TONE: Record<Verdict, "ok" | "warn" | "void" | "idle"> = {
  open: "idle",
  cancelled: "idle",
  unchecked: "idle",
  settled: "ok",
  refunded: "warn",
  stalled: "warn",
  misrouted: "void",
};

/**
 * An offer nobody has accepted yet.
 *
 * These never reach the contract map: a contract id hashes the offer AND the
 * acceptance, so an untaken offer has only its own `id` and no `contract` field
 * to group under. Listing them needs a separate pass — which is the whole
 * marketplace, and it was invisible until now.
 */
export interface OpenOffer {
  offerId: string;
  /** The optional binding to the work itself; resolved separately, see jobs.ts. */
  job?: JobBinding;
  frame: CheckedFrame;
  from: string;
  amount: string;
  asset: string;
  rails: string[];
  lock: string;
  /** Which side the poster takes: `payer` pays, `payee` does the work. */
  role: string;
  expiresMs: number;
  claimByMs: number;
  refundAfterMs: number;
}

export interface Contract {
  id: string;
  boardFrames: CheckedFrame[];
  dealFrames: CheckedFrame[];
  dealRoomName: string;
  /** True once the deal room has actually been fetched. */
  dealRoomRead: boolean;
  verdict: Verdict;
  /** Terminal status from tclk's own state machine, when it could be folded. */
  foldedStatus: string | null;
  /** Signed, valid, and posted where it cannot advance anything. */
  misplaced: CheckedFrame[];
}

/**
 * Group board frames per contract.
 *
 * The join is the subtle part. An `offer` carries only its own `id`, which is
 * NOT the contract id — the contract hashes the offer AND the acceptance
 * together, so it cannot exist until both are public. The `accept` closes the
 * loop: it carries the derived `contract` plus a `ref` back to the offer it
 * accepts. Grouping naively on "contract ?? id" files the two halves under
 * different keys, leaves every contract without its offer, and makes the fold
 * silently impossible — which reads as "nothing ever settles".
 */
export interface BoardState {
  contracts: Map<string, Contract>;
  /** Offers with no acceptance against them, newest first. */
  openOffers: OpenOffer[];
}

export function groupContracts(records: ExportedRecord[]): Map<string, Contract> {
  return readBoard(records).contracts;
}

export function readBoard(records: ExportedRecord[]): BoardState {
  const checked: CheckedFrame[] = [];
  const offersById = new Map<string, CheckedFrame>();

  for (const rec of records) {
    const f = checkFrame(OFFER_ROOM, rec);
    if (!f) continue;
    checked.push(f);
    if (f.type === "offer" && typeof f.frame.id === "string") offersById.set(f.frame.id, f);
  }

  const out = new Map<string, Contract>();
  const ensure = (id: string): Contract => {
    let c = out.get(id);
    if (!c) {
      c = {
        id, boardFrames: [], dealFrames: [],
        dealRoomName: dealRoom(id), dealRoomRead: false,
        verdict: "open", foldedStatus: null, misplaced: [],
      };
      out.set(id, c);
    }
    return c;
  };

  for (const f of checked) {
    const contractId = typeof f.frame.contract === "string" ? f.frame.contract : null;
    if (!contractId) continue;          // a bare offer joins via its accept
    const c = ensure(contractId);
    c.boardFrames.push(f);

    // Pull in the offer this acceptance refers to, so the fold has a genesis.
    const ref = typeof f.frame.ref === "string" ? f.frame.ref : null;
    const offer = ref ? offersById.get(ref) : undefined;
    if (offer && !c.boardFrames.includes(offer)) c.boardFrames.unshift(offer);
  }

  for (const c of out.values()) {
    // Offer first, then by sequence: the offer's seq precedes its accept, but
    // sorting on seq alone breaks if the ring dropped and renumbered.
    c.boardFrames.sort((a, b) =>
      (a.type === "offer" ? 0 : 1) - (b.type === "offer" ? 0 : 1) || a.record.seq - b.record.seq);
    c.misplaced = c.boardFrames.filter((f) => !f.roomCorrect);
    c.verdict = provisional(c);
  }

  // Anything still unspoken for: an offer whose id no acceptance refers to.
  const taken = new Set<string>();
  for (const f of checked) {
    if (typeof f.frame.ref === "string") taken.add(f.frame.ref);
  }

  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const openOffers: OpenOffer[] = [];
  for (const [id, f] of offersById) {
    if (taken.has(id) || !f.signatureValid) continue;
    openOffers.push({
      offerId: id,
      job: (f.frame as { job?: JobBinding }).job,
      frame: f,
      from: f.record.from,
      amount: String(f.frame.amount ?? "0"),
      asset: String(f.frame.asset ?? ""),
      rails: Array.isArray(f.frame.rails) ? (f.frame.rails as string[]) : [],
      lock: String(f.frame.lock ?? ""),
      role: String(f.frame.role ?? ""),
      expiresMs: num(f.frame.expiresMs),
      claimByMs: num(f.frame.claimByMs),
      refundAfterMs: num(f.frame.refundAfterMs),
    });
  }
  openOffers.sort((a, b) => b.frame.record.seq - a.frame.record.seq);

  return { contracts: out, openOffers };
}

/** What the board alone can support. Never claims settlement. */
function provisional(c: Contract): Verdict {
  const types = new Set(c.boardFrames.map((f) => f.type));
  if (types.has("cancel")) return "cancelled";
  if (!types.has("accept")) return "open";
  return "unchecked";
}

/**
 * Fold the contract with the deal room included, using tclk's own state
 * machine. Only frames in a room the spec permits are fed to it — that is the
 * whole point, and it is why a misrouted reveal changes nothing.
 */
export function resolve(c: Contract, dealRecords: ExportedRecord[]): Contract {
  const dealFrames = dealRecords
    .map((r) => checkFrame(c.dealRoomName, r))
    .filter((f): f is CheckedFrame => f !== null && f.contract === c.id);

  const ordered = [...c.boardFrames, ...dealFrames]
    .filter((f) => f.roomCorrect && f.signatureValid)
    .sort((a, b) => (a.room === OFFER_ROOM ? 0 : 1) - (b.room === OFFER_ROOM ? 0 : 1) || a.record.seq - b.record.seq);

  const offerFrame = ordered.find((f) => f.type === "offer");
  let foldedStatus: string | null = null;

  if (offerFrame) {
    try {
      let state: unknown = openContract(offerFrame.frame as never);
      for (const f of ordered) {
        if (f === offerFrame) continue;
        const res = applyFrame(state as never, f.frame as never, Date.parse(f.record.ts)) as unknown as {
          ok: boolean; state: { status?: string };
        };
        // A rejected frame leaves state untouched — exactly the fail-closed
        // behaviour the spec promises, so we keep folding rather than abort.
        state = res.state;
      }
      foldedStatus = (state as { status?: string }).status ?? null;
    } catch {
      foldedStatus = null;
    }
  }

  const verdict: Verdict =
    foldedStatus === "claimed" ? "settled"
    : foldedStatus === "refunded" ? "refunded"
    : foldedStatus === "cancelled" ? "cancelled"
    : dealFrames.length === 0 && c.misplaced.length > 0 ? "misrouted"
    : dealFrames.length === 0 && provisional(c) === "unchecked" ? "stalled"
    : provisional(c);

  return { ...c, dealFrames, dealRoomRead: true, foldedStatus, verdict };
}
