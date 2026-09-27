// GET /xrpl/accounts: the public XRPL Testnet registry from xrpl/data/accounts.testnet.json (written by
// `npm run setup:xrpl`). Addresses and roles only: the response is rebuilt from a field whitelist, so a key that
// is not in the registry schema (for example a seed someone pasted into the file by mistake) is never served.
// The file is read at request time, so a re-run of setup shows up without restarting the API.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { isRecord, sendError } from "../lib/http";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ACCOUNTS_FILE = path.resolve(here, "../../../xrpl/data/accounts.testnet.json");

const ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const address = (v: unknown): string | null => (typeof v === "string" && ADDRESS.test(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

export interface PublicRegistry {
  network: string | null;
  rlusd: { issuer: string | null; currency: string | null };
  city_issuer: string | null;
  city_treasury: string | null;
  agent_account: string | null;
  signers: Record<string, { address: string | null; weight: number | null }>;
  quorum: number | null;
  /** `label` (additive) is set on a DEMO wallet of a REAL organization (np_5, the golden: "demo wallet on XRPL Testnet; the
   *  real organization has not onboarded"); its `name` then carries the label in parentheses too, so a client that shows
   *  only the name never presents the demo wallet as the organization's own. */
  nonprofits: Record<string, { address: string | null; ein: string | null; name: string | null; contract_id: string | null; label?: string }>;
  attacker: string | null;
  source_tag: number | null;
}

/** Whitelist copy of the registry: known keys, addresses validated as classic r-addresses. */
export function publicRegistry(raw: Record<string, unknown>): PublicRegistry {
  const rlusd = isRecord(raw.rlusd) ? raw.rlusd : {};
  const signers: PublicRegistry["signers"] = {};
  if (isRecord(raw.signers)) {
    for (const [role, s] of Object.entries(raw.signers)) {
      if (/^[a-z_]+$/.test(role) && isRecord(s)) signers[role] = { address: address(s.address), weight: int(s.weight) };
    }
  }
  const nonprofits: PublicRegistry["nonprofits"] = {};
  if (isRecord(raw.nonprofits)) {
    for (const [key, np] of Object.entries(raw.nonprofits)) {
      if (/^np_\d+$/.test(key) && isRecord(np)) {
        const label = typeof np.label === "string" && np.label.trim() ? np.label.trim().slice(0, 200) : null;
        const name = text(np.name);
        nonprofits[key] = {
          address: address(np.address),
          ein: text(np.ein),
          name: name !== null && label ? `${name} (${label})` : name,
          contract_id: text(np.contract_id),
          ...(label ? { label } : {}),
        };
      }
    }
  }
  return {
    network: text(raw.network),
    rlusd: { issuer: address(rlusd.issuer), currency: typeof rlusd.currency === "string" && /^[0-9A-F]{40}$/i.test(rlusd.currency) ? rlusd.currency : null },
    city_issuer: address(raw.city_issuer),
    city_treasury: address(raw.city_treasury),
    agent_account: address(raw.agent_account),
    signers,
    quorum: int(raw.quorum),
    nonprofits,
    attacker: address(raw.attacker),
    source_tag: int(raw.source_tag),
  };
}

export function registerXrplRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.get("/xrpl/accounts", async (_req, reply) => {
    let raw: string;
    try {
      raw = await readFile(ACCOUNTS_FILE, "utf8");
    } catch {
      return sendError(reply, 404, "accounts_not_found", "No XRPL account registry yet (xrpl/data/accounts.testnet.json); run `npm run setup:xrpl`");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendError(reply, 500, "accounts_invalid", "xrpl/data/accounts.testnet.json is not valid JSON");
    }
    if (!isRecord(parsed)) return sendError(reply, 500, "accounts_invalid", "xrpl/data/accounts.testnet.json is not a JSON object");
    return publicRegistry(parsed);
  });
}
