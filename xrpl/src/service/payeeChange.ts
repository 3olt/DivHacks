// POST /payees/:ein/change-request: a payee asks to be paid at a different wallet ("we changed our bank details").
// This NEVER changes the registry. It records a PayeeChangeRequest with status "on_hold" (hold_until = now + HOLD_HOURS);
// the co-signer records the hold in its own sticky log and refuses every payment to that EIN (payee_change_on_hold) until
// an officer-signed resolution arrives. Shared by the xrpl service and the demo.
import { randomBytes } from "node:crypto";
import { isValidClassicAddress } from "xrpl";
import type { Db } from "mongodb";
import type { PayeeChangeRequest } from "../../../shared/contracts";
import { COLL, type NonprofitDoc } from "../lib/mongo";
import { EIN_RE } from "../lib/credentials";
import { utcStamp } from "../agent/decision";

export type ChangeRequestResult =
  | { ok: true; status: 202; request: PayeeChangeRequest }
  | { ok: false; status: 400 | 404; error: string; message: string };

export function holdHours(): number {
  const h = Number(process.env.HOLD_HOURS ?? "72");
  return h > 0 ? h : 72;
}

export async function createPayeeChangeRequest(db: Db, ein: string, body: unknown, hours = holdHours(), now = new Date()): Promise<ChangeRequestResult> {
  const b = (body ?? {}) as { new_address?: unknown; reason?: unknown; contact?: unknown };
  const bad = (message: string): ChangeRequestResult => ({ ok: false, status: 400, error: "bad_request", message });
  if (!EIN_RE.test(ein)) return bad("ein must be NN-NNNNNNN");
  if (typeof b.new_address !== "string" || !isValidClassicAddress(b.new_address)) return bad("new_address must be an XRPL classic address");
  if (typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 500) return bad("reason must be a non-empty string (<= 500 chars)");
  if (typeof b.contact !== "string" || !b.contact.trim() || b.contact.length > 200) return bad("contact must be a non-empty string (<= 200 chars): an organizational contact, not a person's private data");
  const np = await db.collection<NonprofitDoc>(COLL.nonprofits).findOne({ ein, "wallet.address": { $exists: true } }, { projection: { _id: 0 } });
  if (!np?.wallet?.address) return { ok: false, status: 404, error: "payee_not_found", message: `no registry wallet for EIN ${ein}` };
  if (b.new_address === np.wallet.address) return bad(`new_address is already the registry wallet for EIN ${ein}`);
  const request: PayeeChangeRequest = {
    request_id: `pcr_${utcStamp(now)}${randomBytes(3).toString("hex")}`,
    ein,
    current_address: np.wallet.address,
    requested_address: b.new_address,
    reason: b.reason.trim(),
    contact: b.contact.trim(),
    status: "on_hold",
    created_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    hold_until: new Date(now.getTime() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    requires: { nessie_reconfirmed: false, officer_approved: false },
    is_demo_data: true,
  };
  await db.collection<PayeeChangeRequest>(COLL.payeeChangeRequests).insertOne({ ...request });
  return { ok: true, status: 202, request };
}

export async function listPayeeChangeRequests(db: Db, ein?: string): Promise<PayeeChangeRequest[]> {
  return db
    .collection<PayeeChangeRequest>(COLL.payeeChangeRequests)
    .find(ein ? { ein } : {}, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .limit(100)
    .toArray();
}

/** Best effort: ask the co-signer to record the new hold now (it also polls every 5 s and re-reads on every /cosign). */
export async function notifyCosignerOfHold(cosignerUrl: string): Promise<{ recorded: boolean; active: number | null; message?: string }> {
  try {
    const r = await fetch(`${cosignerUrl.replace(/\/$/, "")}/holds/refresh`, { method: "POST", signal: AbortSignal.timeout(5000) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; active?: unknown[] };
    return { recorded: r.ok && j.ok === true, active: Array.isArray(j.active) ? j.active.length : null };
  } catch (e) {
    return { recorded: false, active: null, message: `co-signer not reachable (${(e as Error).message}); it records the hold when it next reads the database` };
  }
}
