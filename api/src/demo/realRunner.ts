// Mongo mode: POST /demo/:scenario starts the REAL XRPL Testnet scenario (xrpl/scripts/demo.ts via tsx) in a child
// process and returns at once. The child is the AGENT process (it loads the root .env + xrpl/.env.agent itself); this
// API never holds a signing key. It runs with NOTIFY_API=1 + EVENTS_TOKEN + API_URL=<this API>, so every decision it
// records reaches POST /events/payment -> WS /live while the run is going.
//
// One run at a time. The child is DETACHED with its output in a log file (xrpl/data/api-demo-<run_id>.local.log,
// gitignored): if this API stops mid-run, the demo still finishes on its own, including the kill switch's restore
// (killing the demo between revoke and restore would leave the agent key revoked). Nothing here ever kills a run.
// Services: by default the demo CLI auto-spawns a missing co-signer / xrpl service / officer (dev convenience);
// DEMO_NO_SPAWN=1 passes "no-spawn" so it requires externally started services (the judged demo).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DemoRun, DemoRunStatus } from "../../../shared/contracts";
import { osEnv, scrub, XRPL_DIR } from "../lib/python";
import { nowNY } from "../lib/time";

/** API scenario name -> xrpl demo CLI scenario. `happy` runs the golden REAL organization so the website's main
 *  button moves the real golden pin (site_fbnyc). `escrow` is the real CTT escrow (create -> officer-approved release). */
export const REAL_SCENARIOS: Record<string, string> = {
  happy: "golden",
  golden: "golden",
  injection: "injection",
  duplicate: "duplicate",
  "over-contract": "over-contract",
  uncredentialed: "uncredentialed",
  "address-swap": "address-swap",
  "over-limit": "over-limit",
  "kill-switch": "kill-switch",
  escrow: "escrow",
};
/** Accepted but does nothing in mongo mode: the real escrow run already includes the officer-approved release. */
export const NOOP_SCENARIOS: Record<string, string> = {
  "escrow-release": "No-op in mongo mode: POST /demo/escrow already runs the whole simulated escrow on XRPL Testnet (EscrowCreate -> wrong report refused -> release without the officer refused -> officer approves -> EscrowFinish released).",
};
export const MONGO_SCENARIO_NAMES = [...Object.keys(REAL_SCENARIOS), ...Object.keys(NOOP_SCENARIOS)];

/** Own-property lookup (a scenario name comes from the URL: "constructor" / "__proto__" must not hit Object.prototype). */
export function lookup(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) && typeof map[key] === "string" ? map[key] : undefined;
}

/** The run lock is released (without killing the child) after this long; the run is then reported as status "unknown". */
const RUN_LOCK_MAX_MS = Math.max(60_000, Number(process.env.RUN_LOCK_MAX_MS ?? 10 * 60_000) || 10 * 60_000);
/** Survives an API restart: while the pid in it is alive (and younger than RUN_LOCK_MAX_MS) no new run starts. */
const LOCK_FILE = path.join(XRPL_DIR, "data", "api-demo-lock.local.json");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A run started by an earlier API process that is still going (from the lock file), or null. */
function lockedByOtherProcess(): { run_id: string; scenario: string } | null {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as { run_id?: unknown; scenario?: unknown; pid?: unknown; started_ms?: unknown; api_pid?: unknown };
    if (typeof l.run_id !== "string" || typeof l.pid !== "number" || typeof l.started_ms !== "number") return null;
    if (l.api_pid === process.pid) return null; // ours: the in-memory state is authoritative
    if (Date.now() - l.started_ms > RUN_LOCK_MAX_MS || !pidAlive(l.pid)) return null;
    return { run_id: l.run_id, scenario: typeof l.scenario === "string" ? l.scenario : "?" };
  } catch {
    return null;
  }
}

