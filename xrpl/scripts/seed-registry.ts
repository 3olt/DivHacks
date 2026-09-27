// Seeds the payee registry + demo contracts into MongoDB (db MONGODB_DB or "divhacks"). Idempotent upserts; every
// document is DEMO DATA (is_demo_data: true). Holds no keys: loads only the root .env.
//
//   nonprofits  np_1..np_4 (EIN 00-0000001..4, names from data/accounts.testnet.json), Nonprofit shape with
//               wallet {address (registry wallet), credential_status, credential_expires, bank_verified}.
//               Since Phase 3 the wallet STATUS fields belong to onboarding (scripts/onboard-nonprofit.ts): an EIN with a
//               complete Mongo `onboarding` record keeps what onboarding wrote; any other EIN gets credential_status "none",
//               bank_verified false (the co-signer reads the real credential on-ledger either way).
//   contracts   the 4 demo contracts (Contract shape, values copied from api/src/fixtures/contracts.ts) plus
//               xrpl_budget_rlusd: a TESTNET-SCALE STAND-IN for the contract's remaining balance (the real amount is USD).
//   indexes     decisions.decision_id unique, decisions.invoice_id, payments.payment_id unique, ...
//
// Run: npm run seed:registry   (repo root)   or   npm run seed-registry   (xrpl/)
import path from "node:path";
import { config } from "dotenv";
import { paths } from "../src/env";
import { loadRegistry, type NonprofitKey } from "../src/lib/registry";
import { COLL, ensureIndexes, openMongo, type ContractDoc, type NonprofitDoc } from "../src/lib/mongo";
import { readRegistrySnapshot } from "../src/lib/registrySnapshot";

config({ path: path.join(paths.rootDir, ".env"), quiet: true });

const FIXTURE_SOURCE = "demo fixture (Phase 4 replaces with Checkbook NYC)";
const FIXTURE_SOURCE_URL = "https://www.checkbooknyc.com/";
const BUDGET_NOTE =
  "xrpl_budget_rlusd is a TESTNET-SCALE STAND-IN for this contract's remaining balance, in RLUSD. The contract amount is USD; " +
  "Testnet RLUSD is scarce, so the co-signer's within_contract_amount check compares on-ledger RLUSD paid under this contract with this number.";
const DEFAULT_BUDGET = process.env.SEED_CONTRACT_BUDGET_RLUSD ?? "250.00";

// Street addresses and service types copied from api/src/fixtures/nonprofits.ts (fictional organizations placed at real
// NYC street addresses only so their pins look plausible).
const NP_DETAILS: Record<NonprofitKey, { address: string; service_types: string[] }> = {
  np_1: { address: "30 W Burnside Ave, Bronx, NY 10453", service_types: ["food_pantry"] },
  np_2: { address: "412 E 138th St, Bronx, NY 10454", service_types: ["grocery_giveaway", "food_pantry"] },
  np_3: { address: "2530 Webster Ave, Bronx, NY 10458", service_types: ["youth_program"] },
  np_4: { address: "236 E 116th St, New York, NY 10029", service_types: ["food_pantry"] },
};

// Contract fields copied from api/src/fixtures/contracts.ts (fictional ids in Checkbook's format; spent_to_date = sum of
// the fixture's Checkbook-style payments).
const CONTRACTS: Omit<ContractDoc, "xrpl_budget_rlusd" | "xrpl_budget_note" | "is_demo_data" | "source" | "source_url">[] = [
  { contract_id: "CT1-069-20261409087", agency_code: "HRA", nonprofit_ein: "00-0000001", amount: "1240000.00", start_date: "2025-07-01", end_date: "2028-06-30", registered_date: "2025-09-08", spent_to_date: "186000.00", purpose: "Emergency food assistance: pantry operations and bulk food purchasing" },
  { contract_id: "CT1-069-20271522304", agency_code: "HRA", nonprofit_ein: "00-0000002", amount: "520000.00", start_date: "2026-07-01", end_date: "2027-06-30", registered_date: null, spent_to_date: "0.00", purpose: "Community food distribution: weekly grocery giveaways" },
  { contract_id: "CT1-260-20241298815", agency_code: "DYCD", nonprofit_ein: "00-0000003", amount: "690000.00", start_date: "2024-07-01", end_date: "2027-06-30", registered_date: "2024-06-20", spent_to_date: "505000.00", purpose: "After-school STEM programming (middle school)" },
  { contract_id: "CT1-069-20261409311", agency_code: "HRA", nonprofit_ein: "00-0000004", amount: "880000.00", start_date: "2025-07-01", end_date: "2027-06-30", registered_date: "2025-08-01", spent_to_date: "334400.00", purpose: "Emergency food assistance: pantry and hot-meal program" },
];

