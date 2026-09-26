// The co-signer's Phase 1 checks. Pure functions over the DECODED transaction the co-signer is asked to sign:
// the co-signer never sees the agent's reasoning or any LLM text, only the tx itself, the invoice/decision ids,
// its own pinned copy of the registry + allowlist, its own ledger reads (agent_account Sequence, validated ledger)
// and its own record of what it has already co-signed.
//
// Phase 1 runs 4 of the 8 CHECK_NAMES:
//   destination_is_registry_wallet       Destination is on the pinned allowlist of registry wallets
//   invoice_not_already_paid             this co-signer has never co-signed this invoice_id (its own signing record;
//                                        Phase 2 adds the on-ledger memo-history scan)
//   within_auto_limit_or_officer_signed  0 < Amount <= AUTO_LIMIT (the officer path is Phase 3)
//   tx_format_valid                      exact field whitelist, Flags 0, Fee cap, RLUSD, SourceTag, memo, multisig form,
//                                        and freshness: Sequence == agent_account's current Sequence and
//                                        validated < LastLedgerSequence <= validated + MAX_LLS_AHEAD
// Phase 2 adds credential_valid, within_contract_amount, within_daily_caps, payee_not_excluded.
import { CHECK_NAMES, type Check, type CheckName, type RefusalCode } from "../../../shared/contracts";
import { MEMO_TYPE, MEMO_FORMAT } from "../../../shared/hash";
import { fromHex } from "../lib/xrpl";

export const COSIGNER_RULE_VERSION = "p1-allowlist-2";

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
}

/** What the co-signer read from the ledger itself for this request. */
export interface LedgerView {
  /** agent_account's next Sequence (account_info, ledger "current"). */
  accountSequence: number;
  /** Latest validated ledger index. */
  validatedLedger: number;
}

export interface CheckContext {
  agentAccount: string;
  allowlist: Set<string>;
  rlusd: { currency: string; issuer: string };
  sourceTag: number;
  invoiceId: string;
  autoLimit: number;
  ledger: LedgerView;
  signed: readonly SignedRecord[];
}

export interface CheckResult {
  checks: Check[];
  refusal_reasons: RefusalCode[];
}

type Tx = Record<string, unknown>;

function amountValue(tx: Tx): number {
  const a = tx.Amount as { value?: unknown } | string | undefined;
  if (typeof a !== "object" || a === null || typeof a.value !== "string") return NaN;
  return /^\d+(\.\d+)?(e-?\d+)?$/i.test(a.value) ? Number(a.value) : NaN;
}

