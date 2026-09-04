import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportRoom, readDealRoom, type ExportedRecord } from "./lib/technocore";
import { scanAll, type ScanProgress } from "./lib/scan";
import {
  groupContracts, resolve, VERDICT_LABEL, VERDICT_TONE,
  type Contract, type Verdict,
} from "./lib/verify";

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
  const [filter, setFilter] = useState<Verdict | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const scanStarted = useRef(false);

  useEffect(() => {
    const ac = new AbortController();
    exportRoom(OFFER_ROOM, ac.signal)
      .then((recs) => { setRecords(recs); setContracts(groupContracts(recs)); })
      .catch((e: unknown) => {
        if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, []);

  const ordered = useMemo(
    () => [...contracts.values()].sort((a, b) => lastSeq(b) - lastSeq(a)),
    [contracts],
  );

  const shown = useMemo(
    () => (filter === "all" ? ordered : ordered.filter((c) => c.verdict === filter)).slice(0, PAGE),
    [ordered, filter],
  );

  /**
   * Resolve the rows on screen by reading their deal rooms. Deliberately not
   * done for all ten thousand: a verdict costs one request, and the honest
   * default is to admit we have not looked rather than to guess.
   */
  const resolveVisible = useCallback(async (batch: Contract[]) => {
    const pending = batch.filter((c) => !c.dealRoomRead);
    if (pending.length === 0) return;
    setResolving(true);

    const done = await Promise.all(
      pending.map(async (c) => { const r = await readDealRoom(c.dealRoomName); return r.known ? resolve(c, r.records) : c; }),
    );

    setContracts((prev) => {
      const next = new Map(prev);
      for (const c of done) next.set(c.id, c);
      return next;
    });
    setResolving(false);
  }, []);

  useEffect(() => { void resolveVisible(shown); }, [shown, resolveVisible]);

  /**
   * Resolve EVERY contract, in the background, streaming results as they land.
   * A sample would be cheaper, but a tool whose entire claim is rigour should
   * not report a percentage it did not actually measure.
   *
   * Guarded by a ref rather than by state. The scan updates `contracts` and
   * `scan` as it runs, so listing either as a dependency makes the effect
   * re-run and its own cleanup abort the scan after the first batch — which
   * looks exactly like a scan that silently stops at 25.
   */
  useEffect(() => {
    if (records === null || scanStarted.current) return;
    scanStarted.current = true;

    const ac = new AbortController();
    const pending = [...contracts.values()].filter((c) => !c.dealRoomRead);
    setScan({ done: 0, total: pending.length, finished: pending.length === 0 });

    void scanAll(pending, (resolved, progress) => {
      setContracts((prev) => {
        const next = new Map(prev);
        for (const c of resolved) next.set(c.id, c);
        return next;
      });
      setScan(progress);
    }, ac.signal);

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records]);

  const tally = useMemo(() => {
    const t: Partial<Record<Verdict, number>> = {};
    for (const c of ordered) t[c.verdict] = (t[c.verdict] ?? 0) + 1;
    return t;
  }, [ordered]);

  const checked = useMemo(() => ordered.filter((c) => c.dealRoomRead).length, [ordered]);
  const frames = useMemo(() => ordered.reduce((n, c) => n + c.boardFrames.length, 0), [ordered]);
  const validSigs = useMemo(
    () => ordered.reduce((n, c) => n + c.boardFrames.filter((f) => f.signatureValid).length, 0),
    [ordered],
  );

  const current = selected ? contracts.get(selected) ?? null : null;

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
          <div className="evidence">
            <div className="stat">
              <span className="n">{ordered.length.toLocaleString()}</span>
              <span className="k">contracts on the board</span>
            </div>
            <div className="stat">
              <span className="n">{validSigs.toLocaleString()}</span>
              <span className="k">of {frames.toLocaleString()} signatures valid</span>
            </div>
            <div className="stat">
              <span className="n">{checked === 0 ? "—" : `${Math.round(((tally.settled ?? 0) / checked) * 100)}%`}</span>
              <span className="k">settled &middot; {(tally.settled ?? 0).toLocaleString()} contracts</span>
            </div>
            <div className="stat flag">
              <span className="n">{checked === 0 ? "—" : `${Math.round(((tally.misrouted ?? 0) / checked) * 100)}%`}</span>
              <span className="k">misrouted &middot; {(tally.misrouted ?? 0).toLocaleString()} contracts</span>
            </div>
            <div className="stat">
              <span className="n">{scan && !scan.finished ? `${Math.round((checked / Math.max(1, ordered.length)) * 100)}%` : "100%"}</span>
              <span className="k">
                {scan && !scan.finished
                  ? `scanned · ${checked.toLocaleString()} of ${ordered.length.toLocaleString()} deal rooms`
                  : `every retained contract checked`}
              </span>
            </div>
          </div>
          <p className="note">
            Every contract is checked, not a sample &mdash; one deal-room read each, paced under the
            venue&rsquo;s rate limit, which takes a few minutes and fills in as it goes. The figures are
            complete for <strong>everything still retained</strong>: the board is a ring, so contracts
            older than it are gone from the venue and nobody can judge them. Signatures are not
            the problem here: nearly every frame verifies. The spec is what separates them, since{" "}
            <em>a valid signature in the wrong room cannot advance state.</em>
          </p>

          {current && <Detail contract={current} />}

          <div className="panel">
            <div className="filters">
              {(["all", "settled", "misrouted", "stalled", "unchecked", "refunded", "open"] as const).map((f) => (
                <button
                  key={f}
                  className={`chip${filter === f ? " on" : ""}`}
                  onClick={() => { setFilter(f); setSelected(null); }}
                >
                  {f === "all" ? `all ${ordered.length.toLocaleString()}` : `${VERDICT_LABEL[f]} ${(tally[f] ?? 0).toLocaleString()}`}
                </button>
              ))}
              <span className="spacer" />
              <span className="chip">read directly from technocore.chat</span>
            </div>

            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th><th>Parties</th><th>Board</th>
                    <th>Deal room</th><th>Last seen</th><th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => {
                    const parties = [...new Set(c.boardFrames.map((f) => f.record.from))];
                    return (
                      <tr key={c.id} aria-selected={selected === c.id}
                          onClick={() => setSelected(selected === c.id ? null : c.id)}>
                        <td className="num">{c.id.slice(0, 14)}&hellip;</td>
                        <td>{parties.slice(0, 2).map((p) => (
                          <span className="did" key={p} style={{ display: "block" }}>{short(p)}</span>
                        ))}</td>
                        <td className="num">{c.boardFrames.map((f) => f.type[0]!.toUpperCase()).join(" ")}</td>
                        <td className="num">
                          {!c.dealRoomRead ? "—" : c.dealFrames.length ? `${c.dealFrames.length} frames` : "empty"}
                        </td>
                        <td className="num">{ago(c.boardFrames[c.boardFrames.length - 1]!.record.ts)}</td>
                        <td><span className={`pill ${VERDICT_TONE[c.verdict]}`}>{VERDICT_LABEL[c.verdict]}</span></td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr><td colSpan={6} style={{ color: "var(--muted)" }}>Nothing in this state.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <footer>
            Read live from <code>technocore.chat</code>; every signature checked in your browser with{" "}
            <code>@noble/curves</code>, and every verdict folded through <code>tclk</code>&rsquo;s own state
            machine. <code>tclk/1</code> is alpha and testnet-only &mdash; no rail in it holds value.
            &ldquo;Misrouted&rdquo; means completion frames landed on the board while the deal room stayed
            empty; the likeliest cause is a client posting every frame where the deal started, not bad faith.
          </footer>
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
