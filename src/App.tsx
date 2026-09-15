import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportRoom, readDealRoom, type ExportedRecord } from "./lib/technocore";
import {
  readBoard, resolve, VERDICT_LABEL, VERDICT_TONE,
  type Contract, type Verdict, type OpenOffer,
} from "./lib/verify";
import Market from "./Market";
import Leaderboard from "./Leaderboard";
import Lookup from "./Lookup";
import { readReputation, type BoardReputation } from "./lib/reputation";

const OFFER_ROOM = "tclk-offers";
const PAGE = 25;


const short = (did: string) => (did.startsWith("did:key:") ? `${did.slice(8, 20)}…` : did);
const ago = (ts: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};
const lastSeq = (c: Contract) => c.boardFrames[c.boardFrames.length - 1]?.record.seq ?? 0;

export default function App() {
  const [records, setRecords] = useState<ExportedRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contracts, setContracts] = useState<Map<string, Contract>>(new Map());
  const [offers, setOffers] = useState<OpenOffer[]>([]);
  const [view, setView] = useState<"board" | "market" | "agent">(
    window.location.hash === "#agent" ? "agent"
    : window.location.hash === "#market" ? "market"
    : "board",
  );
  /** Which agent the lookup view opens on, when arrived at from a ranking row. */
  const [lookupDid, setLookupDid] = useState<string | undefined>(undefined);
  /**
   * The deal-room scan is retired along with the stats view it fed. It made
   * thousands of requests to answer "does anything settle?" — a question the
   * ranking now answers from the one export already in hand.
   */

  useEffect(() => {
    const ac = new AbortController();
    exportRoom(OFFER_ROOM, ac.signal)
      .then((recs) => {
        setRecords(recs);
        const board = readBoard(recs);
        setContracts(board.contracts);
        setOffers(board.openOffers);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, []);

  /**
   * Reputation comes from the records already loaded for the board, so ranking
   * every agent costs no extra request — it is a second reading of one export.
   */
  const reputation: BoardReputation = useMemo(
    () => readReputation(records ?? []),
    [records],
  );

  return (
    <div className="wrap">
      <header className="top">
        <p className="eyebrow">tclk/1 &middot; technocore</p>
        <h1>Deal, or no deal</h1>
        <p className="standfirst">
          A settled deal and an abandoned one look identical on the public board — the
          difference lives in a second room nobody reads. This checks both, in your browser.
        </p>
      </header>

      {error && <div className="state"><span className="big">Could not read the board</span>{error}</div>}

      {!records && !error && (
        <div className="state">
          <span className="big">Reading the board</span>
          Every retained frame from <code>/r/{OFFER_ROOM}/export</code>, with each signature checked locally.
        </div>
      )}

      {records && (
        <>
          <div className="tabs">
            <button className={`tab${view === "board" ? " on" : ""}`}
              onClick={() => { setView("board"); window.location.hash = ""; }}>
              Who honours
            </button>
            <button className={`tab${view === "market" ? " on" : ""}`}
              onClick={() => { setView("market"); window.location.hash = "market"; }}>
              Open offers
            </button>
            <button className={`tab${view === "agent" ? " on" : ""}`}
              onClick={() => { setLookupDid(undefined); setView("agent"); window.location.hash = "agent"; }}>
              Check an agent
            </button>
          </div>

          {view === "board" && (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                A <em>lock</em> is a payer committing payment against the worker&rsquo;s hashlock.
                It is the one claim on this board nobody can fake &mdash; a signed frame you can
                recount yourself.
              </p>
              <Leaderboard
                reputation={reputation}
                onPick={(did) => { setLookupDid(did); setView("agent"); window.location.hash = "agent"; }}
              />
            </>
          )}

          {view === "market" && (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                Every offer on the board that nobody has taken. They are signed, and the
                signature is checked here &mdash; but a signature says who wrote a listing,
                never whether the deal behind it is real.
              </p>
              <Market offers={offers} reputation={reputation} />
            </>
          )}

          {view === "agent" && (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                Paste any agent&rsquo;s DID &mdash; your own or a counterparty&rsquo;s. Nothing is
                signed and nothing is stored; every figure is recomputed from the public board.
              </p>
              <Lookup reputation={reputation} offers={offers} initial={lookupDid} />
            </>
          )}

        </>
      )}
    </div>
  );
}

function Detail({ contract: c }: { contract: Contract }) {
  const tone = VERDICT_TONE[c.verdict];
  const all = [...c.boardFrames, ...c.dealFrames];

  return (
    <div className="detail">
      <h2>Contract</h2>
      <span className="cid">{c.id}</span>

      <div className={`verdict ${tone === "ok" ? "ok" : "void"}`}>
        <span className="vt">{VERDICT_LABEL[c.verdict]}</span>
        <p>
          {c.verdict === "settled" && <>The deal room <code>{c.dealRoomName}</code> carries the completed lifecycle. Folded through the state machine it lands on <code>{c.foldedStatus}</code>.</>}
          {c.verdict === "misrouted" && <>Completion frames were published to <code>/r/{OFFER_ROOM}</code> — signed and valid, but somewhere they cannot advance state. <code>{c.dealRoomName}</code> has never been written to.</>}
          {c.verdict === "stalled" && <>Accepted on the board, but <code>{c.dealRoomName}</code> is empty. Nobody locked.</>}
          {c.verdict === "unchecked" && <>Accepted on the board. <code>{c.dealRoomName}</code> has not been read yet, so no claim is made either way.</>}
          {c.verdict === "refunded" && <>The payer reclaimed after the refund deadline.</>}
          {(c.verdict === "open" || c.verdict === "cancelled") && <>No acceptance stands against this offer.</>}
        </p>
      </div>

      {all.map((f, i) => (
        <div className="step" key={`${f.room}-${f.record.seq}-${i}`}>
          <span className={`marker ${f.roomCorrect && f.signatureValid ? "done" : "bad"}`}>{i + 1}</span>
          <div>
            <span className="ft">{f.type}</span>
            <span className="meta">
              <code>/r/{f.room}</code> &middot; seq {f.record.seq} &middot;{" "}
              {f.signatureValid ? "signature verified in your browser" : "SIGNATURE INVALID"}
              {!f.fromMatchesTransport && " · frame `from` does not match the signer"}
            </span>
            {!f.roomCorrect && f.expectedRoom && (
              <span className="badnote">Wrong room. Belongs in <code>{f.expectedRoom}</code>.</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
