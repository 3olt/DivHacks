// Runs builder A's Python scripts under data/ (risk.py, demo_reset.py) as separate processes (mongo mode only).
// Python: PYTHON_BIN if set, else the data/.venv interpreter for this OS (Windows data/.venv/Scripts/python.exe,
// else data/.venv/bin/python), else "python" / "python3" on PATH. The child gets a MINIMAL environment (OS basics
// only): the scripts load the repo-root .env themselves (data/gl_common.py), so no secret is passed on the command
// line or through this process's environment.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const XRPL_DIR = path.join(REPO_ROOT, "xrpl");

/** OS variables a child process needs on Windows / Unix. Nothing else from this process is passed on. */
const OS_ENV = new Set(
  ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "SYSTEMDRIVE", "PROGRAMDATA", "PROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TZ"],
);

export function osEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (OS_ENV.has(k.toUpperCase())) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

export function pythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venv = path.join(DATA_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (fs.existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

export interface PyResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
  ms: number;
}

/** Token / secret values from xrpl/.env.* (e.g. OFFICER_CLICK_TOKEN), which are never in this process's env. Kept private,
 *  used only to redact text we return (log_tail) and never passed to a child. Seeds and private keys are NOT loaded: this
 *  API never holds a signing key (seeds are redacted by their shape below). Read once, lazily. */
let xrplSecrets: [string, string][] | null = null;
function xrplEnvSecrets(): [string, string][] {
  if (xrplSecrets) return xrplSecrets;
  const out: [string, string][] = [];
  try {
    for (const f of fs.readdirSync(XRPL_DIR)) {
      if (!/^\.env(\..+)?$/.test(f) || /example/i.test(f)) continue;
      let text = "";
      try {
        text = fs.readFileSync(path.join(XRPL_DIR, f), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m || /SEED|PRIVATE/i.test(m[1]) || !/TOKEN|SECRET|KEY|PASSWORD|MONGODB_URI/i.test(m[1])) continue;
        const v = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
        if (v.length >= 8) out.push([m[1], v]);
      }
    }
  } catch {
    /* no xrpl dir */
  }
  xrplSecrets = out;
  return out;
}

/** Scrubs anything that looks like a connection string or key from text we log or return. */
export function scrub(text: string): string {
  let out = text.replace(/mongodb(\+srv)?:\/\/\S+/gi, "<uri>");
  // XRPL family seeds (s + base58) and long hex secrets.
  out = out.replace(/\bs[1-9A-HJ-NP-Za-km-z]{24,34}\b/g, "<seed?>");
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && /SEED|TOKEN|SECRET|KEY|PASSWORD|MONGODB_URI/i.test(k)) out = out.split(v).join(`<${k}>`);
  }
  for (const [k, v] of xrplEnvSecrets()) out = out.split(v).join(`<${k}>`);
  return out;
}

/** Runs `python data/<script> ...args` with a timeout (default RISK_TIMEOUT_MS or 90 s). Never throws. */
export function runDataScript(script: string, args: string[], timeoutMs = Number(process.env.RISK_TIMEOUT_MS ?? 90_000)): Promise<PyResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(pythonBin(), [path.join(DATA_DIR, script), ...args], {
        cwd: REPO_ROOT,
        env: osEnv({ PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: null, stdout, stderr, timedOut, error: (e as Error).message, ms: Date.now() - t0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error: e.message, ms: Date.now() - t0 });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: scrub(stderr), timedOut, ms: Date.now() - t0 });
    });
  });
}

/** The last stdout line that parses as a JSON object, or null. */
export function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return null;
}
