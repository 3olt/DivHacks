// The payment agent's signing path. Holds ONLY the agent signer key (weight 1 of quorum 3 on agent_account).
// payInvoice(): destination from the registry by EIN -> decision core + decision_hash -> RLUSD Payment with memo +
// SourceTag -> agent multisig signature -> co-signer (separate process, separate key) checks and co-signs or refuses ->
// multisign -> submit -> wait for a FINAL status -> Decision + Payment to Mongo (+ local JSONL backup).
// Every attempt that gets as far as a decision id is recorded, including ones that fail with an exception after that
// (balance pre-flight, autofill, an unusable co-signer reply, ...): refused with a machine code and 8 "not evaluated"
// checks. Nothing is submitted in those cases.
//
// Two SIMULATED COMPROMISED-AGENT modes exist only for the injection demo (clearly labelled in the decision):
//   compromised_cosigner    obeys an injected address and still asks the co-signer  -> the co-signer refuses
//   compromised_agent_only  obeys it and submits with its own signature only       -> the LEDGER refuses (tefBAD_QUORUM)
import { Wallet, multisign, hashes, decode, type Client, type Payment as XrplPayment } from "xrpl";
import type { Db } from "mongodb";
import type { Check, Decision, Invoice, Payment, RefusalCode } from "../../../shared/contracts";
import { memoHash } from "../../../shared/hash";
import { loadEnv } from "../env";
import { explorerTx, rlusd, sourceTag, submitBlobAndWait, tokenBalance, type SubmitResult } from "../lib/xrpl";
import { loadRegistry, nonprofitByEin, type Registry } from "../lib/registry";
import { notEvaluatedChecks } from "../cosigner/checks";
import { baseDecision, buildMemo, decisionCore, isoSeconds, newDecisionId, paymentFor } from "./decision";
import { agentAudit } from "./audit";
import type { Recorder, RecordResult } from "./record";

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

export interface AgentCtx {
  agentWallet: Wallet;
  client: Client;
  db: Db | null;
  recorder: Recorder;
  reg: Registry;
  cosignerUrl: string;
  log: (msg: string) => void;
}

export interface Attempt {
  decision: Decision;
  payment: Payment;
  destination: string | null;
  explorer_url: string | null;
  delivered_amount: unknown;
  engine_result: string | null;
  memo_json: string | null;
  /** Set once a transaction was submitted: validated | rejected | expired | unknown. */
  submit_status?: SubmitResult["status"];
  recorded: RecordResult;
}

export type PayMode =
  | { kind: "normal" }
  | { kind: "compromised_cosigner"; destination: string }
  | { kind: "compromised_agent_only"; destination: string };

type CosignResponse =
  | { ok: true; signer: "cosigner"; signer_address: string; signed_blob: string; checks: Check[] }
  | { ok: false; refusal_reasons?: string[]; checks?: Check[]; error?: string; message?: string };

