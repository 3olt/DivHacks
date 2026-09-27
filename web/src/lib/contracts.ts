// COPY of ../../../shared/contracts.ts (owned by the backend). Do not edit here: re-copy when it changes.
// Shared data contracts between api/, xrpl/, data/ (via Mongo) and web/.
// The contract for the frontend is docs/API.md. Change a shape here only together with docs/API.md.

/** "CTT" (added in Phase 3, additive) = City Test Token, issued on Testnet by our own city_issuer. It is used ONLY for the
 *  SIMULATED milestone escrow (RLUSD escrow is impossible on Testnet: the RLUSD issuer lacks lsfAllowTrustLineLocking).
 *  A CTT decision/payment is never RLUSD and has no value; label it "simulated escrow (test token, not RLUSD)". */
export type Currency = "RLUSD" | "XRP" | "CTT";
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
  // Added in Phase 3, builder B (additive):
  /** The officer did not sign the rebuilt over-limit payment: no valid approval for this decision (unknown, expired,
   *  already used) or the rebuilt transaction differs from what the officer approved. Nothing was submitted. */
  "officer_approval_invalid",
  /** Simulated escrow: the Condition is not the PREIMAGE-SHA-256 condition the co-signer issued for this milestone. */
  "escrow_condition_invalid",
  /** Simulated escrow: the escrow named by an EscrowFinish/EscrowCancel is not on the validated ledger (or not ours). */
  "escrow_not_found",
  /** Simulated escrow: CancelAfter outside 1..72 h, a finish after CancelAfter, or a cancel before it. */
  "escrow_timing_invalid",
  // Added by the Phase 3 fixes (additive):
  /** Simulated escrow: the co-signer holds no valid officer-signed release approval for this milestone's on-ledger escrow
   *  (missing, stale, already used, or for another escrow), so it did not reveal the fulfillment. */
  "escrow_release_not_approved",
  /** agent_account's signer list is not CANONICAL (the kill switch is engaged): the co-signer refuses to reveal an escrow
   *  fulfillment, because anyone could submit a revealed fulfillment. */
  "agent_key_revoked",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

// ---------------------------------------------------------------------------
// Added in Phase 3 (additive; see xrpl/README.md)
// ---------------------------------------------------------------------------

/** The City Credential (XLS-70) the co-signer's check 1 reads on-ledger: CredentialType = hex of this string,
 *  issuer = city_issuer, URI = hex("ein:<EIN>;https://projects.propublica.org/nonprofits/organizations/<ein digits>"). */
export const CITY_CREDENTIAL_TYPE = "NYC_VERIFIED_NONPROFIT";

/** An officer's signed answer to a payee change request. The co-signer lifts a hold only when this signature verifies
 *  against the officer signer's public key (whose address is signers.officer in xrpl/data/accounts.testnet.json). */
export interface PayeeChangeResolution {
  type: "divhacks/payee-change-resolution/v1";
  request_id: string;
  ein: string;
  requested_address: string;
  decision: "approve" | "reject";
  /** ISO 8601 UTC, when the officer signed. */
  ts: string;
  /** The officer signer's classic address, public key (hex) and signature (hex, over the canonical JSON of the fields above). */
  signer: string;
  public_key: string;
  signature: string;
}

/** A "we changed our bank details" request (Mongo `payee_change_requests`), created by POST /payees/:ein/change-request on
 *  the xrpl service (:4001). It NEVER changes the registry wallet. While it is on hold, every payment to that EIN is refused
 *  (`payee_change_on_hold`, `enforced_by: "hold"`) by the co-signer, which also keeps its own record of every hold it saw.
 *  "reject" closes it (registry unchanged); "approve" records the decision, and the new wallet still has to complete
 *  onboarding (Nessie re-confirmation + signed challenge + on-ledger credential) before anything changes. */
