// Payee change holds (address-swap guardrail) and the officer's signed resolution.
//
// A "we changed our bank details" request lands in Mongo `payee_change_requests` with status "on_hold" (xrpl service,
// POST /payees/:ein/change-request). The CO-SIGNER enforces the hold, and it does not trust the database for it:
//   - HoldBook keeps its own STICKY, APPEND-ONLY record of every hold it has seen (xrpl/data/cosigner-holds.local.jsonl,
//     gitignored). A hold it saw stays active even if the document is later deleted or its status edited.
//   - A hold is lifted ONLY by an officer-signed resolution {type, request_id, ein, requested_address, decision, ts}
//     whose signature verifies with a public key that derives signers.officer.address (pinned accounts.testnet.json),
//     and whose request_id / EIN / requested_address match what the co-signer itself recorded when it first saw the hold.
//   - "reject" closes the request (registry unchanged) -> hold lifted.
//     "approve" records the decision; payments to the EIN stay frozen until the requested wallet has completed onboarding
//     (the registry the co-signer pinned at startup shows it) and hold_until has passed.
// The agent process can write the database, but it cannot produce the officer's signature, so it cannot lift a hold.
import fs from "node:fs";
import { isValidClassicAddress, type Wallet } from "xrpl";
import type { Db } from "mongodb";
import type { PayeeChangeRequest, PayeeChangeResolution } from "../../../shared/contracts";
import { canonicalText, signText, verifyText } from "./signedMessage";
import { EIN_RE } from "./credentials";

export const PAYEE_CHANGE_REQUESTS = "payee_change_requests";
export const RESOLUTION_TYPE = "divhacks/payee-change-resolution/v1" as const;
/** An officer resolution may not be dated more than this far in the future (clock skew). */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export type ResolutionCore = Pick<PayeeChangeResolution, "type" | "request_id" | "ein" | "requested_address" | "decision" | "ts">;

/** The exact text the officer signs: canonical JSON (sorted keys) of the resolution core. */
export function resolutionText(r: ResolutionCore): string {
  return canonicalText({ type: r.type, request_id: r.request_id, ein: r.ein, requested_address: r.requested_address, decision: r.decision, ts: r.ts });
}

/** Officer side: signs a resolution with the officer signer key. */
export function signResolution(core: Omit<ResolutionCore, "type">, officer: Wallet): PayeeChangeResolution {
  const full: ResolutionCore = { type: RESOLUTION_TYPE, ...core };
  const s = signText(officer, resolutionText(full));
  return { ...full, signer: officer.address, public_key: s.public_key, signature: s.signature };
}

/** What the co-signer recorded about a hold when it first saw it. */
export interface HoldSeen {
  request_id: string;
  ein: string;
  current_address: string;
  requested_address: string;
  created_at: string;
  hold_until: string;
}

/** Verifies an officer resolution against the hold as the verifier recorded it (never against the database's copy). */
export function verifyResolution(res: unknown, hold: HoldSeen, officerAddress: string, nowMs = Date.now()): { ok: boolean; why: string | null } {
  const r = res as Partial<PayeeChangeResolution> | null;
  if (!r || typeof r !== "object") return { ok: false, why: "no resolution object" };
  if (r.type !== RESOLUTION_TYPE) return { ok: false, why: `resolution type ${JSON.stringify(r.type)} is not ${RESOLUTION_TYPE}` };
  if (r.request_id !== hold.request_id) return { ok: false, why: `resolution is for request ${JSON.stringify(r.request_id)}, not ${hold.request_id}` };
  if (r.ein !== hold.ein) return { ok: false, why: `resolution names EIN ${JSON.stringify(r.ein)}, the hold is for ${hold.ein}` };
  if (r.requested_address !== hold.requested_address) return { ok: false, why: `resolution names wallet ${JSON.stringify(r.requested_address)}, the hold requested ${hold.requested_address}` };
  if (r.decision !== "approve" && r.decision !== "reject") return { ok: false, why: `decision ${JSON.stringify(r.decision)} is not approve|reject` };
  const ts = typeof r.ts === "string" ? Date.parse(r.ts) : NaN;
  if (!Number.isFinite(ts)) return { ok: false, why: "resolution ts is not a date" };
  if (ts > nowMs + MAX_FUTURE_SKEW_MS) return { ok: false, why: `resolution is dated in the future (${r.ts})` };
  if (ts < Date.parse(hold.created_at) - MAX_FUTURE_SKEW_MS) return { ok: false, why: `resolution (${r.ts}) predates the request (${hold.created_at})` };
  if (r.signer !== officerAddress) return { ok: false, why: `resolution signer ${JSON.stringify(r.signer)} is not the officer ${officerAddress}` };
  const v = verifyText(resolutionText(r as ResolutionCore), String(r.signature ?? ""), String(r.public_key ?? ""), officerAddress);
  return v.ok ? { ok: true, why: null } : { ok: false, why: `officer signature invalid: ${v.why}` };
}

