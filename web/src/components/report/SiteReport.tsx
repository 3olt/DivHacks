"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { API_URL, fetchSite, fetchTrail } from "@/lib/api";
import type { Decision, Site, Trail } from "@/lib/contracts";
import { OUTCOME_BADGES, SITE_TYPE_LABELS, enforcedByLabel, formatDate, formatEventTime, formatMoney, nextEvent, refusalLabel } from "@/lib/format";
import { isDemoContract, isFixtureDecision, isRealTxHash } from "@/lib/openData";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import PaceChart from "./PaceChart";

const MiniMap = dynamic(() => import("./MiniMap"), { ssr: false });

// Public datasets for "target vs actual reach" (not in the API yet; see the section below).
const NYC_DATASETS = {
  supplyGap: "https://data.cityofnewyork.us/d/4kc9-zrs2",
  cfc: "https://data.cityofnewyork.us/d/mpqk-skis",
  sites: "https://data.cityofnewyork.us/d/y9si-s7ab",
};

// Score weights, as documented in docs/API.md ("Risk levels"). Display only: the API computes the score.
const SCORE_FACTORS = [
  { name: "Payment pace", max: 40, how: "Share of the contract term elapsed minus share paid" },
  { name: "Contract registration", max: 20, how: "Days the contract was registered after its start date" },
  { name: "Agency lateness", max: 20, how: "The agency's share of contracts registered late (Comptroller)" },
  { name: "Cash cushion", max: 20, how: "Months of cash on hand from the IRS 990 (under 2 = max, over 6 = 0)" },
];

type Health = { mode: "fixtures" | "mongo" };

