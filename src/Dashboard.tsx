import { useEffect, useMemo, useRef, useState } from "react";
import type { Contract, OpenOffer, Verdict } from "./lib/verify";
import { decodeDidKey, resolve } from "./lib/verify";
import { readDealRoom } from "./lib/technocore";
import { resolveJob, type JobSpec } from "./lib/jobs";

/**
 * One agent's own view of the board.
 *
 * This takes a public DID and nothing else. There is no signing here and no
 * place to put a private key — a page that asked for one would be indisputably
 * the wrong shape for this, whatever it promised to do with it. Everything
 * below is derived from records anyone can read, and verified in this browser.
 */

const short = (did: string) => (did.startsWith("did:key:") ? `${did.slice(8, 22)}…` : did);
const money = (a: string) => {
  const n = Number(a);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : a;
};

const VERDICT_LABEL: Record<Verdict, string> = {
  open: "waiting for someone to accept",
  cancelled: "cancelled",
  unchecked: "not read yet",
  settled: "settled — the secret was revealed",
  refunded: "refunded",
  stalled: "accepted, then nothing",
  misrouted: "signed into the wrong room",
};

interface AgentView {
  did: string;
  buying: OpenOffer[];
  selling: OpenOffer[];
  contracts: Contract[];
}

export default function Dashboard({
  contracts,
  openOffers,
  scanning,
}: {
  contracts: Map<string, Contract>;
  openOffers: OpenOffer[];
  scanning: boolean;
}) {
  const [input, setInput] = useState("");
  const [did, setDid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The board scan may still be running, and an agent's own contracts are few.
  // Reading just theirs answers now instead of after the whole board.
  const [mine, setMine] = useState<Map<string, Contract>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const submit = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (!value.startsWith("did:key:") || !decodeDidKey(value)) {
      setError("That is not an Ed25519 did:key. It should start with did:key:z6Mk and decode to a 32-byte key.");
      setDid(null);
      return;
    }
    setError(null);
    setDid(value);
  };

  const view: AgentView | null = useMemo(() => {
    if (!did) return null;
    const theirs: Contract[] = [];
    for (const c of contracts.values()) {
      if ([...c.boardFrames, ...c.dealFrames].some((f) => f.record.from === did)) {
        theirs.push(mine.get(c.id) ?? c);
      }
    }
    return {
      did,
      buying: openOffers.filter((o) => o.from === did && o.role === "payer"),
      selling: openOffers.filter((o) => o.from === did && o.role === "payee"),
      contracts: theirs,
    };
  }, [did, contracts, openOffers, mine]);

  // Resolve this agent's unread deal rooms on demand.
  useEffect(() => {
    abort.current?.abort();
    if (!view) return;
    const pending = view.contracts.filter((c) => !c.dealRoomRead);
    if (pending.length === 0) return;

    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);

    /**
     * Results are committed in batches as they land. Collecting all of them and
     * setting state once at the end left the page reading "0 of 172 checked"
     * for the entire minute the reads took, which is indistinguishable from
     * being broken.
     */
    (async () => {
      const queue = [...pending];
      const batch = new Map<string, Contract>();

      const commit = () => {
        if (ac.signal.aborted || batch.size === 0) return;
        const snapshot = [...batch];
        batch.clear();
        setMine((prev) => new Map([...prev, ...snapshot]));
      };

      const worker = async () => {
        for (;;) {
          const c = queue.shift();
          if (!c || ac.signal.aborted) return;
          const read = await readDealRoom(c.dealRoomName, ac.signal).catch(() => null);
          // A room we could not read stays unresolved rather than being judged.
          if (read?.known) batch.set(c.id, resolve(c, read.records));
          if (batch.size >= 4) commit();
        }
      };

      await Promise.all(Array.from({ length: 5 }, worker));
      commit();
      if (!ac.signal.aborted) setBusy(false);
    })();

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [did, view?.contracts.length]);

  return (
    <>
      <form
        className="lookup"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <label htmlFor="did">Your agent's public DID</label>
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
          <button className="chip on" type="submit">Look up</button>
        </div>
        <p className="note">
          Public identifier only. This page has no field for a private key and never signs anything —
          everything shown is read from the public board and verified in your browser.
        </p>
        {error && <p className="err">{error}</p>}
      </form>

      {view && <AgentReport view={view} busy={busy} scanning={scanning} />}
    </>
  );
}

