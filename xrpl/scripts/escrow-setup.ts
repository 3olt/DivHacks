// City-side setup for the SIMULATED escrow (Phase 3, builder B): "simulated escrow (test token, not RLUSD)".
// RLUSD escrow is impossible on Testnet (the RLUSD issuer lacks lsfAllowTrustLineLocking -> tecNO_PERMISSION), so the
// milestone escrow locks CTT, a City Test Token issued by OUR city_issuer. Idempotent; every step checks the ledger first.
//   1. city_issuer AccountSet SetFlag 17 (asfAllowTrustLineLocking), so its token can be escrowed
//   2. [NONPROFIT SIDE - SIMULATED] np_1..np_3 TrustSet CTT/city_issuer (the demo keys in xrpl/.env.local)
//   3. if agent_account already has its CTT trust line (a multisigned TrustSet through the co-signer's governance endpoint,
//      created by `npm run demo escrow`), city_issuer issues CTT to it up to CTT_AGENT_TARGET (default 500)
// Keys: root .env + xrpl/.env.local only (CITY_ISSUER_SEED, NP_N_SEED); refuses to run if a signer seed is present.
// Run: npm run setup:escrow   (repo root)
import { AccountSetAsfFlags, TrustSetFlags, Wallet } from "xrpl";
import { loadEnv } from "../src/env";
import { loadRegistry, type NonprofitKey } from "../src/lib/registry";
import { connect, explorerAccount, hasTrustLine, submitWait, tokenBalance, tokenValue } from "../src/lib/xrpl";
import { CTT_CURRENCY, CTT_TRUST_LIMIT } from "../src/lib/governance";
import { SIMULATED_ESCROW_LABEL } from "../src/lib/escrow";

loadEnv(); // root .env + xrpl/.env.local (setup-only seeds)

const LSF_ALLOW_TRUSTLINE_LOCKING = 0x40000000;
const TARGET = Number(process.env.CTT_AGENT_TARGET ?? "500");

async function main(): Promise<number> {
  const signerSeeds = ["AGENT_SEED", "COSIGNER_SEED", "OFFICER_SEED"].filter((k) => process.env[k]);
  if (signerSeeds.length) throw new Error(`refusing to run: signer seeds are present in this process's environment (${signerSeeds.join(", ")})`);
  const reg = loadRegistry();
  const seed = (k: string) => {
    const s = process.env[k];
    if (!s) throw new Error(`${k} missing from xrpl/.env.local`);
    return Wallet.fromSeed(s);
  };
  const issuer = seed("CITY_ISSUER_SEED");
  if (issuer.address !== reg.city_issuer) throw new Error(`CITY_ISSUER_SEED derives ${issuer.address}, not city_issuer ${reg.city_issuer}`);
  console.log(`=== escrow setup: ${SIMULATED_ESCROW_LABEL}; token ${CTT_CURRENCY} issued by city_issuer ${reg.city_issuer} ===`);
  const client = await connect();
  try {
    // 1. issuer flag
    const ai = await client.request({ command: "account_info", account: issuer.address, ledger_index: "validated" });
    if ((Number(ai.result.account_data.Flags) & LSF_ALLOW_TRUSTLINE_LOCKING) === 0) {
      const o = await submitWait(client, { TransactionType: "AccountSet", Account: issuer.address, SetFlag: AccountSetAsfFlags.asfAllowTrustLineLocking }, issuer, "city_issuer AccountSet SetFlag 17 (asfAllowTrustLineLocking)");
      if (o.result !== "tesSUCCESS") throw new Error(`AccountSet failed: ${o.result}`);
    } else console.log("  city_issuer: lsfAllowTrustLineLocking already set");

    // 2. [NONPROFIT SIDE - SIMULATED] trust lines for the credentialed demo nonprofits
    for (const k of ["np_1", "np_2", "np_3"] as NonprofitKey[]) {
      const np = reg.nonprofits[k];
      if (await hasTrustLine(client, np.address, issuer.address, CTT_CURRENCY)) {
        console.log(`  ${k}: ${CTT_CURRENCY} trust line exists`);
        continue;
      }
      const w = seed(`${k.toUpperCase()}_SEED`);
      if (w.address !== np.address) throw new Error(`${k.toUpperCase()}_SEED derives ${w.address}, not ${np.address}`);
      const o = await submitWait(client, { TransactionType: "TrustSet", Account: w.address, LimitAmount: { currency: CTT_CURRENCY, issuer: issuer.address, value: CTT_TRUST_LIMIT }, Flags: TrustSetFlags.tfSetNoRipple }, w, `[NONPROFIT SIDE - SIMULATED] ${k} TrustSet ${CTT_CURRENCY}`);
      if (o.result !== "tesSUCCESS") throw new Error(`${k} TrustSet failed: ${o.result}`);
    }

    // 3. issue CTT to agent_account (only once its multisigned trust line exists)
    if (!(await hasTrustLine(client, reg.agent_account, issuer.address, CTT_CURRENCY))) {
      console.log(`  agent_account has no ${CTT_CURRENCY} trust line yet: it is created by a multisigned TrustSet (agent + co-signer governance endpoint); "npm run demo escrow" does that, then runs this again`);
      return 3;
    }
    const held = await tokenBalance(client, reg.agent_account, issuer.address, CTT_CURRENCY);
    if (held < TARGET) {
      const amt = tokenValue(TARGET - held);
      const o = await submitWait(client, { TransactionType: "Payment", Account: issuer.address, Destination: reg.agent_account, Amount: { currency: CTT_CURRENCY, issuer: issuer.address, value: amt } }, issuer, `city_issuer issues ${amt} ${CTT_CURRENCY} -> agent_account`);
      if (o.result !== "tesSUCCESS") throw new Error(`issuing ${CTT_CURRENCY} failed: ${o.result}`);
    } else console.log(`  agent_account holds ${held} ${CTT_CURRENCY} >= ${TARGET}; nothing issued`);
    console.log(`  agent_account ${CTT_CURRENCY}: ${await tokenBalance(client, reg.agent_account, issuer.address, CTT_CURRENCY)}  ${explorerAccount(reg.agent_account)}`);
    return 0;
  } finally {
    await client.disconnect();
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("escrow setup failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
