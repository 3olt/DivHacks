// Shared data contracts between api/, xrpl/, data/ (via Mongo) and web/.
// The contract for the frontend is docs/API.md. Change a shape here only together with docs/API.md.

export type Currency = "RLUSD" | "XRP";
export type RiskLevel = "green" | "yellow" | "red";
export type SiteType = "food_pantry" | "grocery_giveaway" | "shelter" | "youth_program" | "event";

export interface Site {
  id: string;
  name: string;
  type: SiteType;
  // GeoJSON order: [lng, lat] (MongoDB 2dsphere)
  location: { type: "Point"; coordinates: [number, number] };
  /** Extension (not in the original spec): street address shown in the site panel. */
  address?: string;
  borough: string;
  zip: string;
  nonprofit_ein: string;
  agency_code: "HRA" | "DHS" | "DYCD" | string;
  contract_ids: string[];
  events: { title: string; starts_at: string; is_demo_data: boolean }[];
  risk: { level: RiskLevel; score: number; reasons: string[]; summary: string; computed_at: string };
  is_demo_data: boolean;
}

export interface Nonprofit {
  ein: string;
  name: string;
  address: string;
  service_types: string[];
  financials?: { fiscal_year: number; revenue: number; expenses: number; net_assets: number; cash_months: number; source_url: string };
  wallet?: { address: string; credential_status: "valid" | "expired" | "none"; credential_expires?: string; bank_verified: boolean };
}

export interface Contract {
  contract_id: string;
  agency_code: string;
  nonprofit_ein: string;
  amount: string;
  start_date: string;
  end_date: string;
  registered_date: string | null;
  spent_to_date: string;
  /** Extension (not in the original spec): Checkbook NYC "purpose" text. */
  purpose?: string;
  source: string;
  source_url: string;
}

export interface Invoice {
  invoice_id: string;
  contract_id: string;
  payee_ein: string;
  amount: string;
  currency: Currency;
  period: { from: string; to: string };
  description: string;
  proof?: { kind: "text" | "image" | "pdf"; ref: string };
  submitted_via: "seed" | "web" | "imessage";
  created_at: string;
  is_demo_data: boolean;
}

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Decision {
  decision_id: string;
  invoice_id: string;
  contract_id: string;
  payee_ein: string;
  amount: string;
  currency: Currency;
  outcome: "released" | "held_escrow" | "pending_approval" | "refused";
  refusal_reasons: string[];
  checks: Check[];
  enforced_by: "cosigner" | "ledger" | "hold" | null;
  agent_reasoning: string /* off-chain only */;
  decision_hash: string;
  rule_version: string;
  xrpl_tx_hash: string | null;
  ledger_result: string | null;
  signers: string[];
  source_tag: number;
  created_at: string;
}

export interface Payment {
  payment_id: string;
  source: "checkbook" | "xrpl";
  contract_id: string;
  payee_ein: string;
  amount: string;
  currency: Currency | "USD";
  date: string;
  status: "released" | "held_escrow" | "pending_approval" | "refused";
  invoice_id?: string;
  xrpl_tx_hash?: string;
  explorer_url?: string;
  memo_hash?: string;
  is_demo_data: boolean;
}

export interface Subscriber {
  phone: string;
  zip: string;
  interests: string[];
  site_ids: string[];
  opted_in_at: string;
  channel: "imessage" | "web";
}

// ---------------------------------------------------------------------------
// Additions for the API surface (not in the original type list; documented in docs/API.md)
// ---------------------------------------------------------------------------

/** Agency-level lateness figures (Comptroller data). Served by GET /agencies/:code/stats. */
export interface AgencyStats {
  code: string;
  name: string;
  /** Share of this agency's human-service contracts registered after their start date. */
  pct_contracts_registered_late: number | null;
  /** Average days a contract was registered after its start date. */
  avg_days_registered_late: number | null;
  fiscal_year: number | null;
  source: string;
  source_url: string;
  is_demo_data: boolean;
}

/** GET /sites/:id/trail: agency -> contracts -> payments -> nonprofit, plus the agent's decisions. */
export interface Trail {
  site_id: string;
  agency: AgencyStats;
  contracts: Contract[];
  /** Checkbook + XRPL payments, oldest first. */
  payments: Payment[];
  nonprofit: Nonprofit;
  /** Newest first. */
  decisions: Decision[];
}

/** Messages on WS /live. Clients must ignore unknown `type`s. */
export type LiveMessage =
  | { type: "hello"; mode: "fixtures" | "mongo"; server_time: string }
  | { type: "site_updated"; site_id: string; risk: Site["risk"] }
  | { type: "decision"; decision: Decision };

/** The co-signer's independent checks (Phase 2). `Check.name` uses these ids. */
export const CHECK_NAMES = [
  "credential_valid",
  "destination_is_registry_wallet",
  "invoice_not_already_paid",
  "within_contract_amount",
  "within_auto_limit_or_officer_signed",
  "within_daily_caps",
  "payee_not_excluded",
  "tx_format_valid",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** Machine-readable values for `Decision.refusal_reasons`. */
export const REFUSAL_CODES = [
  "credential_invalid",
  "destination_not_registry_wallet",
  "invoice_already_paid",
  "contract_amount_exceeded",
  "over_auto_limit_needs_officer",
  "daily_cap_exceeded_agent",
  "daily_cap_exceeded_payee",
  "payee_excluded",
  "bad_source_tag",
  "bad_memo",
  "bad_currency",
  "payee_change_on_hold",
  "suspicious_instructions_in_invoice",
  "verifier_rejected",
  "ledger_rejected",
  // Added in Phase 2 (additive; see docs/API.md refusal code table):
  /** The tx carries fields outside the co-signer's whitelist, non-zero Flags, a bad Fee, or bad/unknown signatures. */
  "bad_tx_fields",
  /** Sequence is not the agent account's current one, LastLedgerSequence is outside the window, or a co-signature for it is still live. */
  "tx_not_fresh",
  /** The co-signer could not be reached, timed out, or could not read the ledger / registry, so it signed nothing. */
  "cosigner_unavailable",
  /** The AI invoice verifier timed out, errored or returned unparseable output (fail closed: nothing built). */
  "verifier_unavailable",
  /** The registry in the database changed since the co-signer pinned it at startup (possible tampering). */
  "registry_drift",
  /** The invoice's contract is not in the contracts collection. */
  "contract_not_found",
  // Added by the Phase 2 fixes (additive):
  /** Today is outside the contract's start_date..end_date. */
  "contract_not_active",
  /** The payment was submitted but its final ledger status could not be established (e.g. connection lost).
   *  outcome is "refused" until `npm run reconcile -w xrpl` looks the tx up by xrpl_tx_hash and records the real result. */
  "ledger_status_unknown",
  /** The agent could not read or write the XRPL ledger (autofill / submit failed) before anything landed. */
  "ledger_unavailable",
  /** agent_account's RLUSD working balance is below the invoice amount (pre-flight; nothing signed). */
  "agent_balance_insufficient",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];
