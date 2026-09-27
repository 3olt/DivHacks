"use client";

import Link from "next/link";
import type { Contract, Payment, Site, Trail } from "@/lib/contracts";
import { isDemoContract } from "@/lib/openData";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import { formatDate, formatEventTime, formatMoney, nextEvent } from "@/lib/format";
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
            <Nonprofit trail={trail} demo={site.is_demo_data} />
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

// The main map shows real public records only: XRPL agent payments (test money) are left out here and shown on /demo.
function MoneyTrail({ trail }: { trail: Trail }) {
  const { agency } = trail;
  const payments = trail.payments.filter((p) => p.source !== "xrpl");
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
        <SourceLink href={agency.source_url} label="Comptroller" demo={agency.is_demo_data} />
      </Step>
      {trail.contracts.map((c) => (
        <Step key={c.contract_id} label="Contract">
          <ContractInfo contract={c} />
        </Step>
      ))}
      <Step label="Payments">
        {payments.length === 0 ? (
          <p className="text-xs text-gray-500">No payments recorded.</p>
        ) : (
          <ul className="space-y-1">
            {payments.map((p) => (
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
        {/* null = payment data not loaded for this contract (not $0). */}
        {c.spent_to_date === null ? `${formatMoney(c.amount)} contract · payment data not loaded yet` : `${formatMoney(c.spent_to_date)} of ${formatMoney(c.amount)} spent`} ·{" "}
        {c.start_date} to {c.end_date}
      </p>
      <p className="text-xs text-gray-600">{c.registered_date ? `Registered ${formatDate(c.registered_date)}` : "Not registered"}</p>
      <SourceLink href={c.source_url} label="Checkbook NYC" demo={isDemoContract(c)} />
    </>
  );
}

function PaymentRow({ payment: p }: { payment: Payment }) {
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span className="w-20 shrink-0 text-gray-500">{formatDate(p.date)}</span>
      <span className={p.status === "refused" ? "text-gray-400 line-through" : "text-gray-900"}>{formatMoney(p.amount, p.currency)}</span>
      <span className="text-gray-500">City payment</span>
      {p.status !== "released" && <span className="text-gray-500">({p.status.replace("_", " ")})</span>}
      {p.explorer_url && (
        <a href={p.explorer_url} target="_blank" rel="noreferrer" className="ml-auto text-blue-700 underline">
          tx
        </a>
      )}
    </li>
  );
}

function Nonprofit({ trail, demo }: { trail: Trail; demo: boolean }) {
  const np = trail.nonprofit;
  const f = np.financials;
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
          <SourceLink href={f.source_url} label={`IRS 990, FY${f.fiscal_year} (ProPublica)`} demo={demo} />
        </>
      ) : (
        <p className="text-xs text-gray-500">No IRS 990 on file.</p>
      )}
    </div>
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

function SourceLink({ href, label, demo }: { href: string; label: string; demo?: boolean }) {
  return (
    <p className="text-[11px]">
      <a href={href} target="_blank" rel="noreferrer" className="text-blue-700 underline">
        Source: {label}
      </a>
      {demo && <DemoBadge />}
    </p>
  );
}

function DemoBadge() {
  return <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-500">demo</span>;
}

function Placeholder({ text }: { text: string }) {
  return <div className="rounded-md border border-dashed border-gray-300 p-3 text-xs text-gray-500">{text}</div>;
}
