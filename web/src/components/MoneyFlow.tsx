"use client";

import Link from "next/link";
import type { Site, Trail } from "@/lib/contracts";
import { formatMoney } from "@/lib/format";
import { RISK_COLORS, RISK_LABELS } from "@/lib/risk";

// Government -> nonprofit money flow for the real organizations on the map: who funds each one, how much was
// promised (contracts), and how much was actually paid where payment records are loaded. From GET /sites/:id/trail.
export default function MoneyFlow({
  sites,
  trails,
  onOpenSite,
}: {
  sites: Site[];
  trails: Record<string, Trail>;
  onOpenSite: (id: string) => void;
}) {
  const rows = sites
    .map((site) => ({ site, flow: flowFor(trails[site.id]) }))
    .sort((a, b) => b.site.risk.score - a.site.risk.score);

  const promised = rows.reduce((sum, r) => sum + (r.flow?.promised ?? 0), 0);
  const withPaid = rows.filter((r) => r.flow?.paid !== null && r.flow?.paid !== undefined);
  const paid = withPaid.reduce((sum, r) => sum + (r.flow?.paid ?? 0), 0);
  const paidOf = withPaid.reduce((sum, r) => sum + (r.flow?.paidOfPromised ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Money flow</h2>
        <Link href="/demo" className="text-sm font-medium text-blue-700 underline">
          Live demo →
        </Link>
      </div>
      <p className="text-xs text-gray-600">
        City money promised to these {sites.length} nonprofits: <strong>{formatMoney(promised)}</strong>. Where payment records are loaded ({withPaid.length} of{" "}
        {sites.length}), <strong>{formatMoney(paid)}</strong> of {formatMoney(paidOf)} has been paid.
      </p>

      <ul className="space-y-2">
        {rows.map(({ site, flow }) => (
          <li key={site.id}>
            <button onClick={() => onOpenSite(site.id)} className="w-full rounded-md border border-gray-200 p-3 text-left text-sm hover:border-gray-900">
              <div className="flex items-start gap-2">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: RISK_COLORS[site.risk.level] }} title={RISK_LABELS[site.risk.level]} />
                <p className="text-gray-900">
                  <span className="text-gray-500">{flow?.agency ?? "City agency"} → </span>
                  <span className="font-medium">{site.name}</span>
                </p>
              </div>
              {!flow ? (
                <p className="mt-1 pl-4 text-xs text-gray-500">Loading…</p>
              ) : (
                <div className="mt-1 space-y-1 pl-4">
                  {flow.paid === null ? (
                    <p className="text-xs text-gray-600">
                      {formatMoney(flow.promised)} promised · <span className="text-gray-500">payment data not loaded yet</span>
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-gray-600">
                        {formatMoney(flow.paidOfPromised)} promised · <strong className="text-gray-900">{formatMoney(flow.paid)} paid</strong> (
                        {Math.round((flow.paid / flow.paidOfPromised) * 100)}%)
                        {flow.paidOfPromised < flow.promised && <span className="text-gray-500"> on the contracts with records</span>}
                      </p>
                      <div className="h-1.5 w-full overflow-hidden rounded bg-gray-100">
                        <div className="h-full rounded" style={{ width: `${Math.min(100, (flow.paid / flow.paidOfPromised) * 100)}%`, background: "var(--series-1)" }} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-gray-500">
        Contracts and payments from NYC Comptroller and Checkbook NYC. Click a row for its full money trail and sources. The AI payment agent (XRPL Testnet) is on the live demo.
      </p>
    </div>
  );
}

// Totals across a site's contracts. `spent_to_date: null` = not loaded (never counted as $0).
function flowFor(trail: Trail | undefined) {
  if (!trail) return null;
  const promised = trail.contracts.reduce((sum, c) => sum + Number(c.amount), 0);
  const loaded = trail.contracts.filter((c) => c.spent_to_date !== null);
  return {
    agency: trail.agency.name,
    promised,
    paid: loaded.length ? loaded.reduce((sum, c) => sum + Number(c.spent_to_date), 0) : null,
    paidOfPromised: loaded.reduce((sum, c) => sum + Number(c.amount), 0),
  };
}
