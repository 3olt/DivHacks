// Phase 1 setup (XRPL Testnet only). Idempotent: every step checks the ledger first and skips work that is done,
// so a second run submits no transactions and makes no faucet calls.
//
//   1. load or create + faucet-fund city_issuer, agent_account, np_1..np_4, attacker (city_treasury already exists)
//   2. RLUSD trust lines (limit 1e9, tfSetNoRipple)
//   3. treasury RLUSD: buy through the Testnet XRP/RLUSD AMM with throwaway faucet-funded swapper wallets
//   4. top up agent_account's RLUSD working balance from the treasury (the parent that funds the agent)
//   5. agent_account SignerListSet {agent:1, cosigner:2, officer:1}, quorum 3 (signed with its master key)
//   6. only after the signer list is verified on-ledger: disable agent_account's master key
//      (Phase 3: if the kill switch left the list REVOKED {cosigner:2, officer:1}, setup says so and points to
//      "npm run agent:restore" instead of erroring; it never changes a signer list once the master key is disabled)
//   7. write data/accounts.testnet.json + data/allowlist.json (addresses only, committed)
//
// Keys: setup-only seeds live in the gitignored xrpl/.env.local. Signer keys (agent / cosigner / officer) are
// unfunded keypairs, each generated ONLY if its own file (xrpl/.env.<role>) is missing; afterwards setup reads only
// the *_ADDRESS value from those files and never keeps a signer seed in memory.
//
// Run: npm run setup:xrpl   (repo root)   or   npm run setup   (xrpl/)
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Wallet, isValidClassicAddress, TrustSetFlags, PaymentFlags, AccountSetAsfFlags, type Client, type Payment, type SubmittableTransaction } from "xrpl";
import { loadEnv, paths } from "../src/env";
import {
  connect, xrpBalance, tokenBalance, hasTrustLine, accountState, fundWithRetry, submitWait, explorerAccount,
  rlusd, sourceTag, toHex, tokenValue, tokenValueFloor, xrplWs, type Outcome, type SignerListInfo,
} from "../src/lib/xrpl";
import { registryPath, allowlistPath, type Registry, type Allowlist, type NonprofitKey } from "../src/lib/registry";
import { classifySignerList } from "../src/lib/governance";

loadEnv(); // root .env + xrpl/.env.local (setup-only seeds)

const TREASURY_TARGET = Number(process.env.RLUSD_TREASURY_TARGET ?? "150");
const AGENT_TARGET = Number(process.env.AGENT_RLUSD_TARGET ?? "60");
const MAX_SWAPS = Number(process.env.SETUP_MAX_SWAPS ?? "8");
const TREASURY_MIN_XRP = 30;
const TRUST_LIMIT = "1000000000";
const QUORUM = 3;
const WEIGHTS = { agent: 1, cosigner: 2, officer: 1 } as const;
type SignerRole = keyof typeof WEIGHTS;
const envLocalPath = path.join(paths.xrplDir, ".env.local");
const R = rlusd();

// np_1..np_4 map to the API fixture nonprofits EIN 00-0000001..00-0000004 (names and current contract ids copied
// from api/src/fixtures/nonprofits.ts + contracts.ts; np_1 is the golden fixture site_001).
const NONPROFITS: Record<NonprofitKey, { ein: string; name: string; contract_id: string }> = {
  np_1: { ein: "00-0000001", name: "Burnside Heights Food Collective (demo)", contract_id: "CT1-069-20261409087" },
  np_2: { ein: "00-0000002", name: "South Bronx Table Fund (demo)", contract_id: "CT1-069-20271522304" },
  np_3: { ein: "00-0000003", name: "Bronx Riverbend Youth Works (demo)", contract_id: "CT1-260-20241298815" },
  np_4: { ein: "00-0000004", name: "El Barrio Mesa Comunitaria (demo)", contract_id: "CT1-069-20261409311" },
};

const stats = { txs: 0, faucet: 0, txLog: [] as string[] };

