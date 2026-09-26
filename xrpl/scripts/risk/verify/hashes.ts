// Adversarial check #1: look up EVERY tx hash claimed by the Phase 0 risk checks via raw JSON-RPC `tx`
// and compare validated / TransactionType / TransactionResult / Account / Destination / Amount with the claim.
// Run: cd xrpl && npx tsx scripts/risk/verify/hashes.ts
import { rpc, hexToUtf8, drops } from "./rpc";

type Expect = { id: string; hash: string; type: string; result: string; account?: string; destination?: string; note?: string };

const A = "rNQ9YwGHChHVkqK6HXvXiA6irYodAofTs4", B = "rpbnxTWL6BaXuxuRsV9oTBK2sjVoStdFzt";
const SWAP = "rJ9oAnrkLU8brGG8frUNFUwri5kYNcwinw", TREAS = "rLfrnvDZ4WsFybU8yCbA16jEvsMCQc6mkJ";
const TSTI = "rNMrMXkBtSiVmuC3hgRBvJMPidPUKm26io", TSTH = "rJBU6mDmkdoqMdZMEMGLMfsUJaXv5dRnCU", DEST = "rE2FCQCSKSfDocnMs1Bw9sWw8kYZiyFAHF";
const CI = "rfn4kbeHJ1nEXZFVW6Vygg7qihu6G7qxy6", CS = "rGDcBNaE5UQgcu9MGPbMLvivt7HWWA1CMc", CS2 = "rakqjE144XvCDXymeUo5tmJC42qX5UypfY";
const M = "rEj5p7qqdKMZ6YPR5AjvghoSNpCy2PQQ1d";

const CLAIMS: Expect[] = [
  { id: "X1", hash: "FCF8978B3F82AD44F6DBA73A555D80D7902804A7E2D50E70F60C1CB39EEB7741", type: "Payment", result: "tesSUCCESS", account: A, destination: B, note: "1 XRP, ledger 21070837, SourceTag 26092026" },
  { id: "X3b", hash: "B7FD0F021D47A8AFBD82A0748DAC955DE1A4E3398C22539C60BB7E60C33B0729", type: "Payment", result: "tesSUCCESS", account: SWAP, destination: SWAP, note: "delivered 1.4914128247 RLUSD, SendMax 5 XRP" },
  { id: "X3b", hash: "1B33B9D890BAB28B9066480F03C0B56B664627B7B6E7905944BEA4955D1995B4", type: "TrustSet", result: "tesSUCCESS", account: SWAP },
  { id: "X4b", hash: "1CC289C6F121B53BBB71CDBB176CBAABD25600E16A91D83EAF35C34D879F4862", type: "EscrowCreate", result: "tecNO_PERMISSION", account: TREAS },
  { id: "X4b", hash: "93268D1472B2E84E9536EA46926EC8C4BD0584216F80A806E6FB1A8033C798B5", type: "EscrowCreate", result: "tecNO_PERMISSION", account: SWAP },
  { id: "X4b", hash: "9DCE1C16C770D38E5D752F8A35821816959BE8374D7A56B37C92A5DA42EB27CB", type: "EscrowCreate", result: "tecNO_PERMISSION", account: TREAS },
  { id: "X4b", hash: "21F371744BC98204006D12030147462463C5CBCE0020821E8F934CE01459CAD4", type: "EscrowCreate", result: "tecNO_PERMISSION", account: SWAP },
  { id: "X4c", hash: "0F8EB79D39BB7A214E54B2BE2AC347BC9B2143DD574DAA367784455E994D155E", type: "AccountSet", result: "tesSUCCESS", account: TSTI, note: "SetFlag 17" },
  { id: "X4c", hash: "DE43EB8D5770360E05B2A1DDBDF1EC67C306FF94DB19825A5804C9E6CCE43F69", type: "TrustSet", result: "tesSUCCESS", account: TSTH },
  { id: "X4c", hash: "D1810539CF967B44F50C706677369CC5C661317C3FA864DB626EE0FB865FD616", type: "TrustSet", result: "tesSUCCESS", account: DEST },
  { id: "X4c", hash: "F7B49E29198A98D9DBB1173232259FE9A127FB4E18F8EE31AD3B7B3603ADDC6E", type: "Payment", result: "tesSUCCESS", account: TSTI, destination: TSTH, note: "100 TST" },
  { id: "X4c", hash: "3868D27ECD819A55D0F8657ABC6C52DE70CF159CAA6EC953F88969A9CD892F15", type: "EscrowCreate", result: "tesSUCCESS", account: TSTH, destination: DEST, note: "10 TST, Condition + CancelAfter" },
  { id: "X4c", hash: "67E76D72B40DD2F8DD710A4109A94F9F4409B7CC5429ECA406149C0AFCC26AF5", type: "EscrowFinish", result: "tesSUCCESS", account: DEST },
  { id: "X4c", hash: "FCF9EBD7EE93470A7FE1983BE0E62AA7BAA62B3698B40032FA377A6A869EAD3E", type: "EscrowCreate", result: "tesSUCCESS", account: TSTH, destination: DEST },
  { id: "X4c", hash: "E2D442AEC8B3A7BF21A76E468142EFE93E58A0AAE8CE609AF4BD4F2249822D9D", type: "EscrowFinish", result: "tesSUCCESS", account: DEST },
  { id: "X5", hash: "48B1DC96D078E0E8372DBE1B98273CEA6C8B02CECF7E64DB000F511DCEE92DA3", type: "CredentialCreate", result: "tesSUCCESS", account: CI },
  { id: "X5", hash: "C1ADEB8DAFDE67C58D075255D6DAF4703BAD56EFC87B82F6FCDF4604C120CA48", type: "CredentialAccept", result: "tesSUCCESS", account: CS },
  { id: "X5", hash: "4A2B71C59A22B5E26E593104BC4A3B5683B2C5FD96F6F93F45F1DF8BCFA093CE", type: "CredentialCreate", result: "tecEXPIRED", account: CI, note: "subject CS2" },
  { id: "X5", hash: "7CD57D8CBB90C66BE0A5BE9A24FADDA34F7AFFB0093572B1AED45450207EFCAB", type: "CredentialDelete", result: "tesSUCCESS", account: CI },
  { id: "X5", hash: "CA31410B2CD9D635097F8A9470BB63EC06E036B9979F7DEFF1BE90511D3D5FDC", type: "CredentialCreate", result: "tesSUCCESS", account: CI },
  { id: "X5", hash: "7F84610E08D55564B0379CDD0D2C9779EE3D3DECC7FCC79954070906B5C4714E", type: "CredentialAccept", result: "tesSUCCESS", account: CS },
  { id: "X5", hash: "BF9A027C9702E21B45234504F82B7B125B918E9031E1223214AFB7710E3F7954", type: "CredentialCreate", result: "tecEXPIRED", account: CI },
  { id: "X6", hash: "17898D16CF6CA6C1F68D16D6761D2B0071346A062F5C389A1B19FD0C6F2DFCE1", type: "SignerListSet", result: "tesSUCCESS", account: M },
];

