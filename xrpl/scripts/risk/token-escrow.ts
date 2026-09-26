// X4: Does RLUSD escrow (XLS-85 TokenEscrow) work on Testnet?
//  (a) amendment status: `feature TokenEscrow` + the on-ledger Amendments object
//  (b) city_treasury EscrowCreate of 1 RLUSD (PREIMAGE-SHA-256 condition, CancelAfter now+1h) via client.submit;
//      if treasury holds >= 1 RLUSD it does the full create+finish round trip. Also repeats the create from the
//      X3 SWAP wallet (which holds DEX-bought RLUSD) so "no funds" and "issuer flag" can be told apart.
//  (c) end-to-end with a self-issued token (issuer sets asfAllowTrustLineLocking): create + finish.
// Re-runnable: cd xrpl && npx tsx scripts/risk/token-escrow.ts   (flags: --skip-treasury, --skip-tst)
import crypto from "node:crypto";
import { AccountSetAsfFlags, Wallet, type Client, type SubmittableTransaction } from "xrpl";
import {
  connect, fundedWallet, keypair, ensureTrustLine, submitWait, submitBlob, tokenBalance, preimageCondition, header,
  rippleNow, xrpBalance, RLUSD_ISSUER, RLUSD_CUR, SOURCE_TAG,
} from "./_lib";

const args = process.argv.slice(2);
const AMENDMENTS_INDEX = "7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4";
const amendmentId = (name: string) => crypto.createHash("sha512").update(name, "ascii").digest("hex").slice(0, 64).toUpperCase();
const LSF_ALLOW_TRUSTLINE_LOCKING = 0x40000000;

type Step = { step: string; engine_result?: string; final?: string; hash?: string; link?: string; note?: string };
const steps: Step[] = [];

async function signSubmit(client: Client, tx: SubmittableTransaction, w: Wallet, label: string): Promise<Step> {
  const prepared = await client.autofill(tx);
  const signed = w.sign(prepared);
  const r = await submitBlob(client, signed.tx_blob, signed.hash, label);
  const s = { step: label, engine_result: r.engine_result, final: r.final, hash: r.hash, link: r.link };
  steps.push(s);
  return s;
}

/** EscrowCreate (+ EscrowFinish if the create validated tesSUCCESS). */
async function escrowRoundTrip(client: Client, owner: Wallet, dest: Wallet, amount: { currency: string; issuer: string; value: string }, label: string, finish = true) {
  const cc = preimageCondition();
  const create = await signSubmit(client, {
    TransactionType: "EscrowCreate", Account: owner.address, Destination: dest.address, Amount: amount,
    CancelAfter: rippleNow() + 3600, Condition: cc.condition, SourceTag: SOURCE_TAG,
  }, owner, `${label} EscrowCreate`);
  if (!finish || create.final !== "tesSUCCESS") return { create };
  const t = await client.request({ command: "tx", transaction: create.hash! });
  const seq = (t.result.tx_json as { Sequence: number }).Sequence;
  const destBefore = await tokenBalance(client, dest.address, amount.issuer, amount.currency);
  const fin = await signSubmit(client, {
    TransactionType: "EscrowFinish", Account: dest.address, Owner: owner.address, OfferSequence: seq,
    Condition: cc.condition, Fulfillment: cc.fulfillment,
  }, dest, `${label} EscrowFinish`);
  const destAfter = await tokenBalance(client, dest.address, amount.issuer, amount.currency);
  console.log(`  ${label}: destination ${amount.currency} balance ${destBefore} -> ${destAfter}`);
  return { create, fin, destBefore, destAfter };
}

