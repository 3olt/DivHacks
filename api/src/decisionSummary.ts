// GET /decisions/summary (added Sun 06:15): per-site paid / stopped / pending / held totals over EVERY decision since a
// bound (default: the last demo reset), so "Effect on the locations" is complete (GET /decisions is capped). Pure: both
// stores (fixtures, mongo) load sites + decisions and call summarizeDecisions().
import type { DecisionBucket, DecisionBuckets, DecisionSummary, DecisionSummarySite } from "../../shared/contracts";
import { nowNY, toMillis } from "./lib/time";

/** Parsed ?since=: "epoch" (default: the last demo reset), "all", or an ISO timestamp (ms). */
export type SinceQuery = { kind: "epoch" } | { kind: "all" } | { kind: "iso"; ms: number };

export interface SummarySite {
  id: string;
  name: string;
  is_demo_data: boolean;
  contract_ids: string[];
  nonprofit_ein: string;
}

/** The decision fields the summary reads. approved_from: set on an officer-approved execution (mongo: audit.approved_from). */
export interface SummaryDecision {
  decision_id: string;
  contract_id: string;
  payee_ein: string;
  amount: string;
  currency: string;
  outcome: string;
  created_at: string;
  approved_from?: string;
}

const BUCKET_OF: Record<string, keyof DecisionBuckets> = { released: "paid", refused: "stopped", pending_approval: "pending", held_escrow: "held" };

// Exact decimal sums: amounts are decimal strings; add them as integers at 8 decimal places (never floats).
const SCALE = 8;
const UNIT = 10n ** BigInt(SCALE);
function toUnits(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(s).trim());
  if (!m) return null;
  return BigInt(m[1]) * UNIT + BigInt((m[2] ?? "").slice(0, SCALE).padEnd(SCALE, "0"));
}
/** 12.5 -> "12.50", 1.23456 -> "1.23456" (at least 2 decimals, trailing zeros beyond that dropped). */
function fromUnits(u: bigint): string {
  const s = u.toString().padStart(SCALE + 1, "0");
  const frac = s.slice(-SCALE).replace(/0+$/, "").padEnd(2, "0");
  return `${s.slice(0, -SCALE)}.${frac}`;
}

type Acc = Record<keyof DecisionBuckets, { count: number; units: Map<string, bigint> }> & { approved_later: number };
const newAcc = (): Acc => ({
  paid: { count: 0, units: new Map() },
  stopped: { count: 0, units: new Map() },
  pending: { count: 0, units: new Map() },
  held: { count: 0, units: new Map() },
  approved_later: 0,
});
function add(acc: Acc, key: keyof DecisionBuckets, d: SummaryDecision, approved: boolean): void {
  const b = acc[key];
  b.count++;
  const u = toUnits(d.amount);
  if (u !== null) b.units.set(d.currency, (b.units.get(d.currency) ?? 0n) + u);
  if (key === "pending" && approved) acc.approved_later++;
}
function bucket(b: { count: number; units: Map<string, bigint> }): DecisionBucket {
  const amounts: Record<string, string> = {};
  for (const cur of [...b.units.keys()].sort()) amounts[cur] = fromUnits(b.units.get(cur)!);
  return { count: b.count, amounts: amounts as DecisionBucket["amounts"] };
}
function buckets(acc: Acc): DecisionBuckets {
  return { paid: bucket(acc.paid), stopped: bucket(acc.stopped), pending: { ...bucket(acc.pending), approved_later: acc.approved_later }, held: bucket(acc.held) };
}

/**
 * Site assignment = the rule POST /events/payment uses (findSiteForDecision): the site whose contract_ids contain the
 * decision's contract_id, else the site whose nonprofit_ein is the payee_ein (real sites before demo sites, then by id).
 * extraContracts: contract -> site id added on top (mongo: demo_state.golden_contract_id -> golden site, as in the trail).
 */
export function summarizeDecisions(
  sites: SummarySite[],
  decisions: SummaryDecision[],
  opts: { sinceMs: number | null; sinceMode: DecisionSummary["since_mode"]; extraContracts?: Map<string, string> },
): DecisionSummary {
  const ordered = [...sites].sort((a, b) => Number(a.is_demo_data) - Number(b.is_demo_data) || a.id.localeCompare(b.id));
  const byContract = new Map<string, string>();
  const byEin = new Map<string, string>();
  for (const s of ordered) {
    for (const c of s.contract_ids ?? []) if (!byContract.has(c)) byContract.set(c, s.id);
    if (s.nonprofit_ein && !byEin.has(s.nonprofit_ein)) byEin.set(s.nonprofit_ein, s.id);
  }
  for (const [c, id] of opts.extraContracts ?? []) if (!byContract.has(c)) byContract.set(c, id);

  // Pending decisions the officer approved: a released decision names them in approved_from (any time, not only since).
  const approved = new Set(decisions.filter((d) => d.outcome === "released" && typeof d.approved_from === "string").map((d) => d.approved_from!));

  const perSite = new Map<string, Acc>(sites.map((s) => [s.id, newAcc()]));
  const unassigned = newAcc();
  const totals = newAcc();
  for (const d of decisions) {
    const key = BUCKET_OF[d.outcome];
    if (!key) continue;
    if (opts.sinceMs !== null && !(toMillis(d.created_at) >= opts.sinceMs)) continue;
    const siteId = byContract.get(d.contract_id) ?? byEin.get(d.payee_ein);
    const isApproved = approved.has(d.decision_id);
    add((siteId && perSite.get(siteId)) || unassigned, key, d, isApproved);
    add(totals, key, d, isApproved);
  }
  const outSites: DecisionSummarySite[] = [...sites]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({ site_id: s.id, name: s.name, is_demo_data: s.is_demo_data, ...buckets(perSite.get(s.id)!) }));
  return {
    since: opts.sinceMs === null ? null : nowNY(new Date(opts.sinceMs)),
    since_mode: opts.sinceMode,
    generated_at: nowNY(),
    sites: outSites,
    unassigned: buckets(unassigned),
    totals: buckets(totals),
  };
}
