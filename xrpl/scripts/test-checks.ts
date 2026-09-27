// Offline unit tests (no network, no keys from env): the co-signer's 8 checks (on-ledger credential facts and payee
// change holds included), the verifier's address scrubbing, the payment builder's cross-checks, and the Phase 3 pieces:
// hold record + officer resolutions, wallet-ownership challenges, EIN-only matching, credential URI, micro-deposits; and
// (builder B) the governance validator (kill switch / CTT trust line), the simulated-escrow validators and the officer's exact-match signing rule. Throwaway keypairs are generated in memory for signing test transactions.
// Run: npm run test:checks   (repo root)
import { Wallet, decode, type Payment as XrplPayment } from "xrpl";
import { MEMO_TYPE, MEMO_FORMAT, memoJson } from "../../shared/hash";
import { CHECK_NAMES } from "../../shared/contracts";
import { runChecks, type CheckContext, type SignedRecord } from "../src/cosigner/checks";
import { toHex } from "../src/lib/xrpl";
import { toMicro, type AgentHistory, type LedgerPayment } from "../src/lib/ledgerScan";
import type { RegistryEntry, RegistrySnapshot } from "../src/lib/registrySnapshot";
import { sanitizeProposal, parseProposal, type Proposal } from "../src/verifier/schema";
import { buildFromProposal } from "../src/agent/builder";
import type { Registry } from "../src/lib/registry";
import type { ContractDoc } from "../src/lib/mongo";
import { canonicalInvoiceId, invoiceKey } from "../src/lib/invoiceId";
import { ContractPins, type ContractView } from "../src/lib/contractPins";
import type { Db } from "mongodb";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRED_TYPE_HEX, credentialUriText, einFromCredentialUri, MAX_URI_BYTES, type CredentialFacts } from "../src/lib/credentials";
import { HoldBook, signResolution, type ActiveHold } from "../src/lib/holds";
import { issueChallenge, memoryChallengeStore, verifyChallenge } from "../src/lib/challenge";
import { signText } from "../src/lib/signedMessage";
import { matchNonprofitByEin, newMicroDeposit, verifyMicroDeposit } from "../src/onboarding/lib";
import { checkGovernanceTx, classifySignerList, signerEntriesFor, CTT_TRUST_LIMIT, type GovContext } from "../src/lib/governance";
import { checkEscrowCancel, checkEscrowCreate, checkEscrowFinish, conditionFromPreimage, escrowMemo, fulfillmentMatches, newPreimage, signReleaseApproval, verifyReleaseApproval, type EscrowFacts } from "../src/lib/escrow";
import { cosignerRecordProblems, matchApprovedTx } from "../src/officer/approvals";
import { sha256Hex, computeDecisionHash, DECISION_HASH_FIELDS } from "../../shared/hash";
import { accountRef } from "../src/onboarding/bankLocal";

const agent = Wallet.generate();
const officer = Wallet.generate();
const intruder = Wallet.generate();
const account = Wallet.generate().address;
const np = Wallet.generate().address;
const other = Wallet.generate().address;
const RL = { currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" };
const NOW = Date.parse("2026-09-26T20:00:00Z");
const EIN = "00-0000001";
const CTR = "CT-TEST-1";
const INV = "INV-TEST-1";
const DH = "a".repeat(64);
const ISSUER = Wallet.generate().address;
const CLOSE = 843000000; // ripple seconds (validated ledger close time used by the tests)
const cred = (over: Partial<Extract<CredentialFacts, { found: true }>> = {}): CredentialFacts => ({
  found: true, subject: np, issuer: ISSUER, index: "C".repeat(64), flags: 0x00010000, accepted: true, expiration: CLOSE + 86400 * 90,
  uri_text: `ein:${EIN};https://projects.propublica.org/nonprofits/organizations/000000001`, uri_ein: EIN, ledger_index: 1000, close_time: CLOSE, ...over,
});
const hold = (over: Partial<ActiveHold> = {}): ActiveHold => ({
  request_id: "pcr_test", ein: EIN, current_address: np, requested_address: other, created_at: "2026-09-26T19:00:00Z", hold_until: "2026-09-29T19:00:00Z", state: "on_hold", db_status: "on_hold", ...over,
});
const CV = (over: Partial<ContractView> = {}): ContractView => ({ contract_id: CTR, nonprofit_ein: EIN, xrpl_budget_rlusd: "250.00", start_date: "2026-01-01", end_date: "2027-12-31", is_demo_data: true, ...over });

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({ ein: EIN, name: "Test NP (demo)", address: np, credential_status: "valid", credential_expires: "2026-10-26T00:00:00Z", bank_verified: false, ...over });
const snapshot = (entries: RegistryEntry[]): RegistrySnapshot => ({ entries, sha256: "f".repeat(64), read_at: "", byEin: new Map(entries.map((e) => [e.ein, e])), byAddress: new Map(entries.map((e) => [e.address, e])) });
const history = (payments: Partial<LedgerPayment>[] = []): AgentHistory => ({
  agent_account: account, scanned: payments.length, pages: 1, ledger_index_max: 1000, sent_hashes: new Set(),
  payments: payments.map((p, i) => ({ hash: `H${i}`, ledger_index: 900, close_time_ms: NOW - 3600e3, close_time_iso: "", destination: np, delivered_micro: toMicro(1), memo: null, ...p })),
});
const memoFor = (inv = INV, ctr = CTR, ein = EIN) => ({ Memo: { MemoType: toHex(MEMO_TYPE), MemoFormat: toHex(MEMO_FORMAT), MemoData: toHex(memoJson({ invoice_id: inv, contract_id: ctr, payee_ein: ein, decision_hash: DH, rule_version: "test" })) } });

function baseTx(over: Record<string, unknown> = {}): XrplPayment {
  return {
    TransactionType: "Payment", Account: account, Destination: np, Amount: { ...RL, value: "5" }, Fee: "36", Sequence: 100,
    LastLedgerSequence: 1020, SigningPubKey: "", SourceTag: 26092026, Flags: 0, Memos: [memoFor()], ...over,
  } as XrplPayment;
}
/** Multisig-form tx signed by the agent plus any extra signers (each signature made over this exact tx). */
const signedBy = (tx: XrplPayment, ...ws: Wallet[]): Record<string, unknown> => {
  const signers = [agent, ...ws].map((w) => (decode(w.sign(tx, true).tx_blob) as { Signers: unknown[] }).Signers[0]);
  return { ...(decode(agent.sign(tx, true).tx_blob) as Record<string, unknown>), Signers: signers };
};

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    agentAccount: account, credentialIssuer: ISSUER, credential: cred(), holds: [], signerAddresses: { agent: agent.address, officer: officer.address }, allowlist: new Set([np]),
    registry: snapshot([entry()]), registryDrift: null, contract: CV(),
    exclusions: new Map([["00-0000090", { ein: "00-0000090", name: "Excluded (demo)", list: "SAM.gov (demo)", exclusion_type: "Ineligible", reason: "test", since: "2025-01-01" }]]),
    exclusionsSha256: "e".repeat(64), rlusd: RL, sourceTag: 26092026, invoiceId: INV, autoLimit: 25, dailyCap: 300, payeeDailyCap: 150,
    ledger: { accountSequence: 100, validatedLedger: 1000 }, history: history(), pending: [], signed: [], nowMs: NOW, requireSignatures: true, ...over,
  };
}

