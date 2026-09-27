"use client";

import Link from "next/link";
import { useState } from "react";
import type { Contract, Decision, Payment, Site, Trail } from "@/lib/contracts";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import { OUTCOME_BADGES, enforcedByLabel, formatDate, formatEventTime, formatMoney, nextEvent, refusalLabel } from "@/lib/format";
import TextUs from "./TextUs";

export default function SitePanel({
  site,
  trail,
  trailError,
  onClose,
}: {
  site: Site;
  trail: Trail | null;
  trailError: boolean;
  onClose: () => void;
}) {
  const next = nextEvent(site.events);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-gray-200 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{site.name}</h2>
            <p className="text-sm text-gray-500">{site.address ?? `${site.borough} ${site.zip}`}</p>
            <Link href={`/sites/${site.id}`} className="mt-1 inline-block text-sm font-medium text-blue-700 underline">
              Full report: charts, sources, and how to verify →
            </Link>
          </div>
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-900" aria-label="Close">
            ✕
          </button>
        </div>
        {next && (
          <p className="mt-3 text-sm text-gray-700">
            <span className="font-medium">{next.title}</span> · {formatEventTime(next.starts_at)}
            {next.is_demo_data && <DemoBadge />}
          </p>
        )}
      </div>

      <Section title="Funding status">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: RISK_COLORS[site.risk.level] }} />
          <span className="font-medium text-gray-900">{RISK_LABELS[site.risk.level]}</span>
          <span className="ml-auto text-xs text-gray-500">score {site.risk.score}/100</span>
        </div>
        <p className="mt-2 text-sm text-gray-700">{site.risk.summary}</p>
        <ul className="mt-2 list-disc pl-5 text-xs text-gray-600">
          {site.risk.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Section>

      {!trail ? (
        <Section title="Money trail">
          <p className="text-sm text-gray-500">{trailError ? "Couldn't load the money trail. Check that the API is running, then reopen this location." : "Loading…"}</p>
        </Section>
      ) : (
        <>
          <Section title="Money trail">
            <MoneyTrail trail={trail} />
          </Section>

          <Section title="Nonprofit">
            <Nonprofit trail={trail} />
          </Section>

          <Section title="Payment agent (XRPL)">
            {trail.decisions.length === 0 ? (
              <Placeholder text="No agent payments for this location yet." />
            ) : (
              <ul className="space-y-2">
                {trail.decisions.map((d) => (
                  <DecisionRow key={d.decision_id} decision={d} />
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <Section title="What to know before you go">
        {/* Placeholder: hours, what to bring, eligibility requirements, languages spoken. */}
        <Placeholder text="Hours, what to bring, and eligibility requirements coming soon." />
      </Section>

      <Section title="iMessage alerts">
        <TextUs siteName={site.name} />
      </Section>
    </div>
  );
}

function MoneyTrail({ trail }: { trail: Trail }) {
  const { agency } = trail;
  return (
    <ol className="relative ml-2 border-l-2 border-gray-200">
      <Step label="NYC agency">
        <p className="text-sm font-medium text-gray-900">{agency.name}</p>
        {agency.pct_contracts_registered_late != null && (
          <p className="text-xs text-gray-600">
            Registered {Math.round(agency.pct_contracts_registered_late * 100)}% of FY{agency.fiscal_year} contracts late
            {agency.avg_days_registered_late != null && ` (avg ${agency.avg_days_registered_late} days)`}
          </p>
        )}
        <SourceLink href={agency.source_url} label="Comptroller" />
      </Step>
      {trail.contracts.map((c) => (
        <Step key={c.contract_id} label="Contract">
          <ContractInfo contract={c} />
        </Step>
      ))}
      <Step label="Payments">
        {trail.payments.length === 0 ? (
          <p className="text-xs text-gray-500">No payments recorded.</p>
        ) : (
          <ul className="space-y-1">
            {trail.payments.map((p) => (
              <PaymentRow key={p.payment_id} payment={p} />
            ))}
          </ul>
        )}
      </Step>
      <Step label="Nonprofit">
        <p className="text-sm font-medium text-gray-900">{trail.nonprofit.name}</p>
      </Step>
    </ol>
  );
}

function ContractInfo({ contract: c }: { contract: Contract }) {
  return (
    <>
      <p className="text-sm font-medium text-gray-900">{c.purpose ?? c.contract_id}</p>
      <p className="font-mono text-[11px] text-gray-500">{c.contract_id}</p>
      <p className="text-xs text-gray-600">
        {formatMoney(c.spent_to_date)} of {formatMoney(c.amount)} spent · {c.start_date} to {c.end_date}
      </p>
      <p className="text-xs text-gray-600">{c.registered_date ? `Registered ${formatDate(c.registered_date)}` : "Not registered"}</p>
      <SourceLink href={c.source_url} label="Checkbook NYC" />
    </>
  );
}

function PaymentRow({ payment: p }: { payment: Payment }) {
  const isXrpl = p.source === "xrpl";
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span className="w-20 shrink-0 text-gray-500">{formatDate(p.date)}</span>
      <span className={p.status === "refused" ? "text-gray-400 line-through" : "text-gray-900"}>{formatMoney(p.amount, p.currency)}</span>
      <span className="text-gray-500">{isXrpl ? "XRPL agent" : "City payment"}</span>
      {p.status !== "released" && <span className="text-gray-500">({p.status.replace("_", " ")})</span>}
      {p.explorer_url && (
        <a href={p.explorer_url} target="_blank" rel="noreferrer" className="ml-auto text-blue-700 underline">
          tx
        </a>
      )}
    </li>
  );
}

function Nonprofit({ trail }: { trail: Trail }) {
  const np = trail.nonprofit;
  const f = np.financials;
  const w = np.wallet;
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-gray-900">{np.name}</p>
      {f ? (
        <>
          <dl className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Cash on hand" value={`${f.cash_months} mo`} />
            <Stat label="Revenue" value={formatMoney(f.revenue)} />
            <Stat label="Net assets" value={formatMoney(f.net_assets)} />
          </dl>
          <SourceLink href={f.source_url} label={`IRS 990, FY${f.fiscal_year} (ProPublica)`} />
        </>
      ) : (
        <p className="text-xs text-gray-500">No IRS 990 on file.</p>
      )}
      <div className="text-xs text-gray-600">
        <span>XRPL wallet: </span>
        {!w ? (
          <span className="text-gray-500">none registered</span>
        ) : (
          <>
            <span className="font-mono">{w.address.slice(0, 10)}…</span>{" "}
            {w.credential_status === "valid" && (
              <span className="text-green-700">✓ verified{w.credential_expires ? ` until ${formatDate(w.credential_expires)}` : ""}</span>
            )}
            {w.credential_status === "expired" && <span className="text-red-700">credential expired</span>}
            {w.credential_status === "none" && <span className="text-yellow-700">not verified</span>}
            <span className="text-gray-500"> · bank {w.bank_verified ? "verified" : "not verified"} (Nessie)</span>
          </>
        )}
      </div>
    </div>
  );
}

function DecisionRow({ decision: d }: { decision: Decision }) {
  const [open, setOpen] = useState(false);
  const badge = OUTCOME_BADGES[d.outcome];
  const enforced = enforcedByLabel(d);
  return (
    <li className="rounded-md border border-gray-200 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
        <span className="font-mono text-xs text-gray-600">{d.invoice_id}</span>
        <span className="ml-auto font-medium text-gray-900">{formatMoney(d.amount, d.currency)}</span>
      </div>
      {d.refusal_reasons.length > 0 && <p className="mt-1 text-xs font-medium text-red-700">{refusalLabel(d.refusal_reasons[0])}</p>}
      {enforced && <p className="mt-0.5 text-xs text-gray-700">{enforced}</p>}
      <p className="mt-1 text-xs text-gray-500">
        {formatEventTime(d.created_at)} · signed by {d.signers.join(" + ")}
      </p>
      <button onClick={() => setOpen(!open)} className="mt-1 text-xs text-gray-600 underline">
        {open ? "Hide audit" : "Show audit"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <ul className="space-y-1">
            {d.checks.map((c) => (
              <li key={c.name} className="text-xs">
                <span className={c.passed ? "text-green-700" : "text-red-700"}>{c.passed ? "✓" : "✗"}</span>{" "}
                <span className="font-mono text-gray-800">{c.name}</span>
                <p className="ml-4 text-gray-500">{c.detail}</p>
              </li>
            ))}
          </ul>
          {/* Untrusted invoice text can appear here: render as plain text only. */}
          <p className="text-xs text-gray-600">{d.agent_reasoning}</p>
          <p className="break-all font-mono text-[10px] text-gray-400">decision hash {d.decision_hash}</p>
        </div>
      )}
    </li>
  );
}

function Step({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="mb-3 ml-4 last:mb-0">
      <span className="absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-gray-400" />
      <p className="text-xs text-gray-500">{label}</p>
      {children}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-gray-200 p-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-gray-50 p-2">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-sm font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

function SourceLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-[11px] text-blue-700 underline">
      Source: {label}
    </a>
  );
}

function DemoBadge() {
  return <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-500">demo</span>;
}

function Placeholder({ text }: { text: string }) {
  return <div className="rounded-md border border-dashed border-gray-300 p-3 text-xs text-gray-500">{text}</div>;
}
