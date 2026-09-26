// Adversarial check #2 (read-only): re-derive ledger STATE claims via raw JSON-RPC.
//  - RLUSD issuer Flags bitmask decoded independently (constants from rippled LedgerFormats.h) and
//    cross-checked with xrpl.js AccountRootFlags and the server's own `account_flags`
//  - TokenEscrow amendment: `feature` + Amendments ledger object + our own SHA-512Half("TokenEscrow")
//  - gateway_balances, treasury trust line + RippleState flags
//  - AMM pool / order books / ripple_path_find / funding math
//  - X1 balance deltas from tx metadata, X3c faucet amounts from each wallet's first incoming payment
//  - X5 credential ledger_entry, X6 multisig account signer list + flags + full account_tx history
// Run: cd xrpl && npx tsx scripts/risk/verify/state.ts
import crypto from "node:crypto";
import { LedgerEntry, parseAccountRootFlags } from "xrpl";
const AccountRootFlags = LedgerEntry.AccountRootFlags;
import { rpc, hexToUtf8, drops } from "./rpc";

const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const CUR = "524C555344000000000000000000000000000000";
const TREAS = "rLfrnvDZ4WsFybU8yCbA16jEvsMCQc6mkJ";
const RLUSD = { currency: CUR, issuer: ISSUER };

// rippled include/xrpl/protocol/LedgerFormats.h (AccountRoot)
const LSF: Record<string, number> = {
  lsfPasswordSpent: 0x00010000, lsfRequireDestTag: 0x00020000, lsfRequireAuth: 0x00040000, lsfDisallowXRP: 0x00080000,
  lsfDisableMaster: 0x00100000, lsfNoFreeze: 0x00200000, lsfGlobalFreeze: 0x00400000, lsfDefaultRipple: 0x00800000,
  lsfDepositAuth: 0x01000000, lsfAMM: 0x02000000, lsfDisallowIncomingNFTokenOffer: 0x04000000,
  lsfDisallowIncomingCheck: 0x08000000, lsfDisallowIncomingPayChan: 0x10000000, lsfDisallowIncomingTrustline: 0x20000000,
  lsfAllowTrustLineLocking: 0x40000000, lsfAllowTrustLineClawback: 0x80000000,
};
const decode = (f: number, t: Record<string, number>) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, (f & v) >>> 0 !== 0]));
const setBits = (f: number, t: Record<string, number>) => Object.entries(t).filter(([, v]) => ((f & v) >>> 0) !== 0).map(([k]) => k);
const sha512Half = (s: string) => crypto.createHash("sha512").update(Buffer.from(s, "ascii")).digest("hex").slice(0, 64).toUpperCase();
const val = (a: unknown) => (typeof a === "string" ? Number(a) / 1e6 : Number((a as { value: string }).value));

function section(t: string) { console.log(`\n##### ${t}`); }

