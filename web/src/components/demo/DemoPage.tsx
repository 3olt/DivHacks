"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { API_URL, DEMO_SCENARIOS, fetchDecisions, fetchDemoRun, fetchSites, resetDemo, runDemo, type DemoScenario } from "@/lib/api";
import type { Decision, Site } from "@/lib/contracts";
import { OUTCOME_BADGES, enforcedByLabel, explorerTxUrl, formatEventTime, formatMoney } from "@/lib/format";
import { connectLive } from "@/lib/live";
import { isRealTxHash } from "@/lib/openData";
import { decisionPipeline, type StepStatus } from "@/lib/pipeline";

const MapView = dynamic(() => import("../MapView"), { ssr: false });

// What each scenario demonstrates (docs/API.md "Demo scenarios"). In mongo mode these are real XRPL Testnet runs.
const SCENARIOS: Record<DemoScenario, { title: string; shows: string }> = {
  happy: { title: "Pay a verified invoice", shows: "Pays Food Bank For NYC (the golden site) autonomously: agent + co-signer, no human. Its pin moves." },
  injection: { title: "Prompt-injected invoice", shows: "Three layers: Grok flags it; a tricked agent is refused by the co-signer; the agent alone is rejected by the ledger (tefBAD_QUORUM)." },
  duplicate: { title: "Duplicate invoice", shows: "The same invoice again. The co-signer finds it in the ledger's history." },
  "over-contract": { title: "Over contract amount", shows: "Invoice A is paid; invoice B would pass the contract budget and is refused." },
  uncredentialed: { title: "Unverified wallet", shows: "A nonprofit whose wallet has no City credential on the ledger. Refused. (Testnet only)" },
  "address-swap": { title: "Wallet-change scam", shows: "\"We changed our wallet.\" Payments are held for 72 hours until an officer resolves it." },
  "over-limit": { title: "Over auto-pay limit", shows: "Above the auto-pay limit: waits for a human officer, then pays with 3 signatures." },
  "kill-switch": { title: "Revoke the agent's key", shows: "The agent's key is revoked; the ledger rejects its payment. Then the key is restored." },
  escrow: { title: "Milestone escrow (simulated)", shows: "Money locked in a city test token (not RLUSD); released only after the report is verified and an officer approves. (Testnet only)" },
};

const STEP_STYLE: Record<StepStatus, { icon: string; className: string }> = {
  pass: { icon: "✓", className: "border-green-300 bg-green-50 text-green-800" },
  fail: { icon: "✗", className: "border-red-300 bg-red-50 text-red-800" },
  wait: { icon: "…", className: "border-amber-300 bg-amber-50 text-amber-800" },
  skip: { icon: "–", className: "border-gray-200 bg-gray-50 text-gray-400" },
};

