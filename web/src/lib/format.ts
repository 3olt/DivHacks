import type { Decision, RefusalCode, SiteType } from "./contracts";

export const SITE_TYPE_LABELS: Record<SiteType, string> = {
  food_pantry: "Food pantry",
  grocery_giveaway: "Grocery giveaway",
  shelter: "Shelter",
  youth_program: "Youth program",
  event: "Community event",
};

// Full timestamps (events, XRPL payments, decisions).
export function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Date-only "YYYY-MM-DD" fields: parse at noon so New York doesn't show the previous day.
export function formatDate(value: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Decimal strings from the API. USD shows as "$1,234"; RLUSD/XRP as "1,250.00 RLUSD".
export function formatMoney(amount: string | number, currency: string = "USD"): string {
  const n = Number(amount);
  if (currency === "USD") return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export const REFUSAL_LABELS: Record<RefusalCode, string> = {
  credential_invalid: "Wallet has no valid City credential",
  destination_not_registry_wallet: "Not the nonprofit's registered wallet",
  invoice_already_paid: "Duplicate: invoice already paid",
  contract_amount_exceeded: "Would exceed the contract amount",
  over_auto_limit_needs_officer: "Over the auto-pay limit: needs officer approval",
  daily_cap_exceeded_agent: "Agent's 24-hour limit reached",
  daily_cap_exceeded_payee: "Payee's 24-hour limit reached",
  payee_excluded: "Payee is on the exclusion list",
  bad_source_tag: "Wrong transaction source tag",
  bad_memo: "Missing or malformed payment memo",
  bad_currency: "Wrong currency or issuer",
  payee_change_on_hold: "Wallet change on 72-hour hold",
  suspicious_instructions_in_invoice: "Invoice contained hidden instructions (prompt injection)",
  verifier_rejected: "AI verifier rejected the invoice",
  ledger_rejected: "Rejected by the XRP Ledger itself",
};

export const refusalLabel = (code: string) => REFUSAL_LABELS[code as RefusalCode] ?? code;

export const OUTCOME_BADGES: Record<Decision["outcome"], { label: string; className: string }> = {
  released: { label: "Paid", className: "bg-green-100 text-green-800" },
  pending_approval: { label: "Needs approval", className: "bg-amber-100 text-amber-800" },
  refused: { label: "Blocked", className: "bg-red-100 text-red-800" },
  held_escrow: { label: "In escrow (simulated)", className: "bg-blue-100 text-blue-800" },
};

export function enforcedByLabel(d: Decision): string | null {
  switch (d.enforced_by) {
    case "cosigner":
      return "Stopped by the compliance co-signer";
    case "ledger":
      return `Stopped by the XRP Ledger${d.ledger_result ? ` (${d.ledger_result})` : ""}`;
    case "hold":
      return "Stopped by the 72-hour wallet-change hold";
    default:
      return null;
  }
}

export const explorerTxUrl = (hash: string) => `https://testnet.xrpl.org/transactions/${hash}`;
