// Loads the repo-root .env (shared config), then xrpl/.env.local (setup-only seeds), then an optional
// role file (xrpl/.env.<role>) so each signer's seed lives only in its own process.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const xrplDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(xrplDir, "..");

export function loadEnv(role?: "agent" | "cosigner" | "officer"): void {
  config({ path: path.join(rootDir, ".env"), quiet: true });
  config({ path: path.join(xrplDir, ".env.local"), quiet: true });
  if (role) config({ path: path.join(xrplDir, `.env.${role}`), quiet: true });
}

export const paths = { xrplDir, rootDir };
