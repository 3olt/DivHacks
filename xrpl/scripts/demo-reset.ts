// One-command demo reset (Phase 7): npm run demo:reset [no-topup]
//
// Puts the shared demo back into its "ready for judges" state:
//   1. signer list: restore CANONICAL {agent:1, cosigner:2, officer:1} quorum 3 if a kill-switch run left it revoked
//   2. address-swap holds: the officer rejects every hold still in force (demo requests only; needs the co-signer running)
//   3. demo scores: POST /dev/reset on the API (clears demo_risk, new demo epoch), or data/demo_reset.py if the API is down
//   4. RLUSD: tops the agent up with `npm run setup:xrpl` when it holds less than RESET_MIN_RLUSD (default 60)
//
// This process never loads a signing key. Each step runs the existing CLI (which loads only its own role's key file),
// with every *_SEED variable stripped from the child environment.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { paths } from "../src/env";

const args = process.argv.slice(2).filter((a) => a !== "--");
const skipTopup = args.includes("no-topup") || args.includes("--no-topup");

const rootEnv: Record<string, string> = (() => {
  try {
    return parse(fs.readFileSync(path.join(paths.rootDir, ".env")));
  } catch {
    return {};
  }
})();
const setting = (k: string, fallback: string) => process.env[k] ?? rootEnv[k] ?? fallback;

const API_URL = setting("API_URL", "http://localhost:4000");
const COSIGNER_URL = setting("COSIGNER_URL", "http://localhost:4002");
const XRPL_RPC = setting("XRPL_RPC", "https://s.altnet.rippletest.net:51234");
const MIN_RLUSD = Number(setting("RESET_MIN_RLUSD", "60"));

const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_SEED$/.test(k)));

function run(label: string, cmd: string): number {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { cwd: paths.rootDir, env: childEnv, stdio: "inherit", shell: true });
  const code = r.status ?? 1;
  console.log(`  -> ${label}: exit ${code}`);
  return code;
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any } | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

async function main() {
  const summary: string[] = [];

  // 1. Signer list
  console.log("== 1/4 signer list");
  if (run("agent:status", "npm run agent:status") !== 0) {
    run("agent:restore", "npm run agent:restore");
    const ok = run("agent:status (after restore)", "npm run agent:status") === 0;
    summary.push(ok ? "signer list: RESTORED to canonical" : "signer list: STILL NOT CANONICAL (check the officer and co-signer)");
  } else summary.push("signer list: canonical, master key disabled");

  // 2. Address-swap holds
  console.log("\n== 2/4 address-swap holds");
  const holds = await getJson(`${COSIGNER_URL}/holds`);
  if (!holds) {
    summary.push(`holds: co-signer not reachable at ${COSIGNER_URL} (start it with npm run cosigner, then re-run)`);
  } else {
    const active: any[] = Array.isArray(holds.body?.active) ? holds.body.active : [];
    if (!active.length) summary.push("holds: none in force");
    for (const h of active) {
      const id = h.request_id ?? h.id;
      if (!id) continue;
      const code = run(`officer rejects hold ${id}`, `npm run officer:resolve -- ${id} reject`);
      summary.push(`hold ${id} (EIN ${h.ein ?? "?"}): ${code === 0 ? "rejected by the officer, lifted" : "COULD NOT BE LIFTED"}`);
    }
  }

  // 3. Demo scores
  console.log("\n== 3/4 demo scores");
  const reset = await getJson(`${API_URL}/dev/reset`, { method: "POST" });
  if (reset && reset.status === 200) {
    summary.push(`demo scores: reset through the API (${API_URL})`);
  } else {
    if (reset) console.log(`  API /dev/reset answered ${reset.status}: ${JSON.stringify(reset.body)}`);
    const py = process.platform === "win32" ? "data\\.venv\\Scripts\\python.exe" : "data/.venv/bin/python";
    const code = run("data/demo_reset.py", `${py} data/demo_reset.py`);
    summary.push(code === 0 ? "demo scores: reset with data/demo_reset.py (API not reachable; reload open pages)" : "demo scores: RESET FAILED");
  }

  // 4. RLUSD balance
  console.log("\n== 4/4 agent RLUSD");
  const accounts = JSON.parse(fs.readFileSync(path.join(paths.dataDir, "accounts.testnet.json"), "utf8"));
  const lines = await getJson(XRPL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "account_lines", params: [{ account: accounts.agent_account, peer: accounts.rlusd.issuer }] }),
  });
  const bal = Number(lines?.body?.result?.lines?.find((l: any) => l.currency === accounts.rlusd.currency)?.balance ?? NaN);
  if (!Number.isFinite(bal)) summary.push("agent RLUSD: could not read the balance from the ledger");
  else if (bal >= MIN_RLUSD || skipTopup) summary.push(`agent RLUSD: ${bal.toFixed(2)}${bal < MIN_RLUSD ? " (below the minimum; top-up skipped)" : ""}`);
  else {
    const code = run("setup:xrpl top-up", "npm run setup:xrpl");
    summary.push(`agent RLUSD: was ${bal.toFixed(2)}, top-up ${code === 0 ? "done" : "FAILED"}`);
  }

  console.log("\n== demo reset summary");
  for (const s of summary) console.log(`  - ${s}`);
  const bad = summary.some((s) => /STILL|COULD NOT|FAILED/.test(s));
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