async function main() {
  header("X4 TokenEscrow");
  const client = await connect();
  try {
    // ---------- (a) amendment status ----------
    const id = amendmentId("TokenEscrow");
    let featureResp: unknown;
    try {
      featureResp = (await client.request({ command: "feature", feature: "TokenEscrow" } as never) as { result: unknown }).result;
    } catch (e) {
      featureResp = { error: (e as { data?: unknown }).data ?? (e as Error).message };
    }
    console.log("(a) feature TokenEscrow ->", JSON.stringify(featureResp));
    const am = await client.request({ command: "ledger_entry", index: AMENDMENTS_INDEX, ledger_index: "validated" });
    const node = am.result.node as unknown as { Amendments?: string[]; Majorities?: { Majority: { Amendment: string } }[] };
    const enabled = (node.Amendments ?? []).includes(id);
    const inMajority = (node.Majorities ?? []).some((m) => m.Majority.Amendment === id);
    console.log(`(a) Amendments object @ledger ${(am.result as { ledger_index?: number }).ledger_index}: TokenEscrow id ${id} enabled=${enabled} majority=${inMajority}`);

    // shared destination with RLUSD + TST trust lines
    const dest = await fundedWallet(client, "ESC_DEST");
    await ensureTrustLine(client, dest, RLUSD_ISSUER, RLUSD_CUR);

    // ---------- (b) RLUSD escrow from city_treasury ----------
    const issuerInfo = await client.request({ command: "account_info", account: RLUSD_ISSUER, ledger_index: "validated" });
    const issuerLocking = (Number(issuerInfo.result.account_data.Flags) & LSF_ALLOW_TRUSTLINE_LOCKING) !== 0;
    console.log(`(b) RLUSD issuer lsfAllowTrustLineLocking = ${issuerLocking}`);
    const rlusd1 = { currency: RLUSD_CUR, issuer: RLUSD_ISSUER, value: "1" };
    if (!args.includes("--skip-treasury")) {
      if (!process.env.TREASURY_SEED) throw new Error("TREASURY_SEED missing from xrpl/.env.local");
      const treasury = Wallet.fromSeed(process.env.TREASURY_SEED);
      const tXrp = await xrpBalance(client, treasury.address);
      const tRlusd = await tokenBalance(client, treasury.address, RLUSD_ISSUER, RLUSD_CUR);
      console.log(`(b) city_treasury ${treasury.address}: ${tXrp} XRP, ${tRlusd} RLUSD`);
      if (tXrp === null || tXrp < 21) {
        steps.push({ step: "treasury RLUSD EscrowCreate", note: `skipped: treasury XRP ${tXrp} < 21 (must stay > 20)` });
      } else {
        await escrowRoundTrip(client, treasury, dest, rlusd1, "treasury RLUSD", tRlusd >= 1);
      }
    }
    // Same create from the SWAP wallet (holds DEX-bought RLUSD) to separate "unfunded" from "issuer flag".
    if (process.env.RISK_SWAP_SEED) {
      const swap = keypair("SWAP");
      const sRlusd = await tokenBalance(client, swap.address, RLUSD_ISSUER, RLUSD_CUR);
      console.log(`(b) SWAP wallet ${swap.address}: ${sRlusd} RLUSD`);
      if (sRlusd >= 1) await escrowRoundTrip(client, swap, dest, rlusd1, "funded-holder RLUSD");
    }

    // ---------- (c) self-issued token end-to-end ----------
    if (!args.includes("--skip-tst")) {
      const issuer = await fundedWallet(client, "TST_ISSUER");
      const holder = await fundedWallet(client, "TST_HOLDER");
      const ai = await client.request({ command: "account_info", account: issuer.address, ledger_index: "validated" });
      if ((Number(ai.result.account_data.Flags) & LSF_ALLOW_TRUSTLINE_LOCKING) === 0) {
        const s = await submitWait(client, { TransactionType: "AccountSet", Account: issuer.address, SetFlag: AccountSetAsfFlags.asfAllowTrustLineLocking }, issuer, "TST issuer AccountSet SetFlag 17");
        steps.push({ step: "TST issuer AccountSet SetFlag 17 (asfAllowTrustLineLocking)", final: s.result, hash: s.hash, link: s.link });
      } else {
        steps.push({ step: "TST issuer AccountSet SetFlag 17", note: "already set (lsfAllowTrustLineLocking)" });
      }
      await ensureTrustLine(client, holder, issuer.address, "TST");
      await ensureTrustLine(client, dest, issuer.address, "TST");
      const iss = await submitWait(client, { TransactionType: "Payment", Account: issuer.address, Destination: holder.address, Amount: { currency: "TST", issuer: issuer.address, value: "100" } }, issuer, "issue 100 TST to holder");
      steps.push({ step: "issue 100 TST to holder", final: iss.result, hash: iss.hash, link: iss.link });
      await escrowRoundTrip(client, holder, dest, { currency: "TST", issuer: issuer.address, value: "10" }, "TST");
      console.log(`  TST holder balance now ${await tokenBalance(client, holder.address, issuer.address, "TST")}`);
    }

    // ---------- conclusion ----------
    const find = (p: string) => steps.find((s) => s.step.startsWith(p));
    const rl = find("funded-holder RLUSD EscrowCreate") ?? find("treasury RLUSD EscrowCreate");
    const rlCode = rl?.final ?? rl?.engine_result ?? "n/a";
    let rlusdVerdict: string;
    if (rlCode === "tesSUCCESS") rlusdVerdict = "works";
    else if (rlCode === "temDISABLED" || rlCode === "temBAD_AMOUNT") rlusdVerdict = "blocked by amendment";
    else if (rlCode === "tecNO_PERMISSION") rlusdVerdict = "blocked by issuer flag (RLUSD issuer lacks lsfAllowTrustLineLocking)";
    else if (/tecINSUFFICIENT_FUNDS|tecUNFUNDED/.test(rlCode)) rlusdVerdict = "would work once funded";
    else rlusdVerdict = `inconclusive (${rlCode})`;
    const tstC = find("TST EscrowCreate"), tstF = find("TST EscrowFinish");
    const tstOk = tstC?.final === "tesSUCCESS" && tstF?.final === "tesSUCCESS";
    console.log("\nSTEPS:", JSON.stringify(steps, null, 2));
    console.log(JSON.stringify({
      check: "X4", amendment_TokenEscrow_enabled: enabled, rlusd_issuer_allowTrustLineLocking: issuerLocking,
      rlusd_escrow_result: rlCode, conclusion_rlusd_escrow: `RLUSD escrow: ${rlusdVerdict}`,
      self_issued_token_escrow: tstOk ? "works (create + finish tesSUCCESS)" : `FAILED (${tstC?.final ?? tstC?.engine_result}/${tstF?.final ?? tstF?.engine_result})`,
    }, null, 2));
  } finally {
    await client.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