/** POST /cosign. Never throws: transport errors, timeouts and non-JSON replies become {ok:false, error, message}. */
async function requestCosign(url: string, body: { tx_blob: string; invoice_id: string; decision_id: string }): Promise<{ status: number; cos: CosignResponse }> {
  let status = 0;
  try {
    const res = await fetch(`${url}/cosign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
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
    const why = err.name === "TimeoutError" ? "did not answer within 30 s" : `is unreachable (${err.cause?.code ?? err.message})`;
    return { status, cos: { ok: false, error: "cosigner_unavailable", message: `co-signer at ${url} ${why}` } };
  }
}

export async function payInvoice(invoice: Invoice, ctx: AgentCtx, opts: { reasoning: string; audit?: Record<string, unknown>; mode?: PayMode }): Promise<Attempt> {
  const { client, reg, log } = ctx;
  const mode = opts.mode ?? { kind: "normal" };
  const R = rlusd();
  if (reg.rlusd.issuer !== R.issuer || reg.rlusd.currency !== R.currency) throw new Error("RLUSD issuer/currency in the root .env differ from the registry");
  const tag = sourceTag();
  const now = new Date();
  const decision_id = newDecisionId(now);
  const created_at = isoSeconds(now);
  const core = decisionCore(invoice, decision_id, created_at, opts.reasoning, tag);
  const base = baseDecision(core);
  const auditBase = { ...(opts.audit ?? {}), mode: mode.kind, invoice };
  const st: AttemptState = { stage: "payment_builder", destination: null, memo_json: null, memo_hash: null, agentSigned: false, hash: null };

  const run = async (): Promise<Attempt> => {

    // 1. Destination: ONLY the registry wallet for the payee EIN (the simulated compromised modes override it).
    const hit = nonprofitByEin(reg, invoice.payee_ein);
    const destination = mode.kind === "normal" ? (hit?.np.address ?? null) : mode.destination;
    st.destination = destination;
    if (!destination) {
      const decision: Decision = {
        ...base,
        refusal_reasons: ["destination_not_registry_wallet"],
        checks: notEvaluatedChecks(`no registry wallet for EIN ${invoice.payee_ein}; the payment builder refused before signing`),
      };
      const payment = paymentFor(decision);
      const recorded = await ctx.recorder.record(decision, payment, { ...auditBase, stage: "payment_builder", destination: null });
      return { decision, payment, destination: null, explorer_url: null, delivered_amount: null, engine_result: null, memo_json: null, recorded };
    }

    // 2. Memo + Payment, autofilled, signed by the agent in multisig form.
    const memo = buildMemo(core, base.decision_hash);
    const memo_hash = memoHash(memo.json);
    st.memo_json = memo.json;
    st.memo_hash = memo_hash;
    st.stage = "preflight";
    const tx: XrplPayment = {
      TransactionType: "Payment",
      Account: reg.agent_account,
      Destination: destination,
      Amount: { currency: R.currency, issuer: R.issuer, value: invoice.amount },
      SourceTag: tag,
      Memos: [memo.memo],
    };
    // Pre-flight: never submit a payment the working balance cannot cover (it would fail on-ledger with tecPATH_PARTIAL).
    const held = await tokenBalance(client, reg.agent_account, R.issuer, R.currency);
    if (held < Number(invoice.amount)) {
      throw new AgentBalanceError(
        `agent_account ${reg.agent_account} holds ${held} RLUSD, less than the ${invoice.amount} RLUSD invoice; ` +
          `run "npm run setup:xrpl" to top it up from city_treasury (nothing was signed or submitted)`,
      );
    }
    const agentOnly = mode.kind === "compromised_agent_only";
    st.stage = "autofill";
    const prepared = await client.autofill(tx, agentOnly ? 1 : 2);
    const lls = prepared.LastLedgerSequence;
    if (typeof lls !== "number") throw new Error("autofill did not set LastLedgerSequence");
    const agentBlob = ctx.agentWallet.sign(prepared, true).tx_blob;
    st.agentSigned = true;
    log(`agent: built Payment ${invoice.amount} RLUSD -> ${destination}${hit && mode.kind === "normal" ? ` (${hit.key}, EIN ${invoice.payee_ein})` : " (NOT a registry wallet)"}; memo ${memo.bytes} bytes; Sequence ${prepared.Sequence}, LastLedgerSequence ${lls}; agent_account holds ${held} RLUSD`);

    // 3a. SIMULATED compromised agent: skip the co-signer and submit with the agent's signature alone.
    if (agentOnly) {
      const blob = multisign([agentBlob]);
      const hash = hashes.hashSignedTx(blob);
      st.stage = "ledger";
      st.hash = hash;
      log(`agent: [SIMULATED COMPROMISED AGENT] submitting ${hash} with ONLY the agent signature (weight 1 of quorum 3), skipping the co-signer`);
      const sub = await submitBlobAndWait(client, blob, hash, lls);
      log(`ledger: engine_result ${sub.engine_result} (${sub.engine_result_message}) -> ${sub.status}: ${sub.final}`);
      const audit = await agentAudit(decode(agentBlob) as Record<string, unknown>, invoice.invoice_id, ctx, "post-hoc; this tx never reached the co-signer");
      const released = sub.validated && sub.final === "tesSUCCESS";
      const first: RefusalCode = sub.status === "unknown" ? "ledger_status_unknown" : "ledger_rejected";
      const decision: Decision = {
        ...base,
        outcome: released ? "released" : "refused",
        refusal_reasons: released ? [] : ([...new Set([first, ...audit.refusal_reasons])] as RefusalCode[]),
        checks: audit.checks,
        enforced_by: released || sub.status === "unknown" ? null : "ledger",
        xrpl_tx_hash: sub.validated || sub.status === "unknown" ? hash : null,
        ledger_result: sub.final,
        signers: ["agent"],
      };
      const payment = paymentFor(decision, { memo_hash, ...(decision.xrpl_tx_hash ? { xrpl_tx_hash: hash, explorer_url: explorerTx(hash) } : {}) });
      const recorded = await ctx.recorder.record(decision, payment, {
        ...auditBase, stage: "ledger", destination, tx_hash: hash, engine_result: sub.engine_result, engine_result_message: sub.engine_result_message,
        final_result: sub.final, submit_status: sub.status, memo_json: memo.json, last_ledger_sequence: lls,
      });
      return { decision, payment, destination, explorer_url: decision.xrpl_tx_hash ? explorerTx(hash) : null, delivered_amount: null, engine_result: sub.engine_result, memo_json: memo.json, submit_status: sub.status, recorded };
    }

    // 3b. Co-signer: separate process, separate key. It re-checks the decoded tx from its own sources and signs or refuses.
    log(`agent: signed as agent ${ctx.agentWallet.address} (weight 1); asking the co-signer`);
    st.stage = "cosigner";
    const { status, cos } = await requestCosign(ctx.cosignerUrl, { tx_blob: agentBlob, invoice_id: invoice.invoice_id, decision_id });
    if (!cos.ok) {
      const transport = !cos.refusal_reasons?.length;
      const reasons = (transport ? ["cosigner_unavailable"] : cos.refusal_reasons) as RefusalCode[];
      const decision: Decision = {
        ...base,
        refusal_reasons: reasons,
        checks: cos.checks?.length ? cos.checks : notEvaluatedChecks(`the co-signer did not evaluate the tx (${cos.error ?? "error"}: ${cos.message ?? `HTTP ${status}`})`),
        enforced_by: "cosigner",
        signers: ["agent"],
      };
      const payment = paymentFor(decision, { memo_hash });
      const recorded = await ctx.recorder.record(decision, payment, {
        ...auditBase, stage: "cosigner", http_status: status || null, cosigner_error: cos.error ?? null, cosigner_message: cos.message ?? null, destination, memo_json: memo.json,
      });
      log(`co-signer: REFUSED (${status ? `HTTP ${status}` : "no HTTP response"}): ${reasons.join(", ")}${cos.message ? ` - ${cos.message}` : ""}; nothing signed, nothing submitted`);
      return { decision, payment, destination, explorer_url: null, delivered_amount: null, engine_result: null, memo_json: memo.json, recorded };
    }
    let cosSigner: string | undefined;
    try {
      cosSigner = (decode(String(cos.signed_blob)) as { Signers?: { Signer: { Account: string } }[] }).Signers?.[0]?.Signer.Account;
    } catch (e) {
      throw new CosignerReplyError(`the co-signer said ok but its signed_blob does not decode (${(e as Error).message})`);
    }
    if (cosSigner !== reg.signers.cosigner.address) throw new CosignerReplyError(`the co-signer returned a signature from ${cosSigner ?? "(none)"}, not the registry cosigner ${reg.signers.cosigner.address}`);
    log(`co-signer: SIGNED (${cos.checks.filter((c) => c.passed).length}/${cos.checks.length} checks passed)`);

    // 4. Combine (multisign() verifies both blobs are the same transaction) and submit; wait for a FINAL status.
    let combined: string;
    try {
      combined = multisign([agentBlob, cos.signed_blob]);
    } catch (e) {
      throw new CosignerReplyError(`the co-signer's signed_blob cannot be combined with the agent's (${(e as Error).message})`);
    }
    const hash = hashes.hashSignedTx(combined);
    st.stage = "ledger";
    st.hash = hash;
    log(`agent: submitting ${hash}; waiting until it is validated or the ledger passes LastLedgerSequence ${lls}`);
    const sub = await submitBlobAndWait(client, combined, hash, lls);
    log(`ledger: engine_result ${sub.engine_result} -> ${sub.status}: ${sub.final}`);

    const released = sub.validated && sub.final === "tesSUCCESS";
    const onLedger = sub.validated;
    const unknown = sub.status === "unknown";
    const decision: Decision = {
      ...base,
      outcome: released ? "released" : "refused",
      refusal_reasons: released ? [] : unknown ? ["ledger_status_unknown"] : ["ledger_rejected"],
      checks: cos.checks,
      enforced_by: released || unknown ? null : "ledger",
      xrpl_tx_hash: onLedger || unknown ? hash : null,
      ledger_result: sub.final,
      signers: ["agent", "cosigner"],
    };
    const explorer_url = onLedger || unknown ? explorerTx(hash) : null;
    const payment = paymentFor(decision, { date: sub.close_time_iso ?? created_at, memo_hash, ...(explorer_url ? { xrpl_tx_hash: hash, explorer_url } : {}) });
    const delivered = (sub.meta as { delivered_amount?: unknown } | undefined)?.delivered_amount ?? null;
    const recorded = await ctx.recorder.record(decision, payment, {
      ...auditBase, stage: "ledger", tx_hash: hash, submit_status: sub.status, engine_result: sub.engine_result, engine_result_message: sub.engine_result_message,
      final_result: sub.final, last_ledger_sequence: lls, ledger_index: sub.ledger_index ?? null, destination, np_key: hit?.key ?? null,
      delivered_amount: delivered, memo_json: memo.json, fee_drops: prepared.Fee,
    });
    if (unknown) log(`agent: WARNING: final status of ${hash} is unknown (no definitive answer before the deadline); recorded as ledger_status_unknown. Run "npm run reconcile -w xrpl" to settle it from the ledger (${explorerTx(hash)})`);
    return { decision, payment, destination, explorer_url, delivered_amount: delivered, engine_result: sub.engine_result, memo_json: memo.json, submit_status: sub.status, recorded };
  };

  try {
    return await run();
  } catch (e) {
    return recordFailure(e as Error, ctx, base, auditBase, st);
  }
}

/** Pre-flight: agent_account cannot cover the invoice. */
class AgentBalanceError extends Error {}
/** The co-signer answered ok but its reply is unusable (undecodable, wrong signer, different transaction). */
class CosignerReplyError extends Error {}

interface AttemptState {
  stage: "payment_builder" | "preflight" | "autofill" | "cosigner" | "ledger";
  destination: string | null;
  memo_json: string | null;
  memo_hash: string | null;
  agentSigned: boolean;
  hash: string | null;
}

/** Records an attempt that threw after its decision id existed: refused, with a machine code and "not evaluated" checks. */
async function recordFailure(e: Error, ctx: AgentCtx, base: Decision, auditBase: Record<string, unknown>, st: AttemptState): Promise<Attempt> {
  const msg = e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>").slice(0, 400);
  const submitted = st.stage === "ledger" && !!st.hash;
  const code: RefusalCode =
    e instanceof AgentBalanceError ? "agent_balance_insufficient"
    : e instanceof CosignerReplyError ? "cosigner_unavailable"
    : submitted ? "ledger_status_unknown"
    : "ledger_unavailable";
  const decision: Decision = {
    ...base,
    refusal_reasons: [code],
    checks: notEvaluatedChecks(`the attempt failed at the ${st.stage} stage (${msg})${submitted ? "" : "; nothing was submitted"}`),
    enforced_by: code === "cosigner_unavailable" ? "cosigner" : null,
    xrpl_tx_hash: submitted ? st.hash : null,
    ledger_result: submitted ? "unknown" : null,
    signers: st.agentSigned ? ["agent"] : [],
  };
  const payment = paymentFor(decision, { ...(st.memo_hash ? { memo_hash: st.memo_hash } : {}), ...(submitted && st.hash ? { xrpl_tx_hash: st.hash, explorer_url: explorerTx(st.hash) } : {}) });
  const recorded = await ctx.recorder.record(decision, payment, { ...auditBase, stage: st.stage, error: msg, destination: st.destination, memo_json: st.memo_json, submitted });
  ctx.log(`agent: attempt FAILED at the ${st.stage} stage (${code}): ${msg}; recorded as refused${submitted ? "" : ", nothing submitted"}`);
  return {
    decision, payment, destination: st.destination, explorer_url: submitted && st.hash ? explorerTx(st.hash) : null, delivered_amount: null,
    engine_result: null, memo_json: st.memo_json, submit_status: submitted ? "unknown" : undefined, recorded,
  };
}
