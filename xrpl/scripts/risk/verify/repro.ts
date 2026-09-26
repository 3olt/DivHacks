// Adversarial check #3 (writes to TESTNET): independent reproductions of the claims that cannot be read
// back from ledger state. Uses FRESH faucet wallets (seeds kept in memory only, never persisted/printed),
// never touches city_treasury, and does not import the risk scripts' _lib.ts.
//   R1  faucet amount per call                              (X3c)
//   R2  fresh wallet buys RLUSD on the XRP/RLUSD AMM         (X3b)
//   R3  funded fresh holder: RLUSD EscrowCreate              (X4b: expect tecNO_PERMISSION)
//   R4  CONTROL isolating the root cause with our own token CTL, identical EscrowCreate params:
//        R4a issuer WITHOUT lsfAllowTrustLineLocking, holder funded       -> ?
//        R4b issuer sets asfAllowTrustLineLocking (17), same escrow         -> ?
//        R4c flag set, amount > holder balance (what "0 balance" gives)    -> ?
//        R4d flag set, escrow from an account with NO trust line          -> ?
//   R5  multisig quorum on the X6 account M (its signer seeds read from xrpl/.env.local, never printed):
//        S1 only (w1), S2 only (w2), S1+S3 (w2), master key, unlisted key  -> engine_result each
// Run: cd xrpl && npx tsx scripts/risk/verify/repro.ts [--skip-multisig] [--skip-escrow]
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Client, Wallet, multisign, hashes, xrpToDrops, type SubmittableTransaction, type Payment } from "xrpl";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../../.env"), quiet: true });
config({ path: path.resolve(here, "../../../.env.local"), quiet: true });

