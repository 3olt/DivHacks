// The 4 DEMO sites served in mongo mode next to the 15 real ones, so every XRPL demo scenario lands on a pin.
// They are the fixture sites site_001..site_004 (fictional organizations np_1..np_4, EINs 00-0000001..4; real NYC street
// addresses used only to place the pins), each with the contract its demo wallet is paid under in
// xrpl/data/accounts.testnet.json, and their FIXTURE risk (api/src/risk.ts, as of 2026-09-26). They are flagged
// is_demo_data: true, their names end in "(demo)", and a released payment never changes their risk in mongo mode
// (only the real sites are re-scored, by data/risk.py). Seeded by `npm run seed:demo-sites -w api` (idempotent).
import fs from "node:fs";
import path from "node:path";
import type { Site } from "../../shared/contracts";
import { siteRisk } from "./fixtures/index";
import { FIXTURE_DECISIONS } from "./fixtures/decisions";
import { SITE_SEEDS } from "./fixtures/sites";
import { XRPL_DIR } from "./lib/python";
import { RISK_FIXTURE_COMPUTED_AT } from "./risk";

export const DEMO_SITE_BY_NP = { np_1: "site_001", np_2: "site_002", np_3: "site_003", np_4: "site_004" } as const;
export const DEMO_SITE_IDS: string[] = Object.values(DEMO_SITE_BY_NP);

type Accounts = { nonprofits?: Record<string, { ein?: string; contract_id?: string; name?: string }> };

export function readAccounts(): Accounts {
  return JSON.parse(fs.readFileSync(path.join(XRPL_DIR, "data", "accounts.testnet.json"), "utf8")) as Accounts;
}

/** The demo site documents (Site shape + additive demo fields), ready to upsert by id. */
export function demoSiteDocs(accounts: Accounts = readAccounts()): (Site & Record<string, unknown>)[] {
  return Object.entries(DEMO_SITE_BY_NP).map(([npKey, siteId]) => {
    const np = accounts.nonprofits?.[npKey];
    const seed = SITE_SEEDS.find((s) => s.id === siteId);
    if (!np?.contract_id || !np.ein) throw new Error(`accounts.testnet.json has no ${npKey} contract_id/ein`);
    if (!seed) throw new Error(`fixture site ${siteId} missing`);
    if (seed.nonprofit_ein !== np.ein) throw new Error(`${siteId} is EIN ${seed.nonprofit_ein} but ${npKey} is ${np.ein}`);
    const risk = { ...siteRisk(seed, FIXTURE_DECISIONS, RISK_FIXTURE_COMPUTED_AT), rule_version: "fixture-risk-0" };
    const { is_demo_data: _flag, ...rest } = structuredClone(seed);
    return {
      ...rest,
      name: `${seed.name} (demo)`,
      contract_ids: [np.contract_id],
      risk,
      is_demo_data: true,
      demo_note: `DEMO SITE: fictional organization ${np.name ?? np.ein} (${npKey}), paid by the XRPL Testnet demo scenarios. The street address is real and only places the pin; the organization is not there. Its risk is the fixture score (api/src/risk.ts) and does not change when a demo payment lands.`,
      demo_wallet_key: npKey,
      source: "demo fixture (api/src/fixtures/sites.ts): fictional organization",
      source_url: "https://github.com/3olt/DivHacks/blob/main/api/src/fixtures/sites.ts",
    };
  });
}
