// Builds fixture Decisions: all 8 co-signer checks (CHECK_NAMES order), refusal codes that agree with
// the failed checks, and a real decision_hash (SHA-256 of canonical JSON without decision_hash).
import { CHECK_NAMES, REFUSAL_CODES } from "../../../shared/contracts";
import type { Check, CheckName, Decision, RefusalCode } from "../../../shared/contracts";
import { computeDecisionHash } from "../lib/hash";
import { toMillis } from "../lib/time";
import { CONTRACTS_BY_ID } from "./contracts";
import { NONPROFITS } from "./nonprofits";
import { AUTO_LIMIT, DAILY_CAP, FIXTURE_RULE_VERSION, MEMO_TYPE, REGISTRY_WALLETS, RLUSD_ISSUER, SOURCE_TAG } from "./wallets";

/** Signers are ROLE names, not addresses. */
export type SignerRole = "agent" | "cosigner" | "officer";

export interface DecisionSpec {
  decision_id: string;
  created_at: string;
  invoice_id: string;
  contract_id: string;
  amount: number;
  outcome: Decision["outcome"];
  enforced_by: Decision["enforced_by"];
  refusal_reasons: RefusalCode[];
  /** Checks that failed, with their detail text. Every other check passes. */
  failed?: Partial<Record<CheckName, string>>;
  /** Replace the default detail text of a passing check. */
  detail_overrides?: Partial<Record<CheckName, string>>;
  /** Defaults to the registry wallet for the contract's payee EIN. */
  destination?: string;
  signers: SignerRole[];
  xrpl_tx_hash: string | null;
  ledger_result: string | null;
  /** Written without the "[fixture] " prefix; the factory adds it. */
  agent_reasoning: string;
}

/** Which refusal codes a failed check can produce. Non-check codes (suspicious_instructions_in_invoice,
 *  payee_change_on_hold, verifier_rejected, ledger_rejected) may appear with every check passing. */
export const CHECK_REFUSAL_CODES: Record<CheckName, RefusalCode[]> = {
  credential_valid: ["credential_invalid"],
  destination_is_registry_wallet: ["destination_not_registry_wallet"],
  invoice_not_already_paid: ["invoice_already_paid"],
  within_contract_amount: ["contract_amount_exceeded"],
  within_auto_limit_or_officer_signed: ["over_auto_limit_needs_officer"],
  within_daily_caps: ["daily_cap_exceeded_agent", "daily_cap_exceeded_payee"],
  payee_not_excluded: ["payee_excluded"],
  tx_format_valid: ["bad_source_tag", "bad_memo", "bad_currency"],
};

export const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum = (ds: Decision[]) => ds.reduce((s, d) => s + Number(d.amount), 0);

/** Build a Decision. `history` = decisions that already exist (used for paid-to-date and 24h totals). */
export function makeDecision(spec: DecisionSpec, history: Decision[]): Decision {
  const contract = CONTRACTS_BY_ID.get(spec.contract_id);
  if (!contract) throw new Error(`fixture decision ${spec.decision_id}: unknown contract ${spec.contract_id}`);
  const ein = contract.nonprofit_ein;
  const nonprofit = NONPROFITS.find((n) => n.ein === ein);
  const registry = REGISTRY_WALLETS[ein] ?? "(none)";
  const dest = spec.destination ?? registry;

  const at = toMillis(spec.created_at);
  // `history` only holds decisions that already exist, so everything up to and INCLUDING this second counts
  // (timestamps have 1 s resolution; two demo clicks in the same second must still see each other).
  const released = history.filter((d) => d.outcome === "released" && toMillis(d.created_at) <= at);
  const paidBefore = Number(contract.spent_to_date) + sum(released.filter((d) => d.contract_id === contract.contract_id));
  const last24h = released.filter((d) => at - toMillis(d.created_at) < 86_400_000);
  const agent24h = sum(last24h) + spec.amount;
  const payee24h = sum(last24h.filter((d) => d.payee_ein === ein)) + spec.amount;
  const expires = nonprofit?.wallet?.credential_expires?.slice(0, 10) ?? "n/a";

  const details: Record<CheckName, string> = {
    credential_valid: `${dest} holds an accepted NYC_VERIFIED_NONPROFIT credential for EIN ${ein}, valid until ${expires}`,
    destination_is_registry_wallet: `Destination ${dest} is the registry wallet for EIN ${ein}`,
    invoice_not_already_paid: `No earlier payment memo for ${spec.invoice_id} in the agent account's ledger history`,
    within_contract_amount: `Paid to date ${money(paidBefore)} + ${money(spec.amount)} = ${money(paidBefore + spec.amount)}, within contract amount ${money(Number(contract.amount))}`,
    within_auto_limit_or_officer_signed:
      spec.amount <= AUTO_LIMIT
        ? `${money(spec.amount)} <= AUTO_LIMIT ${money(AUTO_LIMIT)}`
        : `${money(spec.amount)} > AUTO_LIMIT ${money(AUTO_LIMIT)}; officer signature present`,
    within_daily_caps: `Agent 24h total ${money(agent24h)} <= DAILY_CAP ${money(DAILY_CAP)}; payee 24h total ${money(payee24h)}`,
    payee_not_excluded: `EIN ${ein} is not on the exclusions list`,
    tx_format_valid: `SourceTag ${SOURCE_TAG}, memo type ${MEMO_TYPE}, RLUSD issued by ${RLUSD_ISSUER}`,
    ...spec.detail_overrides,
  };

  const failed = spec.failed ?? {};
  const checks: Check[] = CHECK_NAMES.map((name) => {
    const failDetail = failed[name];
    return failDetail !== undefined ? { name, passed: false, detail: failDetail } : { name, passed: true, detail: details[name] };
  });

  // Self-consistency guards: fixtures must tell a coherent story.
  for (const code of spec.refusal_reasons) {
    if (!(REFUSAL_CODES as readonly string[]).includes(code)) throw new Error(`${spec.decision_id}: unknown refusal code ${code}`);
  }
  for (const name of Object.keys(failed) as CheckName[]) {
    if (!CHECK_REFUSAL_CODES[name].some((c) => spec.refusal_reasons.includes(c))) {
      throw new Error(`${spec.decision_id}: failed check ${name} has no matching refusal code`);
    }
  }
  if (spec.outcome === "released") {
    if (spec.refusal_reasons.length || Object.keys(failed).length || !spec.xrpl_tx_hash || spec.ledger_result !== "tesSUCCESS" || spec.enforced_by !== null) {
      throw new Error(`${spec.decision_id}: inconsistent released decision`);
    }
  } else if (spec.refusal_reasons.length === 0) {
    throw new Error(`${spec.decision_id}: non-released decision needs refusal_reasons`);
  }

  const decision: Decision = {
    decision_id: spec.decision_id,
    invoice_id: spec.invoice_id,
    contract_id: contract.contract_id,
    payee_ein: ein,
    amount: spec.amount.toFixed(2),
    currency: "RLUSD",
    outcome: spec.outcome,
    refusal_reasons: [...spec.refusal_reasons],
    checks,
    enforced_by: spec.enforced_by,
    agent_reasoning: `[fixture] ${spec.agent_reasoning}`,
    decision_hash: "",
    rule_version: FIXTURE_RULE_VERSION,
    xrpl_tx_hash: spec.xrpl_tx_hash,
    ledger_result: spec.ledger_result,
    signers: [...spec.signers],
    source_tag: SOURCE_TAG,
    created_at: spec.created_at,
  };
  decision.decision_hash = computeDecisionHash(decision);
  return decision;
}