export default function SiteReport({ id }: { id: string }) {
  const [site, setSite] = useState<Site | null>(null);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [mode, setMode] = useState<Health["mode"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSite(id), fetchTrail(id), fetch(`${API_URL}/health`).then((r) => r.json() as Promise<Health>)])
      .then(([s, t, h]) => {
        if (cancelled) return;
        setSite(s);
        setTrail(t);
        setMode(h.mode);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error && e.message.includes("404") ? "not_found" : "unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <Shell>
        <p className="text-gray-700">
          {error === "not_found" ? "No location with this id." : "Couldn't reach the API. Check that it's running, then reload."}{" "}
          <Link href="/map" className="underline">
            Back to the map
          </Link>
        </p>
      </Shell>
    );
  }
  if (!site || !trail) {
    return (
      <Shell>
        <p className="text-gray-500">Loading report…</p>
      </Shell>
    );
  }

  const contract = trail.contracts[0] ?? null;
  const next = nextEvent(site.events);

  function downloadJson() {
    const blob = new Blob([JSON.stringify({ site, trail, downloaded_at: new Date().toISOString(), api: API_URL }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `glassledger-${site!.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Shell>
      {/* 1. Header + locator map */}
      <header className="grid gap-6 md:grid-cols-[1fr_280px]">
        <div>
          <p className="text-sm text-gray-500">
            {SITE_TYPE_LABELS[site.type] ?? site.type} · {site.borough} {site.zip}
            {site.is_demo_data && <DemoBadge />}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{site.name}</h1>
          <p className="mt-1 text-gray-600">{site.address ?? `${site.borough} ${site.zip}`}</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-sm font-medium">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: RISK_COLORS[site.risk.level] }} />
              {RISK_LABELS[site.risk.level]} · score {site.risk.score}/100
            </span>
            <span className="text-xs text-gray-500">Score computed {formatEventTime(site.risk.computed_at)}</span>
          </div>
          <p className="mt-3 text-gray-800">{site.risk.summary}</p>
          {next && (
            <p className="mt-2 text-sm text-gray-600">
              Next event: <span className="font-medium text-gray-900">{next.title}</span> · {formatEventTime(next.starts_at)}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <Link href={`/map?site=${site.id}`} className="rounded-md bg-gray-900 px-3 py-1.5 font-medium text-white">
              Open on the map
            </Link>
            <Link href="/data" className="rounded-md border border-gray-300 px-3 py-1.5 font-medium text-gray-800 hover:border-gray-900">
              All records (open data)
            </Link>
            <button onClick={downloadJson} className="rounded-md border border-gray-300 px-3 py-1.5 font-medium text-gray-800 hover:border-gray-900">
              Download this report&apos;s data (JSON)
            </button>
          </div>
        </div>
        <div>
          <div className="h-52 overflow-hidden rounded-xl border border-gray-200">
            <MiniMap site={site} />
          </div>
          <p className="mt-1 text-[10px] text-gray-400">Map © OpenStreetMap contributors</p>
        </div>
      </header>

      {/* 2. Money on pace */}
      <Section title="Is the money on pace?" subtitle={contract ? `${contract.purpose ?? contract.contract_id} · ${contract.start_date} to ${contract.end_date}` : undefined}>
        {contract ? <PaceChart contract={contract} payments={trail.payments} /> : <p className="text-sm text-gray-500">No contract on file for this location.</p>}
      </Section>

      {/* 3. Score */}
      <Section title="How the financial status rating was calculated" subtitle="A fixed, explainable formula over the site's funding: no machine learning, and not a prediction of whether an event will happen. The same inputs always give the same score.">
        <ScoreMeter score={site.risk.score} />
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold">What drives this score</h3>
            <ul className="mt-2 space-y-1 text-sm text-gray-700">
              {site.risk.reasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <span className="text-gray-400">•</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold">The formula (0–100)</h3>
            <table className="mt-2 w-full text-left text-sm">
              <tbody>
                {SCORE_FACTORS.map((f) => (
                  <tr key={f.name} className="border-b border-gray-100 align-top">
                    <td className="py-1.5 pr-3 font-medium text-gray-900">{f.name}</td>
                    <td className="py-1.5 pr-3 text-gray-600">{f.how}</td>
                    <td className="py-1.5 text-right tabular-nums text-gray-900">up to {f.max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* PLACEHOLDER: per-factor points need `risk.components` from the API; render them here as a stacked bar when available. */}
            <p className="mt-2 text-xs text-gray-500">Per-factor points will show here once the API publishes them.</p>
          </div>
        </div>
      </Section>

      {/* 4. Target vs actual reach (people) */}
      <Section title="Target vs. actual reach" subtitle="How much help this neighborhood needs vs. how many people are actually being served.">
        {/* PLACEHOLDER: waiting on backend fields (neighborhood need + people served / site capacity). */}
        <div className="grid gap-3 sm:grid-cols-2">
          <PendingTile
            label="Neighborhood need"
            detail="Food supply gap (lbs of food needed but not available) and % food insecure for this neighborhood."
            source="Emergency Food Supply Gap (NYC Open Data)"
            href={NYC_DATASETS.supplyGap}
          />
          <PendingTile
            label="People actually served"
            detail="Individuals served and site capacity, to compare against the need."
            source="Community Food Connection reports + Verified Locations: Sites (NYC Open Data)"
            href={NYC_DATASETS.cfc}
            href2={NYC_DATASETS.sites}
          />
        </div>
      </Section>

      {/* 5. Provenance */}
      <Section title="Where this data came from and how it was processed" subtitle={mode === "fixtures" ? "The API is in fixture mode: records below are demo data until the real public records load." : undefined}>
        <ol className="relative ml-2 border-l-2 border-gray-200">
          {contract && (
            <PipelineStep
              title="City contract"
              detail={`${formatMoney(contract.amount)} contract ${contract.contract_id}, ${contract.registered_date ? `registered ${formatDate(contract.registered_date)}` : "not registered yet"}.`}
              source={contract.source}
              href={contract.source_url}
              demo={isDemoContract(contract)}
            />
          )}
          <PipelineStep
            title="City payments"
            detail={`${trail.payments.filter((p) => p.source === "checkbook").length} payments from ${trail.agency.name}, latest ${lastDate(trail.payments.filter((p) => p.source === "checkbook"))}.`}
            source="Checkbook NYC"
            href={contract?.source_url ?? "https://www.checkbooknyc.com/"}
            demo={trail.payments.some((p) => p.source === "checkbook" && p.is_demo_data)}
          />
          <PipelineStep
            title="Agency track record"
            detail={
              trail.agency.pct_contracts_registered_late != null
                ? `${trail.agency.code} registered ${Math.round(trail.agency.pct_contracts_registered_late * 100)}% of FY${trail.agency.fiscal_year} contracts late (avg ${trail.agency.avg_days_registered_late} days).`
                : "No lateness data for this agency."
            }
            source={trail.agency.source}
            href={trail.agency.source_url}
            demo={trail.agency.is_demo_data}
          />
          <PipelineStep
            title="Nonprofit finances"
            detail={
              trail.nonprofit.financials
                ? `${trail.nonprofit.name}: ${trail.nonprofit.financials.cash_months} months of cash, ${formatMoney(trail.nonprofit.financials.revenue)} revenue (FY${trail.nonprofit.financials.fiscal_year}).`
                : `${trail.nonprofit.name}: no IRS 990 on file.`
            }
            source="IRS Form 990 via ProPublica"
            href={trail.nonprofit.financials?.source_url ?? "https://projects.propublica.org/nonprofits/"}
            demo={site.is_demo_data}
          />
          <PipelineStep
            title="Risk score"
            detail={`Scored ${site.risk.score}/100 (${site.risk.level}) on ${formatEventTime(site.risk.computed_at)} from the steps above, using the fixed formula shown earlier.`}
            source="GlassLedger risk formula (data/risk.py)"
            demo={mode === "fixtures"}
          />
          <PipelineStep
            title="Payment agent on the XRP Ledger"
            detail={`${trail.decisions.length} payment decisions. Each one is checked by an independent co-signer (8 checks) and needs 2 of 3 signing keys; the ledger rejects the agent acting alone.`}
            source="XRP Ledger Testnet"
            href="https://testnet.xrpl.org/"
            demo={trail.decisions.some(isFixtureDecision)}
          />
        </ol>
      </Section>

      {/* 6. Verify */}
      <Section title="Verify it yourself" subtitle="Every agent decision has a fingerprint (SHA-256 hash). The payment's on-ledger memo commits to it, so an edited record wouldn't match.">
        {trail.decisions.length === 0 ? (
          <p className="text-sm text-gray-500">No agent decisions for this location yet.</p>
        ) : (
          <ul className="space-y-2">
            {trail.decisions.map((d) => (
              <DecisionAudit key={d.decision_id} decision={d} memoHash={d.xrpl_tx_hash ? trail.payments.find((p) => p.xrpl_tx_hash === d.xrpl_tx_hash)?.memo_hash : undefined} />
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-gray-500">
          How to check a fingerprint: take the decision record without its <code>decision_hash</code>, sort all keys, remove whitespace, and SHA-256 it
          (the code is in <code>shared/hash.ts</code>). The result must equal <code>decision_hash</code>, and for payments that reached the ledger, the memo&apos;s{" "}
          <code>dh</code> field.
        </p>
      </Section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="viz-root min-h-dvh bg-white text-gray-900">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className="font-semibold">
          GlassLedger
        </Link>
        <div className="flex gap-4 text-sm">
          <Link href="/map" className="text-gray-700 hover:text-gray-900">
            Map
          </Link>
          <Link href="/data" className="text-gray-700 hover:text-gray-900">
            Open data
          </Link>
        </div>
      </nav>
      <main className="mx-auto max-w-5xl space-y-10 px-4 pb-16 pt-4 sm:px-6">{children}</main>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-gray-200 pt-6">
      <h2 className="text-xl font-bold">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-gray-600">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ScoreMeter({ score }: { score: number }) {
  // Bands: green 0-39, yellow 40-69, red 70-100 (docs/API.md).
  const bands = [
    { from: 0, to: 40, color: RISK_COLORS.green },
    { from: 40, to: 70, color: RISK_COLORS.yellow },
    { from: 70, to: 100, color: RISK_COLORS.red },
  ];
  return (
    <div>
      <div className="relative h-3 w-full">
        <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded">
          {bands.map((b) => (
            <div key={b.from} className="h-full opacity-30" style={{ width: `${b.to - b.from}%`, background: b.color }} />
          ))}
        </div>
        <div className="absolute -top-1 h-5 w-1 rounded bg-gray-900" style={{ left: `calc(${Math.min(100, Math.max(0, score))}% - 2px)` }} aria-hidden />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-gray-500">
        <span>0 · stable</span>
        <span>40 · strained</span>
        <span>70 · critical</span>
        <span>100</span>
      </div>
      <p className="mt-1 text-sm">
        Score <strong>{score}</strong> / 100
      </p>
    </div>
  );
}

function PendingTile({ label, detail, source, href, href2 }: { label: string; detail: string; source: string; href: string; href2?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 p-4">
      <p className="text-sm font-semibold text-gray-900">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-300">Data pending</p>
      <p className="mt-2 text-sm text-gray-600">{detail}</p>
      <p className="mt-2 text-xs text-gray-500">
        Source:{" "}
        <a href={href} target="_blank" rel="noreferrer" className="underline">
          {source}
        </a>
        {href2 && (
          <>
            {" · "}
            <a href={href2} target="_blank" rel="noreferrer" className="underline">
              sites dataset
            </a>
          </>
        )}
      </p>
    </div>
  );
}

function PipelineStep({ title, detail, source, href, demo }: { title: string; detail: string; source: string; href?: string; demo?: boolean }) {
  return (
    <li className="mb-5 ml-5 last:mb-0">
      <span className="absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-gray-900" />
      <p className="text-sm font-semibold">
        {title}
        {demo && <DemoBadge />}
      </p>
      <p className="text-sm text-gray-700">{detail}</p>
      <p className="text-xs text-gray-500">
        Source:{" "}
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="underline">
            {source}
          </a>
        ) : (
          source
        )}
      </p>
    </li>
  );
}

function DecisionAudit({ decision: d, memoHash }: { decision: Decision; memoHash?: string }) {
  const badge = OUTCOME_BADGES[d.outcome];
  const enforced = enforcedByLabel(d);
  const passed = d.checks.filter((c) => c.passed).length;
  return (
    <li className="rounded-lg border border-gray-200 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
        <span className="font-mono text-xs text-gray-600">{d.invoice_id}</span>
        <span className="text-xs text-gray-500">{formatEventTime(d.created_at)}</span>
        {isFixtureDecision(d) && <DemoBadge />}
        <span className="ml-auto font-medium">{formatMoney(d.amount, d.currency)}</span>
      </div>
      {d.refusal_reasons.length > 0 && <p className="mt-1 text-xs font-medium text-red-700">{refusalLabel(d.refusal_reasons[0])}</p>}
      {enforced && <p className="text-xs text-gray-700">{enforced}</p>}
      <p className="mt-1 text-xs text-gray-600">
        Co-signer checks passed: {passed}/{d.checks.length} · signed by {d.signers.join(" + ")} · rules {d.rule_version}
      </p>
      <dl className="mt-2 grid gap-1 font-mono text-[11px] text-gray-500">
        <div className="break-all">decision_hash {d.decision_hash}</div>
        {memoHash && <div className="break-all">memo_hash {memoHash}</div>}
      </dl>
      {isRealTxHash(d.xrpl_tx_hash) ? (
        <a href={`https://testnet.xrpl.org/transactions/${d.xrpl_tx_hash}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-blue-700 underline">
          View the transaction on the XRP Ledger
        </a>
      ) : d.xrpl_tx_hash ? (
        <p className="mt-1 text-[11px] text-gray-400">Demo transaction id (not on the ledger)</p>
      ) : null}
    </li>
  );
}

function DemoBadge() {
  return <span className="ml-1.5 rounded bg-gray-100 px-1 text-[10px] font-normal text-gray-500">demo</span>;
}

function lastDate(payments: { date: string }[]): string {
  const last = [...payments].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  return last ? formatDate(last.date) : "none";
}
