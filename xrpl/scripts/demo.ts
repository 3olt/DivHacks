// Demo runner. Phase 1 supports "happy": the agent pays a seeded invoice autonomously (agent + co-signer,
// no human) on XRPL Testnet and prints the explorer link.
//
// This process is the AGENT process: it loads only the root .env + xrpl/.env.agent (AGENT_SEED).
// If no co-signer answers at COSIGNER_URL/health, it spawns one as a CHILD PROCESS whose environment has every
// *_SEED variable removed, so the child loads only its own xrpl/.env.cosigner. That is a dev convenience: the agent
// process then controls the co-signer's lifetime and code path. For the judged demo, run the co-signer yourself in its
// own terminal (`npm run cosigner`) and add `no-spawn` so the demo refuses to spawn one.
//
// Run: npm run demo happy                (repo root)
//      npm run demo happy keep           leave the auto-spawned co-signer running (also --keep-cosigner or KEEP_COSIGNER=1)
//      npm run demo happy no-spawn       require an already-running co-signer (also --no-spawn or COSIGNER_NO_SPAWN=1)
// Windows PowerShell drops a bare `--` before flags (`npm run demo happy -- --keep-cosigner` loses the flag there);
// the positional words `keep` / `no-spawn` and the env vars work in every shell.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Invoice } from "../../shared/contracts";
import { paths } from "../src/env";
import { loadAgentWallet, payInvoice } from "../src/agent/payInvoice";
import { sleep } from "../src/lib/xrpl";

const LATER = ["injection", "duplicate", "over-contract", "address-swap", "over-limit", "kill-switch"];
const MODIFIERS = new Set(["keep", "no-spawn"]);
const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith("--") && !MODIFIERS.has(a));
const truthy = (v: string | undefined) => !!v && !/^(0|false|no)$/i.test(v);
const KEEP = args.includes("--keep-cosigner") || args.includes("keep") || truthy(process.env.KEEP_COSIGNER);
const NO_SPAWN = args.includes("--no-spawn") || args.includes("no-spawn") || truthy(process.env.COSIGNER_NO_SPAWN);

type Health = {
  ok: boolean;
  role: string;
  signer_address: string;
  rule_version: string;
  allowlist_size: number;
  auto_limit?: number;
  policy?: { registry_sha256: string; allowlist_sha256: string; registry_on_disk_matches: boolean; allowlist_on_disk_matches: boolean };
};

const describe = (h: Health) =>
  `signer ${h.signer_address}, rule ${h.rule_version}, allowlist ${h.allowlist_size}, AUTO_LIMIT ${h.auto_limit ?? "?"}` +
  (h.policy
    ? `, policy pinned (allowlist sha256 ${h.policy.allowlist_sha256.slice(0, 12)}${h.policy.allowlist_on_disk_matches && h.policy.registry_on_disk_matches ? "" : ", ON-DISK DRIFT"})`
    : "");

async function health(url: string, timeoutMs = 1500): Promise<Health | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const h = (await r.json()) as Health;
    return h.ok && h.role === "cosigner" ? h : null;
  } catch {
    return null;
  }
}

function spawnCosigner(keep: boolean): ChildProcess {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.endsWith("_SEED")) env[k] = v;
  const serverPath = path.join(paths.xrplDir, "src", "cosigner", "server.ts");
  if (keep) {
    const logPath = path.join(paths.dataDir, "cosigner.local.log");
    const fd = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, ["--import", "tsx", serverPath], { cwd: paths.xrplDir, env, stdio: ["ignore", fd, fd], detached: true });
    child.unref();
    console.log(`demo: co-signer will keep running (pid ${child.pid}); its log: ${path.relative(paths.rootDir, logPath)}`);
    return child;
  }
  const child = spawn(process.execPath, ["--import", "tsx", serverPath], { cwd: paths.xrplDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (s: NodeJS.ReadableStream | null) =>
    s?.on("data", (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`  | ${l}`)));
  pipe(child.stdout);
  pipe(child.stderr);
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill();
  await Promise.race([exited, sleep(5000)]);
  console.log(`demo: stopped the auto-spawned co-signer (pid ${child.pid})`);
}