export interface ActiveHold extends HoldSeen {
  state: "on_hold" | "approved_pending_reonboarding";
  /** How the database copy looks now (for the check detail), e.g. "on_hold", "missing", "rejected (no valid officer signature)". */
  db_status: string;
}

type HoldEvent =
  | ({ type: "seen"; at: string } & HoldSeen)
  | { type: "resolved"; at: string; request_id: string; resolution: PayeeChangeResolution };

interface HoldState {
  seen: HoldSeen;
  seen_at: string;
  resolution: PayeeChangeResolution | null;
  db_status: string;
}

/** Shape check for a request document; only well-formed documents can create a hold. */
function holdFromDoc(d: Partial<PayeeChangeRequest>): HoldSeen | null {
  if (typeof d.request_id !== "string" || !REQUEST_ID_RE.test(d.request_id)) return null;
  if (typeof d.ein !== "string" || !EIN_RE.test(d.ein)) return null;
  if (typeof d.requested_address !== "string" || !isValidClassicAddress(d.requested_address)) return null;
  if (typeof d.created_at !== "string" || !Number.isFinite(Date.parse(d.created_at))) return null;
  return {
    request_id: d.request_id,
    ein: d.ein,
    current_address: typeof d.current_address === "string" ? d.current_address : "",
    requested_address: d.requested_address,
    created_at: d.created_at,
    hold_until: typeof d.hold_until === "string" ? d.hold_until : d.created_at,
  };
}

export class HoldBook {
  private holds = new Map<string, HoldState>();
  readonly problems: string[] = [];

