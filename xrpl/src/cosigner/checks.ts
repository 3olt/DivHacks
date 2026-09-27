// The compliance co-signer's 8 checks (rule p3-cosigner-2; the 8 checks are unchanged since p3-cosigner-1, the bump marks the new officer-facing endpoints). A PURE function over the DECODED transaction plus facts the
// caller gathered itself. The co-signer never sees the agent's reasoning, the invoice or any LLM text: only the tx, the
// invoice/decision ids, and its own sources of truth:
//
//   check                                source of truth
//   1 credential_valid                   the LEDGER: ledger_entry {credential: {subject: Destination, issuer: city_issuer
//                                        (pinned accounts.testnet.json), credential_type: hex NYC_VERIFIED_NONPROFIT}} on
//                                        the validated ledger: exists, lsfAccepted, Expiration > that ledger's close time,
//                                        URI EIN == memo EIN (and the contract's payee EIN). No allowlist fallback (Phase 3).
//   2 destination_is_registry_wallet     memo ctr -> contract terms PINNED at startup (lib/contractPins.ts) ->
//                                        nonprofit_ein == memo ein -> pinned registry wallet for that EIN == Destination,
//                                        and Destination on the pinned allowlist (extra guard); refused (registry_drift) if
//                                        the registry or that contract changed in Mongo since they were pinned; refused
//                                        (payee_change_on_hold) while a payee change request for the EIN is on hold
//                                        (lib/holds.ts: the co-signer's own sticky hold record + officer-signed resolutions)
//   3 invoice_not_already_paid           agent_account's validated on-ledger history (tesSUCCESS Payments, memo inv)
//                                        + the co-signer's own still-live co-signatures; matched by a spelling-insensitive
//                                        key (lib/invoiceId.ts) scoped to the payee EIN
//   4 within_contract_amount             today inside the pinned contract's start_date..end_date, and on-ledger
//                                        tesSUCCESS delivered RLUSD under memo ctr (+ live co-signatures) + this amount
//                                        <= the pinned xrpl_budget_rlusd (testnet-scale stand-in)
//   5 within_auto_limit_or_officer_signed amount <= AUTO_LIMIT, or an officer Signer whose signature verifies
//   6 within_daily_caps                  rolling 24h on-ledger sums (ledger close time) for agent_account <= DAILY_CAP
//                                        and per Destination <= PAYEE_DAILY_CAP, including this amount
//   7 payee_not_excluded                 pinned exclusions.json (fictional SAM.gov / sanctions-style list)
//   8 tx_format_valid                    field whitelist, Flags, Fee, multisig form + signatures, freshness
//                                        (Sequence/LastLedgerSequence), RLUSD currency/issuer, amount format (<= 6 dp),
//                                        SourceTag, memo format (memo inv canonical and == invoice_id)
//
// ALL 8 are always evaluated and returned in CHECK_NAMES order; refusal codes follow the same order.
import { deriveAddress, encodeForMultiSigning, verifyKeypairSignature } from "xrpl";
import { CHECK_NAMES, type Check, type CheckName, type RefusalCode } from "../../../shared/contracts";
import { MEMO_TYPE, MEMO_FORMAT, type PaymentMemo } from "../../../shared/hash";
import { fromHex } from "../lib/xrpl";
import { contractPaidMicro, fmt, paidInvoice, rolling24h, toMicro, type AgentHistory } from "../lib/ledgerScan";
import { invoiceKey, isCanonicalInvoiceId } from "../lib/invoiceId";
import type { ContractView } from "../lib/contractPins";
import type { RegistrySnapshot } from "../lib/registrySnapshot";
import type { ExclusionEntry } from "../lib/registry";
import { credentialProblems, rippleToIso, type CredentialFacts } from "../lib/credentials";
import { describeHold, type ActiveHold } from "../lib/holds";

export const COSIGNER_RULE_VERSION = "p3-cosigner-2";

