// Invoice ids: one canonical spelling on-ledger, and a spelling-insensitive key for "already paid?".
//
// canonical form (what the builder writes into memo `inv`, and the only form the co-signer accepts):
//   NFKC, upper-case, every run of characters outside [A-Z0-9] becomes ONE "-", no leading/trailing "-",
//   1..64 chars, ASCII only. "inv-p2-20260926-201600." -> "INV-P2-20260926-201600".
//   Anything that still has non-ASCII characters after NFKC + upper-casing (e.g. a Cyrillic look-alike letter) has no
//   canonical form and is refused.
// duplicate key: the canonical form with the dashes removed, so "INV-P2-1", "INV P2 1", "inv_p2.1" and "INVP21" are
//   the same invoice. Keys are scoped by payee EIN by the caller (two nonprofits may both use "INV-0001").
//   Folding more aggressively only ever causes false REFUSALS (a human can review those), never a double payment.
export const MAX_INVOICE_ID_LEN = 64;
export const CANONICAL_INVOICE_ID_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export function canonicalInvoiceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const up = raw.normalize("NFKC").toUpperCase();
  if (!/^[\x20-\x7E]*$/.test(up)) return null;
  const c = up.replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return c.length > 0 && c.length <= MAX_INVOICE_ID_LEN && CANONICAL_INVOICE_ID_RE.test(c) ? c : null;
}

export const isCanonicalInvoiceId = (s: unknown): s is string => typeof s === "string" && canonicalInvoiceId(s) === s;

/** Spelling-insensitive duplicate key (canonical form without dashes), or null if the id has no canonical form. */
export function invoiceKey(raw: unknown): string | null {
  const c = canonicalInvoiceId(raw);
  return c ? c.replace(/-/g, "") : null;
}
