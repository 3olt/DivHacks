// The payment agent (Phase 1). Holds ONLY the agent signer key (weight 1 of quorum 3 on agent_account).
// payInvoice(): registry lookup by EIN -> decision core + decision_hash -> RLUSD Payment with memo + SourceTag
// -> agent multisig signature -> co-signer (separate process) checks and co-signs or refuses -> multisign ->
// submit -> wait for a FINAL status -> persist Decision + Payment to xrpl/data/decisions.local.jsonl.
import fs from "node:fs";
import { Wallet, multisign, hashes, decode, type Client, type Payment as XrplPayment } from "xrpl";
import type { Check, Decision, Invoice, Payment } from "../../../shared/contracts";
import { memoHash } from "../../../shared/hash";
import { loadEnv } from "../env";
import { connect, explorerTx, rlusd, sourceTag, submitBlobAndWait, tokenBalance, type SubmitResult } from "../lib/xrpl";
import { decisionsLogPath, loadRegistry, nonprofitByEin } from "../lib/registry";
import { agentReasoning, buildMemo, computeDecisionHash, decisionCore, isoSeconds, newDecisionId } from "./decision";

/** Loads root .env + xrpl/.env.agent ONLY and returns the agent signer wallet. Removes the seed from process.env. */
export function loadAgentWallet(): Wallet {
  loadEnv("agent");
  const seed = process.env.AGENT_SEED;
  if (!seed) throw new Error('AGENT_SEED missing: run "npm run setup:xrpl" to generate xrpl/.env.agent');
  const w = Wallet.fromSeed(seed);
  delete process.env.AGENT_SEED;
  const reg = loadRegistry();
  if (reg.signers.agent.address !== w.address) throw new Error(`AGENT_SEED derives ${w.address}, but the registry's agent signer is ${reg.signers.agent.address}`);
  return w;
}

export interface PayOptions {
  agentWallet: Wallet;
  cosignerUrl?: string;
  client?: Client;
  log?: (msg: string) => void;
}

export interface PayResult {
  decision: Decision;
  payment: Payment | null;
  destination: string | null;
  explorer_url: string | null;
  delivered_amount: unknown;
  engine_result: string | null;
  memo_json: string | null;
  /** Set once a transaction was submitted: validated | rejected | expired | unknown. */
  submit_status?: SubmitResult["status"];
}

type CosignResponse =
  | { ok: true; signer: "cosigner"; signer_address: string; signed_blob: string; checks: Check[] }
  | { ok: false; refusal_reasons?: string[]; checks?: Check[]; error?: string; message?: string };

function persist(decision: Decision, payment: Payment | null, extra: Record<string, unknown>): void {
  fs.appendFileSync(decisionsLogPath, JSON.stringify({ decision, payment, xrpl: extra }) + "\n");
}