async function main(): Promise<number> {
  const reg = loadRegistry();
  const m = await openMongo("divhacks-seed-registry");
  try {
    const db = m.db;
    let changed = 0;

    for (const key of Object.keys(reg.nonprofits) as NonprofitKey[]) {
      const np = reg.nonprofits[key];
      const existing = await db.collection<NonprofitDoc>(COLL.nonprofits).findOne({ ein: np.ein });
      const ex = existing?.wallet;
      const onboarded = await db.collection(COLL.onboarding).findOne({ ein: np.ein, wallet: np.address, status: "complete" });
      // Onboarded (same wallet): keep what onboarding wrote. Otherwise: no credential claimed here.
      const wallet: NonprofitDoc["wallet"] =
        onboarded && ex?.address === np.address ? ex : { address: np.address, credential_status: "none", bank_verified: false };
      const doc: NonprofitDoc = {
        ein: np.ein,
        name: np.name,
        address: NP_DETAILS[key].address,
        service_types: NP_DETAILS[key].service_types,
        wallet,
        is_demo_data: true,
      };
      const r = await db.collection<NonprofitDoc>(COLL.nonprofits).updateOne({ ein: np.ein }, { $set: doc }, { upsert: true });
      changed += r.upsertedCount + r.modifiedCount;
      console.log(
        `nonprofits  ${np.ein}  ${key}  ${np.address}  ${onboarded ? `onboarded: credential ${wallet!.credential_status} until ${wallet!.credential_expires ?? "?"}, bank_verified ${wallet!.bank_verified}` : "not onboarded: credential_status none"}  ` +
          `${r.upsertedCount ? "inserted" : r.modifiedCount ? "updated" : "unchanged"}`,
      );
    }

    for (const c of CONTRACTS) {
      const existing = await db.collection<ContractDoc>(COLL.contracts).findOne({ contract_id: c.contract_id });
      const doc: ContractDoc = {
        ...c,
        source: FIXTURE_SOURCE,
        source_url: FIXTURE_SOURCE_URL,
        // Keep an operator-adjusted budget on re-runs; set the default only on insert or when missing.
        xrpl_budget_rlusd: existing?.xrpl_budget_rlusd ?? DEFAULT_BUDGET,
        xrpl_budget_note: BUDGET_NOTE,
        is_demo_data: true,
      };
      const r = await db.collection<ContractDoc>(COLL.contracts).updateOne({ contract_id: c.contract_id }, { $set: doc }, { upsert: true });
      changed += r.upsertedCount + r.modifiedCount;
      console.log(`contracts   ${c.contract_id}  EIN ${c.nonprofit_ein}  xrpl_budget_rlusd ${doc.xrpl_budget_rlusd} (testnet stand-in)  ${r.upsertedCount ? "inserted" : r.modifiedCount ? "updated" : "unchanged"}`);
    }

    const idx = await ensureIndexes(db);
    console.log(`indexes     ${idx.join(", ")}`);
    const snap = await readRegistrySnapshot(db);
    console.log(`\nregistry snapshot (wallet mapping ein/name/address): ${snap.entries.length} wallets, sha256 ${snap.sha256} (a running co-signer compares against the snapshot it pinned at startup)`);
    console.log(`${changed} document(s) inserted or changed in db "${db.databaseName}"`);
    return 0;
  } finally {
    await m.close();
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("seed-registry failed:", e instanceof Error ? e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>") : e);
    process.exit(1);
  },
);
