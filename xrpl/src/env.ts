// Env loading. Every process loads the repo-root .env (shared, non-signing config).
// - Setup/admin scripts (no role): also load xrpl/.env.local (setup-only seeds: issuer, treasury, demo accounts).
// - Signer processes (role given): load ONLY xrpl/.env.<role>, so each signer's seed lives in exactly one process
//   and a signer process never sees the treasury or any other signer's seed.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const xrplDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(xrplDir, "..");

export type SignerRole = "agent" | "cosigner" | "officer";

export function loadEnv(role?: SignerRole): void {
  config({ path: path.join(rootDir, ".env"), quiet: true });
  if (role) config({ path: path.join(xrplDir, `.env.${role}`), quiet: true });
  else config({ path: path.join(xrplDir, ".env.local"), quiet: true });
}

export const paths = { xrplDir, rootDir, dataDir: path.join(xrplDir, "data") };
