// Offline unit tests (no network, no keys from env): the co-signer's 8 checks, the verifier's address scrubbing and
// the payment builder's cross-checks. Throwaway keypairs are generated in memory for signing test transactions.
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
    agentAccount: account, signerAddresses: { agent: agent.address, officer: officer.address }, allowlist: new Set([np]),
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
// 1 credential_valid
expect("1 credential expired in registry", good, ctx({ registry: snapshot([entry({ credential_expires: "2026-09-01T00:00:00Z" })]) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 credential_status none", good, ctx({ registry: snapshot([entry({ credential_status: "none" })]) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
expect("1 destination not on allowlist", good, ctx({ allowlist: new Set([other]) }), { failed: ["credential_valid"], codes: ["credential_invalid"] });
// 2 destination_is_registry_wallet
expect("2 Destination is not the registry wallet (attacker)", signedBy(baseTx({ Destination: other })), ctx(), { failed: ["credential_valid", "destination_is_registry_wallet"], codes: ["credential_invalid", "destination_not_registry_wallet"] });
expect("2 memo ein != contract payee EIN", signedBy(baseTx({ Memos: [memoFor(INV, CTR, "00-0000002")] })), ctx(), { failed: ["destination_is_registry_wallet"], codes: ["destination_not_registry_wallet"] });
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
expect("7 payee EIN on the exclusion list", signedBy(baseTx({ Destination: other, Memos: [memoFor(INV, CTR, "00-0000090")] })), ctx({ registry: exReg, allowlist: new Set([np, other]), contract: CV({ nonprofit_ein: "00-0000090" }) }), { failed: ["payee_not_excluded"], codes: ["payee_excluded"] });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
