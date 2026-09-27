// Seeds the 4 DEMO sites (fixture site_001..site_004 = the fictional demo nonprofits np_1..np_4) into Mongo `sites`, so
// every XRPL demo scenario lands on a pin in mongo mode. Idempotent: upsert by id, fixture risk restored, is_demo_data true.
// It never touches the 15 real sites (data/ingest.py owns them) and refuses to overwrite a real site with a demo id.
//   npm run seed:demo-sites -w api        (MONGODB_URI / MONGODB_DB from the root .env)
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { demoSiteDocs, readAccounts } from "../src/demoSites";
import { scrub } from "../src/lib/python";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../.env"), quiet: true });

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set (root .env)");
  const accounts = readAccounts();
  const docs = demoSiteDocs(accounts);
  const client = new MongoClient(uri, { appName: "divhacks-seed-demo-sites", serverSelectionTimeoutMS: 10000 });
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DB ?? "divhacks");
    const sites = db.collection("sites");
    await sites.createIndex({ id: 1 }, { unique: true, name: "id_unique" });
    await sites.createIndex({ location: "2dsphere" }, { name: "location_2dsphere" });
    for (const doc of docs) {
      const existing = await sites.findOne({ id: doc.id }, { projection: { is_demo_data: 1 } });
      if (existing && existing.is_demo_data === false) throw new Error(`${doc.id} exists as a REAL site; refusing to overwrite it`);
      // Every contract listed must exist (xrpl seed-registry writes the demo contracts) and belong to this EIN.
      for (const cid of doc.contract_ids) {
        const c = await db.collection("contracts").findOne({ contract_id: cid }, { projection: { nonprofit_ein: 1, is_demo_data: 1 } });
        if (!c) console.warn(`  WARN ${doc.id}: contract ${cid} is not in Mongo yet (run npm run seed:registry)`);
        else if (c.nonprofit_ein !== doc.nonprofit_ein || c.is_demo_data !== true) throw new Error(`${doc.id}: contract ${cid} is not a demo contract of ${doc.nonprofit_ein}`);
      }
      const r = await sites.updateOne({ id: doc.id }, { $set: { ...doc, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") } }, { upsert: true });
      console.log(`${r.upsertedCount ? "inserted" : "updated "} ${doc.id}  ${doc.name}  [${doc.demo_wallet_key}, ${doc.nonprofit_ein}, ${doc.contract_ids.join(", ")}]  risk ${doc.risk.level} ${doc.risk.score}`);
    }
    const [real, demo] = await Promise.all([sites.countDocuments({ is_demo_data: false }), sites.countDocuments({ is_demo_data: true })]);
    console.log(`sites: ${real} real + ${demo} demo`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`seed-demo-sites failed: ${scrub((e as Error).message)}`);
  process.exit(1);
});
