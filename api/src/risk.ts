// Fixture risk engine: deterministic, explainable, 0-100. Modeled on the planned Phase 4 score
// (data/risk.py will be the source of truth once real data lands):
//   payment pace         40  fraction of contract term elapsed minus fraction paid (a 50-point gap = max)
//   registration         20  unregistered past start: 20 * days/90 (cap 20); registered late: 10 * days/90 (cap 10)
//   agency lateness      20  20 * share of the agency's contracts registered late
//   cash cushion         20  months of cash: < 2 = 20, > 6 = 0, linear in between; no 990 on file = 10
// Levels: green < 40, yellow 40-69, red >= 70. Every score ships with reasons[] that carry the numbers.
import type { AgencyStats, Contract, Nonprofit, RiskLevel, Site } from "../../shared/contracts";
import { daysBetween } from "./lib/time";

export type Risk = Site["risk"];

/** Fixture scores are computed "as of" this date so numbers are reproducible. */
export const RISK_AS_OF_DATE = "2026-09-26";
export const RISK_FIXTURE_COMPUTED_AT = "2026-09-26T09:00:00-04:00";

/** Same labels as web/src/lib/risk.ts RISK_LABELS. */
export const RISK_LABELS: Record<RiskLevel, string> = {
  // Financial status rating (renamed from delay wording on 2026-09-26; see context.md "Financial status rating").
  green: "Financially stable",
  yellow: "Financially strained",
  red: "Financially critical",
};

export function levelForScore(score: number): RiskLevel {
  if (score >= 70) return "red";
  if (score >= 40) return "yellow";
  return "green";
}

export interface RiskInputs {
  /** The site's primary contract (site.contract_ids[0]). */
  contract: Contract;
  /** Paid toward that contract: Checkbook spent_to_date + released XRPL RLUSD (demo sites only). */
  paid: number;
  nonprofit: Nonprofit | null;
  agency: AgencyStats | null;
  asOfDate?: string;
}

/** A released XRPL payment that just landed: drops the payment-pace points (the invoice is paid, payments are current). */
export interface ReleaseInfo {
  amount: number;
  invoice_id: string;
  /** "today" or "on 2026-09-20" */
  when: string;
}

interface Component {
  points: number;
  reason: string;
  /** Good-news facts preferred in green summaries. */
  positive?: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
}

function paceComponent(inp: RiskInputs, asOf: string): Component {
  const { contract, paid } = inp;
  const term = Math.max(1, daysBetween(contract.start_date, contract.end_date));
  const elapsed = clamp(daysBetween(contract.start_date, asOf) / term, 0, 1);
  const amount = Number(contract.amount);
  const paidFrac = amount > 0 ? clamp(paid / amount, 0, 1) : 0;
  const gap = elapsed - paidFrac;
  return {
    points: Math.round(40 * clamp(gap / 0.5, 0, 1)),
    reason: `${pct(elapsed)} of contract term elapsed, ${pct(paidFrac)} paid`,
    positive: gap <= 0.05,
  };
}

function registrationComponent(contract: Contract, asOf: string): Component {
  if (!contract.registered_date) {
    const days = daysBetween(contract.start_date, asOf);
    if (days <= 0) return { points: 0, reason: `Contract starts ${contract.start_date}; not yet registered`, positive: true };
    return {
      points: Math.min(20, Math.round((20 * days) / 90)),
      reason: `Contract started ${contract.start_date}, still unregistered (${days} days)`,
    };
  }
  const late = daysBetween(contract.start_date, contract.registered_date);
  if (late <= 0) return { points: 0, reason: `Contract registered on time (${contract.registered_date})`, positive: true };
  return {
    points: Math.min(10, Math.round((10 * late) / 90)),
    reason: `Contract registered ${late} days after its ${contract.start_date} start`,
  };
}