/** POST /cosign. Never throws: transport errors, timeouts and non-JSON replies become {ok:false, error, message}. */
async function requestCosign(url: string, body: { tx_blob: string; invoice_id: string; decision_id: string }): Promise<{ status: number; cos: CosignResponse }> {
  let status = 0;
  try {
    const res = await fetch(`${url}/cosign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    status = res.status;
    const text = await res.text();
    try {
      return { status, cos: JSON.parse(text) as CosignResponse };
    } catch {
      return { status, cos: { ok: false, error: "bad_response", message: `co-signer at ${url} returned HTTP ${status} with a non-JSON body (${text.slice(0, 80).replace(/\s+/g, " ")})` } };
    }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const why = err.name === "TimeoutError" ? "did not answer within 20 s" : `is unreachable (${err.cause?.code ?? err.message})`;
    return { status, cos: { ok: false, error: "cosigner_unavailable", message: `co-signer at ${url} ${why}` } };
  }
}

export async function payInvoice(invoice: Invoice, opts: PayOptions): Promise<PayResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const reg = loadRegistry();
  const R = rlusd();
  if (reg.rlusd.issuer !== R.issuer || reg.rlusd.currency !== R.currency) throw new Error("RLUSD issuer/currency in the root .env differ from the registry");
  const tag = sourceTag();
  const now = new Date();
  const decision_id = newDecisionId(now);
  const created_at = isoSeconds(now);

  // 1. Destination comes ONLY from the registry, looked up by payee EIN.
  const hit = nonprofitByEin(reg, invoice.payee_ein);
  const np = hit ? { key: hit.key, entry: hit.np } : null;
  const core = decisionCore(invoice, decision_id, created_at, agentReasoning(invoice, np), tag);
  const decision_hash = computeDecisionHash(core);
  const base: Decision = {
    ...core,
    outcome: "refused",
    refusal_reasons: [],
    checks: [],
    enforced_by: null,
    decision_hash,
    xrpl_tx_hash: null,
    ledger_result: null,
    signers: [],
  };

  const amountOk = /^\d{1,12}(\.\d{1,6})?$/.test(invoice.amount) && Number(invoice.amount) > 0;
  if (!np || invoice.currency !== "RLUSD" || !amountOk) {
    const reasons: Decision["refusal_reasons"] = [];
    const checks: Check[] = [];
    if (!np) {
      reasons.push("destination_not_registry_wallet");
      checks.push({ name: "destination_is_registry_wallet", passed: false, detail: `No registry wallet for EIN ${invoice.payee_ein}; the payment builder refused before signing (nothing signed)` });
    }
    if (invoice.currency !== "RLUSD" || !amountOk) {
      reasons.push("bad_currency");
      checks.push({ name: "tx_format_valid", passed: false, detail: `Invoice amount ${invoice.amount} ${invoice.currency} is not a positive RLUSD amount; nothing signed` });
    }
    const decision: Decision = { ...base, refusal_reasons: reasons, checks };
    persist(decision, null, { stage: "payment_builder", invoice });
    log(`agent: refused before signing (${reasons.join(", ")})`);
    return { decision, payment: null, destination: null, explorer_url: null, delivered_amount: null, engine_result: null, memo_json: null };
  }
  const destination = np.entry.address;

  // 2-4. Memo + Payment, autofilled for 2 signers, signed by the agent in multisig form.
  const memo = buildMemo(core, decision_hash);
  const tx: XrplPayment = {
    TransactionType: "Payment",
    Account: reg.agent_account,
    Destination: destination,
    Amount: { currency: R.currency, issuer: R.issuer, value: invoice.amount },
    SourceTag: tag,
    Memos: [memo.memo],
  };
  const client = opts.client ?? (await connect());
  try {
    // Pre-flight: never submit a payment the working balance cannot cover (it would fail on-ledger with
    // tecPATH_PARTIAL, burn a Sequence and leave a failed tx carrying our memo in agent_account's history).
    const held = await tokenBalance(client, reg.agent_account, R.issuer, R.currency);
    if (held < Number(invoice.amount)) {
      throw new Error(
        `agent_account ${reg.agent_account} holds ${held} RLUSD, less than the ${invoice.amount} RLUSD invoice; ` +
          `run "npm run setup:xrpl" to top it up from city_treasury (nothing was signed or submitted)`,
      );
    }

    const prepared = await client.autofill(tx, 2);
    const lls = prepared.LastLedgerSequence;
    if (typeof lls !== "number") throw new Error("autofill did not set LastLedgerSequence");
    const agentBlob = opts.agentWallet.sign(prepared, true).tx_blob;
    log(`agent: built Payment ${invoice.amount} RLUSD -> ${destination} (${np.key}, EIN ${invoice.payee_ein}); memo ${memo.bytes} bytes; Sequence ${prepared.Sequence}, Fee ${prepared.Fee} drops, LastLedgerSequence ${lls}; agent_account holds ${held} RLUSD`);
    log(`agent: signed as agent ${opts.agentWallet.address} (weight 1); asking the co-signer`);

    // 5. Co-signer: separate process, separate key. It re-checks the decoded tx and signs or refuses.
    const url = (opts.cosignerUrl ?? process.env.COSIGNER_URL ?? "http://localhost:4002").replace(/\/$/, "");
    const { status, cos } = await requestCosign(url, { tx_blob: agentBlob, invoice_id: invoice.invoice_id, decision_id });
    if (!cos.ok) {
      // A co-signer that refuses, errors or cannot be reached never signs, so nothing can be submitted.
      // refusal_reasons: the co-signer's own codes; for transport/server errors, the generic co-signer-side code.
      const reasons = (cos.refusal_reasons?.length ? cos.refusal_reasons : ["verifier_rejected"]) as Decision["refusal_reasons"];
      const decision: Decision = { ...base, refusal_reasons: reasons, checks: cos.checks ?? [], enforced_by: "cosigner", signers: ["agent"] };
      persist(decision, null, {
        stage: "cosigner", http_status: status || null, cosigner_error: cos.error ?? null, cosigner_message: cos.message ?? null,
        destination, memo_json: memo.json, invoice,
      });
      log(`agent: co-signer did not sign (${status ? `HTTP ${status}` : "no HTTP response"}): ${cos.refusal_reasons?.join(", ") || cos.message || cos.error}; nothing submitted`);
      for (const c of cos.checks ?? []) if (!c.passed) log(`agent:   ${c.name}: ${c.detail}`);
      return { decision, payment: null, destination, explorer_url: null, delivered_amount: null, engine_result: null, memo_json: memo.json };
    }
    const cosSigner = (decode(cos.signed_blob) as { Signers?: { Signer: { Account: string } }[] }).Signers?.[0]?.Signer.Account;
    if (cosSigner !== reg.signers.cosigner.address) throw new Error(`co-signer returned a signature from ${cosSigner}, not the registry cosigner ${reg.signers.cosigner.address}`);
    log(`agent: co-signer ${cos.signer_address} signed (${cos.checks.map((c) => `${c.name}=${c.passed ? "pass" : "FAIL"}`).join(", ")})`);

    // 6. Combine (multisign() verifies both blobs are the same transaction) and submit. Wait for a FINAL status:
    // validated, rejected (tef/tem/tel), or the validated ledger passed LastLedgerSequence without it.
    const combined = multisign([agentBlob, cos.signed_blob]);
    const hash = hashes.hashSignedTx(combined);
    log(`agent: submitting ${hash}; waiting until it is validated or the ledger passes LastLedgerSequence ${lls}`);
    const sub = await submitBlobAndWait(client, combined, hash, lls);
    log(`agent: engine_result ${sub.engine_result} -> ${sub.status}: ${sub.final}`);

    // 7. Persist the full Decision + Payment.
    const released = sub.validated && sub.final === "tesSUCCESS";
    const onLedger = sub.validated; // tesSUCCESS or tec*: has an explorer page
    // unknown: the final status could not be established; keep the hash so it can be reconciled, claim no reason.
    const unknown = sub.status === "unknown";
    const decision: Decision = {
      ...base,
      outcome: released ? "released" : "refused",
      refusal_reasons: released || unknown ? [] : ["ledger_rejected"],
      checks: cos.checks,
      enforced_by: released || unknown ? null : "ledger",
      xrpl_tx_hash: onLedger || unknown ? hash : null,
      ledger_result: sub.final,
      signers: ["agent", "cosigner"],
    };
    const explorer_url = onLedger || unknown ? explorerTx(hash) : null;
    const payment: Payment = {
      payment_id: `pay_${decision_id.slice(4)}`,
      source: "xrpl",
      contract_id: invoice.contract_id,
      payee_ein: invoice.payee_ein,
      amount: invoice.amount,
      currency: "RLUSD",
      date: sub.close_time_iso ?? created_at,
      status: decision.outcome,
      invoice_id: invoice.invoice_id,
      ...(explorer_url ? { xrpl_tx_hash: hash, explorer_url } : {}),
      memo_hash: memoHash(memo.json),
      is_demo_data: true,
    };
    const delivered = (sub.meta as { delivered_amount?: unknown } | undefined)?.delivered_amount ?? null;
    persist(decision, payment, {
      stage: "ledger", tx_hash: hash, submit_status: sub.status, engine_result: sub.engine_result, engine_result_message: sub.engine_result_message,
      final_result: sub.final, last_ledger_sequence: lls, ledger_index: sub.ledger_index ?? null,
      destination, np_key: np.key, delivered_amount: delivered, memo_json: memo.json, fee_drops: prepared.Fee, invoice,
    });
    if (unknown) log(`agent: WARNING: final status of ${hash} is unknown (lost contact before the ledger passed LastLedgerSequence ${lls}); check ${explorerTx(hash)}`);
    return { decision, payment, destination, explorer_url, delivered_amount: delivered, engine_result: sub.engine_result, memo_json: memo.json, submit_status: sub.status };
  } finally {
    if (!opts.client) await client.disconnect();
  }
}
