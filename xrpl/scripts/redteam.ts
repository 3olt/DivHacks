// LIVE negative tests against a real co-signer process (XRPL Testnet + MongoDB), one per guardrail the scenarios do not
// already hit: crafted, agent-signed transactions are POSTed to /cosign and each must come back 422 with the expected
// failing check and refusal code. NOTHING IS EVER SUBMITTED to the ledger by this script, and no RLUSD moves.
// Every crafted tx that could otherwise pass carries a deliberate second defect (a wrong SourceTag), so even a
// guardrail regression cannot produce a usable co-signature.
//
// It spawns its own co-signer instances on port 4012 (never your 4002 co-signer):
//   instance A: started with LOOSENED policy values in its environment (AUTO_LIMIT etc. = 1000000, another database,
//               a non-Testnet node). They must be discarded: /health must show the root .env values.
//               -> auto-limit, forged officer, tx format, amount precision, exclusions, unknown / late / changed /
//                  expired contracts, re-spelled paid invoices, registry drift, (Phase 3) no on-ledger credential (np_4),
//                  a payee change hold whose database document is DELETED (still enforced; the officer resolves it from
//                  the co-signer's own record)
//   instance B: TEST caps via the tighten-only COSIGNER_TEST_DAILY_CAP=60, COSIGNER_TEST_PAYEE_DAILY_CAP=50 (and a
//               COSIGNER_TEST_AUTO_LIMIT that tries to LOOSEN, which must be ignored) -> daily caps
// It writes temporary documents to the SHARED database (REDTEAM-* demo contracts, one demo nonprofit wallet to cause
// registry drift, one payee change request for the fictional EIN 00-0000097, resolved by the officer) and deletes them at the end. A co-signer running elsewhere would see that registry drift, so this
// script refuses to run while a co-signer answers at COSIGNER_URL (override: REDTEAM_ALLOW_SHARED=1).
//
// Run: npm run redteam   (repo root)
import { Wallet, decode, encode, type Payment as XrplPayment } from "xrpl";
import { randomBytes } from "node:crypto";
import { MEMO_TYPE, MEMO_FORMAT, memoJson } from "../../shared/hash";
import { loadAgentWallet } from "../src/agent/payInvoice";
import { loadRegistry } from "../src/lib/registry";
import { readRootEnvFile } from "../src/env";
import { connect, rlusd, sourceTag, toHex } from "../src/lib/xrpl";
import { scanAgentHistory } from "../src/lib/ledgerScan";
import { COLL, openMongo, type ContractDoc, type NonprofitDoc } from "../src/lib/mongo";
import { describeHealth, health, policyProblems, runOfficerResolve, spawnCosigner, stopChild, waitHealthy } from "./_cosigner";

