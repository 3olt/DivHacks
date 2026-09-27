// Officer side of a payee change request: sign {type, request_id, ein, requested_address, decision, ts} with the OFFICER
// signer key (weight 1 on agent_account; loaded only by an officer process via loadEnv("officer")), record it on the
// request, and deliver it to the co-signer, which verifies the signature itself before lifting anything.
//   reject  -> status "rejected": request closed, registry unchanged, hold lifted once the co-signer verifies it
//   approve -> status "approved_pending_reonboarding": decision recorded; the requested wallet must still complete
//              onboarding (Nessie re-confirmation + signed challenge + on-ledger credential) before the registry changes,
//              and payments to the EIN stay frozen until then
// Used by scripts/officer-resolve.ts (CLI). The officer HTTP service (OFFICER_URL, :4004) can call resolvePayeeChange().
import type { Wallet } from "xrpl";
import type { Db } from "mongodb";
import type { PayeeChangeRequest, PayeeChangeResolution } from "../../../shared/contracts";
import { COLL } from "../lib/mongo";
import { signResolution, verifyResolution } from "../lib/holds";

export type ResolveOutcome =
  | {
      ok: true;
      request: PayeeChangeRequest;
      resolution: PayeeChangeResolution;
      message: string;
      cosigner: { delivered: boolean; status: number | null; message: string | null };
    }
  | { ok: false; status: 400 | 404 | 409; error: string; message: string };

export async function resolvePayeeChange(db: Db, officer: Wallet, request_id: string, decision: "approve" | "reject", cosignerUrl?: string): Promise<ResolveOutcome> {
  if (decision !== "approve" && decision !== "reject") return { ok: false, status: 400, error: "bad_request", message: "decision must be approve or reject" };
  const coll = db.collection<PayeeChangeRequest>(COLL.payeeChangeRequests);
  let req: PayeeChangeRequest | null = await coll.findOne({ request_id }, { projection: { _id: 0 } });
  if (!req && cosignerUrl) {
    // The database copy is gone (e.g. deleted by a compromised agent) but the co-signer still enforces the hold from its
    // own record: take the details from there, so the officer can still resolve it, and restore the document.
    const seen = await fetch(`${cosignerUrl.replace(/\/$/, "")}/holds`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json() as Promise<{ holds?: (Pick<PayeeChangeRequest, "request_id" | "ein" | "current_address" | "requested_address" | "created_at" | "hold_until">)[] }>)
      .then((j) => j.holds?.find((h) => h.request_id === request_id))
      .catch(() => undefined);
    if (seen) {
      const restored: PayeeChangeRequest = {
        request_id, ein: seen.ein, current_address: seen.current_address, requested_address: seen.requested_address,
        reason: "(restored from the co-signer's hold record: the database copy was missing)", contact: "(unknown)", status: "on_hold",
        created_at: seen.created_at, hold_until: seen.hold_until, requires: { nessie_reconfirmed: false, officer_approved: false }, is_demo_data: true,
      };
      await coll.insertOne({ ...restored });
      req = restored;
    }
  }
  if (!req) return { ok: false, status: 404, error: "not_found", message: `no payee change request ${request_id} (in the database or the co-signer's hold record)` };
  // Already carries a VALID officer resolution? Then it is closed. (A status edited without a valid signature is not.)
  if (req.resolution && verifyResolution(req.resolution, req, officer.address).ok) {
    return { ok: false, status: 409, error: "already_resolved", message: `request ${request_id} was already resolved: ${req.resolution.decision} at ${req.resolution.ts}` };
  }
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const resolution = signResolution({ request_id, ein: req.ein, requested_address: req.requested_address, decision, ts }, officer);
  const status: PayeeChangeRequest["status"] = decision === "reject" ? "rejected" : "approved_pending_reonboarding";
  const message =
    decision === "reject"
      ? `request closed, registry unchanged (EIN ${req.ein} stays at ${req.current_address})`
      : `resolution recorded, re-onboarding required: ${req.requested_address} must pass Nessie re-confirmation, the signed wallet challenge and receive an on-ledger credential before the registry changes; payments to EIN ${req.ein} stay frozen until then (and at least until ${req.hold_until})`;
  await coll.updateOne({ request_id }, { $set: { status, resolution, "requires.officer_approved": decision === "approve", resolution_note: message } });
  const updated = (await coll.findOne({ request_id }, { projection: { _id: 0 } }))!;

  let cos: { delivered: boolean; status: number | null; message: string | null } = { delivered: false, status: null, message: "no co-signer URL given; it picks the resolution up from the database" };
  if (cosignerUrl) {
    try {
      const r = await fetch(`${cosignerUrl.replace(/\/$/, "")}/holds/resolution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution }),
        signal: AbortSignal.timeout(10000),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; note?: string };
      cos = { delivered: r.ok && j.ok === true, status: r.status, message: j.message ?? j.note ?? null };
    } catch (e) {
      cos = { delivered: false, status: null, message: `co-signer not reachable (${(e as Error).message}); it picks the resolution up from the database when it next reads it` };
    }
  }
  return { ok: true, request: updated, resolution, message, cosigner: cos };
}