/** Amounts matter for these (golden: one 12.50 payment moves the golden pin red -> yellow; over-limit ignores DEMO_AMOUNT). */
const AMOUNT_SENSITIVE = new Set(["golden"]);
const LOG_TAIL_LINES = 80;
const KEEP_RUNS = 25;

export type RunStatusListener = (run: { run_id: string; scenario: string; status: DemoRunStatus }) => void;

interface RunState extends DemoRun {
  logFile: string;
  pid: number | null;
}

export interface RealRunnerOptions {
  /** Where the demo's NOTIFY_API posts go, e.g. http://localhost:4000. */
  apiUrl: string;
  eventsToken?: string;
  noSpawn?: boolean;
  onStatus?: RunStatusListener;
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

export class RealDemoRunner {
  private readonly runs = new Map<string, RunState>();
  private current: RunState | null = null;

  constructor(private readonly opts: RealRunnerOptions) {}

  get active(): DemoRun | null {
    return this.current ? this.view(this.current) : null;
  }

  get(runId: string): DemoRun | null {
    const r = this.runs.get(runId);
    return r ? this.view(r) : null;
  }

  list(): DemoRun[] {
    return [...this.runs.values()].reverse().map((r) => this.view(r));
  }

  /** Called by POST /events/payment: attribute a decision to the active run. */
  noteDecision(decisionId: string): void {
    if (this.current && !this.current.decision_ids.includes(decisionId)) this.current.decision_ids.push(decisionId);
  }

  /** The run that blocks a new run or a reset: this process's active run, or one a previous API process started that is
   *  still alive (lock file). */
  blocking(): { run_id: string; scenario: string } | null {
    if (this.current) return { run_id: this.current.run_id, scenario: this.current.scenario };
    return lockedByOtherProcess();
  }