/** Token amounts the co-signer accepts: a plain positive decimal with at most 6 decimals (no exponent, no rounding). */
export const AMOUNT_RE = /^\d{1,12}(\.\d{1,6})?$/;

/** Highest Fee (drops) the co-signer will sign. A 2-signer Payment costs ~30-40 drops on Testnet. */
export const MAX_FEE_DROPS = 1000;
/** LastLedgerSequence may be at most this many ledgers past the validated ledger the co-signer sees (autofill uses +20). */
export const MAX_LLS_AHEAD = 30;
/** The ONLY fields a transaction may carry. Anything else (SendMax, DeliverMin, Paths, TicketSequence, DestinationTag,
 *  InvoiceID, Delegate, CredentialIDs, AccountTxnID, ...) is refused. Signers are stripped before the co-signer signs. */
export const ALLOWED_FIELDS = new Set([
  "TransactionType", "Account", "Destination", "Amount", "Fee", "Sequence", "LastLedgerSequence",
  "SigningPubKey", "SourceTag", "Memos", "Flags", "NetworkID", "Signers",
]);
/** 0, or only tfFullyCanonicalSig (harmless). tfPartialPayment / tfNoRippleDirect / tfLimitQuality are refused. */
const OK_FLAGS = new Set([0, 0x80000000]);

/** One line of the co-signer's own signing record (xrpl/data/cosigner-signed.local.jsonl). */
export interface SignedRecord {
  ts: string;
  invoice_id: string;
  decision_id: string;
  sequence: number;
  last_ledger_sequence: number;
  destination: string;
  amount: string;
  /** Phase 2+: memo ctr and the hash of the agent+cosigner transaction (to tell settled from still-pending). */
  contract_id?: string;
  tx_hash?: string;
  /** p2-cosigner-2+: memo ein (duplicate keys are scoped to the payee). Older records match any payee. */
  payee_ein?: string;
}

/** What the caller read from the ledger itself for this request. */
export interface LedgerView {
  /** agent_account's next Sequence (account_info, ledger "current"). */
  accountSequence: number;
  /** Latest validated ledger index. */
  validatedLedger: number;
}

export type { ContractView };

export interface CheckContext {
  agentAccount: string;
  /** city_issuer (pinned accounts.testnet.json): the only issuer whose NYC_VERIFIED_NONPROFIT credential counts. */
  credentialIssuer: string;
  /** What the caller read on the validated ledger for (Destination, city_issuer, NYC_VERIFIED_NONPROFIT). */
  credential: CredentialFacts;
  /** Payee change holds in force (the co-signer's sticky record + officer-signed resolutions). runChecks filters by EIN. */
  holds: readonly ActiveHold[];
  /** Signers the tx may already carry: the agent (always) and the officer (over AUTO_LIMIT). */
  signerAddresses: { agent: string; officer: string };
  allowlist: Set<string>;
  /** The registry snapshot the co-signer pinned at startup. */
  registry: RegistrySnapshot;
  /** null when Mongo still matches the pinned snapshot; otherwise what drifted. */
  registryDrift: string | null;
  /** Pinned contract terms for memo ctr (co-signer) or the live record (agent audit); null if not found / no memo. */
  contract: ContractView | null;
  /** Why `contract` is null. */
  contractMissing?: string | null;
  /** Non-null when the live contract no longer matches the pinned terms. */
  contractDrift?: string | null;
  /** Extra context for the detail (e.g. a contract admitted after startup). */
  contractNote?: string | null;
  exclusions: Map<string, ExclusionEntry>;
  exclusionsSha256: string;
  rlusd: { currency: string; issuer: string };
  sourceTag: number;
  invoiceId: string;
  autoLimit: number;
  dailyCap: number;
  payeeDailyCap: number;
  ledger: LedgerView;
  history: AgentHistory;
  /** Co-signatures this co-signer issued that can still land (not in validated history, LastLedgerSequence not passed). */
  pending: readonly SignedRecord[];
  /** The co-signer's full signing record (for the "co-signature for this Sequence still live" rule). */
  signed: readonly SignedRecord[];
  nowMs: number;
  /** true for the co-signer: the agent's multisig signature must be present and valid. */
  requireSignatures: boolean;
}