function loadHappyInvoice(): Invoice {
  const seed = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "invoices", "happy.json"), "utf8")) as Invoice;
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15); // yyyymmdd-HHMMss (UTC)
  return { ...seed, invoice_id: `INV-P1-${stamp}`, created_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"), is_demo_data: true };
}

async function main(): Promise<number> {
  if (!scenario) {
    console.error("usage: npm run demo <scenario> [keep] [no-spawn]   (Phase 1: happy)");
    return 2;
  }
  if (scenario !== "happy") {
    console.error(LATER.includes(scenario) ? `scenario "${scenario}" is not implemented until Phase 2/3` : `unknown scenario "${scenario}" (Phase 1 supports: happy)`);
    return 2;
  }

  const agentWallet = loadAgentWallet(); // root .env + xrpl/.env.agent only
  const url = (process.env.COSIGNER_URL ?? "http://localhost:4002").replace(/\/$/, "");
  console.log(`\n=== demo: happy (XRPL Testnet) ===`);
  console.log(`agent signer: ${agentWallet.address} (weight 1); co-signer URL: ${url}`);

  let child: ChildProcess | null = null;
  let h = await health(url);
  if (h) console.log(`co-signer mode: EXTERNAL (already running at ${url}; ${describe(h)})`);
  else if (NO_SPAWN) {
    throw new Error(`no co-signer answers at ${url}/health and no-spawn is set; start it first with "npm run cosigner" in another terminal`);
  } else {
    child = spawnCosigner(KEEP);
    const deadline = Date.now() + 30000;
    while (!h && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`the co-signer child exited with code ${child.exitCode}`);
      await sleep(500);
      h = await health(url);
    }
    if (!h) {
      await stopChild(child);
      throw new Error(`co-signer did not become healthy at ${url} within 30 s`);
    }
    console.log(`co-signer mode: AUTO-SPAWNED child process (pid ${child.pid}, env without any *_SEED; ${describe(h)})`);
    console.log('  (dev convenience: same OS user, started by the agent process. For the judged demo run "npm run cosigner" in its own terminal.)');
  }

  try {
    const invoice = loadHappyInvoice();
    console.log(`invoice: ${invoice.invoice_id} ${invoice.amount} ${invoice.currency} contract ${invoice.contract_id} payee EIN ${invoice.payee_ein} (is_demo_data)`);
    const r = await payInvoice(invoice, { agentWallet, cosignerUrl: url });
    const d = r.decision;
    console.log("\n--- decision ---");
    console.log(JSON.stringify({
      decision_id: d.decision_id, invoice_id: d.invoice_id, outcome: d.outcome, refusal_reasons: d.refusal_reasons, enforced_by: d.enforced_by,
      signers: d.signers, ledger_result: d.ledger_result, xrpl_tx_hash: d.xrpl_tx_hash, decision_hash: d.decision_hash,
      destination: r.destination, delivered_amount: r.delivered_amount, memo: r.memo_json,
    }, null, 2));
    console.log(`persisted to ${path.relative(paths.rootDir, path.join(paths.dataDir, "decisions.local.jsonl"))}`);
    if (d.outcome === "released" && r.explorer_url) console.log(`\nEXPLORER: ${r.explorer_url}`);
    else if (r.explorer_url && r.submit_status === "unknown") console.log(`\nFINAL STATUS UNKNOWN (check it): ${r.explorer_url}`);
    else if (r.explorer_url) console.log(`\nNOT PAID: the transaction is on-ledger but FAILED with ${d.ledger_result}: ${r.explorer_url}`);
    else console.log(`\nNOT PAID: ${d.refusal_reasons.join(", ") || "refused"} (enforced by ${d.enforced_by ?? "-"}${d.ledger_result ? `, ledger_result ${d.ledger_result}` : ""})`);
    return d.outcome === "released" ? 0 : 1;
  } finally {
    if (child && !KEEP) await stopChild(child);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("demo failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
