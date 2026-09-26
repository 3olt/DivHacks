// The payee registry in MongoDB (nonprofits with a wallet), as a canonical, hashable snapshot.
// The co-signer reads it ONCE at startup and pins it (the hash is logged); on every /cosign it re-reads the collection
// and refuses (registry_drift) if the content no longer matches the pinned snapshot. The agent process has the same
// database credentials in this hackathon setup, so a change while the co-signer runs is treated as possible tampering.
// (Production: the co-signer's DB user is one the agent cannot write, and Phase 3 moves credentials on-ledger.)
import type { Db } from "mongodb";
import { canonicalJson, sha256Hex } from "../../../shared/hash";
import { COLL, type NonprofitDoc } from "./mongo";

export interface RegistryEntry {
  ein: string;
  name: string;
  address: string;
  credential_status: string;
  credential_expires: string | null;
  bank_verified: boolean;
}

export interface RegistrySnapshot {
  entries: RegistryEntry[];
  sha256: string;
  read_at: string;
  byEin: Map<string, RegistryEntry>;
  byAddress: Map<string, RegistryEntry>;
}

export async function readRegistrySnapshot(db: Db): Promise<RegistrySnapshot> {
  const docs = await db
    .collection<NonprofitDoc>(COLL.nonprofits)
    .find({ "wallet.address": { $exists: true } }, { projection: { _id: 0, ein: 1, name: 1, wallet: 1 } })
    .toArray();
  const entries: RegistryEntry[] = docs
    .map((d) => ({
      ein: String(d.ein),
      name: String(d.name),
      address: String(d.wallet?.address ?? ""),
      credential_status: String(d.wallet?.credential_status ?? "none"),
      credential_expires: d.wallet?.credential_expires ?? null,
      bank_verified: d.wallet?.bank_verified === true,
    }))
    .sort((a, b) => (a.ein < b.ein ? -1 : a.ein > b.ein ? 1 : 0));
  return {
    entries,
    sha256: sha256Hex(canonicalJson(entries)),
    read_at: new Date().toISOString(),
    byEin: new Map(entries.map((e) => [e.ein, e])),
    byAddress: new Map(entries.map((e) => [e.address, e])),
  };
}
