// The public account registry (xrpl/data/accounts.testnet.json) and the Phase 1 co-signer allowlist
// (xrpl/data/allowlist.json). Both are written by scripts/setup.ts, committed to git, and hold addresses only.
// loadRegistry()/loadAllowlist() re-read the file on every call (agent, setup, verify).
// The co-signer does NOT use them per request: it pins both files once at startup with readPinnedPolicy()
// (content + SHA-256), so edits made on disk afterwards (e.g. by a compromised agent process running as the same
// OS user) have no effect until the co-signer is restarted. /health reports the pinned hashes and any on-disk drift.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { paths } from "../env";

export type NonprofitKey = "np_1" | "np_2" | "np_3" | "np_4";

export interface RegistryNonprofit {
  address: string;
  ein: string;
  name: string;
  contract_id: string;
}

export interface Registry {
  network: "testnet";
  rlusd: { issuer: string; currency: string };
  city_issuer: string;
  city_treasury: string;
  agent_account: string;
  signers: {
    agent: { address: string; weight: number };
    cosigner: { address: string; weight: number };
    officer: { address: string; weight: number };
  };
  quorum: number;
  nonprofits: Record<NonprofitKey, RegistryNonprofit>;
  attacker: string;
  source_tag: number;
}

export interface Allowlist {
  network: "testnet";
  rule_version: string;
  description: string;
  addresses: string[];
}

export const registryPath = path.join(paths.dataDir, "accounts.testnet.json");
export const allowlistPath = path.join(paths.dataDir, "allowlist.json");
export const decisionsLogPath = path.join(paths.dataDir, "decisions.local.jsonl");

export function loadRegistry(): Registry {
  if (!fs.existsSync(registryPath)) throw new Error(`${registryPath} not found: run "npm run setup:xrpl" first`);
  return JSON.parse(fs.readFileSync(registryPath, "utf8")) as Registry;
}

export function loadAllowlist(): Allowlist {
  if (!fs.existsSync(allowlistPath)) throw new Error(`${allowlistPath} not found: run "npm run setup:xrpl" first`);
  return JSON.parse(fs.readFileSync(allowlistPath, "utf8")) as Allowlist;
}

/** Registry lookup by payee EIN: the ONLY place a payment destination comes from. */
export function nonprofitByEin(reg: Registry, ein: string): { key: NonprofitKey; np: RegistryNonprofit } | null {
  for (const [key, np] of Object.entries(reg.nonprofits) as [NonprofitKey, RegistryNonprofit][]) {
    if (np.ein === ein) return { key, np };
  }
  return null;
}

export interface PinnedFile<T> {
  path: string;
  sha256: string;
  data: T;
}

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Reads a policy file once and returns its parsed content plus the SHA-256 of the exact bytes read. */
export function readPinned<T>(file: string): PinnedFile<T> {
  if (!fs.existsSync(file)) throw new Error(`${file} not found: run "npm run setup:xrpl" first`);
  const bytes = fs.readFileSync(file);
  return { path: file, sha256: createHash("sha256").update(bytes).digest("hex"), data: JSON.parse(bytes.toString("utf8")) as T };
}

/** The co-signer's policy: registry + allowlist, read once and pinned by hash. */
export function readPinnedPolicy(): { registry: PinnedFile<Registry>; allowlist: PinnedFile<Allowlist> } {
  return { registry: readPinned<Registry>(registryPath), allowlist: readPinned<Allowlist>(allowlistPath) };
}
