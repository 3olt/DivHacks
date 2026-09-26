// MongoDB (Atlas) access for xrpl/. Database: MONGODB_DB or "divhacks"; connection string: MONGODB_URI (root .env,
// never printed). Collections used here:
//   nonprofits  Nonprofit shape (+ is_demo_data)                  written by scripts/seed-registry.ts; the co-signer pins a snapshot
//   contracts   Contract shape + xrpl_budget_rlusd + is_demo_data  written by seed-registry / the over-contract demo; the co-signer pins its terms at startup (read-only)
//   decisions   Decision shape + is_demo_data + audit {...}        written by the AGENT process for every attempt (the co-signer never reads it)
//   payments    Payment shape (source "xrpl")                      written by the AGENT process for every attempt
import { MongoClient, type Db } from "mongodb";
import type { Contract, Nonprofit } from "../../../shared/contracts";

export const COLL = {
  nonprofits: "nonprofits",
  contracts: "contracts",
  decisions: "decisions",
  payments: "payments",
} as const;

/**
 * A contract as the xrpl side stores it: the shared Contract shape plus
 * xrpl_budget_rlusd: a TESTNET-SCALE STAND-IN for the contract's remaining balance (decimal string, RLUSD). The real
 * contract amount is USD (`amount`); Testnet RLUSD is scarce, so the co-signer's within_contract_amount check compares
 * on-ledger RLUSD paid under the contract against this stand-in, not against `amount`.
 */
export interface ContractDoc extends Contract {
  xrpl_budget_rlusd: string;
  xrpl_budget_note?: string;
  is_demo_data: boolean;
}

export type NonprofitDoc = Nonprofit & { is_demo_data: boolean };

export function mongoUri(): string {
  const uri = process.env.MONGODB_URI ?? "";
  if (!uri) throw new Error("MONGODB_URI missing from the root .env");
  return uri;
}

export function mongoDbName(): string {
  return process.env.MONGODB_DB ?? "divhacks";
}

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  close: () => Promise<void>;
}

/** Connects (fails within ~10 s if Atlas is unreachable). The URI is never logged. */
export async function openMongo(appName: string): Promise<MongoHandle> {
  const client = new MongoClient(mongoUri(), { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, appName });
  await client.connect();
  const db = client.db(mongoDbName());
  return { client, db, close: () => client.close() };
}

/** Idempotent. decisions.decision_id unique, decisions.invoice_id, decisions.created_at, payments.payment_id unique, ... */
export async function ensureIndexes(db: Db): Promise<string[]> {
  const made: string[] = [];
  made.push(`${COLL.decisions}.` + (await db.collection(COLL.decisions).createIndex({ decision_id: 1 }, { unique: true, name: "decision_id_unique" })));
  made.push(`${COLL.decisions}.` + (await db.collection(COLL.decisions).createIndex({ invoice_id: 1 }, { name: "invoice_id" })));
  made.push(`${COLL.decisions}.` + (await db.collection(COLL.decisions).createIndex({ created_at: -1 }, { name: "created_at_desc" })));
  made.push(`${COLL.payments}.` + (await db.collection(COLL.payments).createIndex({ payment_id: 1 }, { unique: true, name: "payment_id_unique" })));
  made.push(`${COLL.payments}.` + (await db.collection(COLL.payments).createIndex({ contract_id: 1, date: 1 }, { name: "contract_date" })));
  made.push(`${COLL.nonprofits}.` + (await db.collection(COLL.nonprofits).createIndex({ ein: 1 }, { unique: true, name: "ein_unique" })));
  made.push(`${COLL.contracts}.` + (await db.collection(COLL.contracts).createIndex({ contract_id: 1 }, { unique: true, name: "contract_id_unique" })));
  return made;
}

export async function findContract(db: Db, contract_id: string): Promise<ContractDoc | null> {
  return db.collection<ContractDoc>(COLL.contracts).findOne({ contract_id }, { projection: { _id: 0 } });
}

export async function findNonprofit(db: Db, ein: string): Promise<NonprofitDoc | null> {
  return db.collection<NonprofitDoc>(COLL.nonprofits).findOne({ ein }, { projection: { _id: 0 } });
}
