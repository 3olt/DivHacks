"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { API_URL, DEMO_SCENARIOS, fetchDecisions, fetchDemoRun, fetchDemoRuns, fetchSites, resetDemo, runDemo, type DemoRun, type DemoScenario } from "@/lib/api";
import type { Decision, Site, SiteRisk } from "@/lib/contracts";
import { OUTCOME_BADGES, enforcedByLabel, explorerTxUrl, formatEventTime, formatMoney } from "@/lib/format";
import { connectLive } from "@/lib/live";
import { isRealTxHash } from "@/lib/openData";
import { decisionPipeline, type StepStatus } from "@/lib/pipeline";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import { SCENARIOS, asExpected, groupRuns, paidTotals, scenarioOf, type Run } from "@/lib/scenarios";

const MapView = dynamic(() => import("../MapView"), { ssr: false });

const STEP_STYLE: Record<StepStatus, { icon: string; label: string; className: string }> = {
  pass: { icon: "✓", label: "passed", className: "border-green-300 bg-green-50 text-green-800" },
  fail: { icon: "✗", label: "stopped the payment here", className: "border-red-300 bg-red-50 text-red-800" },
  sim: { icon: "⚠", label: "simulated hack (staged on purpose)", className: "border-violet-300 bg-violet-50 text-violet-800" },
  wait: { icon: "…", label: "waiting", className: "border-amber-300 bg-amber-50 text-amber-800" },
  skip: { icon: "–", label: "not reached", className: "border-gray-200 bg-gray-50 text-gray-400" },
};

// Only one Testnet run at a time (the API holds a lock); these scenarios need the real ledger.
const TESTNET_ONLY: DemoScenario[] = ["uncredentialed", "escrow"];

type ActiveRun = { run_id: string | null; scenario: DemoScenario; startedMs: number };
// The latest demo_risk_updated per site (this session): before -> after for "Effect of this run".
type PinMove = { from: SiteRisk; to: SiteRisk };

// On /demo, pins and "Effect on the locations" show the what-if score after Testnet payments (demo_risk ?? risk).
// /map, the site report and iMessage always use the public-records `risk` (docs/API.md, Sun 04:50).
const demoView = (s: Site): Site => (s.demo_risk ? { ...s, risk: s.demo_risk } : s);