export interface PayeeChangeRequest {
  request_id: string;
  ein: string;
  current_address: string;
  requested_address: string;
  reason: string;
  contact: string;
  status: "on_hold" | "rejected" | "approved_pending_reonboarding";
  created_at: string;
  /** created_at + HOLD_HOURS (72 h): the earliest time an approved change could take effect. */
  hold_until: string;
  requires: { nessie_reconfirmed: boolean; officer_approved: boolean };
  resolution?: PayeeChangeResolution;
  is_demo_data: boolean;
}

// ---------------------------------------------------------------------------
// Added in Phase 3, builder B (additive; see xrpl/README.md): over-limit approvals, kill switch, simulated escrow
// ---------------------------------------------------------------------------

/** An over-limit payment waiting for the human officer (Mongo `pending_approvals`, one per pending Decision).
 *  Written by the agent when the co-signer refuses ONLY with `over_auto_limit_needs_officer`; it holds what is needed to
 *  rebuild the same payment later (never a signature). POST /approvals/:decision_id on the officer service (:4004) approves
 *  it once (single use, expires 24 h after creation); the xrpl service then rebuilds the payment fresh and the ledger needs
 *  agent + officer + co-signer. The executed payment is a NEW Decision whose audit.approved_from = this decision_id. */
export interface PendingApproval {
  decision_id: string;
  status: "pending" | "approved" | "executed" | "failed" | "expired";
  created_at: string;
  expires_at: string;
  invoice_id: string;
  contract_id: string;
  payee_ein: string;
  amount: string;
  currency: "RLUSD";
  /** Registry wallet for payee_ein when the agent built the payment. */
  destination: string;
  /** decision_hash of the pending decision: the rebuilt payment's memo carries this dh. */
  decision_hash: string;
  /** The exact on-ledger MemoData JSON {inv,ctr,ein,dh,rv} of the rebuilt payment. */
  memo_json: string;
  cosigner_refusal: string[];
  approval?: { approval_id: string; officer: string; approved_at: string; via: string };
  executed_decision_id?: string;
  xrpl_tx_hash?: string;
  ledger_result?: string;
  is_demo_data: boolean;
}

/** A SIMULATED milestone escrow (Mongo `escrow_milestones`): EscrowCreate of CTT (test token, NOT RLUSD) from agent_account
 *  with a PREIMAGE-SHA-256 condition whose fulfillment only the co-signer holds and reveals inside an EscrowFinish it co-signs. */
export interface EscrowMilestone {
  milestone_id: string;
  contract_id: string;
  payee_ein: string;
  destination: string;
  amount: string;
  currency: "CTT";
  issuer: string;
  condition: string;
  /** Ripple-epoch seconds and ISO time. */
  cancel_after: number;
  cancel_after_iso: string;
  /** Sequence of the EscrowCreate (the escrow's OfferSequence). */
  offer_sequence: number | null;
  status: "held" | "released" | "cancelled" | "failed";
  create_decision_id: string;
  create_tx_hash: string | null;
  finish_decision_id?: string;
  finish_tx_hash?: string;
  label: "simulated escrow (test token, not RLUSD)";
  is_demo_data: boolean;
}

/** The officer's signed approval to release a SIMULATED milestone escrow (Phase 3 fixes, additive). Signed by the officer
 *  signer key over the canonical JSON of every field except signer/public_key/signature, delivered by the officer service to
 *  the co-signer, which reveals the escrow's fulfillment only while it holds a valid, unused approval bound to that escrow. */
export interface MilestoneReleaseApproval {
  type: "divhacks/milestone-release/v1";
  milestone_id: string;
  /** The escrow on-ledger: owner (agent_account) + OfferSequence, its Condition, destination and CTT amount. */
  owner: string;
  offer_sequence: number;
  condition: string;
  destination: string;
  amount: string;
  currency: "CTT";
  issuer: string;
  /** ISO 8601 UTC, when the officer signed. */
  ts: string;
  signer: string;
  public_key: string;
  signature: string;
}
