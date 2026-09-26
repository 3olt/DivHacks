// X3b/c: Can we buy Testnet RLUSD with faucet XRP? Reads the XRP/RLUSD AMM + order books, estimates what
// 90 XRP buys, and proves it with ONE small swap (Payment-to-self, SendMax in XRP, tfPartialPayment)
// into a throwaway wallet with an RLUSD trust line. Also reports XRP per faucet call.
// Run: cd xrpl && npx tsx scripts/risk/dex-rlusd.ts [--quote-only] [--swap] [--xrp=5]
//   default: quotes, and swaps only if the throwaway wallet holds 0 RLUSD (idempotent). --swap forces a new swap.
import { xrpToDrops, PaymentFlags } from "xrpl";
import { connect, fundedWallet, ensureTrustLine, submitWait, tokenBalance, header, RLUSD_ISSUER, RLUSD_CUR, SOURCE_TAG, toHex, xrpBalance } from "./_lib";

const args = process.argv.slice(2);
const QUOTE_ONLY = args.includes("--quote-only");
const FORCE_SWAP = args.includes("--swap");
const SWAP_XRP = Number(args.find((a) => a.startsWith("--xrp="))?.split("=")[1] ?? "5");
const BUDGET_XRP = 90;
const RLUSD = { currency: RLUSD_CUR, issuer: RLUSD_ISSUER };

type Off = { TakerGets: unknown; TakerPays: unknown; taker_gets_funded?: unknown; taker_pays_funded?: unknown; quality?: string; Account: string };
const val = (a: unknown): number => (typeof a === "string" ? Number(a) / 1e6 : Number((a as { value: string }).value));

async function main() {
  header("X3 RLUSD acquisition via Testnet DEX/AMM");
  const client = await connect();
  try {
    // --- AMM ---
    let amm: { xrp: number; rlusd: number; feePct: number; account: string } | null = null;
    try {
      const r = await client.request({ command: "amm_info", asset: { currency: "XRP" }, asset2: RLUSD, ledger_index: "validated" } as never);
      const a = (r as { result: { amm: { amount: unknown; amount2: unknown; trading_fee: number; account: string; lp_token: unknown } } }).result.amm;
      const xrp = val(a.amount), rlusd = val(a.amount2);
      amm = { xrp, rlusd, feePct: a.trading_fee / 1000, account: a.account };
      console.log("amm_info:", JSON.stringify({ account: a.account, amount_xrp: xrp, amount2_rlusd: rlusd, trading_fee: a.trading_fee, spot_rlusd_per_xrp: rlusd / xrp }));
    } catch (e) {
      console.log("amm_info error:", (e as { data?: { error?: string } }).data?.error ?? (e as Error).message);
    }

    // --- Order books, both directions ---
    // (1) offers that GIVE RLUSD for XRP (what a buyer of RLUSD consumes)
    const buyBook = await client.request({ command: "book_offers", taker_gets: RLUSD, taker_pays: { currency: "XRP" }, limit: 50, ledger_index: "validated" });
    // (2) offers that GIVE XRP for RLUSD
    const sellBook = await client.request({ command: "book_offers", taker_gets: { currency: "XRP" }, taker_pays: RLUSD, limit: 50, ledger_index: "validated" });
    const summarize = (offers: Off[]) => offers.slice(0, 5).map((o) => ({ owner: o.Account, gets: val(o.taker_gets_funded ?? o.TakerGets), pays: val(o.taker_pays_funded ?? o.TakerPays), quality: o.quality }));
    console.log(`book_offers taker_gets=RLUSD taker_pays=XRP: ${buyBook.result.offers.length} offers`, JSON.stringify(summarize(buyBook.result.offers as unknown as Off[])));
    console.log(`book_offers taker_gets=XRP taker_pays=RLUSD: ${sellBook.result.offers.length} offers`, JSON.stringify(summarize(sellBook.result.offers as unknown as Off[])));

    // --- Estimate what 90 XRP buys ---
    let bookOut = 0, spent = 0;
    for (const o of buyBook.result.offers as unknown as Off[]) {
      const gets = val(o.taker_gets_funded ?? o.TakerGets), pays = val(o.taker_pays_funded ?? o.TakerPays);
      if (gets <= 0 || pays <= 0) continue;
      const take = Math.min(pays, BUDGET_XRP - spent);
      bookOut += gets * (take / pays); spent += take;
      if (spent >= BUDGET_XRP) break;
    }
    const ammOut = amm ? amm.rlusd * (1 - amm.xrp / (amm.xrp + BUDGET_XRP * (1 - amm.feePct / 100))) : 0;
    console.log("estimate for", BUDGET_XRP, "XRP:", JSON.stringify({ amm_only_rlusd: +ammOut.toFixed(6), book_only_rlusd: +bookOut.toFixed(6), book_xrp_consumable: +spent.toFixed(6) }));

    // --- rippled's own quote (path_find as much as possible with SendMax 90 XRP) ---
    const probe = process.env.RISK_SWAP_ADDRESS ?? process.env.TREASURY_ADDRESS!;
    try {
      const pf = await client.request({
        command: "ripple_path_find", source_account: probe, destination_account: probe,
        destination_amount: { ...RLUSD, value: "-1" }, send_max: xrpToDrops(BUDGET_XRP), ledger_index: "validated",
      } as never);
      const alts = (pf as { result: { alternatives: { source_amount: unknown; destination_amount?: unknown }[] } }).result.alternatives;
      console.log("ripple_path_find (dest=-1, send_max=90 XRP):", JSON.stringify(alts.map((a) => ({ source_amount: a.source_amount, destination_amount: a.destination_amount }))));
    } catch (e) {
      console.log("ripple_path_find error:", (e as { data?: { error?: string; error_message?: string } }).data?.error_message ?? (e as Error).message);
    }

    if (QUOTE_ONLY) return;

    // --- Prove with ONE small swap ---
    const w = await fundedWallet(client, "SWAP", 30);
    await ensureTrustLine(client, w, RLUSD_ISSUER, RLUSD_CUR);
    const had = await tokenBalance(client, w.address, RLUSD_ISSUER, RLUSD_CUR);
    if (had > 0 && !FORCE_SWAP) {
      console.log(`SWAP wallet ${w.address} already holds ${had} RLUSD from a previous run; pass --swap to swap again.`);
      return;
    }
    const xrpBefore = await xrpBalance(client, w.address);
    const out = await submitWait(client, {
      TransactionType: "Payment", Account: w.address, Destination: w.address,
      Amount: { ...RLUSD, value: "1000000" }, SendMax: xrpToDrops(SWAP_XRP), Flags: PaymentFlags.tfPartialPayment,
      SourceTag: SOURCE_TAG, Memos: [{ Memo: { MemoType: toHex("divhacks/risk/v1"), MemoData: toHex(`X3 swap ${SWAP_XRP} XRP->RLUSD`) } }],
    }, w, `swap ${SWAP_XRP} XRP -> RLUSD (Payment to self)`);
    const meta = out.tx.meta as { delivered_amount?: unknown; TransactionResult: string };
    const after = await tokenBalance(client, w.address, RLUSD_ISSUER, RLUSD_CUR);
    console.log(JSON.stringify({
      check: "X3b", wallet: w.address, hash: out.hash, TransactionResult: out.result, explorer: out.link,
      xrp_sent_max: SWAP_XRP, delivered_amount: meta.delivered_amount, rlusd_balance_after: after,
      xrp_before: xrpBefore, xrp_after: await xrpBalance(client, w.address),
    }, null, 2));
  } finally {
    await client.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
