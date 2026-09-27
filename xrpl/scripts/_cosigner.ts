// Shared by demo.ts and redteam.ts: find a running co-signer, or spawn one as a child process with a MINIMAL environment
// (OS basics + the port; no seeds, no policy values, no NODE_OPTIONS). The co-signer then loads its own xrpl/.env.cosigner
// and takes its policy only from the root .env file. Dev convenience only: for the judged demo run `npm run cosigner`
// in its own terminal. Either way, policyProblems() checks /health against the root .env before the demo proceeds.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { paths, readRootEnvFile } from "../src/env";
import { sleep } from "../src/lib/xrpl";
import { COSIGNER_RULE_VERSION } from "../src/cosigner/checks";

export type Health = {
  ok: boolean;
  role: string;
  signer_address: string;
  rule_version: string;
  allowlist_size: number;
  auto_limit?: number;
  caps?: { daily_cap: number; payee_daily_cap: number };
  registry?: { pinned_sha256: string; wallets: number };
  contracts?: { pinned_sha256: string; pinned: number; late_admitted: number };
  policy?: {
    registry_on_disk_matches: boolean;
    allowlist_on_disk_matches: boolean;
    exclusions_on_disk_matches?: boolean;
    source?: string;
    discarded_inherited_keys?: string[];
    test_tightened?: string[];
    mongodb_db?: string;
  };
};

export const describeHealth = (h: Health) =>
  `signer ${h.signer_address}, rule ${h.rule_version}, AUTO_LIMIT ${h.auto_limit ?? "?"}, DAILY_CAP ${h.caps?.daily_cap ?? "?"}, PAYEE_DAILY_CAP ${h.caps?.payee_daily_cap ?? "?"}` +
  (h.registry ? `, registry snapshot ${h.registry.pinned_sha256.slice(0, 12)} (${h.registry.wallets} wallets)` : "") +
  (h.policy && !(h.policy.allowlist_on_disk_matches && h.policy.registry_on_disk_matches && h.policy.exclusions_on_disk_matches !== false) ? ", ON-DISK POLICY DRIFT" : "");

/**
 * Differences between what the co-signer at /health runs and what the root .env FILE says it should run
 * (limits, database, rule version, no test overrides, no on-disk policy drift). Empty array = as expected.
 */
export function policyProblems(h: Health): string[] {
  const file = readRootEnvFile();
  const want = { auto_limit: Number(file.AUTO_LIMIT ?? "25"), daily_cap: Number(file.DAILY_CAP ?? "300"), payee_daily_cap: Number(file.PAYEE_DAILY_CAP ?? "150"), db: file.MONGODB_DB ?? "divhacks" };
  const out: string[] = [];
  if (h.rule_version !== COSIGNER_RULE_VERSION) out.push(`rule ${h.rule_version}, expected ${COSIGNER_RULE_VERSION} (restart it with the current code)`);
  if (!h.policy?.source) out.push("it does not report where its policy comes from (an older co-signer; restart it)");
  if (h.auto_limit !== want.auto_limit) out.push(`AUTO_LIMIT ${h.auto_limit}, root .env says ${want.auto_limit}`);
  if (h.caps?.daily_cap !== want.daily_cap) out.push(`DAILY_CAP ${h.caps?.daily_cap}, root .env says ${want.daily_cap}`);
  if (h.caps?.payee_daily_cap !== want.payee_daily_cap) out.push(`PAYEE_DAILY_CAP ${h.caps?.payee_daily_cap}, root .env says ${want.payee_daily_cap}`);
  if (h.policy?.mongodb_db !== undefined && h.policy.mongodb_db !== want.db) out.push(`database ${h.policy.mongodb_db}, root .env says ${want.db}`);
  if (h.policy?.test_tightened?.length) out.push(`test overrides active (${h.policy.test_tightened.join(", ")})`);
  if (h.policy && !(h.policy.allowlist_on_disk_matches && h.policy.registry_on_disk_matches && h.policy.exclusions_on_disk_matches !== false)) out.push("policy files changed on disk since it started");
  return out;
}

