// Phase 0 risk check: create (or reuse) the city_treasury wallet and its RLUSD trust line so it can
// receive Testnet RLUSD from https://tryrlusd.com. Idempotent: the seed is stored in xrpl/.env.local.
import fs from "node:fs";
import path from "node:path";
import { Client, Wallet, TrustSetFlags } from "xrpl";
import { loadEnv, paths } from "../../src/env";

loadEnv();
const WS = process.env.XRPL_WS ?? "wss://s.altnet.rippletest.net:51233";
const ISSUER = process.env.RLUSD_ISSUER!;
const CUR = process.env.RLUSD_CURRENCY_HEX!;
const envLocal = path.join(paths.xrplDir, ".env.local");

async function main() {
  if (!ISSUER || !CUR) throw new Error("RLUSD_ISSUER / RLUSD_CURRENCY_HEX missing from .env");
  const client = new Client(WS);
  await client.connect();
  try {
    let wallet: Wallet;
    if (process.env.TREASURY_SEED) {
      wallet = Wallet.fromSeed(process.env.TREASURY_SEED);
      console.log("reusing city_treasury", wallet.address);
    } else {
      const funded = await client.fundWallet();
      wallet = funded.wallet;
      fs.appendFileSync(envLocal, `TREASURY_SEED=${wallet.seed}\nTREASURY_ADDRESS=${wallet.address}\n`);
      console.log("created city_treasury", wallet.address, "XRP balance", funded.balance);
    }
    const lines = await client.request({ command: "account_lines", account: wallet.address, peer: ISSUER });
    let line = lines.result.lines.find((l) => l.currency === CUR);
    if (!line) {
      const res = await client.submitAndWait(
        { TransactionType: "TrustSet", Account: wallet.address, LimitAmount: { currency: CUR, issuer: ISSUER, value: "1000000000" }, Flags: TrustSetFlags.tfSetNoRipple },
        { autofill: true, wallet },
      );
      const r = (res.result.meta as { TransactionResult: string }).TransactionResult;
      console.log("TrustSet", r, `https://testnet.xrpl.org/transactions/${res.result.hash}`);
      if (r !== "tesSUCCESS") process.exitCode = 1;
    } else {
      console.log("trust line exists; RLUSD balance", line.balance);
    }
  } finally {
    await client.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
