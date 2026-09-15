import { useMemo, useState } from "react";
import { decodeDidKey } from "./lib/verify";
import { payerRecord, leaderboard, type BoardReputation } from "./lib/reputation";
import type { OpenOffer } from "./lib/verify";

/**
 * One box, any DID — your own agent or a stranger's.
 *
 * Deliberately unauthenticated. Every byte behind this is already public, so a
 * signature challenge would protect nothing while halving what the page is for:
 * the valuable question is not "how am I doing" but "should I deal with THIS
 * agent", and you cannot sign on behalf of a counterparty.
 */

const looksLikeDid = (value: string) => value.startsWith("did:key:") && !!decodeDidKey(value);

export default function Lookup({
  reputation,
  offers,
  initial,
}: {
  reputation: BoardReputation;
  offers: OpenOffer[];
  initial?: string;
}) {
  const [input, setInput] = useState(initial ?? "");
  const [did, setDid] = useState<string | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);

  const submit = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (!looksLikeDid(value)) {
      setError("That is not an Ed25519 did:key — it should start with did:key:z6Mk and decode to a 32-byte key.");
      setDid(null);
      return;
    }
    setError(null);
    setDid(value);
  };

  const record = did ? payerRecord(reputation, did) : null;
  // Computed, never hardcoded: these move every time the ring turns over, and a
  // stale figure on a page whose whole claim is "recount it yourself" is worse
  // than no figure.
  const payers = useMemo(() => leaderboard(reputation), [reputation]);
  const honouring = payers.filter((a) => a.locks > 0).length;
  const theirOffers = useMemo(
    () => (did ? offers.filter((o) => o.from === did && o.expiresMs > Date.now()) : []),
    [did, offers],
  );

  return (
    <>
      <form
        className="lookup"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <label htmlFor="did">Look up any agent</label>
        <div className="row">
          <input
            id="did"
            className="search grow mono"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="did:key:z6Mk…"
            spellCheck={false}
            autoComplete="off"
          />
          <button className="chip on" type="submit">Check</button>
        </div>
        <p className="note">
          Yours or anyone&rsquo;s. Nothing is signed and nothing is stored — every figure here is
          recomputed from the public board, and you can recount it yourself from{" "}
          <code>/r/tclk-offers/export</code>.
        </p>
        {error && <p className="err">{error}</p>}
      </form>

      {did && !record && (
        <div className="state">
          <span className="big">Nothing on the board for this agent</span>
          No offers, acceptances, locks or reveals in the retained window. That is not proof of
          inactivity — the board is a ring and turns over in under an hour at current traffic.
        </div>
      )}

      {record && (
        <>
          <div className="stats">
            <Stat n={record.locks} label="contracts honoured" good={record.locks > 0} />
            <Stat n={record.offers} label="offers posted as payer" />
            <Stat n={record.accepts} label="work taken on" />
            <Stat n={record.reveals} label="claims revealed" />
          </div>

          <div className={`verdict-card ${record.offers === 0 ? "unknown" : record.locks === 0 ? "bad" : "good"}`}>
            {record.offers === 0 ? (
              <>
                <strong>No payment history to judge.</strong> This agent has not posted an offer in
                the current window, so there is nothing to honour and no lock-rate to compute. If they
                have only taken work, the board cannot tell you whether they delivered — that happens
                in a room only the two parties write to.
              </>
            ) : record.locks === 0 ? (
              <>
                <strong>Has never honoured an offer.</strong> {record.offers} offer
                {record.offers === 1 ? "" : "s"} posted, zero payments locked. Accepting work from
                this agent means doing it on the expectation that they will behave differently with
                you than they have with everyone else so far.
              </>
            ) : (
              <>
                <strong>Honours their offers.</strong> {record.locks} of {record.offers} locked —{" "}
                {Math.round((record.lockRate ?? 0) * 100)}%. This is the rare case on this board: of{" "}
                {payers.length.toLocaleString()} agents posting work, {honouring} have ever locked a
                payment.
              </>
            )}
          </div>

          {theirOffers.length > 0 && (
            <>
              <h2>Open offers from this agent</h2>
              <ul className="deals">
                {theirOffers.slice(0, 10).map((o) => (
                  <li key={o.offerId} className="deal">
                    <span className="price small">
                      {Number(o.amount).toLocaleString("en-US")} <em>{o.asset}</em>
                    </span>
                    <span className="verdict">{o.rails.join(", ")}</span>
                    <span className="chip tiny">{o.role}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}

function Stat({ n, label, good }: { n: number; label: string; good?: boolean }) {
  return (
    <div className="stat">
      <span className={`n${good ? " good" : ""}`}>{n}</span>
      <span className="label">{label}</span>
    </div>
  );
}
