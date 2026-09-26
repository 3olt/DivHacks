// X1: Testnet faucet works and a plain XRP Payment with SourceTag + Memo validates.
// Run: cd xrpl && npx tsx scripts/risk/xrp-payment.ts
import { xrpToDrops } from "xrpl";
import { connect, fundedWallet, submitWait, toHex, header, SOURCE_TAG, xrpBalance } from "./_lib";

async function main() {
  header("X1 faucet wallets + 1 XRP payment");
  const client = await connect();
  try {
    const a = await fundedWallet(client, "X1_A");
    const b = await fundedWallet(client, "X1_B");
    const before = await xrpBalance(client, b.address);
    const memoData = { check: "X1", at: new Date().toISOString() };
    const out = await submitWait(
      client,
      {
        TransactionType: "Payment",
        Account: a.address,
        Destination: b.address,
        Amount: xrpToDrops(1),
        SourceTag: SOURCE_TAG,
        Memos: [{ Memo: { MemoType: toHex("divhacks/risk/v1"), MemoData: toHex(JSON.stringify(memoData)), MemoFormat: toHex("application/json") } }],
      },
      a,
      "Payment 1 XRP A->B",
    );
    const after = await xrpBalance(client, b.address);
    const tx = out.tx.tx_json as { SourceTag?: number; Memos?: unknown };
    console.log(JSON.stringify({
      check: "X1",
      pass: out.result === "tesSUCCESS" && tx.SourceTag === SOURCE_TAG,
      from: a.address,
      to: b.address,
      hash: out.hash,
      TransactionResult: out.result,
      validated: out.tx.validated,
      ledger_index: out.tx.ledger_index,
      SourceTag: tx.SourceTag,
      Memos: tx.Memos,
      b_balance_before: before,
      b_balance_after: after,
      explorer: out.link,
    }, null, 2));
    if (out.result !== "tesSUCCESS") process.exitCode = 1;
  } finally {
    await client.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