async function send(client: Client, tx: SubmittableTransaction, wallet: Wallet, label: string): Promise<Outcome> {
  const out = await submitWait(client, tx, wallet, label);
  stats.txs++;
  stats.txLog.push(`${label}: ${out.result} ${out.hash}`);
  return out;
}

async function faucet(client: Client, w: Wallet): Promise<void> {
  await fundWithRetry(client, w);
  stats.faucet++;
}

function appendEnvLocal(text: string): void {
  const cur = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, "utf8") : "";
  const sep = cur.length > 0 && !cur.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envLocalPath, sep + text);
}

/** A setup-only wallet whose seed lives in xrpl/.env.local as <KEY>_SEED (created + appended if missing). */
function localWallet(key: string): Wallet {
  const seed = process.env[`${key}_SEED`];
  if (seed) {
    const w = Wallet.fromSeed(seed);
    const addr = process.env[`${key}_ADDRESS`];
    if (addr && addr !== w.address) throw new Error(`${key}_ADDRESS in .env.local does not match ${key}_SEED`);
    return w;
  }
  const w = Wallet.generate();
  appendEnvLocal(`${key}_SEED=${w.seed}\n${key}_ADDRESS=${w.address}\n`);
  process.env[`${key}_SEED`] = w.seed;
  process.env[`${key}_ADDRESS`] = w.address;
  console.log(`    generated ${key} ${w.address} (seed appended to xrpl/.env.local)`);
  return w;
}

/** Signer keypair address. Generates xrpl/.env.<role> only if it is missing; otherwise reads ONLY the address. */
function signerAddress(role: SignerRole): string {
  const file = path.join(paths.xrplDir, `.env.${role}`);
  const K = role.toUpperCase();
  if (fs.existsSync(file)) {
    // Extract only the address line with a regex; the seed is never parsed into a value (only its presence is tested).
    const text = fs.readFileSync(file, "utf8");
    const address = new RegExp(`^\\s*${K}_ADDRESS\\s*=\\s*["']?(r[1-9A-HJ-NP-Za-km-z]{24,34})["']?\\s*$`, "m").exec(text)?.[1];
    const hasSeed = new RegExp(`^\\s*${K}_SEED\\s*=\\s*\\S`, "m").test(text);
    if (!address || !isValidClassicAddress(address)) throw new Error(`${file} exists but has no valid ${K}_ADDRESS; fix it by hand (setup never overwrites signer key files)`);
    if (!hasSeed) console.warn(`    WARNING: ${file} has no ${K}_SEED; the ${role} process will not be able to sign`);
    return address;
  }
  let w: Wallet | null = Wallet.generate();
  const body =
    `# ${role} signer key for agent_account (weight ${WEIGHTS[role]}). Loaded ONLY by the ${role} process via loadEnv("${role}").\n` +
    `# Unfunded keypair (a signer on the multisig, not an account). Testnet only. Never commit.\n` +
    `${K}_SEED=${w.seed}\n${K}_ADDRESS=${w.address}\n`;
  fs.writeFileSync(file, body, { flag: "wx" });
  const address = w.address;
  w = null;
  console.log(`    generated ${role} signer keypair ${address} -> xrpl/.env.${role}`);
  return address;
}

/** The officer's click credential (x-officer-token on the officer service's [HUMAN CLICK] routes). Lives ONLY in
 *  xrpl/.env.officer, next to OFFICER_SEED; appended once if missing; never printed. */
function ensureOfficerClickToken(): void {
  const file = path.join(paths.xrplDir, ".env.officer");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  if (/^\s*OFFICER_CLICK_TOKEN\s*=\s*[0-9a-f]{64}\s*$/m.test(text)) return;
  const token = randomBytes(32).toString("hex");
  fs.appendFileSync(file, `${text.endsWith("\n") ? "" : "\n"}# The officer's click credential for the officer service's [HUMAN CLICK] routes (header x-officer-token). Never commit.\nOFFICER_CLICK_TOKEN=${token}\n`);
  console.log("    generated OFFICER_CLICK_TOKEN -> xrpl/.env.officer (the officer's click credential; not printed)");
}