const PORT = 4012;
const URL_ = `http://localhost:${PORT}`;
const BAD_TAG = { SourceTag: 1 }; // the deliberate second defect

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${detail}`);
};

async function main(): Promise<number> {
  const agent = loadAgentWallet();
  const reg = loadRegistry();
  const R = rlusd();
  const np1 = reg.nonprofits.np_1;
  const np2 = reg.nonprofits.np_2;
  if (await health(URL_)) throw new Error(`something already answers on ${URL_}; stop it first`);
  const shared = (process.env.COSIGNER_URL ?? "http://localhost:4002").replace(/\/$/, "");
  if ((await health(shared)) && process.env.REDTEAM_ALLOW_SHARED !== "1") {
    throw new Error(`a co-signer is running at ${shared}; this script briefly changes the shared registry (registry_drift for that co-signer). Stop it first, or set REDTEAM_ALLOW_SHARED=1`);
  }
  const client = await connect();
  const mongo = await openMongo("divhacks-redteam");
  const st = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const C = { excl: `REDTEAM-EXCL-${st}`, swap: `REDTEAM-SWAP-${st}`, old: `REDTEAM-OLD-${st}`, late: `REDTEAM-LATE-${st}` };
  const driftEin = `00-00099${String(Math.floor(Math.random() * 90) + 10)}`;
  const cleanup: (() => Promise<unknown>)[] = [];

  const memo = (inv: string, ctr = np1.contract_id, ein = np1.ein) => ({
    Memo: { MemoType: toHex(MEMO_TYPE), MemoFormat: toHex(MEMO_FORMAT), MemoData: toHex(memoJson({ invoice_id: inv, contract_id: ctr, payee_ein: ein, decision_hash: randomBytes(32).toString("hex"), rule_version: "redteam" })) },
  });
  async function craft(inv: string, over: Record<string, unknown> = {}, extraSigner?: { wallet: Wallet; claimAs?: string }) {
    const tx: XrplPayment = {
      TransactionType: "Payment", Account: reg.agent_account, Destination: np1.address,
      Amount: { currency: R.currency, issuer: R.issuer, value: "1" }, SourceTag: sourceTag(), Memos: [memo(inv)],
    };
    const prepared = { ...(await client.autofill(tx, extraSigner ? 3 : 2)), ...over } as XrplPayment;
    const agentTx = decode(agent.sign(prepared, true).tx_blob) as Record<string, unknown>;
    if (extraSigner) {
      const s = (decode(extraSigner.wallet.sign(prepared, true).tx_blob) as { Signers: { Signer: { Account: string } }[] }).Signers[0];
      if (extraSigner.claimAs) s.Signer.Account = extraSigner.claimAs;
      agentTx.Signers = [...(agentTx.Signers as unknown[]), s];
    }
    return encode(agentTx as never);
  }
  /** A tx with a custom memo (contract / EIN / invoice spelling), re-signed by the agent. */
  async function craftMemo(inv: string, ctr: string, ein: string, over: Record<string, unknown> = {}) {
    const t = decode(await craft(inv, over)) as Record<string, unknown>;
    t.Memos = [memo(inv, ctr, ein)];
    delete t.Signers;
    return agent.sign(t as never, true).tx_blob;
  }
  async function attempt(url: string, name: string, inv: string, blob: string, want: { failed: string[]; codes: string[]; absent?: string[] }) {
    const res = await fetch(`${url}/cosign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_blob: blob, invoice_id: inv, decision_id: `dec_redteam_${randomBytes(3).toString("hex")}` }) });
    const body = (await res.json()) as { ok: boolean; signed_blob?: string; refusal_reasons?: string[]; checks?: { name: string; passed: boolean; detail: string }[] };
    const failed = (body.checks ?? []).filter((c) => !c.passed).map((c) => c.name);
    const codes = body.refusal_reasons ?? [];
    const ok =
      res.status === 422 && !body.signed_blob && (body.checks ?? []).length === 8 &&
      want.failed.every((f) => failed.includes(f)) && want.codes.every((c) => codes.includes(c)) && !(want.absent ?? []).some((c) => codes.includes(c));
    record(name, ok, `HTTP ${res.status} failed=[${failed.join(",")}] codes=[${codes.join(",")}]`);
    if (!ok || process.env.REDTEAM_VERBOSE) for (const c of (body.checks ?? []).filter((x) => !x.passed)) console.log(`        ${c.name}: ${c.detail}`);
  }
  const contractDoc = (contract_id: string, ein: string, budget: string, end_date = "2026-12-31"): ContractDoc => ({
    contract_id, agency_code: "HRA", nonprofit_ein: ein, amount: budget, start_date: "2026-09-01", end_date, registered_date: null, spent_to_date: "0.00",
    purpose: "red-team test contract (fictional, deleted after the test)", source: "demo: xrpl red-team test",
    source_url: "https://github.com/3olt/DivHacks/blob/main/xrpl/README.md", xrpl_budget_rlusd: budget, is_demo_data: true,
  });
  const insertContract = async (d: ContractDoc) => {
    await mongo.db.collection<ContractDoc>(COLL.contracts).insertOne({ ...d });
    cleanup.push(() => mongo.db.collection(COLL.contracts).deleteOne({ contract_id: d.contract_id }));
  };

  let child = null as ReturnType<typeof spawnCosigner> | null;
  try {
    // Contracts that must exist BEFORE instance A starts, so it pins them.
    await insertContract(contractDoc(C.excl, "00-0000090", "100.00")); // payee on the fictional exclusion list
    await insertContract(contractDoc(C.swap, np1.ein, "5.00")); // its payee is swapped to np_2 while A runs
    await insertContract(contractDoc(C.old, np1.ein, "5.00", "2020-12-31")); // term ended

    // ---------------- instance A: normal policy; loosened values in its environment must be discarded ----------------
    console.log(`\n=== red-team instance A on ${URL_}: started with AUTO_LIMIT/DAILY_CAP/PAYEE_DAILY_CAP=1000000, MONGODB_DB and XRPL_WS overrides in its env ===`);
    child = spawnCosigner({
      extraEnv: {
        COSIGNER_PORT: String(PORT), COSIGNER_URL: URL_, AUTO_LIMIT: "1000000", DAILY_CAP: "1000000", PAYEE_DAILY_CAP: "1000000",
        MONGODB_DB: "redteam_attacker_db", XRPL_WS: "wss://attacker-node.example.com/testnet",
      },
      prefix: "  A| ",
    });
    const hA = await waitHealthy(child, URL_);
    console.log(`co-signer A: ${describeHealth(hA)}`);
    const probs = policyProblems(hA);
    const file = readRootEnvFile();
    record(
      "env: inherited loosened limits / database / node are discarded",
      probs.length === 0 && hA.auto_limit === Number(file.AUTO_LIMIT ?? "25") && (hA.policy?.discarded_inherited_keys ?? []).length >= 5,
      `AUTO_LIMIT ${hA.auto_limit}, DAILY_CAP ${hA.caps?.daily_cap}, PAYEE_DAILY_CAP ${hA.caps?.payee_daily_cap}, db ${hA.policy?.mongodb_db}; discarded [${(hA.policy?.discarded_inherited_keys ?? []).join(",")}]${probs.length ? `; PROBLEMS: ${probs.join("; ")}` : ""}`,
    );
    const inv = (k: string) => `INV-RT-${k}-${st}`;

    await attempt(URL_, "5 over AUTO_LIMIT (30 RLUSD), no officer", inv("OVER"), await craft(inv("OVER"), { Amount: { currency: R.currency, issuer: R.issuer, value: "30" } }), { failed: ["within_auto_limit_or_officer_signed"], codes: ["over_auto_limit_needs_officer"] });
    await attempt(URL_, "5 over AUTO_LIMIT with a FORGED officer signature", inv("FORGE"), await craft(inv("FORGE"), { Amount: { currency: R.currency, issuer: R.issuer, value: "30" } }, { wallet: Wallet.generate(), claimAs: reg.signers.officer.address }), { failed: ["within_auto_limit_or_officer_signed", "tx_format_valid"], codes: ["over_auto_limit_needs_officer", "bad_tx_fields"] });
    await attempt(URL_, "8 wrong SourceTag", inv("TAG"), await craft(inv("TAG"), { SourceTag: 12345 }), { failed: ["tx_format_valid"], codes: ["bad_source_tag"] });
    await attempt(URL_, "8 extra field (DestinationTag)", inv("DT"), await craft(inv("DT"), { DestinationTag: 42 }), { failed: ["tx_format_valid"], codes: ["bad_tx_fields"] });
    await attempt(URL_, "8 tfPartialPayment flag", inv("PP"), await craft(inv("PP"), { Flags: 0x00020000 }), { failed: ["tx_format_valid"], codes: ["bad_tx_fields"] });
    await attempt(URL_, "8 amount with 7 decimals (0.9999999) is refused, not rounded", inv("DEC"), await craft(inv("DEC"), { Amount: { currency: R.currency, issuer: R.issuer, value: "0.9999999" } }), { failed: ["tx_format_valid"], codes: ["bad_tx_fields"] });
    const cur = await client.request({ command: "account_info", account: reg.agent_account, ledger_index: "current" });
    await attempt(URL_, "8 future Sequence (pre-collecting co-signatures)", inv("SEQ"), await craft(inv("SEQ"), { Sequence: cur.result.account_data.Sequence + 1 }), { failed: ["tx_format_valid"], codes: ["tx_not_fresh"] });
    await attempt(URL_, "8 fake RLUSD (issuer = attacker)", inv("CUR"), await craft(inv("CUR"), { Amount: { currency: R.currency, issuer: reg.attacker, value: "1" } }), { failed: ["tx_format_valid"], codes: ["bad_currency"] });
    await attempt(URL_, "8 memo inv does not match invoice_id", inv("MEMO"), await craft(inv("OTHER")), { failed: ["tx_format_valid"], codes: ["bad_memo"] });
    await attempt(URL_, "8 unknown extra signer", inv("SIGN"), await craft(inv("SIGN"), {}, { wallet: Wallet.generate() }), { failed: ["tx_format_valid"], codes: ["bad_tx_fields"] });

    // 3 re-spelled invoice ids of an invoice already paid to np_1 on-ledger
    const hist = await scanAgentHistory(client, reg.agent_account, R);
    const paid = hist.payments.find((p) => p.memo?.ein === np1.ein && p.memo.ctr === np1.contract_id && /-/.test(p.memo.inv));
    if (!paid?.memo) throw new Error("no on-ledger payment to np_1 with a memo found; run npm run demo happy first");
    const lower = paid.memo.inv.toLowerCase();
    const squashed = paid.memo.inv.replace(/-/g, "");
    await attempt(URL_, `3 paid invoice re-spelled lower-case (${lower})`, lower, await craftMemo(lower, np1.contract_id, np1.ein, BAD_TAG), { failed: ["invoice_not_already_paid"], codes: ["invoice_already_paid", "bad_memo"] });
    await attempt(URL_, `3 paid invoice with a trailing dot`, `${paid.memo.inv}.`, await craftMemo(`${paid.memo.inv}.`, np1.contract_id, np1.ein, BAD_TAG), { failed: ["invoice_not_already_paid"], codes: ["invoice_already_paid", "bad_memo"] });
    await attempt(URL_, `3 paid invoice, canonical but dashes removed (${squashed})`, squashed, await craftMemo(squashed, np1.contract_id, np1.ein, BAD_TAG), { failed: ["invoice_not_already_paid"], codes: ["invoice_already_paid"] });

    // 2/4 contracts: unknown, changed after startup, created after startup with a big budget, term ended
    const ghost = `REDTEAM-NOCONTRACT-${st}`;
    await attempt(URL_, "2/4 memo ctr is not in the contracts collection", inv("GHOST"), await craftMemo(inv("GHOST"), ghost, np1.ein), { failed: ["destination_is_registry_wallet", "within_contract_amount"], codes: ["contract_not_found"] });
    await mongo.db.collection<ContractDoc>(COLL.contracts).updateOne({ contract_id: C.swap }, { $set: { nonprofit_ein: np2.ein } });
    await attempt(URL_, "2 pinned contract's payee swapped in the DB while running", inv("SWAP"), await craftMemo(inv("SWAP"), C.swap, np2.ein, { ...BAD_TAG, Destination: np2.address }), { failed: ["destination_is_registry_wallet"], codes: ["registry_drift"] });
    await insertContract(contractDoc(C.late, np1.ein, "1000000.00"));
    await attempt(URL_, "2/4 contract created after startup with a 1,000,000 budget", inv("LATE"), await craftMemo(inv("LATE"), C.late, np1.ein, BAD_TAG), { failed: ["destination_is_registry_wallet", "within_contract_amount"], codes: ["contract_not_found"] });
    await attempt(URL_, "4 contract term ended (end_date 2020-12-31)", inv("OLD"), await craftMemo(inv("OLD"), C.old, np1.ein, BAD_TAG), { failed: ["within_contract_amount"], codes: ["contract_not_active"] });

    // 7 excluded payee (contract pinned at startup)
    await attempt(URL_, "7 payee EIN on the exclusion list (00-0000090)", inv("EXCL"), await craftMemo(inv("EXCL"), C.excl, "00-0000090"), { failed: ["payee_not_excluded"], codes: ["payee_excluded"] });

    // 2 registry drift: add a wallet to the registry while the co-signer runs (as a compromised agent with DB access could)
    await mongo.db.collection<NonprofitDoc>(COLL.nonprofits).insertOne({
      ein: driftEin, name: "Red-team injected payee (demo)", address: "n/a", service_types: [],
      wallet: { address: reg.attacker, credential_status: "valid", credential_expires: "2027-01-01T00:00:00Z", bank_verified: false }, is_demo_data: true,
    });
    const removeDrift = () => mongo.db.collection(COLL.nonprofits).deleteOne({ ein: driftEin });
    cleanup.push(removeDrift);
    await attempt(URL_, "2 registry changed in Mongo after startup (drift)", inv("DRIFT"), await craft(inv("DRIFT"), BAD_TAG), { failed: ["destination_is_registry_wallet"], codes: ["registry_drift"] });
    await removeDrift();
    await attempt(URL_, "2 drift reverted -> registry_drift gone (other defect kept)", inv("DRIFT2"), await craft(inv("DRIFT2"), BAD_TAG), { failed: ["tx_format_valid"], codes: ["bad_source_tag"], absent: ["registry_drift"] });

    // 1 (Phase 3) on-ledger credential: np_4 was never onboarded, so ledger_entry finds no credential for its wallet
    const np4 = reg.nonprofits.np_4;
    await attempt(URL_, "1 np_4 registry wallet has no on-ledger credential", inv("NOCRED"), await craftMemo(inv("NOCRED"), np4.contract_id, np4.ein, { ...BAD_TAG, Destination: np4.address }), { failed: ["credential_valid"], codes: ["credential_invalid"], absent: ["destination_not_registry_wallet"] });

    // 2 (Phase 3) payee change hold for a fictional EIN; its document is then DELETED from Mongo (a compromised agent could)
    const holdEin = "00-0000097";
    const reqId = `pcr_redteam_${st.replace("-", "")}`;
    const created = new Date();
    await mongo.db.collection(COLL.payeeChangeRequests).insertOne({
      request_id: reqId, ein: holdEin, current_address: np1.address, requested_address: reg.attacker, reason: "red-team hold (fictional EIN)", contact: "red-team",
      status: "on_hold", created_at: created.toISOString().replace(/\.\d{3}Z$/, "Z"), hold_until: new Date(created.getTime() + 72 * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z"),
      requires: { nessie_reconfirmed: false, officer_approved: false }, is_demo_data: true,
    });
    cleanup.push(() => mongo.db.collection(COLL.payeeChangeRequests).deleteMany({ request_id: reqId }));
    await fetch(`${URL_}/holds/refresh`, { method: "POST" });
    await attempt(URL_, "2 payee change on hold for the memo EIN", inv("HOLD"), await craftMemo(inv("HOLD"), np1.contract_id, holdEin, BAD_TAG), { failed: ["destination_is_registry_wallet"], codes: ["payee_change_on_hold"] });
    await mongo.db.collection(COLL.payeeChangeRequests).deleteOne({ request_id: reqId });
    await attempt(URL_, "2 hold document DELETED from Mongo -> still on hold", inv("HOLD2"), await craftMemo(inv("HOLD2"), np1.contract_id, holdEin, BAD_TAG), { failed: ["destination_is_registry_wallet"], codes: ["payee_change_on_hold"] });
    const officerCode = await runOfficerResolve(reqId, "reject", "  officer| ", URL_);
    const holdsNow = (await (await fetch(`${URL_}/holds`)).json()) as { active: { request_id: string }[] };
    record("2 officer rejects the deleted hold (details from the co-signer's record) -> lifted", officerCode === 0 && !holdsNow.active.some((h) => h.request_id === reqId), `officer exit ${officerCode}; active holds [${holdsNow.active.map((h) => h.request_id).join(",")}]`);
    await attempt(URL_, "2 after the officer's signed reject -> no payee_change_on_hold", inv("HOLD3"), await craftMemo(inv("HOLD3"), np1.contract_id, holdEin, BAD_TAG), { failed: ["destination_is_registry_wallet"], codes: ["destination_not_registry_wallet"], absent: ["payee_change_on_hold"] });
    await stopChild(child);
    child = null;

    // ---------------- instance B: tighten-only test caps ----------------
    console.log(`\n=== red-team instance B on ${URL_}: COSIGNER_TEST_DAILY_CAP=60, COSIGNER_TEST_PAYEE_DAILY_CAP=50, COSIGNER_TEST_AUTO_LIMIT=1000000 (must be ignored) ===`);
    child = spawnCosigner({ extraEnv: { COSIGNER_PORT: String(PORT), COSIGNER_URL: URL_, COSIGNER_TEST_DAILY_CAP: "60", COSIGNER_TEST_PAYEE_DAILY_CAP: "50", COSIGNER_TEST_AUTO_LIMIT: "1000000" }, prefix: "  B| " });
    const hB = await waitHealthy(child, URL_);
    console.log(`co-signer B: ${describeHealth(hB)}`);
    record(
      "env: test overrides can only tighten (AUTO_LIMIT not loosened)",
      hB.auto_limit === Number(file.AUTO_LIMIT ?? "25") && hB.caps?.daily_cap === 60 && hB.caps?.payee_daily_cap === 50 && policyProblems(hB).some((p) => p.startsWith("test overrides")),
      `AUTO_LIMIT ${hB.auto_limit}, DAILY_CAP ${hB.caps?.daily_cap}, PAYEE_DAILY_CAP ${hB.caps?.payee_daily_cap}; tightened [${(hB.policy?.test_tightened ?? []).join(", ")}]`,
    );
    await attempt(URL_, "6 rolling 24h caps (real on-ledger totals > test caps)", inv("CAP"), await craft(inv("CAP"), BAD_TAG), { failed: ["within_daily_caps"], codes: ["daily_cap_exceeded_agent", "daily_cap_exceeded_payee"] });
  } finally {
    for (const f of cleanup) await f().catch((e) => console.error(`cleanup failed: ${(e as Error).message}`));
    if (child) await stopChild(child);
    await client.disconnect().catch(() => undefined);
    await mongo.close().catch(() => undefined);
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} red-team results as expected; nothing was submitted to the ledger; temporary REDTEAM-* documents deleted`);
  return bad ? 1 : 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("redteam failed:", e instanceof Error ? e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>") : e);
    process.exit(1);
  },
);