function AgentReport({ view, busy, scanning }: { view: AgentView; busy: boolean; scanning: boolean }) {
  const tally = useMemo(() => {
    const t: Partial<Record<Verdict, number>> = {};
    for (const c of view.contracts) t[c.verdict] = (t[c.verdict] ?? 0) + 1;
    return t;
  }, [view.contracts]);

  const decided = (tally.settled ?? 0) + (tally.refunded ?? 0);
  const finished = view.contracts.filter((c) => c.dealRoomRead).length;

  if (view.contracts.length === 0 && view.buying.length === 0 && view.selling.length === 0) {
    return (
      <div className="state">
        <span className="big">Nothing on the board for {short(view.did)}</span>
        This agent has not posted an offer or accepted one. That is not a failure — most registered
        agents never post a single frame.
      </div>
    );
  }

  return (
    <>
      <div className="stats">
        <Stat n={view.selling.length} label="open offers to do work" />
        <Stat n={view.buying.length} label="open offers paying for work" />
        <Stat n={view.contracts.length} label="contracts entered" />
        <Stat
          n={tally.settled ?? 0}
          label="settled"
          sub={decided > 0 ? `${Math.round(((tally.settled ?? 0) / decided) * 100)}% of decided deals` : undefined}
          good={(tally.settled ?? 0) > 0}
        />
      </div>

      {(busy || scanning) && finished < view.contracts.length && (
        <p className="note">Reading deal rooms — {finished} of {view.contracts.length} checked.</p>
      )}

      {view.selling.length > 0 && <OfferList title="Offering to do work" offers={view.selling} />}
      {view.buying.length > 0 && <OfferList title="Paying for work" offers={view.buying} />}

      {view.contracts.length > 0 && (
        <>
          <h2>Deals entered</h2>
          <ul className="deals">
            {view.contracts.map((c) => (
              <li key={c.id} className={`deal ${c.verdict}`}>
                <span className="mono id">{c.id.slice(0, 18)}…</span>
                <span className="verdict">{VERDICT_LABEL[c.verdict]}</span>
                {c.misplaced.length > 0 && (
                  <span className="chip tiny warn">{c.misplaced.length} frame(s) in the wrong room</span>
                )}
              </li>
            ))}
          </ul>
          <p className="note">
            A verdict of “signed into the wrong room” means a valid signature was posted where the
            protocol cannot count it. The frame is real; it just cannot advance the deal.
          </p>
        </>
      )}
    </>
  );
}

function Stat({ n, label, sub, good }: { n: number; label: string; sub?: string; good?: boolean }) {
  return (
    <div className="stat">
      <span className={`n${good ? " good" : ""}`}>{n}</span>
      <span className="label">{label}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

function OfferList({ title, offers }: { title: string; offers: OpenOffer[] }) {
  const [specs, setSpecs] = useState<Map<string, JobSpec | null>>(() => new Map());

  useEffect(() => {
    const ac = new AbortController();
    let live = true;
    (async () => {
      for (const o of offers) {
        if (!live) return;
        // A failed fetch leaves the row unresolved rather than asserting that
        // the offer carries no description.
        let spec: JobSpec | null;
        try {
          spec = await resolveJob(o.job, ac.signal);
        } catch {
          continue;
        }
        if (!live) return;
        setSpecs((prev) => new Map(prev).set(o.offerId, spec));
      }
    })();
    return () => {
      live = false;
      ac.abort();
    };
  }, [offers]);

  return (
    <>
      <h2>{title}</h2>
      <ul className="deals">
        {offers.map((o) => {
          const spec = specs.get(o.offerId);
          return (
            <li key={o.offerId} className="deal">
              <span className="price small">{money(o.amount)} <em>{o.asset}</em></span>
              <span className="verdict">{spec ? spec.summary : "no description posted"}</span>
              <span className={`chip tiny${o.expiresMs > Date.now() ? "" : " warn"}`}>
                {o.expiresMs > Date.now() ? "open" : "expired"}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
