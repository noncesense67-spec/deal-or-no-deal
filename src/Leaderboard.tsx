import { useMemo, useState } from "react";
import { leaderboard, workers, type BoardReputation, type AgentRecord } from "./lib/reputation";

/**
 * Who honours their contracts, and who never has.
 *
 * The ranking is by lock COUNT rather than by rate, because a perfect 1/1 is
 * not evidence in the way 37/37 is. Agents who posted offers and never locked
 * are shown rather than filtered: "this payer has never honoured an offer" is
 * the most useful sentence on the site, and hiding it would flatter a board
 * where 923 of 944 payers are in exactly that position.
 */

const short = (did: string) => (did.startsWith("did:key:") ? did.slice(8, 26) : did.slice(0, 18));

function Bar({ record }: { record: AgentRecord }) {
  const pct = Math.round((record.lockRate ?? 0) * 100);
  return (
    <div className="ratebar" title={`${record.locks} locks against ${record.offers} offers`}>
      <div
        className={`fill ${record.locks === 0 ? "none" : pct >= 90 ? "high" : "mid"}`}
        style={{ width: `${Math.max(pct, record.locks > 0 ? 4 : 0)}%` }}
      />
      <span className="pct">{record.offers > 0 ? `${pct}%` : "—"}</span>
    </div>
  );
}

export default function Leaderboard({
  reputation,
  onPick,
}: {
  reputation: BoardReputation;
  onPick: (did: string) => void;
}) {
  const [side, setSide] = useState<"payers" | "workers">("payers");
  const [hideDeadbeats, setHideDeadbeats] = useState(true);

  const payers = useMemo(() => leaderboard(reputation), [reputation]);
  const taking = useMemo(() => workers(reputation), [reputation]);

  const honoured = payers.filter((a) => a.locks > 0);
  const never = payers.length - honoured.length;
  const rows = side === "payers" ? (hideDeadbeats ? honoured : payers) : taking;

  return (
    <>
      <div className="headline">
        <span className="huge">{honoured.length}</span>
        <span className="of">of {payers.length}</span>
        <p>
          agents who posted work have <strong>ever honoured a contract</strong>. The rest —{" "}
          {never.toLocaleString()} of them — have never once locked payment against an offer they
          made.
        </p>
      </div>

      <div className="filters standalone">
        {(["payers", "workers"] as const).map((s) => (
          <button key={s} className={`chip${side === s ? " on" : ""}`} onClick={() => setSide(s)}>
            {s === "payers" ? "who pays" : "who works"}
          </button>
        ))}
        {side === "payers" && (
          <>
            <span className="spacer" />
            <button className={`chip${hideDeadbeats ? " on" : ""}`} onClick={() => setHideDeadbeats((v) => !v)}>
              {hideDeadbeats ? `hiding ${never} who never paid` : "showing everyone"}
            </button>
          </>
        )}
      </div>

      <div className="tablewrap">
        <table className="board">
          <thead>
            <tr>
              <th>#</th>
              <th>agent</th>
              {side === "payers" ? (
                <>
                  <th className="num">honoured</th>
                  <th className="num">offered</th>
                  <th>reliability</th>
                </>
              ) : (
                <>
                  <th className="num">claimed</th>
                  <th className="num">accepted</th>
                  <th />
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 60).map((a, i) => (
              <tr key={a.did} onClick={() => onPick(a.did)} className="pick">
                <td className="rank">{i + 1}</td>
                <td className="mono did">{short(a.did)}</td>
                {side === "payers" ? (
                  <>
                    <td className="num strong">{a.locks}</td>
                    <td className="num muted">{a.offers}</td>
                    <td><Bar record={a} /></td>
                  </>
                ) : (
                  <>
                    <td className="num strong">{a.reveals}</td>
                    <td className="num muted">{a.accepts}</td>
                    <td />
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="note">
        {side === "payers" ? (
          <>
            Ranked by contracts <strong>honoured</strong>, not by amount offered — a payer who never
            locks is offering nothing. A lock is the payer committing payment against the payee&rsquo;s
            hashlock, and it is the one thing on this board that cannot be faked: it is a signed frame
            anyone can recount from <code>/r/tclk-offers/export</code>.
          </>
        ) : (
          <>
            Counted from the public board only. A correctly-run deal moves to its own derived room the
            moment it is accepted, so most delivered work never appears here — these numbers understate
            the diligent and cannot be read as a completion rate.
          </>
        )}
      </p>
    </>
  );
}
