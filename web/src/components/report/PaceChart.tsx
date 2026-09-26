"use client";

import { useMemo, useRef, useState } from "react";
import type { Contract, Payment } from "@/lib/contracts";
import { formatDate, formatMoney } from "@/lib/format";

// "Is the money on pace?" Cumulative city payments (USD) vs the straight-line pace the contract needs
// to be fully paid by its end date. Agent (XRPL) payments are testnet RLUSD, so they sit on their own
// strip under the time axis instead of being added to the USD line.
const W = 640;
const H = 280;
const PAD = { top: 16, right: 16, bottom: 56, left: 64 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const DAY = 86_400_000;

// Date-only strings parse at noon local so they land on the right day.
const t = (d: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d).getTime();

export default function PaceChart({ contract, payments }: { contract: Contract; payments: Payment[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [now] = useState(() => Date.now()); // "today", fixed for this view

  const model = useMemo(() => {
    const start = t(contract.start_date);
    const end = t(contract.end_date);
    const total = Number(contract.amount);
    const city = payments
      .filter((p) => p.source === "checkbook" && p.status === "released" && p.contract_id === contract.contract_id)
      .sort((a, b) => t(a.date) - t(b.date));
    const steps = city.reduce<{ at: number; total: number; payment: Payment }[]>(
      (acc, p) => [...acc, { at: t(p.date), total: (acc.at(-1)?.total ?? 0) + Number(p.amount), payment: p }],
      [],
    );
    const agent = payments.filter((p) => p.source === "xrpl" && p.contract_id === contract.contract_id);
    const x = (ms: number) => PAD.left + ((ms - start) / (end - start)) * PLOT_W;
    const y = (v: number) => PAD.top + PLOT_H - (v / total) * PLOT_H;
    const expectedAt = (ms: number) => total * Math.min(1, Math.max(0, (ms - start) / (end - start)));
    const paidAt = (ms: number) => steps.filter((s) => s.at <= ms).at(-1)?.total ?? 0;
    return { start, end, total, steps, agent, x, y, expectedAt, paidAt };
  }, [contract, payments]);

  const { start, end, total, steps, agent, x, y, expectedAt, paidAt } = model;
  const nowClamped = Math.min(Math.max(now, start), end);

  // Step path for cumulative paid, drawn up to today.
  let path = `M${x(start)},${y(0)}`;
  for (const s of steps) path += ` H${x(s.at)} V${y(s.total)}`;
  path += ` H${x(nowClamped)}`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * total);
  const years: number[] = [];
  for (let yr = new Date(start).getFullYear() + 1; new Date(`${yr}-01-01T12:00:00`).getTime() < end; yr++) years.push(yr);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const ms = start + ((px - PAD.left) / PLOT_W) * (end - start);
    setHoverT(ms < start || ms > end ? null : Math.round(ms / DAY) * DAY);
  }

  const hover = hoverT === null ? null : { at: hoverT, expected: expectedAt(hoverT), paid: hoverT <= now ? paidAt(hoverT) : null };
  const paidNow = paidAt(now);
  const expectedNow = expectedAt(now);

  return (
    <figure className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-700" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-5 rounded" style={{ background: "var(--series-1)" }} />
          Paid by the city (cumulative, USD)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-5 border-t-2 border-dashed border-gray-400" />
          On-pace target
        </span>
        {agent.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--series-2)" }} />
            Agent payment attempts (testnet RLUSD, not to scale)
          </span>
        )}
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full touch-none select-none"
          role="img"
          aria-label={`Paid ${formatMoney(paidNow)} of ${formatMoney(total)} so far; on pace would be ${formatMoney(expectedNow)} by today.`}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverT(null)}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="#e5e7eb" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle" className="fill-gray-500 text-[11px]">
                {formatMoney(v)}
              </text>
            </g>
          ))}
          {years.map((yr) => {
            const at = new Date(`${yr}-01-01T12:00:00`).getTime();
            return (
              <text key={yr} x={x(at)} y={PAD.top + PLOT_H + 16} textAnchor="middle" className="fill-gray-500 text-[11px]">
                {yr}
              </text>
            );
          })}
          <text x={x(start)} y={PAD.top + PLOT_H + 16} textAnchor="start" className="fill-gray-500 text-[11px]">
            start
          </text>
          <text x={x(end)} y={PAD.top + PLOT_H + 16} textAnchor="end" className="fill-gray-500 text-[11px]">
            end
          </text>

          {/* On-pace target: straight line from $0 at start to the full amount at end. */}
          <line x1={x(start)} y1={y(0)} x2={x(end)} y2={y(total)} stroke="#9ca3af" strokeWidth={2} strokeDasharray="6 5" />

          {/* Paid so far */}
          <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
          <circle cx={x(nowClamped)} cy={y(paidNow)} r={4} fill="var(--series-1)" stroke="#fff" strokeWidth={2} />

          {/* Today */}
          {now >= start && now <= end && (
            <g>
              <line x1={x(now)} x2={x(now)} y1={PAD.top} y2={PAD.top + PLOT_H} stroke="#111827" strokeWidth={1} strokeDasharray="2 3" />
              <text x={x(now) + 4} y={PAD.top + 10} className="fill-gray-700 text-[11px]">
                today
              </text>
            </g>
          )}

          {/* Agent payment strip (not on the USD scale) */}
          {agent.map((p) => (
            <circle
              key={p.payment_id}
              cx={x(Math.min(Math.max(t(p.date), start), end))}
              cy={PAD.top + PLOT_H + 34}
              r={5}
              fill={p.status === "released" ? "var(--series-2)" : "#fff"}
              stroke="var(--series-2)"
              strokeWidth={2}
            >
              <title>{`${formatDate(p.date)} · ${formatMoney(p.amount, p.currency)} · ${p.status.replace("_", " ")}`}</title>
            </circle>
          ))}

          {/* Hover crosshair */}
          {hover && (
            <g pointerEvents="none">
              <line x1={x(hover.at)} x2={x(hover.at)} y1={PAD.top} y2={PAD.top + PLOT_H} stroke="#6b7280" strokeWidth={1} />
              <circle cx={x(hover.at)} cy={y(hover.expected)} r={4} fill="#9ca3af" stroke="#fff" strokeWidth={2} />
              {hover.paid !== null && <circle cx={x(hover.at)} cy={y(hover.paid)} r={4} fill="var(--series-1)" stroke="#fff" strokeWidth={2} />}
            </g>
          )}
        </svg>

        {hover && (
          <div
            className="pointer-events-none absolute top-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs shadow-md"
            style={{ left: `${(x(hover.at) / W) * 100}%`, transform: x(hover.at) > W / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
          >
            <p className="font-medium text-gray-900">{new Date(hover.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
            <p className="text-gray-700">On-pace target: {formatMoney(hover.expected)}</p>
            <p className="text-gray-700">{hover.paid === null ? "Paid: (future)" : `Paid: ${formatMoney(hover.paid)}`}</p>
          </div>
        )}
      </div>

      <figcaption className="text-sm text-gray-700">
        By today the contract should have paid about <strong>{formatMoney(expectedNow)}</strong> to stay on pace; the city has paid{" "}
        <strong>{formatMoney(paidNow)}</strong> ({Math.round((paidNow / total) * 100)}% of {formatMoney(total)}).
      </figcaption>

      <details className="text-xs text-gray-600">
        <summary className="cursor-pointer">Show as a table</summary>
        <table className="mt-2 w-full text-left">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500">
              <th className="py-1 font-medium">Date</th>
              <th className="py-1 font-medium">Payment</th>
              <th className="py-1 font-medium">Paid to date</th>
              <th className="py-1 font-medium">On-pace target</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.payment.payment_id} className="border-b border-gray-100">
                <td className="py-1">{formatDate(s.payment.date)}</td>
                <td className="py-1">{formatMoney(s.payment.amount)}</td>
                <td className="py-1">{formatMoney(s.total)}</td>
                <td className="py-1">{formatMoney(expectedAt(s.at))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
