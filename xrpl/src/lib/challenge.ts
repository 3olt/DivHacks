// Wallet-ownership challenge for onboarding: the city issues a one-time challenge {nonce, EIN, wallet, expiry}, stored
// SERVER-SIDE (Mongo `onboarding_challenges`); the nonprofit signs its exact text with the wallet's key; the city verifies
// the signature (ripple-keypairs verify), that deriveAddress(public_key) === wallet, that the challenge is unexpired, and
// consumes it atomically (status issued -> used), so a captured signature cannot be replayed.
import { randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import { verifyText } from "./signedMessage";

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const CHALLENGE_PREFIX = "GlassLedger wallet ownership challenge v1";

export interface Challenge {
  challenge_id: string;
  ein: string;
  wallet: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  /** The exact text the wallet key must sign (UTF-8). */
  message: string;
  status: "issued" | "used";
  used_at?: string;
  is_demo_data: boolean;
}

export interface ChallengeStore {
  insert(c: Challenge): Promise<void>;
  /** Atomically marks an ISSUED challenge used and returns it; null if unknown or already used. */
  consume(challenge_id: string, at: string): Promise<Challenge | null>;
  get(challenge_id: string): Promise<Challenge | null>;
}

export function challengeText(c: Pick<Challenge, "ein" | "wallet" | "nonce" | "expires_at" | "challenge_id">): string {
  return [CHALLENGE_PREFIX, `challenge: ${c.challenge_id}`, `ein: ${c.ein}`, `wallet: ${c.wallet}`, `nonce: ${c.nonce}`, `expires: ${c.expires_at}`].join("\n");
}

export async function issueChallenge(store: ChallengeStore, ein: string, wallet: string, now = Date.now(), ttlMs = CHALLENGE_TTL_MS): Promise<Challenge> {
  const base = {
    challenge_id: `chl_${randomBytes(8).toString("hex")}`,
    ein,
    wallet,
    nonce: randomBytes(32).toString("hex"),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
  const c: Challenge = { ...base, message: challengeText(base), status: "issued", is_demo_data: true };
  await store.insert(c);
  return c;
}

export type ChallengeVerdict = { ok: true; challenge: Challenge } | { ok: false; code: "unknown_challenge" | "replayed" | "expired" | "bad_signature" | "mismatch"; why: string };

/**
 * Verifies a signed challenge answer. The challenge is looked up server-side by id (the answer's text is never trusted),
 * its EIN and wallet must be the ones being onboarded, it must be unexpired, the signature must verify with a public key
 * that derives the wallet, and it is consumed atomically (a second use -> "replayed").
 */
export async function verifyChallenge(
  store: ChallengeStore,
  answer: { challenge_id: string; public_key: string; signature: string },
  expect: { ein: string; wallet: string },
  now = Date.now(),
): Promise<ChallengeVerdict> {
  const c = await store.get(answer.challenge_id);
  if (!c) return { ok: false, code: "unknown_challenge", why: `no challenge ${answer.challenge_id} was issued` };
  if (c.status === "used") return { ok: false, code: "replayed", why: `challenge ${c.challenge_id} was already used at ${c.used_at ?? "?"}` };
  if (c.ein !== expect.ein || c.wallet !== expect.wallet) return { ok: false, code: "mismatch", why: `challenge ${c.challenge_id} is for EIN ${c.ein} / ${c.wallet}, not ${expect.ein} / ${expect.wallet}` };
  if (!(Date.parse(c.expires_at) > now)) return { ok: false, code: "expired", why: `challenge ${c.challenge_id} expired at ${c.expires_at}` };
  const sig = verifyText(challengeText(c), answer.signature, answer.public_key, c.wallet);
  if (!sig.ok) return { ok: false, code: "bad_signature", why: sig.why ?? "signature does not verify" };
  const used = await store.consume(c.challenge_id, new Date(now).toISOString());
  if (!used) return { ok: false, code: "replayed", why: `challenge ${c.challenge_id} was consumed concurrently` };
  return { ok: true, challenge: used };
}

export const CHALLENGES = "onboarding_challenges";

export function mongoChallengeStore(db: Db): ChallengeStore {
  const coll = db.collection<Challenge>(CHALLENGES);
  return {
    async insert(c) {
      await coll.insertOne({ ...c });
    },
    async consume(id, at) {
      const r = await coll.findOneAndUpdate({ challenge_id: id, status: "issued" }, { $set: { status: "used", used_at: at } }, { returnDocument: "after", projection: { _id: 0 } });
      return (r as Challenge | null) ?? null;
    },
    async get(id) {
      return coll.findOne({ challenge_id: id }, { projection: { _id: 0 } });
    },
  };
}

export function memoryChallengeStore(): ChallengeStore {
  const m = new Map<string, Challenge>();
  return {
    async insert(c) {
      m.set(c.challenge_id, { ...c });
    },
    async consume(id, at) {
      const c = m.get(id);
      if (!c || c.status !== "issued") return null;
      c.status = "used";
      c.used_at = at;
      return { ...c };
    },
    async get(id) {
      const c = m.get(id);
      return c ? { ...c } : null;
    },
  };
}