async function ensureFunded(client: Client, role: string, w: Wallet): Promise<void> {
  const bal = await xrpBalance(client, w.address);
  if (bal === null) {
    console.log(`  ${role} ${w.address} not on ledger -> faucet`);
    await faucet(client, w);
  } else {
    console.log(`  ${role} ${w.address} exists (${bal} XRP)`);
  }
}

async function ensureTrust(client: Client, role: string, w: Wallet, masterDisabled = false): Promise<void> {
  if (await hasTrustLine(client, w.address, R.issuer, R.currency)) {
    console.log(`  ${role}: RLUSD trust line exists`);
    return;
  }
  if (masterDisabled) throw new Error(`${role} ${w.address} has its master key disabled but no RLUSD trust line; a multisigned TrustSet is needed`);
  await send(client, {
    TransactionType: "TrustSet", Account: w.address, LimitAmount: { ...R, value: TRUST_LIMIT }, Flags: TrustSetFlags.tfSetNoRipple,
  }, w, `${role} TrustSet RLUSD`);
}

const SETUP_MEMO = [{ Memo: { MemoType: toHex("divhacks/setup/v1"), MemoData: toHex("RLUSD acquisition via Testnet XRP/RLUSD AMM") } }];

/** Cross-currency Payment XRP -> RLUSD through the AMM / order book, delivering to `dest`. Returns RLUSD delivered. */
async function swapXrpForRlusd(client: Client, from: Wallet, dest: string, sendMaxDrops: string, label: string): Promise<number> {
  const base: Payment = {
    TransactionType: "Payment", Account: from.address, Destination: dest,
    Amount: { ...R, value: "1000000" }, SendMax: sendMaxDrops, Flags: PaymentFlags.tfPartialPayment, Memos: SETUP_MEMO,
  };
  let out = await send(client, base, from, `${label} (SendMax ${Number(sendMaxDrops) / 1e6} XRP)`);
  if (out.result === "tecPATH_DRY" || out.result === "tecPATH_PARTIAL") {
    console.log(`    default path gave ${out.result}; asking ripple_path_find for paths`);
    const pf = await client.request({
      command: "ripple_path_find", source_account: from.address, destination_account: dest,
      destination_amount: { ...R, value: "-1" }, send_max: sendMaxDrops, ledger_index: "validated",
    } as never);
    const alts = (pf as { result: { alternatives: { paths_computed: Payment["Paths"] }[] } }).result.alternatives;
    if (!alts.length) throw new Error("ripple_path_find returned no alternatives for XRP -> RLUSD");
    out = await send(client, { ...base, Paths: alts[0].paths_computed }, from, `${label} with Paths`);
  }
  if (out.result !== "tesSUCCESS") throw new Error(`${label} failed: ${out.result} ${out.link}`);
  const delivered = (out.tx.meta as { delivered_amount?: { value?: string } | string }).delivered_amount;
  const value = typeof delivered === "object" && delivered?.value ? Number(delivered.value) : 0;
  console.log(`    delivered_amount: ${value} RLUSD -> ${dest}`);
  return value;
}

function signerListMatches(sl: SignerListInfo | null, want: Record<SignerRole, string>): boolean {
  if (!sl || sl.quorum !== QUORUM || sl.entries.length !== 3) return false;
  const expected = new Map((Object.keys(WEIGHTS) as SignerRole[]).map((r) => [want[r], WEIGHTS[r]]));
  return sl.entries.every((e) => expected.get(e.account) === e.weight);
}

