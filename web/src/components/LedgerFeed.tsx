"use client";

import type { Decision, Site } from "@/lib/contracts";
import { OUTCOME_BADGES, enforcedByLabel, explorerTxUrl, formatEventTime, formatMoney, refusalLabel } from "@/lib/format";
import { isRealTxHash } from "@/lib/openData";
import Link from "next/link";

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

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Live ledger</h2>
        <Link href="/demo" className="text-sm font-medium text-blue-700 underline">
          Live demo →
        </Link>
      </div>

      {decisions.length === 0 ? (
        <p className="text-sm text-gray-500">No decisions yet.</p>
      ) : (
        <ul className="space-y-2">
          {groupRepeats(decisions).map(({ decision: d, count }) => {
            const site = siteFor(d);
            const badge = OUTCOME_BADGES[d.outcome];
            const enforced = enforcedByLabel(d);
            return (
              <li key={d.decision_id} className="rounded-md border border-gray-200 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                  {count > 1 && <span className="text-xs font-medium text-gray-600">×{count} attempts</span>}
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
                {d.outcome === "held_escrow" && (
                  <p className="text-xs text-gray-700">Money set aside for a milestone; released once the delivery is confirmed. Simulated with a test token.</p>
                )}
                <p className="mt-1 text-xs text-gray-500">
                  {count > 1 ? "Latest " : ""}
                  {formatEventTime(d.created_at)} · {d.invoice_id} · signed by {d.signers.join(" + ")}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px]">
                  {/* Only real ledger transactions get a link (fixture hashes would 404 on the explorer). */}
                  {isRealTxHash(d.xrpl_tx_hash) && (
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

      {decisions.length > 0 && <p className="text-[11px] text-gray-500">Repeated attempts in a row are grouped. Every attempt is listed on the open data page.</p>}
    </div>
  );
}

// Collapses back-to-back decisions with the same site, outcome, reason, and amount (e.g. a demo button pressed
// several times) into one row with a count. Newest first, so the shown row is the latest attempt.
export function groupRepeats(decisions: Decision[]): { decision: Decision; count: number }[] {
  const key = (d: Decision) => [d.contract_id, d.outcome, d.refusal_reasons[0] ?? "", d.amount].join("|");
  const out: { decision: Decision; count: number }[] = [];
  for (const d of decisions) {
    const last = out.at(-1);
    if (last && key(last.decision) === key(d)) last.count++;
    else out.push({ decision: d, count: 1 });
  }
  return out;
}
