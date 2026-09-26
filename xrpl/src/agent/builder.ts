// The payment builder: turns the verifier's proposal into a payable Invoice, deterministically, or refuses.
// It never takes an address from the invoice or the model: the destination is resolved ONLY from the registry by EIN.
// Cross-checks (all deterministic, no LLM):
//   - suspicious_instructions_found                      -> suspicious_instructions_in_invoice (agent policy; nothing signed)
//   - contract record missing in Mongo                   -> contract_not_found
//   - proposal.contract_id != the contract the invoice was submitted against / the Mongo record -> verifier_rejected
//   - proposal.payee_ein != contract.nonprofit_ein (Mongo) -> verifier_rejected
//   - amount not a positive decimal (<= 6 dp), currency not RLUSD, bad period dates, bad/mismatched invoice id -> verifier_rejected
//   - today outside the contract's start_date..end_date  -> contract_not_active
//   - no registry wallet for the contract's payee EIN    -> destination_not_registry_wallet
// The invoice id is written in CANONICAL form (lib/invoiceId.ts: upper-case, single dashes), so the same invoice always
// carries the same memo `inv`; the co-signer refuses any other spelling and matches duplicates spelling-insensitively.
import type { Invoice, RefusalCode } from "../../../shared/contracts";
import type { ContractDoc } from "../lib/mongo";
import { nonprofitByEin, type NonprofitKey, type Registry } from "../lib/registry";
import type { Proposal } from "../verifier";
import { canonicalInvoiceId, invoiceKey } from "../lib/invoiceId";

export const AMOUNT_RE = /^\d{1,12}(\.\d{1,6})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export interface SubmissionMeta {
  /** The contract the invoice was submitted against (intake context: web form, iMessage, seed). */
  contract_id: string;
  /** The invoice number the submitter gave at intake, if any; the proposal must match it. */
  expected_invoice_id?: string;
  submitted_via: Invoice["submitted_via"];
}

export type BuildResult =
  | { ok: true; invoice: Invoice; destination: string; np_key: NonprofitKey; notes: string[] }
  | {
      ok: false;
      reasons: RefusalCode[];
      problems: string[];
      /** Best-effort identifiers for the refused Decision (never used to pay anything). */
      ids: { invoice_id: string; contract_id: string; payee_ein: string; amount: string };
      /** Registry wallet the payment WOULD go to (for the agent-side audit), if resolvable. */
      would_be_destination: string | null;
    };

export function buildFromProposal(p: Proposal, sub: SubmissionMeta, contract: ContractDoc | null, reg: Registry, fallbackInvoiceId: string, now = new Date()): BuildResult {
  const reasons: RefusalCode[] = [];
  const problems: string[] = [];
  const add = (code: RefusalCode, msg: string) => {
    if (!reasons.includes(code)) reasons.push(code);
    problems.push(msg);
  };

  if (p.suspicious_instructions_found) {
    add(
      "suspicious_instructions_in_invoice",
      `the verifier flagged instruction-like text in the invoice${p.suspicious_excerpts.length ? `: ${p.suspicious_excerpts.map((e) => JSON.stringify(e)).join(" / ")}` : ""}`,
    );
  }
  if (!contract) add("contract_not_found", `contract ${sub.contract_id} is not in the contracts collection`);
  if (p.contract_id !== sub.contract_id) add("verifier_rejected", `invoice names contract "${p.contract_id}", but it was submitted against ${sub.contract_id}`);
  if (contract && p.payee_ein !== contract.nonprofit_ein) add("verifier_rejected", `invoice payee EIN "${p.payee_ein}" is not contract ${contract.contract_id}'s payee EIN ${contract.nonprofit_ein}`);
  const amountOk = AMOUNT_RE.test(p.amount) && Number(p.amount) > 0;
  if (!amountOk) add("verifier_rejected", `amount "${p.amount}" is not a positive decimal with at most 6 decimals`);
  if (p.currency !== "RLUSD") add("verifier_rejected", `currency ${String(p.currency)} is not RLUSD`);
  if (!validDate(p.period.from) || !validDate(p.period.to) || p.period.from > p.period.to) add("verifier_rejected", `service period "${p.period.from}".."${p.period.to}" is not a valid YYYY-MM-DD range`);
  const canon = canonicalInvoiceId(p.invoice_id);
  if (!canon) add("verifier_rejected", `invoice id "${p.invoice_id}" is missing or has no canonical form (ASCII letters, digits and separators, at most 64 characters)`);
  else if (sub.expected_invoice_id && invoiceKey(sub.expected_invoice_id) !== invoiceKey(canon)) add("verifier_rejected", `invoice id "${p.invoice_id}" does not match the id given at intake (${sub.expected_invoice_id})`);
  if (contract) {
    const today = now.toISOString().slice(0, 10);
    if (!(validDate(contract.start_date) && validDate(contract.end_date) && contract.start_date <= today && today <= contract.end_date)) {
      add("contract_not_active", `contract ${contract.contract_id} term ${contract.start_date}..${contract.end_date} does not include today (${today})`);
    }
  }

  const payeeEin = contract?.nonprofit_ein ?? p.payee_ein;
  const hit = nonprofitByEin(reg, payeeEin);
  if (!hit) add("destination_not_registry_wallet", `no registry wallet for EIN ${payeeEin}`);

  const invoice_id = canon ?? canonicalInvoiceId(sub.expected_invoice_id) ?? canonicalInvoiceId(fallbackInvoiceId) ?? "UNKNOWN";
  if (reasons.length) {
    return {
      ok: false,
      reasons,
      problems,
      ids: { invoice_id, contract_id: sub.contract_id, payee_ein: payeeEin, amount: amountOk ? p.amount : "0" },
      would_be_destination: hit?.np.address ?? null,
    };
  }
  const invoice: Invoice = {
    invoice_id: canon!,
    contract_id: contract!.contract_id,
    payee_ein: contract!.nonprofit_ein,
    amount: p.amount,
    currency: "RLUSD",
    period: { from: p.period.from, to: p.period.to },
    description: p.proof_summary,
    submitted_via: sub.submitted_via,
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    is_demo_data: true,
  };
  return {
    ok: true,
    invoice,
    destination: hit!.np.address,
    np_key: hit!.key,
    notes: [
      `contract ${invoice.contract_id} -> payee EIN ${invoice.payee_ein} matches the contracts collection`,
      `destination = registry wallet ${hit!.key} for that EIN (never an address from the invoice)`,
      ...(canon !== p.invoice_id ? [`invoice id "${p.invoice_id}" written in canonical form ${canon}`] : []),
    ],
  };
}