export function runPhase1Checks(tx: Tx, ctx: CheckContext): CheckResult {
  const results = new Map<CheckName, { check: Check; codes: RefusalCode[] }>();
  const set = (name: CheckName, passed: boolean, detail: string, codes: RefusalCode[]) =>
    results.set(name, { check: { name, passed, detail }, codes: passed ? [] : codes });

  // destination_is_registry_wallet: Destination is one of the registry wallets on the (pinned) allowlist.
  const dest = typeof tx.Destination === "string" ? tx.Destination : "";
  const destOk = dest !== "" && ctx.allowlist.has(dest);
  set(
    "destination_is_registry_wallet",
    destOk,
    destOk
      ? `Destination ${dest} is a registry wallet on the Phase 1 allowlist (${ctx.allowlist.size} wallets)`
      : `Destination ${dest || "(missing)"} is not on the Phase 1 allowlist of ${ctx.allowlist.size} registry wallets`,
    ["destination_not_registry_wallet"],
  );

  // invoice_not_already_paid: the co-signer co-signs an invoice at most once (fail closed, even if that earlier
  // transaction never landed). Phase 2 adds the scan of agent_account's on-ledger memo history.
  const prior = ctx.signed.find((r) => r.invoice_id === ctx.invoiceId);
  set(
    "invoice_not_already_paid",
    !prior,
    prior
      ? `Invoice ${ctx.invoiceId} was already co-signed at ${prior.ts} (Sequence ${prior.sequence}, ${prior.amount} RLUSD to ${prior.destination}); the co-signer signs an invoice at most once`
      : `Invoice ${ctx.invoiceId} has never been co-signed (co-signer's own signing record, ${ctx.signed.length} entries; the on-ledger memo scan is Phase 2)`,
    ["invoice_already_paid"],
  );

  // within_auto_limit_or_officer_signed: 0 < amount <= AUTO_LIMIT. Over the limit needs the officer (Phase 3).
  const value = amountValue(tx);
  const limitOk = Number.isFinite(value) && value > 0 && value <= ctx.autoLimit;
  set(
    "within_auto_limit_or_officer_signed",
    limitOk,
    limitOk
      ? `Amount ${value} RLUSD is within AUTO_LIMIT ${ctx.autoLimit} RLUSD`
      : Number.isFinite(value) && value > ctx.autoLimit
        ? `Amount ${value} RLUSD is over AUTO_LIMIT ${ctx.autoLimit} RLUSD and needs the officer's signature (officer path: Phase 3)`
        : `Amount ${String((tx.Amount as { value?: unknown } | undefined)?.value ?? tx.Amount)} is not a positive token amount`,
    Number.isFinite(value) && value > ctx.autoLimit ? ["over_auto_limit_needs_officer"] : ["verifier_rejected"],
  );

  // tx_format_valid: a fresh, plain, multisig-form RLUSD Payment from agent_account with our SourceTag and memo.
  const problems: string[] = [];
  const codes = new Set<RefusalCode>();
  const structural = (msg: string) => {
    problems.push(msg);
    // REFUSAL_CODES has no dedicated code for structural / freshness problems; verifier_rejected is the generic
    // co-signer-side code until Phase 2 adds one.
    codes.add("verifier_rejected");
  };
  if (tx.TransactionType !== "Payment") structural(`TransactionType ${String(tx.TransactionType)} is not Payment`);
  if (tx.Account !== ctx.agentAccount) structural(`Account ${String(tx.Account)} is not agent_account ${ctx.agentAccount}`);
  if (tx.SigningPubKey !== "" || tx.TxnSignature !== undefined) structural("not in multisig form (SigningPubKey must be empty and there must be no TxnSignature)");
  const extra = Object.keys(tx).filter((k) => !ALLOWED_FIELDS.has(k));
  if (extra.length) structural(`fields not allowed: ${extra.join(", ")}`);
  const flags = tx.Flags === undefined ? 0 : Number(tx.Flags);
  if (!OK_FLAGS.has(flags)) structural(`Flags 0x${flags.toString(16)} not allowed (must be 0; no tfPartialPayment)`);
  const fee = typeof tx.Fee === "string" && /^\d+$/.test(tx.Fee) ? Number(tx.Fee) : NaN;
  if (!(fee > 0 && fee <= MAX_FEE_DROPS)) structural(`Fee ${String(tx.Fee)} drops is outside 1..${MAX_FEE_DROPS}`);
  if (!(Number.isFinite(value) && value > 0)) structural("Amount value must be a positive number");

  // Freshness: the co-signature is only usable for agent_account's CURRENT Sequence and for ~20 ledgers,
  // so co-signatures cannot be collected in advance for Sequence N+1, N+2, ... and replayed later.
  if (tx.Sequence !== ctx.ledger.accountSequence) {
    structural(`Sequence ${String(tx.Sequence)} is not agent_account's current Sequence ${ctx.ledger.accountSequence}`);
  }
  const lls = typeof tx.LastLedgerSequence === "number" ? tx.LastLedgerSequence : NaN;
  if (!(lls > ctx.ledger.validatedLedger && lls <= ctx.ledger.validatedLedger + MAX_LLS_AHEAD)) {
    structural(`LastLedgerSequence ${String(tx.LastLedgerSequence ?? "(missing)")} must be in (${ctx.ledger.validatedLedger}, ${ctx.ledger.validatedLedger + MAX_LLS_AHEAD}] (validated ledger + ${MAX_LLS_AHEAD})`);
  }
  const live = ctx.signed.find((r) => r.sequence === tx.Sequence && r.last_ledger_sequence >= ctx.ledger.validatedLedger);
  if (live) structural(`a co-signature for Sequence ${live.sequence} (invoice ${live.invoice_id}) is still live until ledger ${live.last_ledger_sequence}`);

  const amt = tx.Amount as { currency?: string; issuer?: string; value?: string } | string | undefined;
  if (typeof amt !== "object" || amt === null || amt.currency !== ctx.rlusd.currency || amt.issuer !== ctx.rlusd.issuer) {
    problems.push(`Amount is not RLUSD issued by ${ctx.rlusd.issuer}`);
    codes.add("bad_currency");
  }
  if (tx.SourceTag !== ctx.sourceTag) {
    problems.push(`SourceTag ${String(tx.SourceTag)} is not ${ctx.sourceTag}`);
    codes.add("bad_source_tag");
  }
  let memoDesc = "";
  const memos = tx.Memos as { Memo: { MemoType?: string; MemoFormat?: string; MemoData?: string } }[] | undefined;
  if (!Array.isArray(memos) || memos.length !== 1) {
    problems.push(`expected exactly 1 memo, got ${Array.isArray(memos) ? memos.length : 0}`);
    codes.add("bad_memo");
  } else {
    const m = memos[0].Memo;
    const type = m.MemoType ? fromHex(m.MemoType) : "";
    const format = m.MemoFormat ? fromHex(m.MemoFormat) : "";
    let data: Record<string, unknown> | null = null;
    try {
      data = m.MemoData ? (JSON.parse(fromHex(m.MemoData)) as Record<string, unknown>) : null;
    } catch {
      data = null;
    }
    const keysOk = !!data && ["inv", "ctr", "ein", "dh", "rv"].every((k) => typeof data![k] === "string") && Object.keys(data).length === 5;
    if (type !== MEMO_TYPE || format !== MEMO_FORMAT || !keysOk) {
      problems.push(`memo must be type ${MEMO_TYPE}, format ${MEMO_FORMAT}, data {inv,ctr,ein,dh,rv}`);
      codes.add("bad_memo");
    } else if (data!.inv !== ctx.invoiceId) {
      problems.push(`memo inv ${String(data!.inv)} does not match invoice_id ${ctx.invoiceId}`);
      codes.add("bad_memo");
    } else if (!/^[0-9a-f]{64}$/.test(String(data!.dh))) {
      problems.push("memo dh is not a SHA-256 hex digest");
      codes.add("bad_memo");
    } else memoDesc = `, memo ${MEMO_TYPE} inv ${String(data!.inv)}`;
  }
  const fmtOk = problems.length === 0;
  set(
    "tx_format_valid",
    fmtOk,
    fmtOk
      ? `Plain multisig-form Payment from agent_account ${ctx.agentAccount}, SourceTag ${ctx.sourceTag}${memoDesc}, RLUSD issued by ${ctx.rlusd.issuer}, ` +
          `Fee ${fee} drops, Sequence ${String(tx.Sequence)} = current, LastLedgerSequence ${lls} (validated ${ctx.ledger.validatedLedger})`
      : problems.join("; "),
    [...codes],
  );

  // Report in CHECK_NAMES order (only the checks Phase 1 runs); refusal codes follow the same order.
  const ordered = CHECK_NAMES.filter((n) => results.has(n)).map((n) => results.get(n)!);
  return {
    checks: ordered.map((r) => r.check),
    refusal_reasons: [...new Set(ordered.flatMap((r) => r.codes))],
  };
}