export async function health(url: string, timeoutMs = 1500): Promise<Health | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const h = (await r.json()) as Health;
    return h.ok && h.role === "cosigner" ? h : null;
  } catch {
    return null;
  }
}

/** OS variables a Node child needs on Windows/Unix. Nothing else from the parent is passed on. */
const PASS_ENV = new Set(
  ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "SYSTEMDRIVE", "PROGRAMDATA", "PROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TZ"],
);

/** Spawns the co-signer with a minimal environment. `extraEnv` (e.g. COSIGNER_PORT, COSIGNER_TEST_* tighten-only
 *  overrides) is added on top; policy keys in it are discarded by the co-signer itself. */
export function spawnCosigner(opts: { keep?: boolean; extraEnv?: Record<string, string>; prefix?: string } = {}): ChildProcess {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (PASS_ENV.has(k.toUpperCase())) env[k] = v;
  if (process.env.COSIGNER_URL) env.COSIGNER_URL = process.env.COSIGNER_URL;
  Object.assign(env, opts.extraEnv ?? {});
  const serverPath = path.join(paths.xrplDir, "src", "cosigner", "server.ts");
  if (opts.keep) {
    const logPath = path.join(paths.dataDir, "cosigner.local.log");
    const fd = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, ["--import", "tsx", serverPath], { cwd: paths.xrplDir, env, stdio: ["ignore", fd, fd], detached: true });
    child.unref();
    console.log(`co-signer will keep running (pid ${child.pid}); its log: ${path.relative(paths.rootDir, logPath)}`);
    return child;
  }
  // detached (own process group / hidden console): a Ctrl+C in the demo's terminal does not kill the co-signer in the middle
  // of a kill-switch restore; the demo stops it itself (stopChild / its signal handler).
  const child = spawn(process.execPath, ["--import", "tsx", serverPath], { cwd: paths.xrplDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
  const prefix = opts.prefix ?? "  | ";
  const pipe = (s: NodeJS.ReadableStream | null) =>
    s?.on("data", (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`${prefix}${l}`)));
  pipe(child.stdout);
  pipe(child.stderr);
  return child;
}

export async function waitHealthy(child: ChildProcess, url: string, timeoutMs = 45000): Promise<Health> {
  const deadline = Date.now() + timeoutMs;
  let h: Health | null = null;
  while (!h && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the co-signer child exited with code ${child.exitCode}`);
    await sleep(500);
    h = await health(url);
  }
  if (!h) {
    await stopChild(child);
    throw new Error(`co-signer did not become healthy at ${url} within ${timeoutMs / 1000} s`);
  }
  return h;
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill();
  await Promise.race([exited, sleep(5000)]);
  console.log(`stopped the auto-spawned child process (pid ${child.pid})`);
}

/** Runs the officer CLI (scripts/officer-resolve.ts) as a SEPARATE process with a minimal environment: it loads its own
 *  xrpl/.env.officer (OFFICER_SEED); the calling agent process never sees that key. Resolves with its exit code. */
export function runOfficerResolve(requestId: string, decision: "approve" | "reject", prefix = "  officer| ", cosignerUrl?: string): Promise<number> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (PASS_ENV.has(k.toUpperCase())) env[k] = v;
  const cos = cosignerUrl ?? process.env.COSIGNER_URL;
  if (cos) env.COSIGNER_URL = cos;
  const script = path.join(paths.xrplDir, "scripts", "officer-resolve.ts");
  const child = spawn(process.execPath, ["--import", "tsx", script, requestId, decision], { cwd: paths.xrplDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (s: NodeJS.ReadableStream | null) =>
    s?.on("data", (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`${prefix}${l}`)));
  pipe(child.stdout);
  pipe(child.stderr);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 3, builder B: the other services (xrpl service :4001, officer :4004) and one-shot child scripts, each spawned with
// the same MINIMAL environment (OS basics + service URLs; no seeds, no policy values). Each child loads its own env file
// (the xrpl service xrpl/.env.agent, the officer xrpl/.env.officer, escrow-setup xrpl/.env.local), so the calling process
// never sees those keys. Dev convenience: for the judged demo start each service in its own terminal and use no-spawn.

export function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (PASS_ENV.has(k.toUpperCase())) env[k] = v;
  for (const k of ["COSIGNER_URL", "XRPL_SERVICE_URL", "OFFICER_URL"]) if (process.env[k]) env[k] = process.env[k];
  return Object.assign(env, extra);
}

export type ServiceKind = "xrpl-service" | "officer";
const SERVICE_SCRIPT: Record<ServiceKind, string[]> = { "xrpl-service": ["src", "service", "server.ts"], officer: ["src", "officer", "server.ts"] };

/** GET <url>/health; returns the JSON when ok and the role matches. */
export async function serviceHealth(url: string, role: ServiceKind, timeoutMs = 1500): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const h = (await r.json()) as Record<string, unknown>;
    return h.ok && h.role === role ? h : null;
  } catch {
    return null;
  }
}

export function spawnService(kind: ServiceKind, opts: { keep?: boolean; prefix?: string } = {}): ChildProcess {
  const script = path.join(paths.xrplDir, ...SERVICE_SCRIPT[kind]);
  const env = minimalEnv();
  if (opts.keep) {
    const fd = fs.openSync(path.join(paths.dataDir, `${kind}.local.log`), "a");
    const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: paths.xrplDir, env, stdio: ["ignore", fd, fd], detached: true });
    child.unref();
    return child;
  }
  const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: paths.xrplDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
  const prefix = opts.prefix ?? `  ${kind}| `;
  const pipe = (s: NodeJS.ReadableStream | null) => s?.on("data", (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`${prefix}${l}`)));
  pipe(child.stdout);
  pipe(child.stderr);
  return child;
}

export async function waitService(child: ChildProcess, url: string, role: ServiceKind, timeoutMs = 60000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the ${role} child exited with code ${child.exitCode}`);
    await sleep(500);
    const h = await serviceHealth(url, role);
    if (h) return h;
  }
  await stopChild(child);
  throw new Error(`${role} did not become healthy at ${url} within ${timeoutMs / 1000} s`);
}