export interface CheckResult {
  checks: Check[];
  refusal_reasons: RefusalCode[];
}

type Tx = Record<string, unknown>;
type SignerJson = { Signer?: { Account?: string; SigningPubKey?: string; TxnSignature?: string } };

/** The Amount's value if it is a plain positive decimal with <= 6 decimals; NaN otherwise (never rounded). */
function amountValue(tx: Tx): number {
  const a = tx.Amount as { value?: unknown } | string | undefined;
  if (typeof a !== "object" || a === null || typeof a.value !== "string" || !AMOUNT_RE.test(a.value)) return NaN;
  const v = Number(a.value);
  return v > 0 ? v : NaN;
}

function parseMemo(tx: Tx): { data: PaymentMemo | null; problem: string | null } {
  const memos = tx.Memos as { Memo: { MemoType?: string; MemoFormat?: string; MemoData?: string } }[] | undefined;
  if (!Array.isArray(memos) || memos.length !== 1) return { data: null, problem: `expected exactly 1 memo, got ${Array.isArray(memos) ? memos.length : 0}` };
  const m = memos[0].Memo ?? {};
  let type = "", format = "", data: Record<string, unknown> | null = null;
  try {
    type = m.MemoType ? fromHex(m.MemoType) : "";
    format = m.MemoFormat ? fromHex(m.MemoFormat) : "";
    data = m.MemoData ? (JSON.parse(fromHex(m.MemoData)) as Record<string, unknown>) : null;
  } catch {
    data = null;
  }
  const keysOk = !!data && Object.keys(data).join(",") === "inv,ctr,ein,dh,rv" && ["inv", "ctr", "ein", "dh", "rv"].every((k) => typeof data![k] === "string");
  if (type !== MEMO_TYPE || format !== MEMO_FORMAT || !keysOk) return { data: null, problem: `memo must be type ${MEMO_TYPE}, format ${MEMO_FORMAT}, data {inv,ctr,ein,dh,rv}` };
  if (!/^[0-9a-f]{64}$/.test(String(data!.dh))) return { data: null, problem: "memo dh is not a SHA-256 hex digest" };
  return { data: data as unknown as PaymentMemo, problem: null };
}

export interface SignatureCheck {
  account: string;
  role: "agent" | "officer" | "unknown";
  valid: boolean;
}

/** Verifies every Signer's multisig signature over encodeForMultiSigning(tx without Signers, signer account). */
export function verifySigners(tx: Tx, signers: { agent: string; officer: string }): SignatureCheck[] {
  const list = (tx.Signers as SignerJson[] | undefined) ?? [];
  const bare: Tx = { ...tx };
  delete bare.Signers;
  return list.map((s) => {
    const account = String(s.Signer?.Account ?? "");
    const role = account === signers.agent ? "agent" : account === signers.officer ? "officer" : "unknown";
    let valid = false;
    try {
      const pub = String(s.Signer?.SigningPubKey ?? "");
      const sig = String(s.Signer?.TxnSignature ?? "");
      valid = !!pub && !!sig && deriveAddress(pub) === account && verifyKeypairSignature(encodeForMultiSigning(bare as never, account), sig, pub);
    } catch {
      valid = false;
    }
    return { account, role, valid };
  });
}

