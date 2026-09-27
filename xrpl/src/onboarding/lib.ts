// Pure onboarding helpers (no network): EIN-only matching against the nonprofits registry, and the micro-deposit
// commitment. Used by scripts/onboard-nonprofit.ts and unit-tested in scripts/test-checks.ts.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { EIN_RE } from "../lib/credentials";
import { normalizeForMatch } from "../nessie/client";
import type { NonprofitKey, Registry } from "../lib/registry";

export interface RegistryRecord {
  ein: string;
  name: string;
}

export type EinMatch<T extends RegistryRecord> =
  | { ok: true; ein: string; np_key: NonprofitKey | null; record: T; lookalikes_ignored: T[] }
  | { ok: false; why: string; lookalikes_ignored: T[] };

/** "np_2" -> its EIN (accounts.testnet.json); "00-0000002" or "000000002" -> "00-0000002"; anything else -> null. */
export function einFromArg(arg: string, reg: Pick<Registry, "nonprofits">): { ein: string; np_key: NonprofitKey | null } | null {
  const a = arg.trim();
  if (/^np_[1-9]\d*$/.test(a)) {
    const np = (reg.nonprofits as Record<string, { ein: string }>)[a];
    return np ? { ein: np.ein, np_key: a as NonprofitKey } : null;
  }
  const ein = /^\d{9}$/.test(a) ? `${a.slice(0, 2)}-${a.slice(2)}` : a;
  if (!EIN_RE.test(ein)) return null;
  const key = (Object.entries(reg.nonprofits) as [NonprofitKey, { ein: string }][]).find(([, n]) => n.ein === ein)?.[0] ?? null;
  return { ein, np_key: key };
}

/** Two names that a human could confuse (same normalized text, or one contains the other, or same first two words). */
export function namesLookAlike(a: string, b: string): boolean {
  const x = normalizeForMatch(a).replace(/\bdemo\b/g, "").trim();
  const y = normalizeForMatch(b).replace(/\bdemo\b/g, "").trim();
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const w = (s: string) => s.split(" ").slice(0, 2).join(" ");
  return w(x).length > 4 && w(x) === w(y);
}

/**
 * Matches ONLY on the EIN (exact, strict NN-NNNNNNN in ASCII digits). A name is never accepted as input and never used to
 * match; records whose names look like the target's but whose EIN differs are reported as ignored look-alikes.
 */
export function matchNonprofitByEin<T extends RegistryRecord>(records: readonly T[], arg: string, reg: Pick<Registry, "nonprofits">): EinMatch<T> {
  const parsed = einFromArg(arg, reg);
  if (!parsed) return { ok: false, why: `${JSON.stringify(arg)} is not np_N or an EIN (NN-NNNNNNN); organizations are matched by EIN only, never by name`, lookalikes_ignored: [] };
  const hits = records.filter((r) => r.ein === parsed.ein);
  if (hits.length !== 1) return { ok: false, why: hits.length ? `${hits.length} registry records share EIN ${parsed.ein}` : `no nonprofits record with EIN ${parsed.ein}`, lookalikes_ignored: [] };
  const record = hits[0];
  const lookalikes = records.filter((r) => r.ein !== parsed.ein && namesLookAlike(r.name, record.name));
  return { ok: true, ein: parsed.ein, np_key: parsed.np_key, record, lookalikes_ignored: lookalikes };
}

/** A two-amount micro-deposit (integers 1..99, "cents") with a salted commitment; the amounts themselves are not stored.
 *  Only 9,801 pairs exist, so the salt must stay away from the commitment: onboarding keeps it in the gitignored local
 *  bank file (src/onboarding/bankLocal.ts), never in Mongo next to commitment_sha256. */
export interface MicroDeposit {
  amounts: [number, number];
  /** Reference shown on the statement ("GlassLedger ACCTVERIFY <ref>"): lets the nonprofit find the two deposits. */
  ref: string;
  salt: string;
  commitment_sha256: string;
}

export function commitment(ein: string, ref: string, salt: string, amounts: readonly number[]): string {
  const sorted = [...amounts].sort((a, b) => a - b).join(",");
  return createHash("sha256").update(`${salt}|${ein}|${ref}|${sorted}`, "utf8").digest("hex");
}

export function newMicroDeposit(ein: string): MicroDeposit {
  const amounts: [number, number] = [randomInt(1, 100), randomInt(1, 100)];
  const ref = randomBytes(3).toString("hex").toUpperCase();
  const salt = randomBytes(16).toString("hex");
  return { amounts, ref, salt, commitment_sha256: commitment(ein, ref, salt, amounts) };
}

export function verifyMicroDeposit(md: Pick<MicroDeposit, "ref" | "salt" | "commitment_sha256">, ein: string, reported: readonly number[]): boolean {
  return reported.length === 2 && reported.every((n) => Number.isInteger(n) && n >= 1 && n <= 99) && commitment(ein, md.ref, md.salt, reported) === md.commitment_sha256;
}

export const depositDescription = (ref: string) => `GlassLedger ACCTVERIFY ${ref}`;