/** Runs a one-shot script (xrpl/scripts/<name>) as a separate process with the minimal environment; resolves its exit code.
 *  Detached (own process group / hidden console), so a Ctrl+C in the calling terminal does not interrupt e.g. a restore. */
export function runChildScript(name: string, args: string[], prefix: string): Promise<number> {
  return runChildScriptCapture(name, args, prefix).then((r) => r.code);
}

/** Same, also returning the child's stdout lines. */
export function runChildScriptCapture(name: string, args: string[], prefix: string): Promise<{ code: number; lines: string[] }> {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(paths.xrplDir, "scripts", name), ...args], { cwd: paths.xrplDir, env: minimalEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
  const lines: string[] = [];
  const pipe = (s: NodeJS.ReadableStream | null, keep: boolean) =>
    s?.on("data", (b: Buffer) =>
      b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => {
        if (keep) lines.push(l);
        if (!l.startsWith("OFFICER_CLICK_RESULT ")) console.log(`${prefix}${l}`);
      }),
    );
  pipe(child.stdout, true);
  pipe(child.stderr, false);
  return new Promise((resolve) => child.once("exit", (code) => resolve({ code: code ?? 1, lines })));
}

/** The OFFICER's click, as a SEPARATE process (scripts/officer-click.ts): it loads xrpl/.env.officer itself (the click
 *  credential); the calling agent process never sees it. Resolves {code, status, body} of the officer service's answer. */
export async function runOfficerClick(args: string[], prefix = "  officer-click| "): Promise<{ code: number; status: number; body: Record<string, unknown> }> {
  const r = await runChildScriptCapture("officer-click.ts", args, prefix);
  const line = [...r.lines].reverse().find((l) => l.startsWith("OFFICER_CLICK_RESULT "));
  let parsed: { status?: number; body?: Record<string, unknown> } = {};
  try {
    parsed = line ? (JSON.parse(line.slice("OFFICER_CLICK_RESULT ".length)) as typeof parsed) : {};
  } catch {
    parsed = {};
  }
  return { code: r.code, status: parsed.status ?? 0, body: parsed.body ?? { ok: false, error: "no_result", message: `officer-click exited ${r.code} without a result line` } };
}
