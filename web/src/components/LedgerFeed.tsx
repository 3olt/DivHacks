"use client";

import type { Decision, Site } from "@/lib/contracts";
import { OUTCOME_BADGES, enforcedByLabel, explorerTxUrl, formatEventTime, formatMoney, refusalLabel } from "@/lib/format";
import DemoControls from "./DemoControls";

// Public, live list of every payment decision the agent made: the transparency view.
export default function LedgerFeed({
  decisions,
  sites,
  onOpenSite,
}: {
  decisions: Decision[];
  sites: Site[];
  onOpenSite: (id: string) => void;
}) {
  const siteFor = (d: Decision) => sites.find((s) => s.contract_ids.includes(d.contract_id)) ?? sites.find((s) => s.nonprofit_ein === d.payee_ein);
  const paid = decisions.filter((d) => d.outcome === "released");
  const blocked = decisions.filter((d) => d.outcome === "refused").length;
  const pending = decisions.filter((d) => d.outcome === "pending_approval").length;
  const released = paid.reduce((sum, d) => sum + Number(d.amount), 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Live ledger</h2>
        <p className="text-sm text-gray-600">Every payment the AI agent tried to make, whether it went through, and what stopped it. Updates live.</p>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Paid" value={`${paid.length}`} sub={formatMoney(released, "RLUSD")} />
        <Stat label="Blocked" value={`${blocked}`} />
        <Stat label="Needs approval" value={`${pending}`} />
      </dl>

      <DemoControls />

      {decisions.length === 0 ? (
        <p className="text-sm text-gray-500">No decisions yet.</p>
      ) : (
        <ul className="space-y-2">
          {decisions.map((d) => {
            const site = siteFor(d);
            const badge = OUTCOME_BADGES[d.outcome];
            const enforced = enforcedByLabel(d);
            return (
              <li key={d.decision_id} className="rounded-md border border-gray-200 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                  <span className="ml-auto font-medium text-gray-900">{formatMoney(d.amount, d.currency)}</span>
                </div>
                {site ? (
                  <button onClick={() => onOpenSite(site.id)} className="mt-1 text-left text-sm font-medium text-gray-900 underline decoration-gray-300 hover:decoration-gray-900">
                    {site.name}
                  </button>
                ) : (
                  <p className="mt-1 text-sm text-gray-900">EIN {d.payee_ein}</p>
                )}
                {d.refusal_reasons.length > 0 && <p className="text-xs font-medium text-red-700">{refusalLabel(d.refusal_reasons[0])}</p>}
                {enforced && <p className="text-xs text-gray-700">{enforced}</p>}
                <p className="mt-1 text-xs text-gray-500">
                  {formatEventTime(d.created_at)} · {d.invoice_id} · signed by {d.signers.join(" + ")}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px]">
                  {d.xrpl_tx_hash && (
                    <a href={explorerTxUrl(d.xrpl_tx_hash)} target="_blank" rel="noreferrer" className="text-blue-700 underline">
                      View on XRPL
                    </a>
                  )}
                  <span className="font-mono text-gray-400" title={d.decision_hash}>
                    audit hash {d.decision_hash.slice(0, 12)}…
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md bg-gray-50 p-2">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-lg font-semibold text-gray-900">{value}</dd>
      {sub && <dd className="text-[10px] text-gray-500">{sub}</dd>}
    </div>
  );
}