export function runChecks(tx: Tx, ctx: CheckContext): CheckResult {
  const results = new Map<CheckName, { check: Check; codes: RefusalCode[] }>();
  const set = (name: CheckName, passed: boolean, detail: string, codes: RefusalCode[]) =>
    results.set(name, { check: { name, passed, detail }, codes: passed ? [] : codes });

  const dest = typeof tx.Destination === "string" ? tx.Destination : "";
  const value = amountValue(tx);
  const micro = Number.isFinite(value) && value > 0 ? toMicro(value) : NaN;
  const amt = Number.isFinite(micro) ? fmt(micro) : String((tx.Amount as { value?: unknown } | undefined)?.value ?? tx.Amount);
  const memo = parseMemo(tx);
  const sigs = verifySigners(tx, ctx.signerAddresses);
  const regDest = ctx.registry.byAddress.get(dest);
  const pendingSum = (f: (r: SignedRecord) => boolean) => ctx.pending.filter(f).reduce((s, r) => s + toMicro(r.amount), 0);

  // 1 credential_valid: the on-ledger City Credential of the Destination (no allowlist fallback since Phase 3)
  {
    const c = ctx.credential;
    const eins = [memo.data?.ein ?? null, ctx.contract?.nonprofit_ein ?? null];
    const why = c.subject === dest && c.issuer === ctx.credentialIssuer ? credentialProblems(c, eins) : [`the credential facts are for ${c.subject} / issuer ${c.issuer}, not Destination ${dest || "(none)"} / city_issuer ${ctx.credentialIssuer}`];
    set(
      "credential_valid",
      why.length === 0,
      why.length === 0 && c.found
        ? `On-ledger credential ${c.index} (NYC_VERIFIED_NONPROFIT, issuer city_issuer ${c.issuer}, subject ${dest}): accepted (lsfAccepted), expires ${rippleToIso(c.expiration!)} > ` +
            `validated ledger ${c.ledger_index} close ${rippleToIso(c.close_time)}, URI EIN ${c.uri_ein} = memo EIN${regDest ? ` (${regDest.name})` : ""}`
        : `${why.join("; ")} (read on-ledger with ledger_entry; the allowlist is not a substitute)`,
      ["credential_invalid"],
    );
  }

  // 2 destination_is_registry_wallet: memo ctr -> contract -> nonprofit_ein == memo ein -> registry wallet == Destination
  {
    const codes: RefusalCode[] = [];
    const why: string[] = [];
    if (ctx.registryDrift) {
      why.push(`the registry in the database changed since the co-signer pinned it (${ctx.registryDrift}); refusing until it is restarted and the change is reviewed`);
      codes.push("registry_drift");
    }
    if (ctx.contractDrift) {
      why.push(`${ctx.contractDrift}; refusing until the co-signer is restarted and the change is reviewed`);
      codes.push("registry_drift");
    }
    if (!ctx.allowlist.has(dest)) {
      why.push(`Destination ${dest || "(missing)"} is not on the pinned allowlist (${ctx.allowlist.size} wallets)`);
      codes.push("destination_not_registry_wallet");
    }
    const holdEins = new Set([memo.data?.ein, ctx.contract?.nonprofit_ein, regDest?.ein].filter((e): e is string => !!e));
    const holds = ctx.holds.filter((h) => holdEins.has(h.ein));
    for (const h of holds) {
      why.push(`${describeHold(h)}; payments to this EIN are frozen until an officer-signed resolution is verified by the co-signer`);
      codes.push("payee_change_on_hold");
    }
    let passDetail = "";
    if (!memo.data) {
      why.push(`no valid payment memo, so the contract and payee EIN cannot be resolved`);
      codes.push("destination_not_registry_wallet");
    } else if (!ctx.contract) {
      why.push(ctx.contractMissing ?? `contract ${memo.data.ctr} (memo ctr) is not in the contracts collection`);
      codes.push("contract_not_found");
    } else {
      const ein = ctx.contract.nonprofit_ein;
      const reg = ctx.registry.byEin.get(ein);
      if (memo.data.ein !== ein) {
        why.push(`memo ein ${memo.data.ein} is not contract ${ctx.contract.contract_id}'s payee EIN ${ein}`);
        codes.push("destination_not_registry_wallet");
      }
      if (!reg) {
        why.push(`no registry wallet for EIN ${ein}`);
        codes.push("destination_not_registry_wallet");
      } else if (reg.address !== dest) {
        why.push(`Destination ${dest || "(missing)"} is not the registry wallet ${reg.address} for EIN ${ein} (${reg.name})`);
        codes.push("destination_not_registry_wallet");
      } else {
        passDetail =
          `Destination ${dest} is the registry wallet for EIN ${ein} (${reg.name}), the payee of contract ${ctx.contract.contract_id} (memo ctr -> pinned contract terms -> nonprofit_ein; registry snapshot ${ctx.registry.sha256.slice(0, 12)} pinned at startup, unchanged; on the pinned allowlist); ` +
          `no payee change request on hold for EIN ${ein} (${ctx.holds.length} hold${ctx.holds.length === 1 ? "" : "s"} in force for other EINs)` +
          (ctx.contractNote ? `; ${ctx.contractNote}` : "");
      }
    }
    set("destination_is_registry_wallet", why.length === 0, why.length === 0 ? passDetail : why.join("; "), [...new Set(codes)]);
  }

  // 3 invoice_not_already_paid: on-ledger memo history (tesSUCCESS only) + still-live co-signatures, matched by a
  //   spelling-insensitive key (case, punctuation, separators ignored) scoped to the payee EIN.
  {
    const key = invoiceKey(ctx.invoiceId);
    const ein = memo.data?.ein ?? null;
    const scope = ein ? `payee EIN ${ein}` : "any payee (no valid memo ein)";
    if (!key) {
      set("invoice_not_already_paid", false, `Invoice id ${JSON.stringify(ctx.invoiceId)} has no canonical form (A-Z, 0-9 and single dashes), so it cannot be checked against the payment history`, ["bad_memo"]);
    } else {
      const paid = paidInvoice(ctx.history, ctx.invoiceId, ein);
      const pend = ctx.pending.find((r) => invoiceKey(r.invoice_id) === key && (!ein || !r.payee_ein || r.payee_ein === ein));
      set(
        "invoice_not_already_paid",
        !paid && !pend,
        paid
          ? `Invoice ${ctx.invoiceId} was already paid on-ledger${paid.memo?.inv !== ctx.invoiceId ? ` as ${JSON.stringify(paid.memo?.inv)} (same invoice, different spelling)` : ""}: tx ${paid.hash} (${fmt(paid.delivered_micro)} RLUSD to ${paid.destination}, ledger ${paid.ledger_index}, ${paid.close_time_iso})`
          : pend
            ? `Invoice ${ctx.invoiceId} already has a co-signed transaction that can still land (${pend.invoice_id}, Sequence ${pend.sequence}, LastLedgerSequence ${pend.last_ledger_sequence})`
            : `No tesSUCCESS payment memo matching invoice key ${key} for ${scope} in agent_account's on-ledger history (${ctx.history.scanned} txs scanned through ledger ${ctx.history.ledger_index_max}; case, punctuation and separators ignored) and no live co-signature for it`,
        ["invoice_already_paid"],
      );
    }
  }

  // 4 within_contract_amount: contract active today, and on-ledger paid under memo ctr + live co-signatures + this
  //   amount <= the pinned xrpl_budget_rlusd
  {
    if (!ctx.contract) {
      set(
        "within_contract_amount",
        false,
        `No contract record for ${memo.data ? `memo ctr ${memo.data.ctr}` : "this tx (no valid memo)"}, so there is no budget to check against${ctx.contractMissing ? ` (${ctx.contractMissing})` : ""}`,
        ["contract_not_found"],
      );
    } else {
      const c = ctx.contract;
      const today = new Date(ctx.nowMs).toISOString().slice(0, 10);
      const dateOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
      const active = dateOk(c.start_date) && dateOk(c.end_date) && c.start_date <= today && today <= c.end_date;
      const budget = AMOUNT_RE.test(c.xrpl_budget_rlusd) ? toMicro(c.xrpl_budget_rlusd) : NaN;
      const paid = contractPaidMicro(ctx.history, c.contract_id);
      const pend = pendingSum((r) => r.contract_id === c.contract_id);
      const total = paid.micro + pend + (Number.isFinite(micro) ? micro : 0);
      const within = Number.isFinite(micro) && Number.isFinite(budget) && total <= budget;
      const codes: RefusalCode[] = [];
      if (!active) codes.push("contract_not_active");
      if (!within) codes.push(Number.isFinite(micro) ? "contract_amount_exceeded" : "bad_tx_fields");
      set(
        "within_contract_amount",
        codes.length === 0,
        (active
          ? `Contract ${c.contract_id} term ${c.start_date}..${c.end_date} includes today (${today}). `
          : `Contract ${c.contract_id} is NOT active today (${today}): term ${c.start_date || "?"}..${c.end_date || "?"}. `) +
          `On-ledger paid under ${c.contract_id}: ${fmt(paid.micro)} RLUSD (${paid.count} payment${paid.count === 1 ? "" : "s"})` +
          (pend ? ` + ${fmt(pend)} co-signed and pending` : "") +
          ` + this ${amt} = ${fmt(total)}, ${within ? "within" : "EXCEEDS"} the contract's testnet-scale budget ${Number.isFinite(budget) ? fmt(budget) : JSON.stringify(c.xrpl_budget_rlusd)} RLUSD` +
          ` (xrpl_budget_rlusd, a stand-in for the remaining contract balance)`,
        codes,
      );
    }
  }

  // 5 within_auto_limit_or_officer_signed
  {
    const officer = sigs.find((s) => s.role === "officer");
    const limitMicro = toMicro(ctx.autoLimit);
    if (!Number.isFinite(micro)) {
      set("within_auto_limit_or_officer_signed", false, `Amount ${amt} is not a positive token amount`, ["bad_tx_fields"]);
    } else if (micro <= limitMicro) {
      set("within_auto_limit_or_officer_signed", true, `${amt} RLUSD <= AUTO_LIMIT ${fmt(limitMicro)} RLUSD (no officer needed)`, []);
    } else if (officer?.valid) {
      set("within_auto_limit_or_officer_signed", true, `${amt} RLUSD > AUTO_LIMIT ${fmt(limitMicro)} RLUSD and the officer ${officer.account} has signed (signature verified)`, []);
    } else {
      set(
        "within_auto_limit_or_officer_signed",
        false,
        `${amt} RLUSD > AUTO_LIMIT ${fmt(limitMicro)} RLUSD and ${officer ? `the officer signature on the tx does NOT verify` : "the officer has not signed"}`,
        ["over_auto_limit_needs_officer"],
      );
    }
  }

  // 6 within_daily_caps: rolling 24h by ledger close time, including live co-signatures and this amount
  {
    const add = Number.isFinite(micro) ? micro : 0;
    const agent = rolling24h(ctx.history, ctx.nowMs);
    const payee = rolling24h(ctx.history, ctx.nowMs, dest);
    const agentTotal = agent.micro + pendingSum(() => true) + add;
    const payeeTotal = payee.micro + pendingSum((r) => r.destination === dest) + add;
    const capA = toMicro(ctx.dailyCap);
    const capP = toMicro(ctx.payeeDailyCap);
    const codes: RefusalCode[] = [];
    if (agentTotal > capA) codes.push("daily_cap_exceeded_agent");
    if (payeeTotal > capP) codes.push("daily_cap_exceeded_payee");
    set(
      "within_daily_caps",
      codes.length === 0 && Number.isFinite(micro),
      `Agent 24h on-ledger ${fmt(agent.micro)} (${agent.count} payments) + this ${amt} = ${fmt(agentTotal)} ${agentTotal > capA ? ">" : "<="} DAILY_CAP ${fmt(capA)}; ` +
        `payee ${dest || "(none)"} 24h ${fmt(payee.micro)} + this = ${fmt(payeeTotal)} ${payeeTotal > capP ? ">" : "<="} PAYEE_DAILY_CAP ${fmt(capP)} RLUSD`,
      codes.length ? codes : ["bad_tx_fields"],
    );
  }

  // 7 payee_not_excluded: every EIN this payment resolves to (memo ein, contract payee, registry owner of Destination)
  {
    const eins = [...new Set([memo.data?.ein, ctx.contract?.nonprofit_ein, regDest?.ein].filter((e): e is string => !!e))];
    const hit = eins.map((e) => ctx.exclusions.get(e)).find(Boolean);
    const listDesc = `exclusion list (${ctx.exclusions.size} fictional SAM.gov/sanctions-style entries, pinned ${ctx.exclusionsSha256.slice(0, 12)})`;
    if (hit) {
      set("payee_not_excluded", false, `EIN ${hit.ein} (${hit.name}) is on the ${listDesc}: ${hit.list}, ${hit.exclusion_type} since ${hit.since}`, ["payee_excluded"]);
    } else if (eins.length === 0) {
      set("payee_not_excluded", false, `Cannot establish the payee EIN (no valid memo, contract or registry entry for the Destination)`, ["bad_memo"]);
    } else {
      set("payee_not_excluded", true, `EIN ${eins.join(", ")} is not on the ${listDesc}`, []);
    }
  }

  // 8 tx_format_valid: a fresh, plain, multisig-form RLUSD Payment from agent_account with our SourceTag and memo.
  {
    const problems: string[] = [];
    const codes = new Set<RefusalCode>();
    const add = (code: RefusalCode, msg: string) => {
      problems.push(msg);
      codes.add(code);
    };
    if (tx.TransactionType !== "Payment") add("bad_tx_fields", `TransactionType ${String(tx.TransactionType)} is not Payment`);
    if (tx.Account !== ctx.agentAccount) add("bad_tx_fields", `Account ${String(tx.Account)} is not agent_account ${ctx.agentAccount}`);
    if (tx.SigningPubKey !== "" || tx.TxnSignature !== undefined) add("bad_tx_fields", "not in multisig form (SigningPubKey must be empty and there must be no TxnSignature)");
    const extra = Object.keys(tx).filter((k) => !ALLOWED_FIELDS.has(k));
    if (extra.length) add("bad_tx_fields", `fields not allowed: ${extra.join(", ")}`);
    const flags = tx.Flags === undefined ? 0 : Number(tx.Flags);
    if (!OK_FLAGS.has(flags)) add("bad_tx_fields", `Flags 0x${flags.toString(16)} not allowed (must be 0; no tfPartialPayment)`);
    const fee = typeof tx.Fee === "string" && /^\d+$/.test(tx.Fee) ? Number(tx.Fee) : NaN;
    if (!(fee > 0 && fee <= MAX_FEE_DROPS)) add("bad_tx_fields", `Fee ${String(tx.Fee)} drops is outside 1..${MAX_FEE_DROPS}`);
    if (!Number.isFinite(micro)) add("bad_tx_fields", `Amount value ${JSON.stringify((tx.Amount as { value?: unknown } | undefined)?.value ?? null)} must be a plain positive decimal with at most 6 decimals`);

    // Signatures: only the agent (required) and the officer may have signed, each at most once, each verifying.
    const accounts = sigs.map((s) => s.account);
    if (ctx.requireSignatures && !sigs.some((s) => s.role === "agent")) add("bad_tx_fields", "the agent's multisig signature is missing");
    if (new Set(accounts).size !== accounts.length) add("bad_tx_fields", "a signer appears twice in Signers");
    for (const s of sigs) {
      if (s.role === "unknown") add("bad_tx_fields", `Signer ${s.account} is not the agent or the officer`);
      else if (!s.valid) add("bad_tx_fields", `the ${s.role}'s signature does not verify`);
    }

    // Freshness: usable only for agent_account's CURRENT Sequence and for ~20 ledgers, so co-signatures cannot be
    // collected in advance for Sequence N+1, N+2, ... and replayed later to get around the other checks.
    if (tx.Sequence !== ctx.ledger.accountSequence) add("tx_not_fresh", `Sequence ${String(tx.Sequence)} is not agent_account's current Sequence ${ctx.ledger.accountSequence}`);
    const lls = typeof tx.LastLedgerSequence === "number" ? tx.LastLedgerSequence : NaN;
    if (!(lls > ctx.ledger.validatedLedger && lls <= ctx.ledger.validatedLedger + MAX_LLS_AHEAD)) {
      add("tx_not_fresh", `LastLedgerSequence ${String(tx.LastLedgerSequence ?? "(missing)")} must be in (${ctx.ledger.validatedLedger}, ${ctx.ledger.validatedLedger + MAX_LLS_AHEAD}]`);
    }
    const live = ctx.signed.find((r) => r.sequence === tx.Sequence && r.last_ledger_sequence >= ctx.ledger.validatedLedger);
    if (live) add("tx_not_fresh", `a co-signature for Sequence ${live.sequence} (invoice ${live.invoice_id}) is still live until ledger ${live.last_ledger_sequence}`);

    const a = tx.Amount as { currency?: string; issuer?: string } | string | undefined;
    if (typeof a !== "object" || a === null || a.currency !== ctx.rlusd.currency || a.issuer !== ctx.rlusd.issuer) add("bad_currency", `Amount is not RLUSD issued by ${ctx.rlusd.issuer}`);
    if (tx.SourceTag !== ctx.sourceTag) add("bad_source_tag", `SourceTag ${String(tx.SourceTag)} is not ${ctx.sourceTag}`);
    if (memo.problem) add("bad_memo", memo.problem);
    else if (memo.data!.inv !== ctx.invoiceId) add("bad_memo", `memo inv ${memo.data!.inv} does not match invoice_id ${ctx.invoiceId}`);
    else if (!isCanonicalInvoiceId(memo.data!.inv)) add("bad_memo", `memo inv ${JSON.stringify(memo.data!.inv)} is not in canonical form (upper-case A-Z, 0-9, single dashes, <= 64 chars)`);

    const signedBy = sigs.length ? `, signed by ${sigs.map((s) => `${s.role} (verified)`).join(" + ")}` : "";
    set(
      "tx_format_valid",
      problems.length === 0,
      problems.length === 0
        ? `Plain multisig-form Payment from agent_account, SourceTag ${ctx.sourceTag}, memo ${MEMO_TYPE} {inv,ctr,ein,dh,rv} for ${ctx.invoiceId}, RLUSD issued by ${ctx.rlusd.issuer}, ` +
            `Fee ${fee} drops, Sequence ${String(tx.Sequence)} = current, LastLedgerSequence ${lls} (validated ${ctx.ledger.validatedLedger})${signedBy}`
        : problems.join("; "),
      [...codes],
    );
  }

  const ordered = CHECK_NAMES.map((n) => results.get(n)!);
  return {
    checks: ordered.map((r) => r.check),
    refusal_reasons: [...new Set(ordered.flatMap((r) => r.codes))],
  };
}

/** 8 placeholder checks for a decision where no transaction could be evaluated (e.g. the verifier failed). */
export function notEvaluatedChecks(why: string): Check[] {
  return CHECK_NAMES.map((name) => ({ name, passed: false, detail: `not evaluated: ${why}` }));
}