function writeIfChanged(file: string, obj: unknown): boolean {
  const text = JSON.stringify(obj, null, 2) + "\n";
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

async function main() {
  console.log(`\n=== Phase 1 setup (${xrplWs()}) ===`);
  const client = await connect();
  try {
    const info = await client.request({ command: "server_info" });
    const reserveBase = info.result.info.validated_ledger?.reserve_base_xrp ?? 1;

    // ---- 1. accounts --------------------------------------------------------------------------------------
    console.log("\n[1] accounts");
    if (!process.env.TREASURY_SEED) throw new Error("TREASURY_SEED missing from xrpl/.env.local (city_treasury must already exist)");
    const treasury = localWallet("TREASURY");
    const cityIssuer = localWallet("CITY_ISSUER");
    const agentAccount = localWallet("AGENT_ACCOUNT");
    const nps = Object.fromEntries((Object.keys(NONPROFITS) as NonprofitKey[]).map((k) => [k, localWallet(k.toUpperCase())])) as Record<NonprofitKey, Wallet>;
    const attacker = localWallet("ATTACKER");
    await ensureFunded(client, "city_treasury", treasury);
    await ensureFunded(client, "city_issuer", cityIssuer);
    await ensureFunded(client, "agent_account", agentAccount);
    for (const k of Object.keys(nps) as NonprofitKey[]) await ensureFunded(client, k, nps[k]);
    await ensureFunded(client, "attacker", attacker);

    const signers: Record<SignerRole, string> = { agent: signerAddress("agent"), cosigner: signerAddress("cosigner"), officer: signerAddress("officer") };
    for (const r of Object.keys(signers) as SignerRole[]) console.log(`  signer ${r} (weight ${WEIGHTS[r]}): ${signers[r]}`);
    ensureOfficerClickToken();
    if (new Set(Object.values(signers)).size !== 3) throw new Error("signer keys must be three distinct keypairs");

    let agentState = await accountState(client, agentAccount.address);

    // ---- 2. trust lines -----------------------------------------------------------------------------------
    console.log("\n[2] RLUSD trust lines");
    await ensureTrust(client, "city_treasury", treasury);
    await ensureTrust(client, "agent_account", agentAccount, agentState.masterDisabled);
    for (const k of Object.keys(nps) as NonprofitKey[]) await ensureTrust(client, k, nps[k]);
    await ensureTrust(client, "attacker", attacker);

    // ---- 3. treasury RLUSD via the AMM ----------------------------------------------------------------------
    console.log("\n[3] treasury RLUSD");
    const agentRl = await tokenBalance(client, agentAccount.address, R.issuer, R.currency);
    const agentNeed = Math.max(0, AGENT_TARGET - agentRl);
    // The treasury target is what the treasury keeps AFTER funding the agent; otherwise the agent top-up in step 4
    // would push the treasury back under its target and every re-run would swap again.
    const goal = TREASURY_TARGET + agentNeed;
    let treasuryRl = await tokenBalance(client, treasury.address, R.issuer, R.currency);
    console.log(`  treasury ${treasuryRl} RLUSD; goal ${goal} (target ${TREASURY_TARGET} + agent top-up ${tokenValue(agentNeed)})`);
    let swaps = 0;
    while (treasuryRl < goal && swaps < MAX_SWAPS) {
      swaps++;
      const swapper = Wallet.generate(); // throwaway: its XRP is spent on the swap; the seed is not kept
      console.log(`  swap ${swaps}/${MAX_SWAPS}: throwaway swapper ${swapper.address}`);
      await faucet(client, swapper);
      const bal = (await xrpBalance(client, swapper.address)) ?? 0;
      const sendMax = Math.floor((bal - (reserveBase + 1)) * 1e6);
      if (sendMax <= 0) throw new Error(`swapper ${swapper.address} has only ${bal} XRP`);
      await swapXrpForRlusd(client, swapper, treasury.address, String(sendMax), `swap ${swaps} XRP->RLUSD to treasury`);
      treasuryRl = await tokenBalance(client, treasury.address, R.issuer, R.currency);
      console.log(`    treasury now ${treasuryRl} RLUSD`);
    }
    if (treasuryRl < goal) {
      const txrp = (await xrpBalance(client, treasury.address)) ?? 0;
      const spare = Math.floor((txrp - TREASURY_MIN_XRP) * 1e6);
      if (spare >= 5e6) {
        console.log(`  swap cap reached; treasury swaps its own spare ${spare / 1e6} XRP (keeps ${TREASURY_MIN_XRP} XRP)`);
        await swapXrpForRlusd(client, treasury, treasury.address, String(spare), "treasury self-swap XRP->RLUSD");
        treasuryRl = await tokenBalance(client, treasury.address, R.issuer, R.currency);
      }
    }
    if (treasuryRl < goal) console.warn(`  WARNING: treasury ${treasuryRl} RLUSD is below goal ${goal}; re-run setup to continue`);
    else if (swaps === 0) console.log("  treasury at or above goal; no swaps");

    // ---- 4. agent working balance ---------------------------------------------------------------------------
    console.log("\n[4] agent_account RLUSD working balance");
    if (agentNeed > 0.000001) {
      // Round DOWN to 6 decimals: a value rounded up could exceed the treasury balance (tecPATH_PARTIAL).
      const amt = Number(tokenValueFloor(Math.min(agentNeed, treasuryRl)));
      if (amt <= 0) console.warn("  WARNING: treasury has no RLUSD to fund the agent");
      else {
        const out = await send(client, {
          TransactionType: "Payment", Account: treasury.address, Destination: agentAccount.address, Amount: { ...R, value: tokenValue(amt) },
        }, treasury, `treasury -> agent_account ${tokenValue(amt)} RLUSD`);
        if (out.result !== "tesSUCCESS") throw new Error(`agent top-up failed: ${out.result}`);
      }
    } else console.log(`  agent_account holds ${agentRl} RLUSD >= ${AGENT_TARGET}; no top-up`);

    // ---- 5. signer list ---------------------------------------------------------------------------------------
    console.log("\n[5] agent_account signer list");
    agentState = await accountState(client, agentAccount.address);
    const slConfig = classifySignerList(agentState.signerList, signers);
    let revoked = false;
    if (signerListMatches(agentState.signerList, signers)) console.log("  signer list already matches {agent:1, cosigner:2, officer:1} quorum 3");
    else if (agentState.masterDisabled && slConfig === "REVOKED") {
      // Phase 3 kill switch engaged: {cosigner:2, officer:1} quorum 3. Not an error: the officer restores it.
      revoked = true;
      console.log("  agent_account is REVOKED (kill switch engaged): signer list {cosigner:2, officer:1} quorum 3, the agent key does not count.");
      console.log('  Setup does not touch it. To restore {agent:1, cosigner:2, officer:1}, the officer runs:  npm run agent:restore');
      console.log("  (or POST $OFFICER_URL/agent/restore on the officer service). Continuing with the rest of setup.");
    } else if (agentState.masterDisabled) {
      console.error("  ERROR: agent_account's master key is disabled but its on-ledger signer list does not match the signer key files.");
      console.error("  On-ledger:", JSON.stringify(agentState.signerList));
      console.error("  Expected:", JSON.stringify(signers), "quorum", QUORUM);
      console.error(`  It is ${slConfig}, neither CANONICAL nor REVOKED; fixing it needs a multisigned SignerListSet by hand. Setup will not touch the account.`);
      process.exitCode = 1;
      return;
    } else {
      const out = await send(client, {
        TransactionType: "SignerListSet", Account: agentAccount.address, SignerQuorum: QUORUM,
        SignerEntries: (Object.keys(WEIGHTS) as SignerRole[]).map((r) => ({ SignerEntry: { Account: signers[r], SignerWeight: WEIGHTS[r] } })),
      }, agentAccount, "agent_account SignerListSet {agent:1, cosigner:2, officer:1} quorum 3");
      if (out.result !== "tesSUCCESS") throw new Error(`SignerListSet failed: ${out.result}`);
    }

    // ---- 6. disable master key (only after the signer list is verified on-ledger) ------------------------------
    console.log("\n[6] agent_account master key");
    agentState = await accountState(client, agentAccount.address);
    if (agentState.masterDisabled) console.log(`  master key already disabled (lsfDisableMaster set)${revoked ? "; signer list REVOKED (run npm run agent:restore)" : ""}`);
    else if (!signerListMatches(agentState.signerList, signers)) throw new Error("signer list not verified on-ledger; refusing to disable the master key");
    else {
      const out = await send(client, { TransactionType: "AccountSet", Account: agentAccount.address, SetFlag: AccountSetAsfFlags.asfDisableMaster }, agentAccount, "agent_account AccountSet asfDisableMaster");
      if (out.result !== "tesSUCCESS") throw new Error(`AccountSet asfDisableMaster failed: ${out.result}`);
      agentState = await accountState(client, agentAccount.address);
    }

    // ---- 7. registry + allowlist ------------------------------------------------------------------------------
    console.log("\n[7] data files");
    const registry: Registry = {
      network: "testnet",
      rlusd: { issuer: R.issuer, currency: R.currency },
      city_issuer: cityIssuer.address,
      city_treasury: treasury.address,
      agent_account: agentAccount.address,
      signers: {
        agent: { address: signers.agent, weight: WEIGHTS.agent },
        cosigner: { address: signers.cosigner, weight: WEIGHTS.cosigner },
        officer: { address: signers.officer, weight: WEIGHTS.officer },
      },
      quorum: QUORUM,
      nonprofits: Object.fromEntries((Object.keys(NONPROFITS) as NonprofitKey[]).map((k) => [k, { address: nps[k].address, ...NONPROFITS[k] }])) as Registry["nonprofits"],
      attacker: attacker.address,
      source_tag: sourceTag(),
    };
    const allowlist: Allowlist = {
      network: "testnet",
      rule_version: "p1-allowlist-1",
      description: "Phase 1 co-signer allowlist: the registry wallets of the demo nonprofits np_1..np_4. The co-signer reads this file once at startup and pins its SHA-256; restart the co-signer after changing it.",
      addresses: (Object.keys(NONPROFITS) as NonprofitKey[]).map((k) => nps[k].address),
    };
    console.log(`  ${path.relative(paths.rootDir, registryPath)}: ${writeIfChanged(registryPath, registry) ? "written" : "unchanged"}`);
    console.log(`  ${path.relative(paths.rootDir, allowlistPath)}: ${writeIfChanged(allowlistPath, allowlist) ? "written" : "unchanged"}`);

    // ---- summary ------------------------------------------------------------------------------------------------
    const rows: [string, string][] = [
      ["city_issuer", cityIssuer.address], ["city_treasury", treasury.address], ["agent_account", agentAccount.address],
      ...(Object.keys(nps) as NonprofitKey[]).map((k) => [k, nps[k].address] as [string, string]), ["attacker", attacker.address],
    ];
    console.log("\n=== summary ===");
    console.log(["role".padEnd(15), "address".padEnd(35), "XRP".padStart(12), "RLUSD".padStart(12), "  explorer"].join(" "));
    for (const [role, addr] of rows) {
      const x = await xrpBalance(client, addr);
      const t = await tokenBalance(client, addr, R.issuer, R.currency);
      console.log([role.padEnd(15), addr.padEnd(35), String(x ?? "-").padStart(12), String(t).padStart(12), "  " + explorerAccount(addr)].join(" "));
    }
    for (const r of Object.keys(signers) as SignerRole[]) {
      console.log([`signer:${r}`.padEnd(15), signers[r].padEnd(35), "keypair".padStart(12), `weight ${WEIGHTS[r]}`.padStart(12), "  (unfunded signer key, not an account)"].join(" "));
    }
    const sl = agentState.signerList;
    const roleOf = (a: string) => (Object.keys(signers) as SignerRole[]).find((r) => signers[r] === a) ?? "unknown";
    console.log(`\nagent_account signer list (on-ledger): quorum ${sl?.quorum} entries ${sl?.entries.map((e) => `${roleOf(e.account)}:${e.weight} (${e.account})`).join(", ")}`);
    console.log(`agent_account lsfDisableMaster: ${agentState.masterDisabled} (Flags 0x${agentState.flags.toString(16)})`);
    console.log(`\ntransactions submitted this run: ${stats.txs}; faucet calls this run: ${stats.faucet}`);
    for (const l of stats.txLog) console.log(`  ${l}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error("setup failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