  /** Starts a run. Throws RunInProgressError if one is active. */
  start(scenario: string): DemoRun {
    const busy = this.blocking();
    if (busy) throw new RunInProgressError(busy.run_id, busy.scenario);
    const cli = lookup(REAL_SCENARIOS, scenario);
    if (!cli) throw new Error(`not a real scenario: ${scenario}`);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const run_id = `run_${stamp}_${randomBytes(3).toString("hex")}`;
    const logFile = path.join(XRPL_DIR, "data", `api-demo-${run_id}.local.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, "a");

    const args = ["--import", "tsx", path.join(XRPL_DIR, "scripts", "demo.ts"), cli];
    if (this.opts.noSpawn) args.push("no-spawn");
    const env = osEnv({
      NOTIFY_API: "1",
      API_URL: this.opts.apiUrl,
      EVENTS_TOKEN: this.opts.eventsToken,
      COSIGNER_URL: process.env.COSIGNER_URL,
      XRPL_SERVICE_URL: process.env.XRPL_SERVICE_URL,
      OFFICER_URL: process.env.OFFICER_URL,
      OVER_LIMIT_AMOUNT: process.env.OVER_LIMIT_AMOUNT,
      DEMO_AMOUNT: AMOUNT_SENSITIVE.has(cli) ? undefined : process.env.DEMO_AMOUNT,
      PYTHONIOENCODING: "utf-8",
    });

    const run: RunState = {
      run_id,
      scenario,
      cli_scenario: cli,
      status: "running",
      exit_code: null,
      started_at: nowNY(),
      finished_at: null,
      decision_ids: [],
      log_tail: [],
      logFile,
      pid: null,
    };
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: XRPL_DIR, env, stdio: ["ignore", fd, fd], detached: true, windowsHide: true });
    } finally {
      fs.closeSync(fd);
    }
    run.pid = child.pid ?? null;
    this.current = run;
    this.runs.set(run_id, run);
    while (this.runs.size > KEEP_RUNS) this.runs.delete(this.runs.keys().next().value!);
    this.opts.log?.info(`demo run ${run_id}: ${scenario} -> npm run demo ${cli}${this.opts.noSpawn ? " no-spawn" : ""} (pid ${run.pid}, log ${path.relative(XRPL_DIR, logFile)})`);
    this.opts.onStatus?.({ run_id, scenario, status: "running" });
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ run_id, scenario, pid: run.pid, api_pid: process.pid, started_ms: Date.now() }));
    } catch (e) {
      this.opts.log?.warn(`demo run ${run_id}: could not write the lock file: ${(e as Error).message}`);
    }
    const dropLock = () => {
      try {
        const l = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) as { run_id?: string };
        if (l.run_id === run_id) fs.unlinkSync(LOCK_FILE);
      } catch {
        /* no lock file */
      }
    };

    // A hung child (Testnet stall) must not hold the one-run lock forever: after RUN_LOCK_MAX_MS the lock is released
    // and the run reported "unknown". The child is NOT killed (a kill-switch run must be allowed to restore).
    const lockTimer = setTimeout(() => {
      if (run.status !== "running") return;
      run.status = "unknown";
      this.refreshTail(run);
      run.log_tail.push(`[api] no exit after ${Math.round(RUN_LOCK_MAX_MS / 60_000)} min: run lock released; the child (pid ${run.pid}) was not killed and may still be running`);
      if (this.current === run) this.current = null;
      this.opts.log?.warn(`demo run ${run_id} (${scenario}): no exit after ${RUN_LOCK_MAX_MS} ms; lock released (child pid ${run.pid} not killed)`);
      this.opts.onStatus?.({ run_id, scenario, status: "unknown" });
    }, RUN_LOCK_MAX_MS);
    lockTimer.unref();

    const finish = (code: number | null, err?: string) => {
      if (run.status !== "running" && run.status !== "unknown") return;
      clearTimeout(lockTimer);
      dropLock();
      run.exit_code = code;
      run.status = code === 0 ? "succeeded" : "failed";
      run.finished_at = nowNY();
      this.refreshTail(run);
      if (err) run.log_tail.push(`[api] ${err}`);
      if (this.current === run) this.current = null;
      this.opts.log?.[run.status === "succeeded" ? "info" : "warn"](`demo run ${run_id} (${scenario}) ${run.status}, exit ${code}; decisions: ${run.decision_ids.join(", ") || "none"}`);
      this.opts.onStatus?.({ run_id, scenario, status: run.status });
    };
    child.once("error", (e) => finish(null, `could not start the demo: ${e.message}`));
    child.once("exit", (code) => finish(code));
    return this.view(run);
  }

  /** Re-reads the tail of the run's log (cheap: only the last 64 KB) and collects the decision ids it printed. */
  private refreshTail(run: RunState): void {
    let text = "";
    try {
      const st = fs.statSync(run.logFile);
      const len = Math.min(st.size, 64 * 1024);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(run.logFile, "r");
      try {
        fs.readSync(fd, buf, 0, len, st.size - len);
      } finally {
        fs.closeSync(fd);
      }
      text = buf.toString("utf8");
    } catch {
      return;
    }
    const lines = scrub(text).split(/\r?\n/).filter((l) => l.trim() !== "");
    run.log_tail = lines.slice(-LOG_TAIL_LINES);
    // demo.ts prints "decision <id>  invoice <inv>  ..." for every decision it shows.
    for (const l of lines) {
      const m = /^decision (\S+)\s+invoice /.exec(l);
      if (m && !run.decision_ids.includes(m[1])) run.decision_ids.push(m[1]);
    }
  }

  private view(run: RunState): DemoRun {
    if (run.status === "running" || run.status === "unknown") this.refreshTail(run);
    const { logFile: _f, pid: _p, ...pub } = run;
    return structuredClone(pub);
  }
}

export class RunInProgressError extends Error {
  constructor(
    readonly runId: string,
    readonly scenario: string,
  ) {
    super(`demo run ${runId} (${scenario}) is still running`);
  }
}
