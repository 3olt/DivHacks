// Shared helpers for the Phase 0 XRPL risk-check scripts (Testnet only).
// Throwaway wallets are generated once and their seeds appended to the gitignored xrpl/.env.local
// as RISK_<NAME>_SEED, so every script is re-runnable without burning faucet calls.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client, Wallet, type SubmittableTransaction, type TxResponse } from "xrpl";
import { loadEnv, paths } from "../../src/env";

loadEnv();

export const WS = process.env.XRPL_WS ?? "wss://s.altnet.rippletest.net:51233";
if (!/altnet|testnet|devnet/.test(WS)) throw new Error(`refusing to run risk checks against non-test network ${WS}`);
export const RLUSD_ISSUER = process.env.RLUSD_ISSUER ?? "";
export const RLUSD_CUR = process.env.RLUSD_CURRENCY_HEX ?? "";
export const SOURCE_TAG = Number(process.env.AGENT_SOURCE_TAG ?? "26092026");
const envLocal = path.join(paths.xrplDir, ".env.local");

export const explorer = (hash: string) => `https://testnet.xrpl.org/transactions/${hash}`;
export const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const RIPPLE_EPOCH = 946684800;
export const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

export async function connect(): Promise<Client> {
  const client = new Client(WS, { timeout: 30000 });
  await client.connect();
  return client;
}

export async function xrpBalance(client: Client, address: string): Promise<number | null> {
  try {
    const r = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    return Number(r.result.account_data.Balance) / 1e6;
  } catch (e) {
    if (String((e as { data?: { error?: string } }).data?.error ?? e).includes("actNotFound")) return null;
    throw e;
  }
}

/** Calls the Testnet faucet with exponential backoff. Returns the XRP the faucet added. */
export async function fundWithRetry(client: Client, wallet: Wallet, tries = 6): Promise<number> {
  let delay = 5000;
  for (let i = 1; ; i++) {
    try {
      const before = (await xrpBalance(client, wallet.address)) ?? 0;
      const res = await client.fundWallet(wallet, { usageContext: "divhacks-risk-check" });
      const added = res.balance - before;
      console.log(`  faucet: ${wallet.address} +${added} XRP (balance ${res.balance})`);
      return added;
    } catch (e) {
      console.warn(`  faucet attempt ${i}/${tries} failed: ${(e as Error).message}`);
      if (i >= tries) throw e;
      await sleep(delay);
      delay *= 2;
    }
  }
}

/** A seed-only keypair (never funded), persisted as RISK_<NAME>_SEED. */
export function keypair(name: string): Wallet {
  const key = `RISK_${name}_SEED`;
  const existing = process.env[key];
  if (existing) return Wallet.fromSeed(existing);
  const w = Wallet.generate();
  fs.appendFileSync(envLocal, `${key}=${w.seed}\n${`RISK_${name}_ADDRESS`}=${w.address}\n`);
  process.env[key] = w.seed;
  return w;
}

/** A funded throwaway wallet. Re-funds from the faucet if the account is missing or below minXrp. */
export async function fundedWallet(client: Client, name: string, minXrp = 20): Promise<Wallet> {
  const w = keypair(name);
  const bal = await xrpBalance(client, w.address);
  if (bal === null || bal < minXrp) {
    console.log(`  ${name} ${w.address} balance ${bal ?? "(not on ledger)"} -> funding`);
    await fundWithRetry(client, w);
  } else {
    console.log(`  reusing ${name} ${w.address} (${bal} XRP)`);
  }
  return w;
}

export type Outcome = { hash: string; result: string; link: string; tx: TxResponse["result"] };

/** autofill + sign + submitAndWait; returns the validated TransactionResult. */
export async function submitWait(client: Client, tx: SubmittableTransaction, wallet: Wallet, label: string): Promise<Outcome> {
  const res = await client.submitAndWait(tx, { autofill: true, wallet });
  const result = (res.result.meta as { TransactionResult: string }).TransactionResult;
  const out = { hash: res.result.hash, result, link: explorer(res.result.hash), tx: res.result };
  console.log(`  ${label}: ${result} ${out.link}`);
  return out;
}

export type Prelim = { engine_result: string; engine_result_message: string; hash: string; link: string; final?: string };

/** Submits an already-signed blob with `submit` (not submitAndWait), records engine_result, then
 *  (if the tx could be included) waits for validation to report the final result as well. */
export async function submitBlob(client: Client, blob: string, hash: string, label: string): Promise<Prelim> {
  const r = await client.request({ command: "submit", tx_blob: blob });
  const out: Prelim = {
    engine_result: r.result.engine_result,
    engine_result_message: r.result.engine_result_message,
    hash,
    link: explorer(hash),
  };
  console.log(`  ${label}: engine_result=${out.engine_result} (${out.engine_result_message}) hash=${hash}`);
  if (out.engine_result === "tesSUCCESS" || out.engine_result.startsWith("tec") || out.engine_result === "terQUEUED") {
    out.final = await waitFinal(client, hash);
    console.log(`  ${label}: validated result=${out.final} ${out.link}`);
  }
  return out;
}

export async function waitFinal(client: Client, hash: string, timeoutMs = 30000): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const t = await client.request({ command: "tx", transaction: hash });
      if (t.result.validated) return (t.result.meta as { TransactionResult: string }).TransactionResult;
    } catch {
      /* txnNotFound until it lands */
    }
    await sleep(1500);
  }
  return "not-validated-within-timeout";
}

/** Ensures `holder` has a trust line to issuer/currency. */
export async function ensureTrustLine(client: Client, holder: Wallet, issuer: string, currency: string, limit = "1000000000"): Promise<void> {
  const lines = await client.request({ command: "account_lines", account: holder.address, peer: issuer });
  if (lines.result.lines.some((l) => l.currency === currency)) {
    console.log(`  trust line ${holder.address} -> ${issuer} ${currency} exists`);
    return;
  }
  await submitWait(client, { TransactionType: "TrustSet", Account: holder.address, LimitAmount: { currency, issuer, value: limit } }, holder, `TrustSet ${holder.address}`);
}

export async function tokenBalance(client: Client, holder: string, issuer: string, currency: string): Promise<number> {
  const lines = await client.request({ command: "account_lines", account: holder, peer: issuer, ledger_index: "validated" });
  const line = lines.result.lines.find((l) => l.currency === currency);
  return line ? Number(line.balance) : 0;
}

/** PREIMAGE-SHA-256 crypto-condition for a 32-byte preimage (RFC draft / rippled format). */
export function preimageCondition(preimage = crypto.randomBytes(32)) {
  const digest = crypto.createHash("sha256").update(preimage).digest("hex");
  return {
    preimage: preimage.toString("hex").toUpperCase(),
    condition: ("A0258020" + digest + "810120").toUpperCase(),
    fulfillment: ("A0228020" + preimage.toString("hex")).toUpperCase(),
  };
}

export function header(title: string) {
  console.log(`\n=== ${title} ===  (${WS})`);
}
