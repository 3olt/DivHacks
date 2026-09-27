// Where onboarding keeps what must NOT go into MongoDB (Phase 3 fixes): the Nessie ids (customer, account, deposits), which
// are tied to our Nessie API key, and the micro-deposit salt (with the salt, the 2 x 1..99 amounts behind the commitment
// could be brute-forced from 9,801 candidates). They live in a gitignored, city-side local file,
// xrpl/data/onboarding-bank.local.json, keyed by EIN; the Mongo `onboarding` record keeps only
// {provider, account_ref (HMAC-SHA256 of the account id under a per-EIN key from this file), micro_deposit {ref,
// commitment_sha256, ...}, verified, verified_at}. Nothing here is printed.
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import { paths } from "../env";

export const BANK_LOCAL_PATH = path.join(paths.dataDir, "onboarding-bank.local.json");

export interface BankLocal {
  provider: "nessie" | "stub";
  customer_id: string;
  account_id: string;
  /** Per-EIN key for account_ref (HMAC-SHA256), so the Mongo record reveals nothing about the account id. */
  ref_key: string;
  micro_deposit?: { ref: string; salt: string; deposit_ids: string[]; sent_at: string };
  updated_at: string;
}

export function readBankLocal(file = BANK_LOCAL_PATH): Record<string, BankLocal> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, BankLocal>;
  } catch {
    return {};
  }
}

export function writeBankLocal(ein: string, entry: BankLocal, file = BANK_LOCAL_PATH): void {
  const all = readBankLocal(file);
  all[ein] = entry;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const newRefKey = () => randomBytes(16).toString("hex");

/** What the Mongo record stores instead of the account id. */
export function accountRef(refKey: string, provider: string, accountId: string): string {
  return createHmac("sha256", refKey).update(`${provider}:${accountId}`, "utf8").digest("hex");
}

/** Moves Nessie ids and micro-deposit salts that an earlier build wrote into Mongo `onboarding` to the local file, then
 *  $unsets them in Mongo. Idempotent. Returns the EINs it migrated. */
export async function migrateBankIdsOutOfMongo(db: Db): Promise<string[]> {
  const coll = db.collection("onboarding");
  const docs = await coll
    .find({ $or: [{ "bank.customer_id": { $exists: true } }, { "bank.account_id": { $exists: true } }, { "bank.micro_deposit.deposit_ids": { $exists: true } }, { "bank.micro_deposit.salt": { $exists: true } }] }, { projection: { _id: 0, ein: 1, bank: 1 } })
    .toArray();
  const done: string[] = [];
  for (const d of docs) {
    const ein = String(d.ein);
    const b = (d.bank ?? {}) as { provider?: "nessie" | "stub"; customer_id?: string; account_id?: string; micro_deposit?: { ref?: string; salt?: string; deposit_ids?: string[]; sent_at?: string } };
    const prev = readBankLocal()[ein];
    const provider = b.provider ?? prev?.provider ?? "nessie";
    const entry: BankLocal = {
      provider,
      customer_id: b.customer_id ?? prev?.customer_id ?? "",
      account_id: b.account_id ?? prev?.account_id ?? "",
      ref_key: prev?.ref_key ?? newRefKey(),
      ...(b.micro_deposit?.salt || prev?.micro_deposit
        ? { micro_deposit: { ref: b.micro_deposit?.ref ?? prev?.micro_deposit?.ref ?? "", salt: b.micro_deposit?.salt ?? prev?.micro_deposit?.salt ?? "", deposit_ids: b.micro_deposit?.deposit_ids ?? prev?.micro_deposit?.deposit_ids ?? [], sent_at: b.micro_deposit?.sent_at ?? prev?.micro_deposit?.sent_at ?? "" } }
        : {}),
      updated_at: new Date().toISOString(),
    };
    writeBankLocal(ein, entry); // written BEFORE anything is removed from Mongo
    await coll.updateOne(
      { ein },
      {
        $unset: { "bank.customer_id": "", "bank.account_id": "", "bank.micro_deposit.deposit_ids": "", "bank.micro_deposit.salt": "" },
        $set: { "bank.account_ref": entry.account_id ? accountRef(entry.ref_key, provider, entry.account_id) : null, "bank.ids_location": "xrpl/data/onboarding-bank.local.json (gitignored, city side)" },
      },
    );
    done.push(ein);
  }
  return done;
}
