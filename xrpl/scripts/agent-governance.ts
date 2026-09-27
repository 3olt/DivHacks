// Kill switch CLI, run BY THE OFFICER (Phase 3, builder B). This process loads ONLY the root .env + xrpl/.env.officer
// (OFFICER_SEED) and refuses to run if any other seed is present. Same code path as POST /agent/revoke|restore on the
// officer service (src/officer/governance.ts): officer signs the SignerListSet, the co-signer co-signs it through
// POST /governance/cosign (which accepts only REVOKED or CANONICAL), then it is submitted.
//
//   npm run agent:revoke     SignerListSet {cosigner:2, officer:1} quorum 3: the agent key stops counting (kill switch)
//   npm run agent:restore    SignerListSet {agent:1, cosigner:2, officer:1} quorum 3 (idempotent: no-op if already canonical)
//   npm run agent:status     read-only: the on-ledger signer list configuration and the master-key flag
// Modifiers: no-spawn (require a co-signer at COSIGNER_URL; otherwise one is spawned with a minimal environment).
import type { ChildProcess } from "node:child_process";
import { Wallet } from "xrpl";
import { loadEnv } from "../src/env";
import { loadRegistry } from "../src/lib/registry";
import { connect } from "../src/lib/xrpl";
import { setAgentSignerList, signerListStatus } from "../src/officer/governance";
import { health, spawnCosigner, stopChild, waitHealthy } from "./_cosigner";

loadEnv("officer");

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const action = args.find((a) => ["revoke", "restore", "status"].includes(a));
  if (!action) {
    console.error("usage: npm run agent:revoke | agent:restore | agent:status   (xrpl: tsx scripts/agent-governance.ts revoke|restore|status [no-spawn])");
    return 2;
  }
  const foreign = Object.keys(process.env).filter((k) => k.endsWith("_SEED") && k !== "OFFICER_SEED");
  if (foreign.length) throw new Error(`refusing to run: other seeds are present in this process's environment (${foreign.join(", ")})`);
  const reg = loadRegistry();
  const client = await connect();
  let child: ChildProcess | null = null;
  try {
    const before = await signerListStatus(client, reg);
    console.log(`agent_account ${reg.agent_account}: signer list ${before.config} (quorum ${before.quorum}; ${before.entries.map((e) => `${e.role}:${e.weight}`).join(", ")}), master key disabled: ${before.master_disabled}`);
    if (action === "status") return before.config === "CANONICAL" && before.master_disabled ? 0 : 1;

    const seed = process.env.OFFICER_SEED;
    if (!seed) throw new Error('OFFICER_SEED missing: run "npm run setup:xrpl" to generate xrpl/.env.officer');
    const officer = Wallet.fromSeed(seed);
    delete process.env.OFFICER_SEED;
    if (officer.address !== reg.signers.officer.address) throw new Error(`OFFICER_SEED derives ${officer.address}, not the registry officer ${reg.signers.officer.address}`);

    const cosignerUrl = (process.env.COSIGNER_URL ?? "http://localhost:4002").replace(/\/$/, "");
    if (!(await health(cosignerUrl))) {
      if (args.includes("no-spawn")) throw new Error(`no co-signer answers at ${cosignerUrl} and no-spawn is set`);
      child = spawnCosigner({ prefix: "  cosigner| " });
      await waitHealthy(child, cosignerUrl);
      console.log(`(spawned a co-signer child with a minimal environment at ${cosignerUrl})`);
    }
    const target = action === "revoke" ? "REVOKED" : "CANONICAL";
    const r = await setAgentSignerList(target, { client, officer, reg, cosignerUrl, log: (m) => console.log(m) });
    console.log(`${r.ok ? "OK" : "FAILED"}: ${r.message}${r.engine_result ? ` (engine_result ${r.engine_result}, final ${r.final})` : ""}${r.explorer_url ? ` ${r.explorer_url}` : ""}`);
    const after = await signerListStatus(client, reg);
    console.log(`agent_account now: ${after.config} (${after.entries.map((e) => `${e.role}:${e.weight}`).join(", ")}, quorum ${after.quorum}), master key disabled: ${after.master_disabled}`);
    return r.ok ? 0 : 1;
  } finally {
    await client.disconnect().catch(() => undefined);
    if (child) await stopChild(child);
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("agent-governance failed:", e instanceof Error ? e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>") : e);
    process.exit(1);
  },
);
