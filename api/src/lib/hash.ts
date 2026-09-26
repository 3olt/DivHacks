// The decision hash (dh) and memo hash definitions live in shared/hash.ts so that api/ and xrpl/ can never
// disagree. decision_hash = SHA-256 of the canonical JSON of ONLY the pre-signing fields (DECISION_HASH_FIELDS);
// memo_hash = SHA-256 of the on-ledger MemoData JSON string {inv, ctr, ein, dh, rv}.
export {
  canonicalJson,
  computeDecisionHash,
  DECISION_HASH_FIELDS,
  MEMO_FORMAT,
  MEMO_TYPE,
  memoHash,
  memoJson,
  sha256Hex,
} from "../../../shared/hash";

/**
 * Obviously fake 64-hex transaction hash for fixtures: "00000000FA15E" + zero padding + n in hex.
 * These do NOT exist on any ledger.
 */
export function fakeTxHash(n: number): string {
  const tail = n.toString(16).toUpperCase();
  return `00000000FA15E${tail.padStart(64 - 13, "0")}`;
}
