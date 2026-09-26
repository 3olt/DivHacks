// Env loading. Every process loads the repo-root .env (shared, non-signing config).
// - Setup/admin scripts (no role): also load xrpl/.env.local (setup-only seeds: issuer, treasury, demo accounts).
// - Signer processes (role given): load ONLY xrpl/.env.<role>, so each signer's seed lives in exactly one process
//   and a signer process never sees the treasury or any other signer's seed.
// - The co-signer additionally takes every POLICY key (limits, database, ledger node, RLUSD, SourceTag) ONLY from the
//   root .env FILE: values inherited from whoever started it are discarded, so an agent that spawns the co-signer cannot
//   loosen its limits or point it at another database / ledger node. (Its names are reported, never its values.)
import fs from "node:fs";
import { config, parse } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const xrplDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(xrplDir, "..");
const rootEnvPath = path.join(rootDir, ".env");

export type SignerRole = "agent" | "cosigner" | "officer";

/** Keys the co-signer's decisions depend on. For the co-signer they come only from the root .env file. */
export const POLICY_KEYS = [
  "AUTO_LIMIT",
  "DAILY_CAP",
  "PAYEE_DAILY_CAP",
  "MONGODB_URI",
  "MONGODB_DB",
  "XRPL_WS",
  "RLUSD_ISSUER",
  "RLUSD_CURRENCY_HEX",
  "AGENT_SOURCE_TAG",
] as const;

/** The root .env file parsed on its own (no process env mixed in). Empty object if the file is missing. */
export function readRootEnvFile(): Record<string, string> {
  try {
    return parse(fs.readFileSync(rootEnvPath));
  } catch {
    return {};
  }
}

/** Names of inherited POLICY_KEYS the co-signer discarded at startup (set by loadEnv("cosigner")). */
export const discardedInheritedPolicyKeys: string[] = [];

export function loadEnv(role?: SignerRole): void {
  if (role === "cosigner") {
    const file = readRootEnvFile();
    for (const k of POLICY_KEYS) {
      if (process.env[k] !== undefined && process.env[k] !== file[k]) discardedInheritedPolicyKeys.push(k);
      if (file[k] !== undefined) process.env[k] = file[k];
      else delete process.env[k];
    }
  }
  config({ path: rootEnvPath, quiet: true });
  if (role) config({ path: path.join(xrplDir, `.env.${role}`), quiet: true });
  else config({ path: path.join(xrplDir, ".env.local"), quiet: true });
  if (role === "cosigner") {
    // xrpl/.env.cosigner must not change policy either: re-apply the root file's values.
    const file = readRootEnvFile();
    for (const k of POLICY_KEYS) {
      if (file[k] !== undefined) process.env[k] = file[k];
      else delete process.env[k];
    }
  }
}

export const paths = { xrplDir, rootDir, dataDir: path.join(xrplDir, "data") };