export default function DemoPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [mode, setMode] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // decision_id shown in "Latest run"
  const [running, setRunning] = useState<DemoScenario | "reset" | null>(null);
  // A real Testnet run (mongo mode) keeps going after the POST returns; buttons stay locked until it finishes.
  const [activeRun, setActiveRun] = useState<{ run_id: string; scenario: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Initial load + live updates (pins recolor on site_updated; new decisions appear and become the latest run).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [s, d, h] = await Promise.all([fetchSites(), fetchDecisions(50), fetch(`${API_URL}/health`).then((r) => r.json())]);
        if (cancelled) return;
        setSites(s);
        setDecisions(d);
        setMode(h.mode);
        if (h.demo_run && h.demo_run.status === "running") setActiveRun({ run_id: h.demo_run.run_id, scenario: h.demo_run.scenario });
      } catch {
        if (!cancelled) setError("Can't reach the API. Is it running on :4000?");
      }
    }
    load();
    const stop = connectLive((msg) => {
      if (msg.type === "hello") load();
      else if (msg.type === "site_updated") setSites((s) => s.map((x) => (x.id === msg.site_id ? { ...x, risk: msg.risk } : x)));
      else if (msg.type === "decision") {
        setDecisions((f) => [msg.decision, ...f.filter((d) => d.decision_id !== msg.decision.decision_id)]);
        setSelected(msg.decision.decision_id);
      } else if (msg.type === "demo_run") {
        if (msg.status === "running") setActiveRun({ run_id: msg.run_id, scenario: msg.scenario });
        else {
          setActiveRun((r) => (r?.run_id === msg.run_id ? null : r));
          setNotice(`Run "${msg.scenario}" ${msg.status}.`);
        }
      }
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  // Fallback if a demo_run message is missed: poll the run until it has a final status.
  useEffect(() => {
    if (!activeRun) return;
    const t = setInterval(async () => {
      const r = await fetchDemoRun(activeRun.run_id).catch(() => null);
      if (r && r.status !== "running") setActiveRun(null);
    }, 5000);
    return () => clearInterval(t);
  }, [activeRun]);

  async function run(action: DemoScenario | "reset") {
    setRunning(action);
    setError("");
    setNotice("");
    try {
      if (action === "reset") {
        const r = await resetDemo();
        if (!r.ok) {
          setError(r.message ?? "Reset failed");
          return;
        }
        // The reset doesn't "un-broadcast" removed decisions (docs/API.md), so refetch.
        const [s, d] = await Promise.all([fetchSites(), fetchDecisions(50)]);
        setSites(s);
        setDecisions(d);
        setSelected(null);
      } else {
        const r = await runDemo(action);
        if (!r.ok) {
          if (r.error === "run_in_progress" && r.run_id) setActiveRun({ run_id: r.run_id, scenario: "another scenario" });
          setError(r.error === "run_in_progress" ? "A run is already going. Wait for it to finish." : r.error === "testnet_only" ? "This scenario only runs on XRPL Testnet (the API is in fixture mode)." : r.message);
        } else if (r.run_id) {
          setActiveRun({ run_id: r.run_id, scenario: action });
          setNotice(`Running "${SCENARIOS[action].title}" on XRPL Testnet. Decisions appear below as they happen (about 20 s to 2 min).`);
        } else if (r.message) setNotice(r.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setRunning(null);
    }
  }

  const siteFor = (d: Decision) => sites.find((s) => s.contract_ids.includes(d.contract_id)) ?? sites.find((s) => s.nonprofit_ein === d.payee_ein);
  const latest = decisions.find((d) => d.decision_id === selected) ?? decisions[0] ?? null;
  const latestSite = latest ? siteFor(latest) : undefined;

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

      <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-[1fr_520px]">
        <div className="space-y-4">
          <div className="h-[40dvh] overflow-hidden rounded-xl border border-gray-200 lg:h-[calc(100dvh-8rem)]">
            <MapView sites={sites} selectedId={latestSite?.id ?? null} onSelect={() => {}} onPopupChange={() => {}} onDismiss={() => setSelected(null)} />
          </div>
        </div>

        <div className="space-y-6">
          <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
            <strong>This is the agent playground.</strong> The four &quot;(demo)&quot; nonprofits exist only here: fictional organizations with Testnet wallets,
            so the agent has someone to pay and to block. Food Bank For NYC is a real organization with a demo wallet; paying it moves its pin on the main map.
          </p>
          <p className="rounded-md bg-gray-50 p-3 text-xs text-gray-600">
            Each payment needs <strong>3 signature weights</strong> on the XRP Ledger: agent 1 + independent co-signer 2 (officer 1 for large payments). The agent
            can&apos;t pay alone.{" "}
            {mode === "mongo"
              ? "Buttons run real transactions on the XRP Ledger Testnet (test money, no value); each run spends a little of the demo budget."
              : "The API is in fixture mode: these runs are simulated decisions."}
          </p>

          {/* Scenario buttons */}
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Run a scenario</h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {DEMO_SCENARIOS.map((s) => (
                <button
                  key={s}
                  onClick={() => run(s)}
                  disabled={running !== null || activeRun !== null}
                  className="rounded-lg border border-gray-200 p-3 text-left hover:border-gray-900 disabled:opacity-50"
                >
                  <p className="text-sm font-semibold">{running === s || activeRun?.scenario === s ? "Running…" : SCENARIOS[s].title}</p>
                  <p className="mt-0.5 text-xs text-gray-600">{SCENARIOS[s].shows}</p>
                </button>
              ))}
            </div>
            <button onClick={() => run("reset")} disabled={running !== null || activeRun !== null} className="mt-2 text-xs text-gray-600 underline disabled:opacity-50">
              {running === "reset" ? "Resetting…" : "Reset demo data"}
            </button>
            {activeRun && <p className="mt-2 text-xs text-amber-700">A Testnet run is in progress ({activeRun.scenario}); buttons unlock when it finishes.</p>}
            {notice && <p className="mt-2 text-xs text-gray-700">{notice}</p>}
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          </section>

          {/* Pipeline of the latest (or selected) run */}
          {latest && (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{selected ? "Selected run" : "Latest run"}</h2>
              <div className="mt-2 rounded-xl border border-gray-200 p-4">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${OUTCOME_BADGES[latest.outcome].className}`}>{OUTCOME_BADGES[latest.outcome].label}</span>
                  <span className="text-sm font-medium">{latestSite?.name ?? `EIN ${latest.payee_ein}`}</span>
                  <span className="ml-auto text-sm font-medium">{formatMoney(latest.amount, latest.currency)}</span>
                </div>
                <ol className="mt-3 space-y-1.5">
                  {decisionPipeline(latest).map((step, i) => (
                    <li key={step.name} className={`flex gap-3 rounded-md border px-3 py-2 text-sm ${STEP_STYLE[step.status].className}`}>
                      <span className="w-4 shrink-0 font-bold">{STEP_STYLE[step.status].icon}</span>
                      <span className="w-44 shrink-0 font-medium">
                        {i + 1}. {step.name}
                      </span>
                      <span className="text-xs leading-5">{step.detail}</span>
                    </li>
                  ))}
                </ol>
                <DecisionDetails decision={latest} />
              </div>
            </section>
          )}

          {/* Full technical ledger */}
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">All agent decisions</h2>
            <ul className="mt-2 space-y-1">
              {decisions.map((d) => {
                const steps = decisionPipeline(d);
                return (
                  <li key={d.decision_id}>
                    <button
                      onClick={() => setSelected(d.decision_id)}
                      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs hover:border-gray-900 ${d.decision_id === latest?.decision_id ? "border-gray-900" : "border-gray-200"}`}
                    >
                      <span className={`rounded px-1.5 py-0.5 font-medium ${OUTCOME_BADGES[d.outcome].className}`}>{OUTCOME_BADGES[d.outcome].label}</span>
                      <span className="truncate font-medium">{siteFor(d)?.name ?? d.payee_ein}</span>
                      <span className="ml-auto flex shrink-0 gap-0.5" aria-label="pipeline">
                        {steps.map((s) => (
                          <span key={s.name} title={`${s.name}: ${s.detail}`} className={`h-2.5 w-2.5 rounded-full border ${STEP_STYLE[s.status].className}`} />
                        ))}
                      </span>
                      <span className="w-20 shrink-0 text-right text-gray-500">{formatEventTime(d.created_at).split(", ").slice(-1)[0]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function DecisionDetails({ decision: d }: { decision: Decision }) {
  const enforced = enforcedByLabel(d);
  return (
    <div className="mt-4 space-y-3 text-xs">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-700">
        <dt className="text-gray-500">Stopped by</dt>
        <dd>{enforced ?? "Nothing (paid)"}</dd>
        <dt className="text-gray-500">Signed by</dt>
        <dd>{d.signers.join(" + ")}</dd>
        <dt className="text-gray-500">Ledger result</dt>
        <dd className="font-mono">{d.ledger_result ?? "—"}</dd>
        <dt className="text-gray-500">Rules version</dt>
        <dd className="font-mono">{d.rule_version}</dd>
        <dt className="text-gray-500">Source tag</dt>
        <dd className="font-mono">{d.source_tag}</dd>
        <dt className="text-gray-500">Time</dt>
        <dd>{formatEventTime(d.created_at)}</dd>
      </dl>
      <div>
        <p className="font-semibold text-gray-700">Co-signer checks</p>
        <ul className="mt-1 space-y-1">
          {d.checks.map((c) => (
            <li key={c.name}>
              <span className={c.passed ? "text-green-700" : "text-red-700"}>{c.passed ? "✓" : "✗"}</span> <span className="font-mono text-gray-800">{c.name}</span>
              <p className="ml-4 text-gray-500">{c.detail}</p>
            </li>
          ))}
        </ul>
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