  /** @param file the sticky append-only record (null = in memory only, e.g. the agent's audit). */
  constructor(private file: string | null, private officerAddress: string) {
    if (file && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
        try {
          this.apply(JSON.parse(line) as HoldEvent);
        } catch {
          this.problems.push(`unreadable line in ${file}`);
        }
      }
    }
  }

  private apply(e: HoldEvent) {
    if (e.type === "seen") {
      if (!this.holds.has(e.request_id)) {
        const { type: _t, at, ...seen } = e;
        this.holds.set(e.request_id, { seen, seen_at: at, resolution: null, db_status: "unknown (not re-read yet)" });
      }
    } else if (e.type === "resolved") {
      const h = this.holds.get(e.request_id);
      // Re-verified on load: an edited file line cannot lift a hold without the officer's signature.
      if (h && !h.resolution && verifyResolution(e.resolution, h.seen, this.officerAddress, Date.now()).ok) h.resolution = e.resolution;
    }
  }

  private append(e: HoldEvent) {
    this.apply(e);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(e) + "\n");
  }

  /** Reads every change request in the database: records holds not seen before, and verified officer resolutions. */
  async refresh(db: Db, nowMs = Date.now()): Promise<void> {
    const docs = (await db.collection(PAYEE_CHANGE_REQUESTS).find({}, { projection: { _id: 0 } }).toArray()) as Partial<PayeeChangeRequest>[];
    const inDb = new Set<string>();
    for (const d of docs) {
      const seen = holdFromDoc(d);
      if (!seen) continue;
      inDb.add(seen.request_id);
      if (!this.holds.has(seen.request_id)) {
        // First sight. A request that is already "resolved" in the database is still recorded as a hold: only a valid
        // officer signature (checked next) resolves it.
        this.append({ type: "seen", at: new Date(nowMs).toISOString(), ...seen });
      }
      const h = this.holds.get(seen.request_id)!;
      if (!h.resolution && d.resolution) {
        const v = verifyResolution(d.resolution, h.seen, this.officerAddress, nowMs);
        if (v.ok) this.append({ type: "resolved", at: new Date(nowMs).toISOString(), request_id: seen.request_id, resolution: d.resolution });
        h.db_status = v.ok ? String(d.status) : `${String(d.status)} (resolution rejected: ${v.why})`;
      } else {
        h.db_status = h.resolution ? String(d.status) : d.status === "on_hold" ? "on_hold" : `${String(d.status)} (no valid officer signature)`;
      }
      if (seen.ein !== h.seen.ein || seen.requested_address !== h.seen.requested_address) h.db_status += `; database copy was edited (now EIN ${seen.ein}, wallet ${seen.requested_address})`;
    }
    for (const [id, h] of this.holds) if (!inDb.has(id)) h.db_status = "missing from the database (deleted or made unreadable)";
  }

  /** Accepts a resolution delivered directly (e.g. POST /holds/resolution). The hold must have been seen first. */
  accept(res: unknown, nowMs = Date.now()): { ok: boolean; why: string | null; request_id?: string } {
    const id = (res as { request_id?: unknown } | null)?.request_id;
    const h = typeof id === "string" ? this.holds.get(id) : undefined;
    if (!h) return { ok: false, why: `no hold ${JSON.stringify(id)} is known to this co-signer (refresh first)` };
    if (h.resolution) return { ok: true, why: "already resolved", request_id: h.seen.request_id };
    const v = verifyResolution(res, h.seen, this.officerAddress, nowMs);
    if (!v.ok) return { ...v, request_id: h.seen.request_id };
    this.append({ type: "resolved", at: new Date(nowMs).toISOString(), request_id: h.seen.request_id, resolution: res as PayeeChangeResolution });
    return { ok: true, why: null, request_id: h.seen.request_id };
  }

  /**
   * Holds still in force. Rejected -> lifted. Approved -> in force until `registryAddress(ein)` (the registry the
   * co-signer pinned at startup) shows the requested wallet and hold_until has passed.
   */
  active(nowMs = Date.now(), registryAddress?: (ein: string) => string | undefined): ActiveHold[] {
    const out: ActiveHold[] = [];
    for (const h of this.holds.values()) {
      const r = h.resolution;
      if (r?.decision === "reject") continue;
      if (r?.decision === "approve") {
        const done = registryAddress?.(h.seen.ein) === h.seen.requested_address && Date.parse(h.seen.hold_until) <= nowMs;
        if (done) continue;
        out.push({ ...h.seen, state: "approved_pending_reonboarding", db_status: h.db_status });
        continue;
      }
      out.push({ ...h.seen, state: "on_hold", db_status: h.db_status });
    }
    return out;
  }

  /** Every hold this book knows, with its resolution (for GET /holds). */
  list(): (HoldSeen & { seen_at: string; resolution: string | null; db_status: string })[] {
    return [...this.holds.values()].map((h) => ({
      ...h.seen,
      seen_at: h.seen_at, resolution: h.resolution ? `${h.resolution.decision} by officer at ${h.resolution.ts} (signature verified)` : null, db_status: h.db_status,
    }));
  }

  get size(): number {
    return this.holds.size;
  }
}

/** One-line description of an active hold for check details. */
export function describeHold(h: ActiveHold): string {
  const what = h.state === "on_hold" ? "on hold" : "approved by the officer but the new wallet has not completed onboarding";
  return `payee change request ${h.request_id} for EIN ${h.ein} (requested wallet ${h.requested_address}, created ${h.created_at}, hold until ${h.hold_until}) is ${what}; database copy: ${h.db_status}`;
}
