"use client";

import type { Contract, Payment, SiteDetail } from "@/lib/types";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";
import { formatEventTime } from "@/lib/format";
import FollowSiteButton from "./FollowSiteButton";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const XRPL_TESTNET_TX = "https://testnet.xrpl.org/transactions/";

export default function SitePanel({ detail, onClose, onNeedSignup }: { detail: SiteDetail; onClose: () => void; onNeedSignup: () => void }) {
  const { site, nonprofit, contracts, payments } = detail;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-gray-200 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{site.name}</h2>
            <p className="text-sm text-gray-500">{site.address}</p>
          </div>
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-900" aria-label="Close">
            ✕
          </button>
        </div>
        {site.next_event && (
          <p className="mt-3 text-sm text-gray-700">
            <span className="font-medium">{site.next_event.title}</span> ·{" "}
            {formatEventTime(site.next_event.starts_at)}
          </p>
        )}
      </div>

      <Section title="Funding status">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: RISK_COLORS[site.risk.level] }} />
          <span className="font-medium text-gray-900">{RISK_LABELS[site.risk.level]}</span>
          <span className="ml-auto text-xs text-gray-500">risk {site.risk.score}/100</span>
        </div>
        <ul className="mt-2 list-disc pl-5 text-sm text-gray-700">
          {site.risk.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Section>

      <Section title="Money trail">
        {contracts.length === 0 && <p className="text-sm text-gray-500">No contracts found.</p>}
        {contracts.map((c) => (
          <Trail key={c.contract_id} contract={c} nonprofitName={nonprofit?.name ?? site.name} />
        ))}
      </Section>

      {nonprofit && (
        <Section title="Nonprofit finances">
          <dl className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Cash reserves" value={`${nonprofit.cash_reserve_months} mo`} />
            <Stat label="To programs" value={`${nonprofit.program_expense_pct}%`} />
            <Stat label="Revenue" value={usd(nonprofit.annual_revenue_usd)} />
          </dl>
          <p className="mt-3 text-xs text-gray-600">
            XRPL wallet:{" "}
            {nonprofit.xrpl_wallet ? (
              <>
                <span className="font-mono">{nonprofit.xrpl_wallet.slice(0, 10)}…</span>{" "}
                <span className="text-green-700">✓ verified until {nonprofit.credential_valid_until}</span>
              </>
            ) : (
              <span className="text-yellow-700">not verified</span>
            )}
          </p>
        </Section>
      )}

      <Section title="Payments (XRPL agent)">
        {/* Filled by the XRPL agent via POST /api/payments. Placeholder until it is connected. */}
        {payments.length === 0 && <Placeholder text="No payments yet. Verified XRPL payments from the agent will appear here." />}
        <ul className="space-y-2">
          {[...payments].reverse().map((p) => (
            <PaymentRow key={p.invoice_id} payment={p} />
          ))}
        </ul>
      </Section>

      <Section title="What to know before you go">
        {/* Placeholder: hours, what to bring, eligibility requirements, languages spoken. */}
        <Placeholder text="Hours, what to bring, and eligibility requirements coming soon." />
      </Section>

      <Section title="iMessage alerts">
        <FollowSiteButton siteId={site.id} onNeedSignup={onNeedSignup} />
      </Section>
    </div>
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

function Placeholder({ text }: { text: string }) {
  return <div className="rounded-md border border-dashed border-gray-300 p-3 text-xs text-gray-500">{text}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-gray-50 p-2">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-sm font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

function Trail({ contract: c, nonprofitName }: { contract: Contract; nonprofitName: string }) {
  const steps = [
    { label: "NYC agency", value: c.agency, note: `avg ${c.agency_avg_days_late} days late` },
    { label: "Contract", value: `${c.contract_id} · ${c.purpose}`, note: `${usd(c.paid_to_date_usd)} of ${usd(c.value_usd)} paid · ${c.registered ? "registered" : "not registered"}` },
    { label: "Nonprofit", value: nonprofitName, note: c.days_payment_late > 0 ? `${c.days_payment_late} days behind` : "paid on time" },
  ];
  return (
    <ol className="relative ml-2 border-l-2 border-gray-200">
      {steps.map((s) => (
        <li key={s.label} className="mb-3 ml-4 last:mb-0">
          <span className="absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-gray-400" />
          <p className="text-xs text-gray-500">{s.label}</p>
          <p className="text-sm font-medium text-gray-900">{s.value}</p>
          <p className="text-xs text-gray-600">{s.note}</p>
        </li>
      ))}
    </ol>
  );
}

function PaymentRow({ payment: p }: { payment: Payment }) {
  const badge = {
    released: "bg-green-100 text-green-800",
    held_escrow: "bg-yellow-100 text-yellow-800",
    refused: "bg-red-100 text-red-800",
  }[p.status];
  return (
    <li className="rounded-md border border-gray-200 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${badge}`}>{p.status.replace("_", " ")}</span>
        <span className="font-mono text-xs text-gray-600">{p.invoice_id}</span>
        <span className="ml-auto font-medium text-gray-900">{p.amount_xrp} XRP</span>
      </div>
      {p.refusal_reason && <p className="mt-1 text-xs text-red-700">{p.refusal_reason}</p>}
      <p className="mt-1 text-xs text-gray-600">{p.agent_reasoning}</p>
      {p.xrpl_tx_hash && (
        <a href={XRPL_TESTNET_TX + p.xrpl_tx_hash} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-blue-700 underline">
          View on XRPL testnet
        </a>
      )}
    </li>
  );
}