async function main() {
  // ---------------- X2: issuer flags ----------------
  section("X2 RLUSD issuer account_info");
  const ai = await rpc<any>("account_info", { account: ISSUER, ledger_index: "validated", api_version: 2 });
  const ad = ai.account_data;
  const flags = Number(ad.Flags) >>> 0;
  const xrplJsSet = Object.entries(AccountRootFlags).filter(([k, v]) => typeof v === "number" && isNaN(Number(k)) && ((flags & (v as number)) >>> 0) !== 0).map(([k]) => k);
  console.log(JSON.stringify({
    ledger_index: ai.ledger_index, validated: ai.validated, Flags: flags, Flags_hex: "0x" + flags.toString(16).toUpperCase(),
    set_bits_rippled_constants: setBits(flags, LSF),
    set_bits_xrpljs_AccountRootFlags: xrplJsSet,
    xrpljs_parseAccountRootFlags: parseAccountRootFlags(flags),
    xrpljs_lsfAllowTrustLineLocking_constant: (AccountRootFlags as any).lsfAllowTrustLineLocking,
    bit_0x40000000_AllowTrustLineLocking: ((flags & 0x40000000) >>> 0) !== 0,
    unexplained_bits: "0x" + ((flags & ~Object.values(LSF).reduce((a, b) => (a | b) >>> 0, 0)) >>> 0).toString(16),
    server_account_flags: ai.account_flags,
    TransferRate: ad.TransferRate ?? "(absent)", TickSize: ad.TickSize, Domain: hexToUtf8(ad.Domain),
    Balance: drops(ad.Balance), OwnerCount: ad.OwnerCount,
  }, null, 2));

  // ---------------- X4a: amendment ----------------
  section("X4a TokenEscrow amendment");
  const id = sha512Half("TokenEscrow");
  const feat = await rpc<any>("feature", { feature: "TokenEscrow" });
  const feat2 = await rpc<any>("feature", { feature: id });
  const am = await rpc<any>("ledger_entry", { index: "7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4", ledger_index: "validated" });
  // Also confirm the Amendments object index itself = SHA-512Half(0x0066) (space key 'f')
  const amIdx = crypto.createHash("sha512").update(Buffer.from([0x00, 0x66])).digest("hex").slice(0, 64).toUpperCase();
  const credId = sha512Half("Credentials");
  console.log(JSON.stringify({
    my_sha512half_TokenEscrow: id, feature_by_name: feat, feature_by_id: feat2,
    amendments_index_derived: amIdx, amendments_ledger_index: am.ledger_index,
    TokenEscrow_in_Amendments: (am.node?.Amendments ?? []).includes(id),
    Credentials_in_Amendments: (am.node?.Amendments ?? []).includes(credId),
    total_enabled_amendments: (am.node?.Amendments ?? []).length,
  }, null, 2));

  // ---------------- X2: gateway_balances + treasury line ----------------
  section("X2 gateway_balances + treasury trust line");
  const gb = await rpc<any>("gateway_balances", { account: ISSUER, ledger_index: "validated" });
  console.log("obligations:", JSON.stringify(gb.obligations), "locked:", JSON.stringify(gb.locked ?? null), "frozen:", JSON.stringify(gb.frozen_balances ?? null), "error:", gb.error ?? null);
  const al = await rpc<any>("account_lines", { account: TREAS, peer: ISSUER, ledger_index: "validated" });
  console.log("treasury account_lines:", JSON.stringify(al.lines));
  const rs = await rpc<any>("ledger_entry", { ripple_state: { accounts: [TREAS, ISSUER], currency: CUR }, ledger_index: "validated" });
  const RS = { lsfLowReserve: 0x10000, lsfHighReserve: 0x20000, lsfLowAuth: 0x40000, lsfHighAuth: 0x80000, lsfLowNoRipple: 0x100000, lsfHighNoRipple: 0x200000, lsfLowFreeze: 0x400000, lsfHighFreeze: 0x800000 };
  console.log("RippleState:", JSON.stringify({ index: rs.index, Flags: rs.node?.Flags, set: setBits(Number(rs.node?.Flags), RS), LowLimit: rs.node?.LowLimit, HighLimit: rs.node?.HighLimit, Balance: rs.node?.Balance }));
  const tai = await rpc<any>("account_info", { account: TREAS, ledger_index: "validated" });
  console.log("treasury XRP:", drops(tai.account_data?.Balance), "Sequence:", tai.account_data?.Sequence);

  // ---------------- X4b: can any RLUSD escrow exist at all? ----------------
  section("X4b: any Escrow objects holding RLUSD? (gateway_balances.locked above; also issuer account_objects type=escrow)");
  const ao = await rpc<any>("account_objects", { account: ISSUER, type: "escrow", ledger_index: "validated", limit: 50 });
  console.log("issuer escrow objects:", JSON.stringify(ao.account_objects?.length ?? ao.error));

  // ---------------- X3b: AMM + books + path_find ----------------
  section("X3b AMM / books / path_find");
  const amm = await rpc<any>("amm_info", { asset: { currency: "XRP" }, asset2: RLUSD, ledger_index: "validated" });
  const x = val(amm.amm.amount), y = val(amm.amm.amount2), fee = amm.amm.trading_fee / 100000;
  console.log(JSON.stringify({ account: amm.amm.account, xrp: x, rlusd: y, trading_fee: amm.amm.trading_fee, spot_rlusd_per_xrp: y / x }));
  const out90 = y * (1 - x / (x + 90 * (1 - fee)));
  const xrpFor = (dy: number) => (x * dy) / (y - dy) / (1 - fee);
  const x2500 = xrpFor(2500), x10k = xrpFor(10000);
  console.log(JSON.stringify({
    amm_out_for_90_xrp: out90,
    xrp_needed_2500_rlusd: x2500, faucet_calls_2500_at_90: x2500 / 90,
    xrp_needed_10000_rlusd: x10k, faucet_calls_10000_at_90: x10k / 90,
    slippage_10000_vs_spot_incl_fee_pct: (1 - 10000 / x10k / (y / x)) * 100,
    price_impact_10000_excl_fee_pct: (1 - 10000 / (x10k * (1 - fee)) / (y / x)) * 100,
  }, null, 2));
  const bb = await rpc<any>("book_offers", { taker_gets: RLUSD, taker_pays: { currency: "XRP" }, limit: 100, ledger_index: "validated" });
  const sb = await rpc<any>("book_offers", { taker_gets: { currency: "XRP" }, taker_pays: RLUSD, limit: 100, ledger_index: "validated" });
  const fmt = (o: any) => ({ owner: o.Account, gets: val(o.taker_gets_funded ?? o.TakerGets), pays: val(o.taker_pays_funded ?? o.TakerPays), xrp_per_rlusd: val(o.taker_pays_funded ?? o.TakerPays) / val(o.taker_gets_funded ?? o.TakerGets) });
  console.log(`book taker_gets=RLUSD/taker_pays=XRP: ${bb.offers?.length} offers`, JSON.stringify(bb.offers?.slice(0, 8).map(fmt)));
  console.log(`book taker_gets=XRP/taker_pays=RLUSD: ${sb.offers?.length} offers (limit 100)`);
  const pf = await rpc<any>("ripple_path_find", { source_account: TREAS, destination_account: TREAS, destination_amount: { ...RLUSD, value: "-1" }, send_max: "90000000", ledger_index: "validated" });
  console.log("ripple_path_find:", JSON.stringify(pf.alternatives?.map((a: any) => ({ source_amount: a.source_amount, destination_amount: a.destination_amount })) ?? pf));

  // ---------------- X1: balance deltas from metadata ----------------
  section("X1 balance deltas from metadata");
  const x1 = await rpc<any>("tx", { transaction: "FCF8978B3F82AD44F6DBA73A555D80D7902804A7E2D50E70F60C1CB39EEB7741", api_version: 2 });
  for (const n of x1.meta.AffectedNodes) {
    const m = n.ModifiedNode;
    if (m?.LedgerEntryType === "AccountRoot") console.log(m.FinalFields.Account, "Balance", drops(m.PreviousFields?.Balance), "->", drops(m.FinalFields.Balance));
  }

  // ---------------- X3c: faucet amount per call ----------------
  section("X3c first incoming payment (faucet) for each throwaway wallet");
  const wallets: Record<string, string> = {
    X1_A: "rNQ9YwGHChHVkqK6HXvXiA6irYodAofTs4", X1_B: "rpbnxTWL6BaXuxuRsV9oTBK2sjVoStdFzt", SWAP: "rJ9oAnrkLU8brGG8frUNFUwri5kYNcwinw",
    ESC_DEST: "rE2FCQCSKSfDocnMs1Bw9sWw8kYZiyFAHF", TST_ISSUER: "rNMrMXkBtSiVmuC3hgRBvJMPidPUKm26io", TST_HOLDER: "rJBU6mDmkdoqMdZMEMGLMfsUJaXv5dRnCU",
    CRED_ISSUER: "rfn4kbeHJ1nEXZFVW6Vygg7qihu6G7qxy6", CRED_SUBJECT: "rGDcBNaE5UQgcu9MGPbMLvivt7HWWA1CMc", CRED_SUBJECT2: "rakqjE144XvCDXymeUo5tmJC42qX5UypfY",
    MS_M: "rEj5p7qqdKMZ6YPR5AjvghoSNpCy2PQQ1d",
  };
  for (const [name, addr] of Object.entries(wallets)) {
    const at = await rpc<any>("account_tx", { account: addr, forward: true, limit: 5, api_version: 2 });
    const incoming = (at.transactions ?? []).filter((t: any) => t.tx_json?.TransactionType === "Payment" && t.tx_json?.Destination === addr && t.tx_json?.Account !== addr);
    const first = incoming[0];
    console.log(name, addr, first ? `${drops(first.meta.delivered_amount)} from ${first.tx_json.Account} tx ${first.hash} ${first.meta.TransactionResult}` : `no incoming payment found (${at.error ?? "?"})`);
  }

  // ---------------- X5: credential ----------------
  section("X5 credential ledger_entry");
  const cr = await rpc<any>("ledger_entry", {
    credential: { subject: "rGDcBNaE5UQgcu9MGPbMLvivt7HWWA1CMc", issuer: "rfn4kbeHJ1nEXZFVW6Vygg7qihu6G7qxy6", credential_type: Buffer.from("NYC_VERIFIED_NONPROFIT").toString("hex").toUpperCase() },
    ledger_index: "validated",
  });
  const cn = cr.node ?? {};
  console.log(JSON.stringify({ error: cr.error, index: cr.index, LedgerEntryType: cn.LedgerEntryType, Flags: cn.Flags, lsfAccepted: ((Number(cn.Flags) & 0x10000) >>> 0) !== 0, Expiration: cn.Expiration, Expiration_iso: cn.Expiration ? new Date((cn.Expiration + 946684800) * 1000).toISOString() : null, CredentialType: hexToUtf8(cn.CredentialType), URI: hexToUtf8(cn.URI) }, null, 2));
  const cr2 = await rpc<any>("ledger_entry", {
    credential: { subject: "rakqjE144XvCDXymeUo5tmJC42qX5UypfY", issuer: "rfn4kbeHJ1nEXZFVW6Vygg7qihu6G7qxy6", credential_type: Buffer.from("NYC_VERIFIED_NONPROFIT").toString("hex").toUpperCase() },
    ledger_index: "validated",
  });
  console.log("past-expiry subject credential exists on ledger?", cr2.error ?? "YES (unexpected)");

  // ---------------- X6: multisig account ----------------
  section("X6 multisig account M");
  const M = "rEj5p7qqdKMZ6YPR5AjvghoSNpCy2PQQ1d";
  const mi = await rpc<any>("account_info", { account: M, ledger_index: "validated", signer_lists: true, api_version: 2 });
  const mf = Number(mi.account_data.Flags) >>> 0;
  console.log(JSON.stringify({ Flags: mf, set: setBits(mf, LSF), server_account_flags: mi.account_flags, signer_lists: mi.signer_lists, balance: drops(mi.account_data.Balance) }, null, 2));
  const mt = await rpc<any>("account_tx", { account: M, forward: true, limit: 50, api_version: 2 });
  for (const t of mt.transactions ?? []) {
    const j = t.tx_json;
    console.log(t.ledger_index, t.hash, j.TransactionType, t.meta.TransactionResult, j.Account === M ? "(from M)" : `(from ${j.Account})`,
      j.SetFlag !== undefined ? `SetFlag=${j.SetFlag}` : "", j.Signers ? `Signers=${j.Signers.map((s: any) => s.Signer.Account).join(",")}` : (j.SigningPubKey ? "single-signed" : ""),
      j.Amount ? `Amount=${JSON.stringify(drops(j.Amount))}` : "", j.Destination ? `-> ${j.Destination}` : "");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