let pass = 0, fail = 0;
function expect(name: string, tx: Record<string, unknown>, c: CheckContext, want: { failed: string[]; codes: string[] }) {
  const r = runChecks(tx, c);
  const failed = r.checks.filter((x) => !x.passed).map((x) => x.name).sort();
  const okOrder = r.checks.map((x) => x.name).join() === CHECK_NAMES.join();
  const ok = okOrder && failed.join() === [...want.failed].sort().join() && want.codes.every((code) => r.refusal_reasons.includes(code as never)) && (want.failed.length > 0 || r.refusal_reasons.length === 0);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(62)} failed=[${failed.join(",")}] codes=[${r.refusal_reasons.join(",")}]`);
  if (!ok) for (const x of r.checks.filter((y) => !y.passed)) console.log(`        ${x.name}: ${x.detail}`);
}
function assert(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name.padEnd(62)} ${detail}`);
}

const good = signedBy(baseTx());
console.log("--- co-signer checks (runChecks) ---");
expect("baseline: all 8 pass", good, ctx(), { failed: [], codes: [] });
// 1 credential_valid (on-ledger facts; no allowlist fallback)
expect("1 no on-ledger credential (entryNotFound)", good, ctx({ credential: { found: false, subject: np, issuer: ISSUER, ledger_index: 1000, close_time: CLOSE } }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 credential not accepted (lsfAccepted unset)", good, ctx({ credential: cred({ flags: 0, accepted: false }) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 credential expired vs validated ledger close time", good, ctx({ credential: cred({ expiration: CLOSE - 1 }) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 credential Expiration == close time counts as expired", good, ctx({ credential: cred({ expiration: CLOSE }) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 credential without Expiration", good, ctx({ credential: cred({ expiration: null }) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 credential URI EIN != memo EIN", good, ctx({ credential: cred({ uri_ein: "00-0000002" }) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 credential URI has no EIN", good, ctx({ credential: cred({ uri_ein: null, uri_text: "https://example.org" }) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 credential by another issuer is not the City's", good, ctx({ credential: cred({ issuer: other }) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 registry says valid + on allowlist, but no credential on-ledger -> refused", good, ctx({ credential: { found: false, subject: np, issuer: ISSUER, ledger_index: 1000, close_time: CLOSE }, registry: snapshot([entry({ credential_status: "valid" })]) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 registry says none, but a valid credential is on-ledger -> pass (ledger wins)", good, ctx({ registry: snapshot([entry({ credential_status: "none", credential_expires: null })]) }), { failed: [], codes: [] });
// 2 destination_is_registry_wallet
expect("2 Destination is not the registry wallet (attacker)", signedBy(baseTx({ Destination: other })), ctx({ credential: { found: false, subject: other, issuer: ISSUER, ledger_index: 1000, close_time: CLOSE } }), { failed: ["credential_valid", "destination_is_registry_wallet"], codes: ["credential_invalid", "destination_not_registry_wallet"] });
expect("2 Destination not on the pinned allowlist (extra guard)", good, ctx({ allowlist: new Set([other]) }), { failed: ["destination_is_registry_wallet"], codes: ["destination_not_registry_wallet"] });
expect("2 payee change request on hold for the EIN", good, ctx({ holds: [hold()] }), { failed: ["destination_is_registry_wallet"], codes: ["payee_change_on_hold"] });
expect("2 approved change still pending re-onboarding keeps the hold", good, ctx({ holds: [hold({ state: "approved_pending_reonboarding" })] }), { failed: ["destination_is_registry_wallet"], codes: ["payee_change_on_hold"] });
expect("2 hold for ANOTHER EIN does not block this payee", good, ctx({ holds: [hold({ ein: "00-0000002" })] }), { failed: [], codes: [] });
expect("2 memo ein != contract payee EIN (and != the credential EIN)", signedBy(baseTx({ Memos: [memoFor(INV, CTR, "00-0000002")] })), ctx(), { failed: ["credential_valid", "destination_is_registry_wallet"], codes: ["credential_invalid", "destination_not_registry_wallet"] });
expect("2 registry drifted since startup", good, ctx({ registryDrift: "pinned aaa vs now bbb" }), { failed: ["destination_is_registry_wallet"], codes: ["registry_drift"] });
expect("2+4 contract not in contracts collection", good, ctx({ contract: null }), { failed: ["destination_is_registry_wallet", "within_contract_amount"], codes: ["contract_not_found"] });
// 3 invoice_not_already_paid
expect("3 invoice paid on-ledger (memo inv)", good, ctx({ history: history([{ memo: { inv: INV, ctr: CTR, ein: EIN, dh: DH, rv: "x" } }]) }), { failed: ["invoice_not_already_paid"], codes: ["invoice_already_paid"] });
const pend: SignedRecord = { ts: "", invoice_id: INV, decision_id: "d", sequence: 99, last_ledger_sequence: 1010, destination: np, amount: "5", contract_id: CTR };
expect("3 invoice has a live co-signature pending", good, ctx({ pending: [pend] }), { failed: ["invoice_not_already_paid"], codes: ["invoice_already_paid"] });
const paidHist = history([{ memo: { inv: INV, ctr: CTR, ein: EIN, dh: DH, rv: "x" } }]);
for (const variant of ["inv-test-1", "INV-TEST-1.", "Inv_Test_1"]) {
  expect(`3 re-spelled paid invoice ${JSON.stringify(variant)} (not canonical)`, signedBy(baseTx({ Memos: [memoFor(variant)] })), ctx({ invoiceId: variant, history: paidHist }), { failed: ["invoice_not_already_paid", "tx_format_valid"], codes: ["invoice_already_paid", "bad_memo"] });
}
expect("3 canonical but re-spelled paid invoice INVTEST1", signedBy(baseTx({ Memos: [memoFor("INVTEST1")] })), ctx({ invoiceId: "INVTEST1", history: paidHist }), { failed: ["invoice_not_already_paid"], codes: ["invoice_already_paid"] });
expect("3 same invoice number paid to ANOTHER payee is not a duplicate", good, ctx({ history: history([{ destination: other, memo: { inv: INV, ctr: "CT-OTHER", ein: "00-0000002", dh: DH, rv: "x" } }]) }), { failed: [], codes: [] });
expect("3 live co-signature for a re-spelled id", good, ctx({ pending: [{ ...pend, invoice_id: "inv_test_1", payee_ein: EIN }] }), { failed: ["invoice_not_already_paid"], codes: ["invoice_already_paid"] });
// 4 within_contract_amount
expect("4 on-ledger paid 246 (2 days ago) + 5 > budget 250", good, ctx({ history: history([{ delivered_micro: toMicro(246), close_time_ms: NOW - 48 * 3600e3, memo: { inv: "OTHER", ctr: CTR, ein: EIN, dh: DH, rv: "x" } }]) }), { failed: ["within_contract_amount"], codes: ["contract_amount_exceeded"] });
expect("4 budget 4.99 < 5", good, ctx({ contract: CV({ xrpl_budget_rlusd: "4.99" }) }), { failed: ["within_contract_amount"], codes: ["contract_amount_exceeded"] });
expect("4 contract ended (end_date 2026-06-30)", good, ctx({ contract: CV({ end_date: "2026-06-30" }) }), { failed: ["within_contract_amount"], codes: ["contract_not_active"] });
expect("4 contract not started yet", good, ctx({ contract: CV({ start_date: "2026-10-01" }) }), { failed: ["within_contract_amount"], codes: ["contract_not_active"] });
expect("2 pinned contract changed in the database (drift)", good, ctx({ contractDrift: "contract CT-TEST-1 changed since it was pinned (xrpl_budget_rlusd ...)" }), { failed: ["destination_is_registry_wallet"], codes: ["registry_drift"] });
// 5 within_auto_limit_or_officer_signed
const big = baseTx({ Amount: { ...RL, value: "30" } });
expect("5 30 > AUTO_LIMIT 25, no officer", signedBy(big), ctx(), { failed: ["within_auto_limit_or_officer_signed"], codes: ["over_auto_limit_needs_officer"] });
expect("5 30 > AUTO_LIMIT 25, officer signed (verified) -> pass", signedBy(big, officer), ctx(), { failed: [], codes: [] });
const forged = signedBy(big, intruder);
(forged.Signers as { Signer: { Account: string } }[])[1].Signer.Account = officer.address; // intruder's signature, claiming to be the officer
expect("5 forged officer signature", forged, ctx(), { failed: ["within_auto_limit_or_officer_signed", "tx_format_valid"], codes: ["over_auto_limit_needs_officer", "bad_tx_fields"] });
// 6 within_daily_caps
expect("6 agent 24h 296 + 5 > DAILY_CAP 300", good, ctx({ history: history([{ delivered_micro: toMicro(296), destination: other }]) }), { failed: ["within_daily_caps"], codes: ["daily_cap_exceeded_agent"] });
expect("6 payee 24h 146 + 5 > PAYEE_DAILY_CAP 150", good, ctx({ history: history([{ delivered_micro: toMicro(146) }]) }), { failed: ["within_daily_caps"], codes: ["daily_cap_exceeded_payee"] });
expect("6 payment 25h ago is outside the rolling window", good, ctx({ history: history([{ delivered_micro: toMicro(296), close_time_ms: NOW - 25 * 3600e3 }]) }), { failed: [], codes: [] });
// 7 payee_not_excluded
const exReg = snapshot([entry(), entry({ ein: "00-0000090", address: other, name: "Excluded (demo)" })]);
expect("7 payee EIN on the exclusion list", signedBy(baseTx({ Destination: other, Memos: [memoFor(INV, CTR, "00-0000090")] })), ctx({ registry: exReg, allowlist: new Set([np, other]), contract: CV({ nonprofit_ein: "00-0000090" }), credential: cred({ subject: other, uri_ein: "00-0000090" }) }), { failed: ["payee_not_excluded"], codes: ["payee_excluded"] });
// 8 tx_format_valid
expect("8 wrong SourceTag", signedBy(baseTx({ SourceTag: 1 })), ctx(), { failed: ["tx_format_valid"], codes: ["bad_source_tag"] });
expect("8 extra field DestinationTag", signedBy(baseTx({ DestinationTag: 7 })), ctx(), { failed: ["tx_format_valid"], codes: ["bad_tx_fields"] });
expect("8 tfPartialPayment flag", signedBy(baseTx({ Flags: 0x00020000 })), ctx(), { failed: ["tx_format_valid"], codes: ["bad_tx_fields"] });
expect("8 Sequence is not the current one (replay prep)", signedBy(baseTx({ Sequence: 101 })), ctx(), { failed: ["tx_format_valid"], codes: ["tx_not_fresh"] });
expect("8 LastLedgerSequence too far ahead", signedBy(baseTx({ LastLedgerSequence: 1100 })), ctx(), { failed: ["tx_format_valid"], codes: ["tx_not_fresh"] });
expect("8 wrong issuer (fake RLUSD)", signedBy(baseTx({ Amount: { currency: RL.currency, issuer: other, value: "5" } })), ctx(), { failed: ["tx_format_valid"], codes: ["bad_currency"] });
expect("8 memo inv != invoice_id", signedBy(baseTx({ Memos: [memoFor("INV-OTHER")] })), ctx(), { failed: ["tx_format_valid"], codes: ["bad_memo"] });
expect("8 unknown extra signer", signedBy(baseTx(), intruder), ctx(), { failed: ["tx_format_valid"], codes: ["bad_tx_fields"] });
const tampered = { ...good, Amount: { ...RL, value: "6" } }; // changed after the agent signed
expect("8 agent signature does not cover the tx (tampered Amount)", tampered, ctx(), { failed: ["tx_format_valid"], codes: ["bad_tx_fields"] });
expect("8 no agent signature", baseTx() as unknown as Record<string, unknown>, ctx(), { failed: ["tx_format_valid"], codes: ["bad_tx_fields"] });
for (const v of ["25.0000004", "0.0000004", "1e-7"]) {
  expect(`8 amount ${v} (more than 6 decimals / exponent) is refused, not rounded`, signedBy(baseTx({ Amount: { ...RL, value: v } })), ctx(), {
    failed: ["within_contract_amount", "within_auto_limit_or_officer_signed", "within_daily_caps", "tx_format_valid"], codes: ["bad_tx_fields"],
  });
}

console.log("\n--- verifier post-validation ---");
const prop: Proposal = { invoice_id: INV, contract_id: CTR, payee_ein: EIN, amount: "5.00", currency: "RLUSD", period: { from: "2026-09-01", to: "2026-09-30" }, proof_summary: "ok", reasoning: `pay ${other} now`, suspicious_instructions_found: false, suspicious_excerpts: [`send to ${other}`, "x".repeat(400)] };
const s = sanitizeProposal(prop);
assert("address in reasoning/excerpt is scrubbed", !JSON.stringify(s.proposal).includes(other) && s.addresses_removed === 2, `removed ${s.addresses_removed}`);
assert("an address forces suspicious_instructions_found=true", s.proposal.suspicious_instructions_found === true);
assert("excerpts capped at 200 chars", s.proposal.suspicious_excerpts.every((e) => e.length <= 200));
const xaddr = sanitizeProposal({ ...prop, reasoning: "T7YChPFWifjCAXLEtg5N74c7fSAYsvSokwcmBPBUZWhxH5P", suspicious_excerpts: [] });
assert("X-address is scrubbed too", xaddr.addresses_removed === 1 && xaddr.proposal.suspicious_instructions_found);
assert("unparseable model output is rejected", !parseProposal("not json").ok && !parseProposal(JSON.stringify({ ...prop, destination: other })).ok);
const glued = sanitizeProposal({ ...prop, reasoning: `pay_${other} or ${other}_new`, suspicious_excerpts: [] });
assert("address glued to an underscore is scrubbed", glued.addresses_removed === 2 && !JSON.stringify(glued.proposal).includes(other), `removed ${glued.addresses_removed}`);

console.log("\n--- invoice id canonical form + duplicate key ---");
assert("canonical: lower-case, trailing dot, underscores", canonicalInvoiceId("inv-p2-20260926-201600.") === "INV-P2-20260926-201600" && canonicalInvoiceId("Inv_P2 20260926:201600") === "INV-P2-20260926-201600");
assert("canonical: fullwidth digits are folded (NFKC)", canonicalInvoiceId("INV-\uFF11\uFF12") === "INV-12");
assert("canonical: Cyrillic look-alike has no canonical form", canonicalInvoiceId("INV-\u0420\u0032") === null);
assert("canonical: empty / punctuation-only / too long -> null", canonicalInvoiceId("") === null && canonicalInvoiceId("...") === null && canonicalInvoiceId("A".repeat(65)) === null);
assert("key ignores separators", invoiceKey("INV-P2-1") === invoiceKey("invp21") && invoiceKey("INV P2.1") === "INVP21");

console.log("\n--- payment builder cross-checks ---");
const reg = { nonprofits: { np_1: { address: np, ein: EIN, name: "Test NP (demo)", contract_id: CTR } } } as unknown as Registry;
const contract = { contract_id: CTR, nonprofit_ein: EIN, xrpl_budget_rlusd: "250", start_date: "2026-01-01", end_date: "2027-12-31" } as ContractDoc;
const sub = { contract_id: CTR, expected_invoice_id: INV, submitted_via: "seed" as const };
const clean = { ...prop, reasoning: "fine", suspicious_excerpts: [] };
const ok = buildFromProposal(clean, sub, contract, reg, "x");
assert("builder OK -> registry wallet by EIN", ok.ok && ok.destination === np);
const cases: [string, Proposal, string][] = [
  ["suspicious flag -> suspicious_instructions_in_invoice", { ...clean, suspicious_instructions_found: true }, "suspicious_instructions_in_invoice"],
  ["payee EIN != contract EIN -> verifier_rejected", { ...clean, payee_ein: "00-0000002" }, "verifier_rejected"],
  ["contract id != submitted -> verifier_rejected", { ...clean, contract_id: "CT-OTHER" }, "verifier_rejected"],
  ["amount '12,50' -> verifier_rejected", { ...clean, amount: "12,50" }, "verifier_rejected"],
  ["bad period -> verifier_rejected", { ...clean, period: { from: "2026-09-31", to: "2026-09-30" } }, "verifier_rejected"],
  ["invoice id != intake id -> verifier_rejected", { ...clean, invoice_id: "INV-OTHER" }, "verifier_rejected"],
];
for (const [name, p, code] of cases) {
  const b = buildFromProposal(p, sub, contract, reg, "x");
  assert(name, !b.ok && b.reasons.includes(code as never), b.ok ? "built!" : `[${b.reasons.join(",")}]`);
}
const nc = buildFromProposal(clean, sub, null, reg, "x");
assert("missing contract -> contract_not_found", !nc.ok && nc.reasons.includes("contract_not_found"));
const lc = buildFromProposal({ ...clean, invoice_id: "inv-test-1." }, sub, contract, reg, "x");
assert("lower-case invoice id is written in canonical form", lc.ok && lc.invoice.invoice_id === INV, lc.ok ? lc.invoice.invoice_id : `[${lc.reasons.join(",")}]`);
const ended = buildFromProposal(clean, sub, { ...contract, end_date: "2026-06-30" }, reg, "x", new Date(NOW));
assert("contract ended -> contract_not_active", !ended.ok && ended.reasons.includes("contract_not_active"));

console.log("\n--- contract pinning (fake database) ---");
{
  let docs: Partial<ContractDoc>[] = [{ contract_id: CTR, nonprofit_ein: EIN, xrpl_budget_rlusd: "250.00", start_date: "2026-01-01", end_date: "2027-12-31", is_demo_data: true }];
  const fakeDb = {
    collection: () => ({
      find: () => ({ toArray: async () => docs.map((d) => ({ ...d })) }),
      findOne: async (q: { contract_id: string }) => docs.find((d) => d.contract_id === q.contract_id) ?? null,
    }),
  } as unknown as Db;
  const pins = await ContractPins.load(fakeDb);
  const resolve = pins.resolver(fakeDb, new Set([EIN]));
  const r0 = await resolve(CTR);
  assert("pinned contract resolves, no drift", !!r0.contract && r0.drift === null);
  docs = [{ ...docs[0], xrpl_budget_rlusd: "1000000" }];
  const r1 = await resolve(CTR);
  assert("pinned contract budget raised in the database -> drift, pinned budget kept", r1.drift !== null && r1.contract?.xrpl_budget_rlusd === "250.00", r1.drift ?? "");
  docs = [{ ...docs[0], xrpl_budget_rlusd: "250.00", nonprofit_ein: "00-0000002" }];
  assert("pinned contract payee changed -> drift", (await resolve(CTR)).drift !== null);
  docs.push({ contract_id: "LATE-BIG", nonprofit_ein: EIN, xrpl_budget_rlusd: "1000000", start_date: "2026-01-01", end_date: "2026-12-31", is_demo_data: true });
  docs.push({ contract_id: "LATE-REAL", nonprofit_ein: EIN, xrpl_budget_rlusd: "10", start_date: "2026-01-01", end_date: "2026-12-31", is_demo_data: false });
  docs.push({ contract_id: "LATE-NOREG", nonprofit_ein: "00-0000077", xrpl_budget_rlusd: "10", start_date: "2026-01-01", end_date: "2026-12-31", is_demo_data: true });
  docs.push({ contract_id: "LATE-OK", nonprofit_ein: EIN, xrpl_budget_rlusd: "20.00", start_date: "2026-01-01", end_date: "2026-12-31", is_demo_data: true });
  assert("late contract with a big budget is not admitted", (await resolve("LATE-BIG")).contract === null);
  assert("late contract not flagged demo data is not admitted", (await resolve("LATE-REAL")).contract === null);
  assert("late contract for a non-registry EIN is not admitted", (await resolve("LATE-NOREG")).contract === null);
  const ok1 = await resolve("LATE-OK");
  assert("late small demo contract is admitted and noted", !!ok1.contract && !!ok1.note && pins.lateAdmitted === 1);
  docs = docs.map((d) => (d.contract_id === "LATE-OK" ? { ...d, xrpl_budget_rlusd: "25.00" } : d));
  assert("admitted late contract is pinned: a later change -> drift", (await resolve("LATE-OK")).drift !== null);
}

console.log("\n--- payee change holds: the co-signer's sticky record + officer signatures (fake database, temp file) ---");
{
  const REQ = { request_id: "pcr_20260926190000abcdef", ein: EIN, current_address: np, requested_address: other, reason: "changed banks", contact: "x", status: "on_hold", created_at: "2026-09-26T19:00:00Z", hold_until: "2026-09-29T19:00:00Z", requires: { nessie_reconfirmed: false, officer_approved: false }, is_demo_data: true };
  let docs: Record<string, unknown>[] = [{ ...REQ }];
  const fakeDb = { collection: () => ({ find: () => ({ toArray: async () => docs.map((d) => JSON.parse(JSON.stringify(d))) }) }) } as unknown as Db;
  const file = path.join(os.tmpdir(), `holds-test-${process.pid}-${Date.now()}.jsonl`);
  const T = Date.parse("2026-09-26T20:00:00Z");
  const book = new HoldBook(file, officer.address);
  await book.refresh(fakeDb, T);
  assert("a new request becomes an active hold", book.active(T).length === 1 && book.active(T)[0].state === "on_hold");
  docs = [];
  await book.refresh(fakeDb, T);
  assert("deleting the request does NOT lift the hold", book.active(T).length === 1 && /missing/.test(book.active(T)[0].db_status), book.active(T)[0]?.db_status);
  docs = [{ ...REQ, status: "rejected" }];
  await book.refresh(fakeDb, T);
  assert("flipping status to rejected without a signature does NOT lift it", book.active(T).length === 1, book.active(T)[0]?.db_status);
  const core = { request_id: REQ.request_id, ein: EIN, requested_address: other, decision: "reject" as const, ts: "2026-09-26T19:30:00Z" };
  docs = [{ ...REQ, status: "rejected", resolution: { ...signResolution(core, intruder), signer: officer.address } }];
  await book.refresh(fakeDb, T);
  assert("a resolution signed by another key (claiming the officer) does NOT lift it", book.active(T).length === 1, book.active(T)[0]?.db_status);
  assert("an officer signature for ANOTHER request does not apply", !book.accept({ ...signResolution({ ...core, request_id: "pcr_other" }, officer) }, T).ok);
  const swapped = signResolution({ ...core, requested_address: np }, officer);
  assert("an officer signature naming a different wallet is rejected", !book.accept({ ...swapped, request_id: REQ.request_id }, T).ok);
  const tampered = { ...signResolution(core, officer), decision: "approve" };
  assert("a valid signature with the decision edited afterwards is rejected", !book.accept(tampered, T).ok);
  assert("a resolution dated in the future is rejected", !book.accept(signResolution({ ...core, ts: "2026-09-27T20:00:00Z" }, officer), T).ok);
  const real = signResolution(core, officer);
  const ok = book.accept(real, T);
  assert("the officer's signed reject lifts the hold", ok.ok && book.active(T).length === 0, ok.why ?? "");
  const reloaded = new HoldBook(file, officer.address);
  assert("the record survives a restart (hold seen + verified resolution)", reloaded.size === 1 && reloaded.active(T).length === 0);
  fs.appendFileSync(file, JSON.stringify({ type: "seen", at: "x", request_id: "pcr_second", ein: "00-0000002", current_address: np, requested_address: other, created_at: "2026-09-26T19:00:00Z", hold_until: "2026-09-29T19:00:00Z" }) + "\n");
  fs.appendFileSync(file, JSON.stringify({ type: "resolved", at: "x", request_id: "pcr_second", resolution: { ...signResolution({ ...core, request_id: "pcr_second", ein: "00-0000002" }, intruder), signer: officer.address } }) + "\n");
  const again = new HoldBook(file, officer.address);
  assert("a forged 'resolved' line in the file does not lift a hold on reload", again.active(T).some((h) => h.request_id === "pcr_second"));
  docs = [];
  await again.refresh(fakeDb, T);
  assert("a hold seen before a restart stays active with an empty database", again.active(T).some((h) => h.request_id === "pcr_second"));
  const approve = new HoldBook(null, officer.address);
  docs = [{ ...REQ, request_id: "pcr_approve" }];
  await approve.refresh(fakeDb, T);
  approve.accept(signResolution({ ...core, request_id: "pcr_approve", decision: "approve" }, officer), T);
  assert("approve keeps payments frozen (re-onboarding required)", approve.active(T)[0]?.state === "approved_pending_reonboarding");
  const after = Date.parse("2026-09-30T00:00:00Z");
  assert("approve lifts only when the pinned registry shows the new wallet after hold_until", approve.active(after, () => np).length === 1 && approve.active(after, () => other).length === 0);
  fs.rmSync(file, { force: true });
}

console.log("\n--- wallet-ownership challenge ---");
{
  const store = memoryChallengeStore();
  const w = Wallet.generate();
  const c1 = await issueChallenge(store, EIN, w.address, NOW);
  const ans = { challenge_id: c1.challenge_id, ...signText(w, c1.message) };
  const v1 = await verifyChallenge(store, ans, { ein: EIN, wallet: w.address }, NOW + 1000);
  assert("signed challenge verifies (deriveAddress(public_key) == wallet)", v1.ok);
  const v2 = await verifyChallenge(store, ans, { ein: EIN, wallet: w.address }, NOW + 2000);
  assert("the same answer replayed is rejected", !v2.ok && v2.code === "replayed");
  const c2 = await issueChallenge(store, EIN, w.address, NOW, 1000);
  const v3 = await verifyChallenge(store, { challenge_id: c2.challenge_id, ...signText(w, c2.message) }, { ein: EIN, wallet: w.address }, NOW + 5000);
  assert("an expired challenge is rejected", !v3.ok && v3.code === "expired");
  const c3 = await issueChallenge(store, EIN, w.address, NOW);
  const v4 = await verifyChallenge(store, { challenge_id: c3.challenge_id, ...signText(intruder, c3.message) }, { ein: EIN, wallet: w.address }, NOW + 1000);
  assert("a signature by another key is rejected", !v4.ok && v4.code === "bad_signature");
  const v5 = await verifyChallenge(store, { challenge_id: c3.challenge_id, public_key: intruder.publicKey, signature: signText(w, c3.message).signature }, { ein: EIN, wallet: w.address }, NOW + 1000);
  assert("a valid signature presented with another public key is rejected", !v5.ok);
  const v6 = await verifyChallenge(store, { challenge_id: c3.challenge_id, ...signText(w, c3.message) }, { ein: "00-0000002", wallet: w.address }, NOW + 1000);
  assert("a challenge issued for another EIN is rejected", !v6.ok && v6.code === "mismatch");
  const v7 = await verifyChallenge(store, { challenge_id: c3.challenge_id, ...signText(w, c3.message.replace(EIN, "00-0000002")) }, { ein: EIN, wallet: w.address }, NOW + 1000);
  assert("a signature over edited challenge text is rejected", !v7.ok && v7.code === "bad_signature");
}

console.log("\n--- EIN-only matching (look-alikes) ---");
{
  const regLike = { nonprofits: { np_2: { ein: "00-0000002", address: np, name: "South Bronx Table Fund (demo)", contract_id: CTR } } } as unknown as Registry;
  const recs = [
    { ein: "00-0000002", name: "South Bronx Table Fund (demo)" },
    { ein: "00-0000092", name: "South Bronx Table Fund" }, // look-alike name, different EIN
    { ein: "00-0000093", name: "SOUTH BRONX TABLE FUND, INC." },
  ];
  const byKey = matchNonprofitByEin(recs, "np_2", regLike);
  assert("np_2 -> EIN 00-0000002, look-alikes reported, never matched", byKey.ok && byKey.record.ein === "00-0000002" && byKey.lookalikes_ignored.length === 2, byKey.ok ? byKey.lookalikes_ignored.map((r) => r.ein).join(",") : byKey.why);
  const byName = matchNonprofitByEin(recs, "South Bronx Table Fund", regLike);
  assert("a name is refused (EIN only)", !byName.ok);
  const lookalike = matchNonprofitByEin(recs, "00-0000092", regLike);
  assert("the look-alike's own EIN matches only the look-alike record", lookalike.ok && lookalike.record.name === "South Bronx Table Fund" && lookalike.np_key === null);
  assert("an EIN with a letter O instead of 0 is refused", !matchNonprofitByEin(recs, "00-O000002", regLike).ok);
  assert("fullwidth digits are refused", !matchNonprofitByEin(recs, "00-\uFF10000002", regLike).ok);
  const nine = matchNonprofitByEin(recs, "000000002", regLike);
  assert("9 plain digits are read as NN-NNNNNNN", nine.ok && nine.ein === "00-0000002");
  assert("an unknown EIN is refused", !matchNonprofitByEin(recs, "00-0000077", regLike).ok);
}

console.log("\n--- credential URI + micro-deposit ---");
{
  const uri = credentialUriText("00-0000001");
  assert("URI carries the EIN and the ProPublica link, <= 256 bytes", uri === "ein:00-0000001;https://projects.propublica.org/nonprofits/organizations/000000001" && Buffer.byteLength(uri) <= MAX_URI_BYTES);
  assert("EIN parsed back from the hex URI", einFromCredentialUri(Buffer.from(uri).toString("hex")) === "00-0000001" && einFromCredentialUri("68747470") === null);
  assert("credential type is hex of NYC_VERIFIED_NONPROFIT", Buffer.from(CRED_TYPE_HEX, "hex").toString() === "NYC_VERIFIED_NONPROFIT");
  const md = newMicroDeposit(EIN);
  assert("micro-deposit amounts are integers 1..99", md.amounts.every((a) => Number.isInteger(a) && a >= 1 && a <= 99));
  assert("the right pair verifies (any order)", verifyMicroDeposit(md, EIN, [...md.amounts].reverse()));
  assert("a wrong pair, one amount, or another EIN does not", !verifyMicroDeposit(md, EIN, [md.amounts[0], (md.amounts[1] % 99) + 1]) && !verifyMicroDeposit(md, EIN, [md.amounts[0]]) && !verifyMicroDeposit(md, "00-0000002", md.amounts));
}

console.log("\n--- Phase 3 (builder B): governance (kill switch, CTT trust line) ---");
{
  const cosignerAddr = Wallet.generate().address;
  const S = { agent: agent.address, cosigner: cosignerAddr, officer: officer.address };
  const g: GovContext = { agentAccount: account, cityIssuer: ISSUER, signers: S, ledger: { accountSequence: 100, validatedLedger: 1000 } };
  /** Multisig-form tx signed ONLY by the given wallets. */
  const signOnly = (tx: Record<string, unknown>, ...ws: Wallet[]): Record<string, unknown> => {
    const sig = ws.map((w) => (decode(w.sign(tx as never, true).tx_blob) as { Signers: unknown[] }).Signers[0]);
    return { ...(decode(ws[0].sign(tx as never, true).tx_blob) as Record<string, unknown>), Signers: sig };
  };
  const sls = (over: Record<string, unknown> = {}) => ({ TransactionType: "SignerListSet", Account: account, Fee: "30", Sequence: 100, LastLedgerSequence: 1020, SignerQuorum: 3, SignerEntries: signerEntriesFor("REVOKED", S), Flags: 0, ...over });
  const gv = (name: string, tx: Record<string, unknown>, purpose: string, wantOk: boolean, wantPurpose: string | null = null) => {
    const r = checkGovernanceTx(tx, purpose, g);
    assert(name, r.ok === wantOk && (wantPurpose === null || r.purpose === wantPurpose), r.ok ? `ok ${r.purpose}` : r.problems.join("; ").slice(0, 150));
  };
  gv("gov: REVOKED {cosigner:2, officer:1} signed by the officer -> ok", signOnly(sls(), officer), "revoke_agent", true, "revoke_agent");
  gv("gov: CANONICAL restore signed by the officer -> ok", signOnly(sls({ SignerEntries: signerEntriesFor("CANONICAL", S) }), officer), "restore_agent", true, "restore_agent");
  gv("gov: purpose does not match the tx -> refused", signOnly(sls(), officer), "restore_agent", false);
  gv("gov: signer list change signed by the agent only -> refused", signOnly(sls(), agent), "revoke_agent", false);
  gv("gov: officer + agent signatures -> refused (agent may not sign)", signOnly(sls(), officer, agent), "revoke_agent", false);
  gv("gov: another configuration {agent:3, cosigner:2} -> refused", signOnly(sls({ SignerEntries: [{ SignerEntry: { Account: agent.address, SignerWeight: 3 } }, { SignerEntry: { Account: cosignerAddr, SignerWeight: 2 } }] }), officer), "revoke_agent", false);
  gv("gov: REVOKED entries with quorum 2 -> refused", signOnly(sls({ SignerQuorum: 2 }), officer), "revoke_agent", false);
  gv("gov: signed by an unknown key -> refused", signOnly(sls(), intruder), "revoke_agent", false);
  gv("gov: stale Sequence -> refused", signOnly(sls({ Sequence: 99 }), officer), "revoke_agent", false);
  gv("gov: LastLedgerSequence too far ahead -> refused", signOnly(sls({ LastLedgerSequence: 1100 }), officer), "revoke_agent", false);
  gv("gov: Fee above the cap -> refused", signOnly(sls({ Fee: "5000" }), officer), "revoke_agent", false);
  gv("gov: extra field (Memos) -> refused", signOnly(sls({ Memos: [memoFor()] }), officer), "revoke_agent", false);
  gv("gov: another account's signer list -> refused", signOnly(sls({ Account: other }), officer), "revoke_agent", false);
  const ts = (over: Record<string, unknown> = {}) => ({ TransactionType: "TrustSet", Account: account, Fee: "30", Sequence: 100, LastLedgerSequence: 1020, LimitAmount: { currency: "CTT", issuer: ISSUER, value: CTT_TRUST_LIMIT }, Flags: 0x00020000, ...over });
  gv("gov: TrustSet CTT/city_issuer signed by the agent -> ok", signOnly(ts(), agent), "ctt_trust_line", true, "ctt_trust_line");
  gv("gov: TrustSet for RLUSD -> refused", signOnly(ts({ LimitAmount: { ...RL, value: CTT_TRUST_LIMIT } }), agent), "ctt_trust_line", false);
  gv("gov: TrustSet CTT from another issuer -> refused", signOnly(ts({ LimitAmount: { currency: "CTT", issuer: other, value: CTT_TRUST_LIMIT } }), agent), "ctt_trust_line", false);
  gv("gov: TrustSet with another limit -> refused", signOnly(ts({ LimitAmount: { currency: "CTT", issuer: ISSUER, value: "5" } }), agent), "ctt_trust_line", false);
  gv("gov: TrustSet without tfSetNoRipple -> refused", signOnly(ts({ Flags: 0 }), agent), "ctt_trust_line", false);
  gv("gov: a Payment is not a governance tx -> refused", signedBy(baseTx()), "revoke_agent", false);
  assert("classifySignerList: CANONICAL / REVOKED / OTHER / NONE",
    classifySignerList({ quorum: 3, entries: [{ account: officer.address, weight: 1 }, { account: agent.address, weight: 1 }, { account: cosignerAddr, weight: 2 }] }, S) === "CANONICAL" &&
      classifySignerList({ quorum: 3, entries: [{ account: cosignerAddr, weight: 2 }, { account: officer.address, weight: 1 }] }, S) === "REVOKED" &&
      classifySignerList({ quorum: 2, entries: [{ account: cosignerAddr, weight: 2 }, { account: officer.address, weight: 1 }] }, S) === "OTHER" &&
      classifySignerList(null, S) === "NONE");
}

console.log("\n--- Phase 3 (builder B): simulated escrow (CTT test token) ---");
{
  const pre = newPreimage();
  const cc = conditionFromPreimage(pre);
  assert("PREIMAGE-SHA-256: condition A0258020<sha256>810120, fulfillment A0228020<preimage>", /^A0258020[0-9A-F]{64}810120$/.test(cc.condition) && cc.fulfillment === `A0228020${pre}`);
  assert("fulfillment matches its condition, not another", fulfillmentMatches(cc.condition, cc.fulfillment) && !fulfillmentMatches(conditionFromPreimage(newPreimage()).condition, cc.fulfillment));
  const MS = "MS-TEST-1";
  const facts = (over: Partial<EscrowFacts> = {}): EscrowFacts => ({
    agentAccount: account, cityIssuer: ISSUER, sourceTag: 26092026, signerAddresses: { agent: agent.address, officer: officer.address }, maxAmount: 25,
    ledger: { accountSequence: 100, validatedLedger: 1000, closeTime: CLOSE }, issuedCondition: cc.condition, registry: snapshot([entry()]), registryDrift: null,
    allowlist: new Set([np]), contract: CV(), credential: cred(), holds: [], exclusions: new Map(), ...over,
  });
  const create = (over: Record<string, unknown> = {}) => ({
    TransactionType: "EscrowCreate", Account: account, Destination: np, Amount: { currency: "CTT", issuer: ISSUER, value: "5" }, Condition: cc.condition, CancelAfter: CLOSE + 86400,
    SourceTag: 26092026, Memos: [escrowMemo({ ms: MS, ctr: CTR, ein: EIN, dh: DH, rv: "test" })], Fee: "30", Sequence: 100, LastLedgerSequence: 1020, SigningPubKey: "", Flags: 0, ...over,
  });
  const signed = (tx: Record<string, unknown>) => ({ ...(decode(agent.sign(tx as never, true).tx_blob) as Record<string, unknown>) });
  const ec = (name: string, tx: Record<string, unknown>, f: EscrowFacts, codes: string[], fn = checkEscrowCreate) => {
    const r = fn(tx, MS, f);
    const ok = codes.length ? codes.every((c) => r.refusal_reasons.includes(c as never)) : r.refusal_reasons.length === 0 && r.checks.every((c) => c.passed);
    assert(name, ok, `codes=[${r.refusal_reasons.join(",")}]${ok ? "" : ` ${r.checks.filter((c) => !c.passed).map((c) => c.detail).join(" | ").slice(0, 160)}`}`);
  };
  ec("escrow create: baseline (CTT, issued condition, 24 h, registry wallet) -> ok", signed(create()), facts(), []);
  ec("escrow create: condition not issued for this milestone", signed(create({ Condition: conditionFromPreimage(newPreimage()).condition })), facts(), ["escrow_condition_invalid"]);
  ec("escrow create: no condition issued at all", signed(create()), facts({ issuedCondition: null }), ["escrow_condition_invalid"]);
  ec("escrow create: milestone already escrowed", signed(create()), facts({ priorCreate: "already escrowed" }), ["escrow_condition_invalid"]);
  ec("escrow create: 30 CTT > AUTO_LIMIT", signed(create({ Amount: { currency: "CTT", issuer: ISSUER, value: "30" } })), facts(), ["over_auto_limit_needs_officer"]);
  ec("escrow create: RLUSD instead of the test token", signed(create({ Amount: { ...RL, value: "5" } })), facts(), ["bad_currency"]);
  ec("escrow create: CTT from another issuer", signed(create({ Amount: { currency: "CTT", issuer: other, value: "5" } })), facts(), ["bad_currency"]);
  ec("escrow create: CancelAfter only 30 min away", signed(create({ CancelAfter: CLOSE + 1800 })), facts(), ["escrow_timing_invalid"]);
  ec("escrow create: CancelAfter 100 h away", signed(create({ CancelAfter: CLOSE + 100 * 3600 })), facts(), ["escrow_timing_invalid"]);
  ec("escrow create: FinishAfter set", signed(create({ FinishAfter: CLOSE + 7200 })), facts(), ["escrow_timing_invalid", "bad_tx_fields"]);
  ec("escrow create: destination not the registry wallet", signed(create({ Destination: other })), facts({ credential: cred({ subject: other }) }), ["destination_not_registry_wallet"]);
  ec("escrow create: destination without an on-ledger credential", signed(create()), facts({ credential: { found: false, subject: np, issuer: ISSUER, ledger_index: 1000, close_time: CLOSE } }), ["credential_invalid"]);
  ec("escrow create: payee change on hold", signed(create()), facts({ holds: [hold()] }), ["payee_change_on_hold"]);
  ec("escrow create: not signed by the agent", create(), facts(), ["bad_tx_fields"]);
  ec("escrow create: stale Sequence", signed(create({ Sequence: 99 })), facts(), ["tx_not_fresh"]);
  ec("escrow create: memo milestone != request milestone", signed(create({ Memos: [escrowMemo({ ms: "MS-OTHER", ctr: CTR, ein: EIN, dh: DH, rv: "test" })] })), facts(), ["escrow_condition_invalid"]);
  const esc = { found: true as const, owner: account, seq: 90, destination: np, amount: { currency: "CTT", issuer: ISSUER, value: "5" }, condition: cc.condition, cancel_after: CLOSE + 3600, finish_after: null };
  const finish = (over: Record<string, unknown> = {}) => ({ TransactionType: "EscrowFinish", Account: account, Owner: account, OfferSequence: 90, Condition: cc.condition, Fee: "400", Sequence: 100, LastLedgerSequence: 1020, SigningPubKey: "", SourceTag: 26092026, Flags: 0, ...over });
  const RNOW = Date.parse("2026-09-26T20:00:00Z");
  const relCore = (over: Record<string, unknown> = {}) => ({ milestone_id: MS, owner: account, offer_sequence: 90, condition: cc.condition, destination: np, amount: "5", currency: "CTT" as const, issuer: ISSUER, ts: "2026-09-26T19:55:00Z", ...over });
  const approval = signReleaseApproval(relCore(), officer);
  const rel = (over: Partial<NonNullable<EscrowFacts["releaseApproval"]>> = {}) => ({ approval, used: false, officerAddress: officer.address, nowMs: RNOW, ...over });
  const ff = (over: Partial<EscrowFacts> = {}) => facts({ escrow: esc, recordedOfferSequence: 90, releaseApproval: rel(), signerList: "CANONICAL", ...over });
  ec("escrow finish: unsigned template for the recorded escrow + officer release approval -> ok", finish(), ff(), [], checkEscrowFinish);
  ec("escrow finish: no officer release approval -> refused", finish(), ff({ releaseApproval: rel({ approval: null }) }), ["escrow_release_not_approved"], checkEscrowFinish);
  ec("escrow finish: release approval already used -> refused", finish(), ff({ releaseApproval: rel({ used: true }) }), ["escrow_release_not_approved"], checkEscrowFinish);
  ec("escrow finish: release approval signed by another key -> refused", finish(), ff({ releaseApproval: rel({ approval: { ...signReleaseApproval(relCore(), intruder), signer: officer.address } }) }), ["escrow_release_not_approved"], checkEscrowFinish);
  ec("escrow finish: release approval for another escrow (seq 91) -> refused", finish(), ff({ releaseApproval: rel({ approval: signReleaseApproval(relCore({ offer_sequence: 91 }), officer) }) }), ["escrow_release_not_approved"], checkEscrowFinish);
  ec("escrow finish: release approval with another amount -> refused", finish(), ff({ releaseApproval: rel({ approval: signReleaseApproval(relCore({ amount: "50" }), officer) }) }), ["escrow_release_not_approved"], checkEscrowFinish);
  ec("escrow finish: release approval older than 30 min -> refused", finish(), ff({ releaseApproval: rel({ nowMs: RNOW + 60 * 60 * 1000 }) }), ["escrow_release_not_approved"], checkEscrowFinish);
  ec("escrow finish: kill switch engaged (REVOKED) -> refused", finish(), ff({ signerList: "REVOKED" }), ["agent_key_revoked"], checkEscrowFinish);
  assert("release approval: amount written 5.00 vs escrow 5 verifies (micro-units)", verifyReleaseApproval(signReleaseApproval(relCore({ amount: "5.00" }), officer), { milestone_id: MS, owner: account, offer_sequence: 90, condition: cc.condition, destination: np, amount: "5", issuer: ISSUER }, officer.address, RNOW).ok);
  ec("escrow finish: template already carries a Fulfillment", finish({ Fulfillment: cc.fulfillment }), ff(), ["bad_tx_fields"], checkEscrowFinish);
  ec("escrow finish: template already signed", signed(finish()), ff(), ["bad_tx_fields"], checkEscrowFinish);
  ec("escrow finish: escrow not on the ledger", finish(), ff({ escrow: { found: false, owner: account, seq: 90 } }), ["escrow_not_found"], checkEscrowFinish);
  ec("escrow finish: OfferSequence is not the co-signed escrow", finish({ OfferSequence: 91 }), ff({ escrow: { ...esc, seq: 91 } }), ["escrow_not_found"], checkEscrowFinish);
  ec("escrow finish: after CancelAfter", finish(), ff({ escrow: { ...esc, cancel_after: CLOSE - 10 } }), ["escrow_timing_invalid"], checkEscrowFinish);
  ec("escrow finish: payee change on hold", finish(), ff({ holds: [hold()] }), ["payee_change_on_hold"], checkEscrowFinish);
  ec("escrow finish: credential expired since the create", finish(), ff({ credential: cred({ expiration: CLOSE - 1 }) }), ["credential_invalid"], checkEscrowFinish);
  ec("escrow finish: another milestone's condition", finish({ Condition: conditionFromPreimage(newPreimage()).condition }), ff(), ["escrow_condition_invalid"], checkEscrowFinish);
  ec("escrow finish: a finish co-signature is still live", finish(), ff({ priorFinish: "live" }), ["tx_not_fresh"], checkEscrowFinish);
  const cancel = (over: Record<string, unknown> = {}) => ({ TransactionType: "EscrowCancel", Account: account, Owner: account, OfferSequence: 90, Fee: "30", Sequence: 100, LastLedgerSequence: 1020, SigningPubKey: "", SourceTag: 26092026, Flags: 0, ...over });
  ec("escrow cancel: before CancelAfter -> refused", signed(cancel()), ff(), ["escrow_timing_invalid"], checkEscrowCancel);
  ec("escrow cancel: after CancelAfter -> ok", signed(cancel()), ff({ escrow: { ...esc, cancel_after: CLOSE - 10 } }), [], checkEscrowCancel);
}

console.log("\n--- Phase 3 (builder B): the officer signs only the exact approved payment ---");
{
  const M = memoJson({ invoice_id: INV, contract_id: CTR, payee_ein: EIN, decision_hash: DH, rule_version: "test" });
  const intent = { destination: np, amount: "30.00", memo_json: M };
  const mf = { agentAccount: account, rlusd: RL, sourceTag: 26092026, signers: { agent: agent.address, officer: officer.address }, ledger: { accountSequence: 100, validatedLedger: 1000 } };
  const tx30 = (over: Record<string, unknown> = {}) => baseTx({ Amount: { ...RL, value: "30.00" }, ...over });
  const agentOnly = (tx: XrplPayment) => decode(agent.sign(tx, true).tx_blob) as Record<string, unknown>;
  const exact = matchApprovedTx(agentOnly(tx30()), intent, mf);
  assert("approval: the exact approved payment, agent-signed -> officer signs", exact.length === 0, exact.join("; "));
  assert("approval: amount 30.01 -> refused", matchApprovedTx(agentOnly(tx30({ Amount: { ...RL, value: "30.01" } })), intent, mf).length > 0);
  assert("approval: another destination -> refused", matchApprovedTx(agentOnly(tx30({ Destination: other })), intent, mf).length > 0);
  const otherMemo = { Memo: { MemoType: toHex(MEMO_TYPE), MemoFormat: toHex(MEMO_FORMAT), MemoData: toHex(memoJson({ invoice_id: INV, contract_id: CTR, payee_ein: EIN, decision_hash: "b".repeat(64), rule_version: "test" })) } };
  assert("approval: memo with another decision hash -> refused", matchApprovedTx(agentOnly(tx30({ Memos: [otherMemo] })), intent, mf).length > 0);
  assert("approval: stale Sequence -> refused", matchApprovedTx(agentOnly(tx30({ Sequence: 99 })), intent, mf).length > 0);
  assert("approval: not signed by the agent -> refused", matchApprovedTx(tx30() as unknown as Record<string, unknown>, intent, mf).length > 0);
  assert("approval: extra field (DestinationTag) -> refused", matchApprovedTx(agentOnly(tx30({ DestinationTag: 7 })), intent, mf).length > 0);

  // The officer checks a pending approval against the CO-SIGNER's own record of the refusal (not only the agent's documents).
  const pend = { decision_id: "dec_1", invoice_id: INV, contract_id: CTR, payee_ein: EIN, amount: "30.00", destination: np, decision_hash: DH, memo_json: M };
  const seen = { ts: "2026-09-26T20:00:00Z", decision_id: "dec_1", invoice_id: INV, destination: np, amount: "30", contract_id: CTR, payee_ein: EIN, dh: DH, memo_sha256: sha256Hex(M) };
  assert("approval: pending record = the co-signer's record (30.00 vs codec '30') -> ok", cosignerRecordProblems(pend, [seen]).length === 0, cosignerRecordProblems(pend, [seen]).join("; "));
  const forgedHash = "c".repeat(64);
  const forgedMemo = memoJson({ invoice_id: INV, contract_id: CTR, payee_ein: EIN, decision_hash: forgedHash, rule_version: "test" });
  assert("approval: CONSISTENT rewrite (amount x10, new hash + memo) -> refused by the co-signer's record", cosignerRecordProblems({ ...pend, amount: "300.00", decision_hash: forgedHash, memo_json: forgedMemo }, [seen]).length >= 2);
  assert("approval: no co-signer record for the decision -> refused", cosignerRecordProblems(pend, []).length === 1);
  assert("approval: two different co-signer records for one decision -> refused", cosignerRecordProblems(pend, [seen, { ...seen, amount: "300" }]).length > 0);
  assert("approval: another destination than the co-signer saw -> refused", cosignerRecordProblems({ ...pend, destination: other }, [seen]).length > 0);
}

console.log("\n--- Phase 3 fixes: Nessie ids stay out of Mongo ---");
{
  const id = "5f8d0d55b54764421b7156c3";
  const r1 = accountRef("a".repeat(32), "nessie", id);
  assert("bank: account_ref is an HMAC (64 hex), does not contain the account id, depends on the per-EIN key", /^[0-9a-f]{64}$/.test(r1) && !r1.includes(id) && r1 !== accountRef("b".repeat(32), "nessie", id) && r1 === accountRef("a".repeat(32), "nessie", id));
}

console.log("\n--- Sun (Q4): decision labels are not part of decision_hash ---");
{
  const core = { decision_id: "dec_20260927102113aaaa", invoice_id: "INV-P6-TAMPER-20260927-102113-A", contract_id: "CT1-069-20261409087", payee_ein: "00-0000001", amount: "1.00", currency: "RLUSD" as const, agent_reasoning: "x", rule_version: "p2-grok-1", source_tag: 26092026, created_at: "2026-09-27T10:21:13Z" };
  const h = computeDecisionHash(core);
  assert("labels: scenario/run_id/step/steps_total do not change decision_hash", computeDecisionHash({ ...core, scenario: "tamper", run_id: "run_x", step: 1, steps_total: 3 } as typeof core) === h && !(DECISION_HASH_FIELDS as readonly string[]).some((k) => ["scenario", "run_id", "step", "steps_total"].includes(k)));
  assert("labels: a hashed field still changes it", computeDecisionHash({ ...core, amount: "10.00" }) !== h);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