function agencyComponent(agency: AgencyStats | null, code: string): Component {
  if (!agency || agency.pct_contracts_registered_late == null) {
    return { points: 10, reason: `No lateness data for agency ${code}` };
  }
  const fy = agency.fiscal_year ? ` of FY${agency.fiscal_year}` : "";
  const avg = agency.avg_days_registered_late != null ? ` (avg ${agency.avg_days_registered_late} days)` : "";
  return {
    points: Math.round(20 * agency.pct_contracts_registered_late),
    reason: `${agency.code} registered ${pct(agency.pct_contracts_registered_late)}${fy} contracts late${avg}`,
  };
}

function cashComponent(nonprofit: Nonprofit | null): Component {
  const f = nonprofit?.financials;
  if (!f) return { points: 10, reason: "No IRS 990 on file; cash cushion unknown" };
  const m = f.cash_months;
  const points = m < 2 ? 20 : m > 6 ? 0 : Math.round((20 * (6 - m)) / 4);
  return { points, reason: `${m.toFixed(1)} months of cash on hand (FY${f.fiscal_year} 990)`, positive: m >= 4 };
}

const wordCount = (s: string) => s.trim().split(/\s+/).length;

/** "Contract registered..." -> "contract registered..." but keep acronyms ("HRA", "RLUSD"). */
const midSentence = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function buildSummary(level: RiskLevel, rawFacts: string[]): string {
  const label = RISK_LABELS[level];
  const facts = rawFacts.map(midSentence);
  const two = `${label}: ${facts[0]}; ${facts[1]}.`;
  if (facts.length >= 2 && wordCount(two) <= 25) return two;
  const one = `${label}: ${facts[0]}.`;
  if (wordCount(one) <= 25) return one;
  return `${label}.`;
}

/** Compute a site's risk from its primary contract, nonprofit and agency. Pure and deterministic. */
export function computeRisk(inp: RiskInputs, computedAt: string, release?: ReleaseInfo): Risk {
  const asOf = inp.asOfDate ?? RISK_AS_OF_DATE;
  const pace = paceComponent(inp, asOf);
  const others: Component[] = [
    registrationComponent(inp.contract, asOf),
    agencyComponent(inp.agency, inp.contract.agency_code),
    cashComponent(inp.nonprofit),
  ];

  if (release) {
    const amount = Number(inp.contract.amount);
    const paidFrac = amount > 0 ? clamp(inp.paid / amount, 0, 1) : 0;
    const lead = [
      `RLUSD ${formatMoney(release.amount)} released on XRPL ${release.when} (demo)`,
      `Invoice ${release.invoice_id} paid; payments now current (${pct(paidFrac)} of contract paid)`,
    ];
    const rest = [...others].sort((a, b) => b.points - a.points);
    const score = rest.reduce((s, c) => s + c.points, 0);
    const level = levelForScore(score);
    const reasons = [...lead, ...rest.map((c) => c.reason)];
    // Green: lead with the payment. Still yellow/red: the payment plus the biggest remaining driver, so the
    // summary never reads "Financially strained: ... payments now current" without the remaining driver.
    const facts = level === "green" ? lead : [lead[0], ...rest.map((c) => c.reason)];
    return { level, score, reasons, summary: buildSummary(level, facts), computed_at: computedAt };
  }

  const all = [pace, ...others];
  const score = Math.min(100, all.reduce((s, c) => s + c.points, 0));
  const level = levelForScore(score);
  const sorted = [...all].sort((a, b) => b.points - a.points);
  const reasons = sorted.map((c) => c.reason);
  // Green summaries lead with the good news (pace/registration); yellow/red with the biggest drivers.
  const facts =
    level === "green"
      ? [...all.filter((c) => c.positive), ...sorted.filter((c) => !c.positive)].map((c) => c.reason)
      : reasons;
  return { level, score, reasons, summary: buildSummary(level, facts), computed_at: computedAt };
}

/** Deterministic risk for POST /dev/flip: a score in the middle of the requested band. */
export function devFlipRisk(level: RiskLevel, computedAt: string): Risk {
  const score = level === "green" ? 20 : level === "yellow" ? 55 : 85;
  // Carries the score so that, like every other risk, the reason has a number in it.
  const reason = `Manually set to ${level} (score ${score}) for testing (dev flip)`;
  return { level, score, reasons: [reason], summary: `${RISK_LABELS[level]}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`, computed_at: computedAt };
}