export default function DemoPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [demoRuns, setDemoRuns] = useState<DemoRun[]>([]);
  const [mode, setMode] = useState<string | null>(null);
  const [selected, setSelected] = useState<DemoScenario>("happy");
  const [openRunKey, setOpenRunKey] = useState<string | null>(null); // an earlier run picked from the history / ledger
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [pinMoves, setPinMoves] = useState<Record<string, PinMove>>({});
  const [mapHidden, setMapHidden] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Initial load + live updates: demo pins move on demo_risk_updated, decisions land as the agent records them.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [s, d, runs, h] = await Promise.all([fetchSites(), fetchDecisions(200), fetchDemoRuns().catch(() => []), fetch(`${API_URL}/health`).then((r) => r.json())]);
        if (cancelled) return;
        setSites(s);
        setDecisions(d);
        setDemoRuns(runs);
        setMode(h.mode);
        if (h.demo_run?.status === "running" && (DEMO_SCENARIOS as readonly string[]).includes(h.demo_run.scenario)) {
          setActiveRun({ run_id: h.demo_run.run_id, scenario: h.demo_run.scenario, startedMs: Date.now() });
        }
      } catch {
        if (!cancelled) setError("Can't reach the API. Is it running on :4000?");
      }
    }
    load();
    const stop = connectLive((msg) => {
      if (msg.type === "hello") load();
      else if (msg.type === "site_updated") setSites((s) => s.map((x) => (x.id === msg.site_id ? { ...x, risk: msg.risk } : x)));
      else if (msg.type === "demo_risk_updated") {
        setSites((s) => s.map((x) => (x.id === msg.site_id ? { ...x, demo_risk: msg.demo_risk } : x)));
        setPinMoves((p) => {
          const next = { ...p };
          if (msg.demo_risk && msg.previous_demo_risk) next[msg.site_id] = { from: msg.previous_demo_risk, to: msg.demo_risk };
          else delete next[msg.site_id]; // reset: back to the public score
          return next;
        });
      } else if (msg.type === "decision") {
        setDecisions((f) => [msg.decision, ...f.filter((d) => d.decision_id !== msg.decision.decision_id)]);
        setOpenRunKey(null);
      } else if (msg.type === "demo_run" && msg.status !== "running") {
        setActiveRun((r) => (r && (r.run_id === msg.run_id || r.run_id === null) ? null : r));
        finish();
      }
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  // While a run is going: tick the timer, and poll it in case the demo_run message is missed.
  useEffect(() => {
    if (!activeRun) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      if (!activeRun.run_id) return;
      const r = await fetchDemoRun(activeRun.run_id).catch(() => null);
      if (r && r.status !== "running") {
        setActiveRun(null);
        finish();
      }
    }, 5000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [activeRun]);

  async function finish() {
    const [runs, d] = await Promise.all([fetchDemoRuns().catch(() => null), fetchDecisions(200).catch(() => null)]);
    if (runs) setDemoRuns(runs);
    if (d) setDecisions(d);
  }

  function pick(s: DemoScenario) {
    setSelected(s);
    setOpenRunKey(null);
    setMapHidden(false);
    setError("");
  }

  async function start() {
    if (starting || activeRun) return;
    setStarting(true);
    setError("");
    setOpenRunKey(null);
    const startedMs = Date.now();
    try {
      const r = await runDemo(selected);
      if (!r.ok) {
        setError(
          r.error === "run_in_progress"
            ? "Another run is still going. Wait for it to finish."
            : r.error === "testnet_only"
              ? "This scenario needs the real XRP Ledger Testnet (the API is in fixture mode)."
              : r.message,
        );
      } else if (r.run_id) {
        setActiveRun({ run_id: r.run_id, scenario: selected, startedMs });
        setNow(startedMs);
      } else {
        finish(); // fixture mode: the decisions are already recorded
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setStarting(false);
    }
  }

  async function reset() {
    if (!window.confirm("Reset the demo? Every pin on this page goes back to its public-records score, for everyone on the team. The Testnet history is kept.")) return;
    setResetting(true);
    setError("");
    try {
      const r = await resetDemo();
      if (!r.ok) setError(r.message ?? "Reset failed");
      else {
        // Refetch rather than rely on the broadcasts (docs/API.md).
        const [s, d] = await Promise.all([fetchSites(), fetchDecisions(200)]);
        setSites(s);
        setDecisions(d);
        setPinMoves({});
        setOpenRunKey(null);
      }
    } finally {
      setResetting(false);
    }
  }

  const runs = groupRuns(decisions);
  const runOf = new Map<string, { run: Run; index: number }>();
  for (const run of runs) run.decisions.forEach((d, index) => runOf.set(d.decision_id, { run, index }));

  const lastRun = (s: DemoScenario) => runs.find((r) => r.scenario === s) ?? null;
  // The newest button press for a scenario that never reached the ledger (e.g. keys missing on this computer).
  const lastFailure = (s: DemoScenario) => {
    const r = demoRuns.find((x) => x.scenario === s);
    if (!r || (r.status !== "failed" && r.status !== "unknown")) return null;
    const done = lastRun(s);
    return done && done.at > Date.parse(r.started_at) ? null : r;
  };

  const viewedRun = runs.find((r) => r.key === openRunKey) ?? lastRun(selected);
  const failure = lastFailure(selected);
  const info = SCENARIOS[selected];
  const siteByEin = (ein: string) => sites.find((s) => s.nonprofit_ein === ein);
  const payeeSite = viewedRun ? siteByEin(viewedRun.decisions[0].payee_ein) : info.payee === "golden" ? sites.find((s) => s.is_golden) : siteByEin(info.payee);
  const progress = activeRun
    ? decisions.filter((d) => scenarioOf(d.invoice_id) === activeRun.scenario && Date.parse(d.created_at) >= activeRun.startedMs - 2000).length
    : 0;

  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <nav className="flex items-center justify-between border-b border-gray-200 px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-lg font-bold">
            GlassLedger
          </Link>
          <span className="text-sm text-gray-500">Live demo: the payment agent and its guardrails</span>
        </div>
        <div className="flex gap-4 text-sm">
          <Link href="/map" className="text-gray-700 hover:text-gray-900">
            Map
          </Link>
          <Link href="/data" className="text-gray-700 hover:text-gray-900">
            Open data
          </Link>
        </div>
      </nav>

      <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-[1fr_600px]">
        <div className="h-[40dvh] overflow-hidden rounded-xl border border-gray-200 lg:sticky lg:top-6 lg:h-[calc(100dvh-7rem)]">
          <MapView sites={sites.map(demoView)} selectedId={mapHidden ? null : (payeeSite?.id ?? null)} onSelect={() => {}} onPopupChange={() => {}} onDismiss={() => setMapHidden(true)} />
        </div>

        <div className="space-y-8">
          <div className="space-y-2">
            <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
              <strong>This is the agent playground.</strong> The four &quot;(demo)&quot; nonprofits are fictional organizations with Testnet wallets, so the agent has
              someone to pay and to block. Food Bank For NYC is a real organization with a demo wallet. Test payments move pins on this page only; the main map
              always shows public records.
            </p>
            <p className="rounded-md bg-gray-50 p-3 text-xs text-gray-600">
              Every payment needs <strong>3 signature weights</strong> on the XRP Ledger: the AI agent has 1, the independent co-signer 2, a human officer 1. The
              agent can never pay alone.{" "}
              {mode === "mongo"
                ? "Runs are real transactions on the XRP Ledger Testnet (test money, no value)."
                : mode
                  ? "The API is in fixture mode: runs are simulated, nothing touches the ledger."
                  : ""}
            </p>
          </div>

          {/* 1. Pick */}
          <section>
            <SectionTitle n={1} title="Pick a scenario" />
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {DEMO_SCENARIOS.map((s) => (
                <ScenarioCard
                  key={s}
                  title={SCENARIOS[s].title}
                  selected={s === selected}
                  running={activeRun?.scenario === s}
                  elapsed={activeRun?.scenario === s ? now - activeRun.startedMs : 0}
                  last={lastRun(s)}
                  failure={lastFailure(s)}
                  onClick={() => pick(s)}
                />
              ))}
            </div>
          </section>

          {/* 2. What happens */}
          <section>
            <SectionTitle n={2} title={info.title} />
            <div className="mt-2 space-y-4 rounded-xl border border-gray-200 p-4 text-sm">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">The problem</p>
                <p className="mt-1 text-gray-800">{info.problem}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">How GlassLedger stops it</p>
                <p className="mt-1 text-gray-800">{info.defense}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">What this run does</p>
                <ol className="mt-1 space-y-1.5">
                  {info.attempts.map((a, i) => (
                    <li key={a.label} className="flex gap-2">
                      <span className="w-5 shrink-0 text-gray-400">{i + 1}.</span>
                      <div>
                        <p className="text-gray-900">
                          {a.label} {a.simulated && <SimulatedPill text={a.simulated} />}
                        </p>
                        <p className="text-xs text-gray-500">Expected: {a.result}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                {info.note && <p className="mt-2 text-xs text-gray-500">{info.note}</p>}
              </div>

              <div className="border-t border-gray-100 pt-4">
                <button
                  onClick={start}
                  disabled={starting || activeRun !== null || !mode || (mode !== "mongo" && TESTNET_ONLY.includes(selected))}
                  className="w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  {activeRun?.scenario === selected
                    ? `Running… ${clock(now - activeRun.startedMs)}`
                    : starting
                      ? "Starting…"
                      : mode === "mongo"
                        ? "Run this scenario on XRPL Testnet"
                        : "Run this scenario (simulated)"}
                </button>
                {activeRun && activeRun.scenario === selected && (
                  <p className="mt-2 text-xs text-amber-800">
                    {progress} of {info.attempts.length} steps recorded. Each step appears under Result as it lands (about 20 s to 2 min in total). The other
                    buttons unlock when it finishes.
                  </p>
                )}
                {activeRun && activeRun.scenario !== selected && (
                  <p className="mt-2 text-xs text-amber-800">&quot;{SCENARIOS[activeRun.scenario].title}&quot; is running. One run at a time: wait for it to finish.</p>
                )}
                {mode && mode !== "mongo" && TESTNET_ONLY.includes(selected) && <p className="mt-2 text-xs text-gray-500">Needs the real XRP Ledger Testnet.</p>}
                {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
              </div>
            </div>
          </section>

          {/* 3. Result */}
          <section id="result">
            <SectionTitle n={3} title="Result" />
            {failure && !activeRun && !openRunKey && (
              <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                <p className="font-semibold">Your last try ({timeOf(failure.started_at)}) didn&apos;t reach the ledger. Nothing was sent.</p>
                <p className="mt-1">{explainFailure(failure)}</p>
                {viewedRun && <p className="mt-1 text-red-700">Below: the last run that did complete.</p>}
              </div>
            )}
            {!viewedRun ? (
              <p className="mt-2 text-sm text-gray-500">No run of this scenario yet.</p>
            ) : (
              <RunResult
                run={viewedRun}
                site={payeeSite}
                pinMove={payeeSite && runs.find((r) => r.decisions[0].payee_ein === payeeSite.nonprofit_ein)?.key === viewedRun.key ? pinMoves[payeeSite.id] : undefined}
              />
            )}
            {runs.filter((r) => r.scenario === selected).length > 1 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-gray-500">Earlier runs:</span>
                {runs
                  .filter((r) => r.scenario === selected)
                  .slice(0, 6)
                  .map((r) => (
                    <button
                      key={r.key}
                      onClick={() => setOpenRunKey(r.key)}
                      className={`rounded border px-2 py-0.5 ${r.key === viewedRun?.key ? "border-gray-900 text-gray-900" : "border-gray-200 text-gray-600 hover:border-gray-900"}`}
                    >
                      {timeOf(r.decisions[0].created_at)}
                    </button>
                  ))}
              </div>
            )}
          </section>

          {/* Effect on the locations */}
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Effect on the locations</h2>
            <LocationEffects
              sites={sites.filter((s) => s.is_demo_data || s.is_golden)}
              decisions={decisions}
              onSelect={(ein) => {
                const s = DEMO_SCENARIOS.find((x) => (SCENARIOS[x].payee === "golden" ? sites.find((y) => y.is_golden)?.nonprofit_ein : SCENARIOS[x].payee) === ein);
                if (s) pick(s);
              }}
            />
          </section>

          {/* Live ledger */}
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Live ledger: every agent decision</h2>
            <LiveLedger
              decisions={decisions}
              runOf={runOf}
              siteName={(ein) => siteByEin(ein)?.name ?? `EIN ${ein}`}
              onOpen={(run) => {
                if (run.scenario) setSelected(run.scenario);
                setOpenRunKey(run.key);
                setMapHidden(false);
                document.getElementById("result")?.scrollIntoView({ behavior: "smooth" });
              }}
            />
            <button onClick={reset} disabled={resetting || activeRun !== null} className="mt-4 text-xs text-gray-600 underline disabled:opacity-50">
              {resetting ? "Resetting…" : "Reset demo data"}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ n, title }: { n: number; title: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-900 text-[11px] text-white">{n}</span>
      {title}
    </h2>
  );
}

function SimulatedPill({ text }: { text: string }) {
  return <span className="ml-1 whitespace-nowrap rounded bg-violet-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-violet-800">{text}</span>;
}

function ScenarioCard({
  title,
  selected,
  running,
  elapsed,
  last,
  failure,
  onClick,
}: {
  title: string;
  selected: boolean;
  running: boolean;
  elapsed: number;
  last: Run | null;
  failure: DemoRun | null;
  onClick: () => void;
}) {
  const status = running
    ? { text: `Running… ${clock(elapsed)}`, className: "text-amber-700" }
    : failure
      ? { text: `Last try failed · ${timeOf(failure.started_at)}`, className: "text-red-700" }
      : last
        ? asExpected(last)
          ? { text: `✓ As expected · ${timeOf(last.decisions[0].created_at)}`, className: "text-green-700" }
          : { text: `Ran · ${timeOf(last.decisions[0].created_at)}`, className: "text-gray-600" }
        : { text: "Not run yet", className: "text-gray-400" };
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-lg border p-2.5 text-left ${selected ? "border-gray-900 bg-gray-50 ring-1 ring-gray-900" : "border-gray-200 hover:border-gray-500"}`}
    >
      <p className="text-sm font-semibold leading-tight">{title}</p>
      <p className={`mt-1 text-[11px] ${status.className}`}>{status.text}</p>
    </button>
  );
}

function RunResult({ run, site, pinMove }: { run: Run; site?: Site; pinMove?: PinMove }) {
  const info = run.scenario ? SCENARIOS[run.scenario] : null;
  const expected = info?.attempts.length ?? run.decisions.length;
  const ok = asExpected(run);
  const paid = paidTotals(run.decisions);
  const blocked = run.decisions.filter((d) => d.outcome === "refused").length;
  const paidText = Object.entries(paid)
    .map(([cur, n]) => formatMoney(n, cur))
    .join(" + ");
  return (
    <div className="mt-2 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{site?.name ?? `EIN ${run.decisions[0].payee_ein}`}</span>
        <span className="text-gray-500">· {formatEventTime(run.decisions[0].created_at)}</span>
        <span className={`ml-auto rounded px-2 py-0.5 text-xs font-semibold ${ok ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-700"}`}>
          {ok ? `✓ As expected (${run.decisions.length} of ${expected} steps)` : `${run.decisions.length} of ${expected} steps recorded`}
        </span>
      </div>

      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500">
        {(["pass", "fail", "sim", "skip", "wait"] as StepStatus[]).map((s) => (
          <span key={s}>
            <span className={`mr-1 inline-block w-4 rounded border text-center font-bold ${STEP_STYLE[s].className}`}>{STEP_STYLE[s].icon}</span>
            {STEP_STYLE[s].label}
          </span>
        ))}
      </p>

      <ol className="space-y-3">
        {run.decisions.map((d, i) => (
          <AttemptCard key={d.decision_id} n={i + 1} decision={d} attempt={info?.attempts[i]} />
        ))}
      </ol>

      <div className="rounded-md bg-gray-50 p-3 text-xs text-gray-700">
        <p className="font-semibold text-gray-900">Effect of this run</p>
        <p className="mt-1">
          {paidText ? `Paid ${paidText} to ${site?.name ?? "the nonprofit"} (Testnet test money).` : "No money moved."}
          {blocked > 0 && ` ${blocked} payment${blocked === 1 ? " was" : "s were"} stopped${run.scenario === "injection" ? "; the scammer's wallet got nothing" : ""}.`}
        </p>
        {site && (
          <p className="mt-1">
            {!paidText
              ? `Its pin didn't move: nothing was paid.`
              : pinMove
                ? `Its pin on this page moved: ${riskText(pinMove.from)} → ${riskText(pinMove.to)}.`
                : site.demo_risk
                  ? `Its pin on this page: ${riskText(site.risk)} from public records → ${riskText(site.demo_risk)} after the test payments since the last reset.`
                  : `This run was before the last reset, so its pin is back to its public-records score, ${riskText(site.risk)}.`}
            {site.is_golden && " The main map never changes from test money."}
          </p>
        )}
      </div>
    </div>
  );
}

function AttemptCard({ n, decision: d, attempt }: { n: number; decision: Decision; attempt?: { label: string; simulated?: string } }) {
  const [open, setOpen] = useState(false);
  const badge = OUTCOME_BADGES[d.outcome];
  return (
    <li className="rounded-xl border border-gray-200 p-3">
      <div className="flex items-start gap-2">
        <p className="text-sm font-medium text-gray-900">
          {n}. {attempt?.label ?? d.invoice_id} {attempt?.simulated && <SimulatedPill text={attempt.simulated} />}
        </p>
        <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
        <span className="shrink-0 text-sm font-medium">{formatMoney(d.amount, d.currency).replace(" (test token, not RLUSD)", "")}</span>
      </div>
      <ol className="mt-2 space-y-1">
        {decisionPipeline(d).map((step) => (
          <li key={step.name} className={`flex gap-2 rounded-md border px-2.5 py-1.5 text-xs ${STEP_STYLE[step.status].className}`}>
            <span className="w-3 shrink-0 font-bold">{STEP_STYLE[step.status].icon}</span>
            <span className="w-40 shrink-0 font-medium">{step.name}</span>
            <span className="leading-4">{step.detail}</span>
          </li>
        ))}
      </ol>
      <button onClick={() => setOpen(!open)} className="mt-2 text-xs text-gray-600 underline">
        {open ? "Hide technical details" : "Technical details"}
      </button>
      {open && <DecisionDetails decision={d} />}
    </li>
  );
}

function LocationEffects({
  sites,
  decisions,
  onSelect,
}: {
  sites: Site[];
  decisions: Decision[];
  onSelect: (ein: string) => void;
}) {
  const rows = [...sites].sort((a, b) => Number(!!b.is_golden) - Number(!!a.is_golden) || a.name.localeCompare(b.name));
  return (
    <div className="mt-2">
      <table className="w-full text-left text-xs">
        <thead className="text-gray-500">
          <tr className="border-b border-gray-200">
            <th className="py-1.5 font-medium">Location</th>
            <th className="py-1.5 font-medium">Paid</th>
            <th className="py-1.5 text-right font-medium">Stopped</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const mine = decisions.filter((d) => d.payee_ein === s.nonprofit_ein);
            const paid = Object.entries(paidTotals(mine));
            const count = mine.filter((d) => d.outcome === "released").length;
            const shown = s.demo_risk ?? s.risk;
            return (
              <tr key={s.id} className="cursor-pointer border-b border-gray-100 align-top hover:bg-gray-50" onClick={() => onSelect(s.nonprofit_ein)}>
                <td className="py-2 pr-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: RISK_COLORS[shown.level] }} title={RISK_LABELS[shown.level]} />
                    <div>
                      <p className="font-medium text-gray-900">{s.name}</p>
                      <p className="text-gray-500">
                        {s.is_golden ? "Real organization" : "Fictional"} · public records: {riskText(s.risk)}
                        {s.demo_risk && (
                          <>
                            {" "}
                            → <span className="font-medium text-gray-900">after test payments: {riskText(s.demo_risk)}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="py-2 pr-2 text-gray-800">
                  {count === 0 ? "—" : `${paid.map(([cur, n]) => formatMoney(n, cur).replace(" (test token, not RLUSD)", "")).join(" + ")} (${count})`}
                </td>
                <td className="py-2 text-right text-gray-800">{mine.filter((d) => d.outcome === "refused").length || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-gray-500">
        Colors on this page are the what-if score after the Testnet payments since the last reset (the Food Bank&apos;s at a disclosed demo scale, 1 RLUSD =
        $10,000). The main map always shows public records. Paid / stopped: {/* GET /decisions returns at most 200 */}
        {decisions.length >= 200 ? "the latest 200 agent decisions" : "every agent decision"} (test money). Click a row to see its scenario.
      </p>
    </div>
  );
}

function LiveLedger({
  decisions,
  runOf,
  siteName,
  onOpen,
}: {
  decisions: Decision[];
  runOf: Map<string, { run: Run; index: number }>;
  siteName: (ein: string) => string;
  onOpen: (run: Run) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? decisions : decisions.slice(0, 25);
  return (
    <div className="mt-2">
      <ul className="space-y-1">
        {shown.map((d) => {
          const where = runOf.get(d.decision_id);
          const info = where?.run.scenario ? SCENARIOS[where.run.scenario] : null;
          const attempt = info?.attempts[where?.index ?? -1];
          return (
            <li key={d.decision_id}>
              <button
                onClick={() => where && onOpen(where.run)}
                className="flex w-full items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-left text-xs hover:border-gray-900"
              >
                <span className={`w-20 shrink-0 rounded px-1.5 py-0.5 text-center font-medium ${OUTCOME_BADGES[d.outcome].className}`}>{OUTCOME_BADGES[d.outcome].label}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-gray-900">
                    {info ? `${info.title} · step ${(where?.index ?? 0) + 1} of ${where?.run.decisions.length}` : d.invoice_id}
                    {attempt?.simulated && <SimulatedPill text={attempt.simulated} />}
                  </span>
                  <span className="block truncate text-gray-500">
                    {siteName(d.payee_ein)} · {formatMoney(d.amount, d.currency).replace(" (test token, not RLUSD)", "")}
                  </span>
                </span>
                <span className="shrink-0 text-right text-gray-500">{timeOf(d.created_at)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {decisions.length > 25 && (
        <button onClick={() => setAll(!all)} className="mt-2 text-xs text-gray-600 underline">
          {all ? "Show fewer" : `Show all ${decisions.length}`}
        </button>
      )}
    </div>
  );
}

function DecisionDetails({ decision: d }: { decision: Decision }) {
  const enforced = enforcedByLabel(d);
  return (
    <div className="mt-3 space-y-3 text-xs">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-700">
        <dt className="text-gray-500">Stopped by</dt>
        <dd>{enforced ?? "Nothing"}</dd>
        <dt className="text-gray-500">Signed by</dt>
        <dd>{d.signers.join(" + ") || "nobody"}</dd>
        <dt className="text-gray-500">Ledger result</dt>
        <dd className="font-mono">{d.ledger_result ?? "—"}</dd>
        <dt className="text-gray-500">Invoice</dt>
        <dd className="font-mono">{d.invoice_id}</dd>
        <dt className="text-gray-500">Rules version</dt>
        <dd className="font-mono">{d.rule_version}</dd>
        <dt className="text-gray-500">Time</dt>
        <dd>{formatEventTime(d.created_at)}</dd>
      </dl>
      <div>
        <p className="font-semibold text-gray-700">Co-signer checks</p>
        {d.checks.length === 0 ? (
          <p className="mt-1 text-gray-500">The co-signer was never asked.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {d.checks.map((c) => (
              <li key={c.name}>
                <span className={c.passed ? "text-green-700" : "text-red-700"}>{c.passed ? "✓" : "✗"}</span> <span className="font-mono text-gray-800">{c.name}</span>
                <p className="ml-4 text-gray-500">{c.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-semibold text-gray-700">Agent reasoning (off-chain; untrusted invoice text may appear)</p>
        <p className="mt-1 text-gray-600">{d.agent_reasoning}</p>
      </div>
      <p className="break-all font-mono text-[10px] text-gray-400">decision_hash {d.decision_hash}</p>
      {isRealTxHash(d.xrpl_tx_hash) ? (
        <a href={explorerTxUrl(d.xrpl_tx_hash)} target="_blank" rel="noreferrer" className="text-blue-700 underline">
          View the transaction on the XRP Ledger
        </a>
      ) : d.xrpl_tx_hash ? (
        <p className="text-[11px] text-gray-400">Demo transaction id (not on the ledger)</p>
      ) : null}
    </div>
  );
}

// Why a run never reached the ledger, from the runner's last log lines.
function explainFailure(run: DemoRun): string {
  const line = [...run.log_tail].reverse().find((l) => /fail|error|missing|refused/i.test(l)) ?? `The runner exited with code ${run.exit_code ?? "unknown"}.`;
  if (/AGENT_SEED|\.env\.agent/.test(line)) return "This computer doesn't have the XRPL keys (xrpl/.env.agent is missing). Real runs only work on the machine that holds the keys.";
  if (/ECONNREFUSED|:4001|cosigner/i.test(line)) return "The co-signer service isn't running on this computer.";
  if (run.status === "unknown") return "The run didn't report back within 10 minutes.";
  return line;
}

function riskText(r: SiteRisk): string {
  return `${RISK_LABELS[r.level]} (${r.score})`;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