const WS = "wss://s.altnet.rippletest.net:51233";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const CUR = "524C555344000000000000000000000000000000";
const ESC_DEST = "rE2FCQCSKSfDocnMs1Bw9sWw8kYZiyFAHF"; // same destination the X4 script used
const X1_B = "rpbnxTWL6BaXuxuRsV9oTBK2sjVoStdFzt";
const args = process.argv.slice(2);
const explorer = (h: string) => `https://testnet.xrpl.org/transactions/${h}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rippleNow = () => Math.floor(Date.now() / 1000) - 946684800;
const results: Record<string, unknown> = {};

function condition() {
  const pre = crypto.randomBytes(32);
  return { condition: ("A0258020" + crypto.createHash("sha256").update(pre).digest("hex") + "810120").toUpperCase() };
}

async function waitValidated(client: Client, hash: string, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const t = await client.request({ command: "tx", transaction: hash });
      if (t.result.validated) return t.result;
    } catch { /* not yet */ }
    await sleep(1500);
  }
  return null;
}

/** Sign with `w`, `submit` (records engine_result), then wait for validation when the tx can be included. */
async function submitRaw(client: Client, tx: SubmittableTransaction, w: Wallet, label: string) {
  const prepared = await client.autofill(tx);
  const signed = w.sign(prepared);
  const r = await client.request({ command: "submit", tx_blob: signed.tx_blob });
  const out: Record<string, unknown> = { label, engine_result: r.result.engine_result, engine_result_message: r.result.engine_result_message, hash: signed.hash };
  if (/^(tes|tec)/.test(r.result.engine_result) || r.result.engine_result === "terQUEUED") {
    const v = await waitValidated(client, signed.hash);
    out.validated = !!v;
    out.final = v ? (v.meta as { TransactionResult: string }).TransactionResult : "not validated in time";
    if (v) out.delivered_amount = (v.meta as { delivered_amount?: unknown }).delivered_amount;
    out.explorer = explorer(signed.hash);
  }
  console.log(`  ${label}: engine_result=${out.engine_result}${out.final ? ` final=${out.final}` : ""} ${out.explorer ?? "(not applied; hash " + signed.hash + ")"}`);
  return out;
}

async function faucet(client: Client, label: string) {
  for (let i = 1; ; i++) {
    try {
      const w = Wallet.generate();
      const r = await client.fundWallet(w, { usageContext: "divhacks-verify" });
      console.log(`  faucet ${label}: ${w.address} balance ${r.balance} XRP`);
      return { w, balance: r.balance };
    } catch (e) {
      console.warn(`  faucet ${label} attempt ${i} failed: ${(e as Error).message}`);
      if (i >= 5) throw e;
      await sleep(5000 * i);
    }
  }
}

async function lineBalance(client: Client, acct: string, issuer: string, cur: string) {
  const l = await client.request({ command: "account_lines", account: acct, peer: issuer, ledger_index: "validated" });
  return l.result.lines.find((x) => x.currency === cur)?.balance ?? "(no line)";
}

async function main() {
  const client = new Client(WS, { timeout: 30000 });
  await client.connect();
  try {
    if (!args.includes("--skip-escrow")) {
      console.log("\n== R1 faucet ==");
      const h = await faucet(client, "HOLDER");
      const iss = await faucet(client, "CTL_ISSUER");
      const bare = await faucet(client, "NO_LINE");
      results.R1_faucet_balances = [h.balance, iss.balance, bare.balance];
      await sleep(4000);

      console.log("\n== R2 buy RLUSD on the AMM with a fresh wallet ==");
      results.R2_trustset = await submitRaw(client, { TransactionType: "TrustSet", Account: h.w.address, LimitAmount: { currency: CUR, issuer: ISSUER, value: "1000000" } }, h.w, "HOLDER TrustSet RLUSD");
      results.R2_swap = await submitRaw(client, {
        TransactionType: "Payment", Account: h.w.address, Destination: h.w.address,
        Amount: { currency: CUR, issuer: ISSUER, value: "1000000" }, SendMax: xrpToDrops(5), Flags: 0x00020000, // tfPartialPayment
      }, h.w, "HOLDER swap 5 XRP -> RLUSD");
      results.R2_rlusd_balance = await lineBalance(client, h.w.address, ISSUER, CUR);
      console.log(`  HOLDER RLUSD balance: ${results.R2_rlusd_balance}`);

      console.log("\n== R3 RLUSD EscrowCreate from a funded fresh holder ==");
      results.R3_rlusd_escrow = await submitRaw(client, {
        TransactionType: "EscrowCreate", Account: h.w.address, Destination: ESC_DEST,
        Amount: { currency: CUR, issuer: ISSUER, value: "1" }, CancelAfter: rippleNow() + 3600, Condition: condition().condition,
      } as SubmittableTransaction, h.w, "R3 RLUSD EscrowCreate 1 RLUSD (holder has >1 RLUSD)");

      console.log("\n== R4 control: our own token CTL ==");
      const CTL = { currency: "CTL", issuer: iss.w.address };
      await submitRaw(client, { TransactionType: "AccountSet", Account: iss.w.address, SetFlag: 8 }, iss.w, "CTL issuer asfDefaultRipple");
      await submitRaw(client, { TransactionType: "TrustSet", Account: h.w.address, LimitAmount: { ...CTL, value: "1000000" } }, h.w, "HOLDER TrustSet CTL");
      await submitRaw(client, { TransactionType: "Payment", Account: iss.w.address, Destination: h.w.address, Amount: { ...CTL, value: "100" } }, iss.w, "issue 100 CTL to HOLDER");
      const ai0 = await client.request({ command: "account_info", account: iss.w.address, ledger_index: "validated" });
      results.R4_issuer_flags_before = { Flags: ai0.result.account_data.Flags, allowTrustLineLocking: ((Number(ai0.result.account_data.Flags) & 0x40000000) >>> 0) !== 0 };
      const escrow = (value: string, from = h.w.address): SubmittableTransaction => ({
        TransactionType: "EscrowCreate", Account: from, Destination: ESC_DEST, Amount: { ...CTL, value },
        CancelAfter: rippleNow() + 3600, Condition: condition().condition,
      } as SubmittableTransaction);
      results.R4a_no_flag = await submitRaw(client, escrow("10"), h.w, "R4a CTL EscrowCreate 10, issuer WITHOUT lsfAllowTrustLineLocking");
      results.R4_setflag = await submitRaw(client, { TransactionType: "AccountSet", Account: iss.w.address, SetFlag: 17 }, iss.w, "CTL issuer AccountSet SetFlag 17");
      const ai1 = await client.request({ command: "account_info", account: iss.w.address, ledger_index: "validated" });
      results.R4_issuer_flags_after = { Flags: ai1.result.account_data.Flags, allowTrustLineLocking: ((Number(ai1.result.account_data.Flags) & 0x40000000) >>> 0) !== 0 };
      results.R4b_with_flag = await submitRaw(client, escrow("10"), h.w, "R4b CTL EscrowCreate 10, issuer WITH lsfAllowTrustLineLocking");
      results.R4c_overdraw = await submitRaw(client, escrow("1000"), h.w, "R4c CTL EscrowCreate 1000 (> balance), flag set");
      results.R4d_no_line = await submitRaw(client, escrow("1", bare.w.address), bare.w, "R4d CTL EscrowCreate 1 from account with NO CTL trust line, flag set");
      results.R4_holder_ctl_after = await lineBalance(client, h.w.address, iss.w.address, "CTL");
    }

    if (!args.includes("--skip-multisig")) {
      console.log("\n== R5 multisig quorum on X6 account M ==");
      const seeds = ["RISK_MS_M_SEED", "RISK_MS_S1_SEED", "RISK_MS_S2_SEED", "RISK_MS_S3_SEED"].map((k) => process.env[k]);
      if (seeds.some((s) => !s)) throw new Error("RISK_MS_* seeds missing from xrpl/.env.local");
      const [m, s1, s2, s3] = seeds.map((s) => Wallet.fromSeed(s!));
      const stranger = Wallet.generate();
      const pay = (): Payment => ({ TransactionType: "Payment", Account: m.address, Destination: X1_B, Amount: xrpToDrops(1) });
      const ms = async (signers: Wallet[], label: string) => {
        const prepared = await client.autofill(pay(), signers.length);
        const blob = multisign(signers.map((s) => s.sign(prepared, true).tx_blob));
        const r = await client.request({ command: "submit", tx_blob: blob });
        const out = { label, engine_result: r.result.engine_result, engine_result_message: r.result.engine_result_message, hash: hashes.hashSignedTx(blob) };
        console.log(`  ${label}: ${out.engine_result} (${out.engine_result_message})`);
        return out;
      };
      const seqBefore = (await client.request({ command: "account_info", account: m.address, ledger_index: "current" })).result.account_data.Sequence;
      results.R5_S1_only_w1 = await ms([s1], "S1 only (weight 1)");
      results.R5_S2_only_w2 = await ms([s2], "S2 only (weight 2)");
      results.R5_S1_S3_w2 = await ms([s1, s3], "S1+S3 (weight 2)");
      results.R5_unlisted = await ms([stranger], "unlisted random key");
      const mp = await client.autofill(pay());
      const ss = m.sign(mp);
      const rm = await client.request({ command: "submit", tx_blob: ss.tx_blob });
      results.R5_master = { label: "master key single-signed", engine_result: rm.result.engine_result, engine_result_message: rm.result.engine_result_message, hash: ss.hash };
      console.log(`  master key single-signed: ${rm.result.engine_result} (${rm.result.engine_result_message})`);
      await sleep(8000);
      const seqAfter = (await client.request({ command: "account_info", account: m.address, ledger_index: "validated" })).result.account_data.Sequence;
      results.R5_M_sequence_unchanged = { before_current: seqBefore, after_validated: seqAfter, unchanged: seqBefore === seqAfter };
      console.log(`  M Sequence before ${seqBefore}, after (validated) ${seqAfter}: none of the rejected txs consumed a sequence`);
    }
  } finally {
    await client.disconnect();
  }
  console.log("\nRESULTS:", JSON.stringify(results, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