type TxRes = {
  status?: string; error?: string; validated?: boolean; ledger_index?: number; hash?: string;
  meta?: { TransactionResult: string; delivered_amount?: unknown; AffectedNodes?: unknown[] };
  tx_json?: Record<string, unknown>;
} & Record<string, unknown>;

async function main() {
  let ok = 0, bad = 0;
  const rows: unknown[] = [];
  for (const c of CLAIMS) {
    const r = await rpc<TxRes>("tx", { transaction: c.hash, binary: false, api_version: 2 });
    const tx = (r.tx_json ?? r) as Record<string, unknown>;
    const got = {
      found: !r.error, error: r.error, validated: r.validated, ledger_index: r.ledger_index,
      TransactionType: tx.TransactionType, TransactionResult: r.meta?.TransactionResult,
      Account: tx.Account, Destination: tx.Destination, Amount: drops(tx.DeliverMax ?? tx.Amount), SendMax: drops(tx.SendMax),
      Flags: tx.Flags, SetFlag: tx.SetFlag, SourceTag: tx.SourceTag, delivered_amount: drops(r.meta?.delivered_amount),
      Subject: tx.Subject, Expiration: tx.Expiration, CredentialType: hexToUtf8(tx.CredentialType as string),
      Condition: tx.Condition, CancelAfter: tx.CancelAfter, OfferSequence: tx.OfferSequence, Owner: tx.Owner,
      SignerQuorum: tx.SignerQuorum, SignerEntries: tx.SignerEntries,
      LimitAmount: tx.LimitAmount,
      Memos: (tx.Memos as { Memo: Record<string, string> }[] | undefined)?.map((m) => ({
        MemoType: m.Memo.MemoType, MemoType_utf8: hexToUtf8(m.Memo.MemoType), MemoFormat_utf8: hexToUtf8(m.Memo.MemoFormat), MemoData_utf8: hexToUtf8(m.Memo.MemoData),
      })),
    };
    const mismatches: string[] = [];
    if (!got.found) mismatches.push(`not found (${r.error})`);
    if (got.validated !== true) mismatches.push(`validated=${got.validated}`);
    if (got.TransactionType !== c.type) mismatches.push(`type ${got.TransactionType} != ${c.type}`);
    if (got.TransactionResult !== c.result) mismatches.push(`result ${got.TransactionResult} != ${c.result}`);
    if (c.account && got.Account !== c.account) mismatches.push(`Account ${got.Account} != ${c.account}`);
    if (c.destination && got.Destination !== c.destination) mismatches.push(`Destination ${got.Destination} != ${c.destination}`);
    if (mismatches.length) bad++; else ok++;
    rows.push({ id: c.id, hash: c.hash, claim: `${c.type} ${c.result}${c.note ? " / " + c.note : ""}`, verdict: mismatches.length ? "MISMATCH" : "MATCH", mismatches, got });
  }
  console.log(JSON.stringify(rows, null, 2));
  console.log(`\nSUMMARY: ${ok} match, ${bad} mismatch, of ${CLAIMS.length} claimed hashes`);
}
main().catch((e) => { console.error(e); process.exit(1); });
