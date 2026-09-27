// SIMULATED milestone escrow (Phase 3, builder B). PURE: no keys, no network.
//
// RLUSD escrow is impossible on Testnet (EscrowCreate -> tecNO_PERMISSION: the RLUSD issuer lacks lsfAllowTrustLineLocking;
// only Ripple can change that). What we cannot do, we SIMULATE, and label it everywhere:
//   "simulated escrow (test token, not RLUSD)": the escrowed asset is CTT, a City Test Token issued by our own city_issuer
//   (AccountSet SetFlag 17 asfAllowTrustLineLocking). The mechanics are the real XLS-85 TokenEscrow on Testnet.
//
// Flow: the co-signer issues a PREIMAGE-SHA-256 condition per milestone (it keeps the preimage in its own file, never in
// Mongo, logs or responses) -> EscrowCreate from agent_account (agent + co-signer multisig; this module's
// checkEscrowCreate) -> the milestone report goes through the Grok verifier + payment builder (agent side) -> the OFFICER
// approves the release (a signed MilestoneReleaseApproval bound to the on-ledger escrow, delivered by the officer service
// to the co-signer) -> the co-signer reveals the fulfillment ONLY inside an EscrowFinish it co-signs, and only while it
// holds a valid, unused officer approval for that escrow and agent_account's signer list is CANONICAL (checkEscrowFinish)
// -> tesSUCCESS. EscrowCancel after CancelAfter returns the tokens to agent_account (checkEscrowCancel).
// Once revealed, a fulfillment can be used by anyone (XRPL lets any account submit an EscrowFinish), which is why the
// co-signer gates the reveal on the officer's approval and refuses it while the kill switch is engaged.
import crypto from "node:crypto";
import type { Wallet } from "xrpl";
import type { Check, MilestoneReleaseApproval, RefusalCode } from "../../../shared/contracts";
import { canonicalText, signText, verifyText } from "./signedMessage";
import { verifySigners, AMOUNT_RE, MAX_LLS_AHEAD } from "../cosigner/checks";
import { credentialProblems, rippleToIso, type CredentialFacts } from "./credentials";
import { describeHold, type ActiveHold } from "./holds";
import type { RegistrySnapshot } from "./registrySnapshot";
import type { ContractView } from "./contractPins";
import type { ExclusionEntry } from "./registry";
import { fromHex, toHex } from "./xrpl";
import { CTT_CURRENCY } from "./governance";
import { isCanonicalInvoiceId } from "./invoiceId";

export const ESCROW_RULE_VERSION = "p3-escrow-2";
export const SIMULATED_ESCROW_LABEL = "simulated escrow (test token, not RLUSD)" as const;
export const ESCROW_MEMO_TYPE = "divhacks/escrow/v1";
export const ESCROW_MEMO_FORMAT = "application/json";
/** CancelAfter must be between 1 h and 72 h after the validated ledger's close time. */
export const MIN_CANCEL_AFTER_S = 3600;
export const MAX_CANCEL_AFTER_S = 72 * 3600;
/** An EscrowFinish with a 32-byte-preimage fulfillment costs ~370 drops multisigned; cap at 2000. */
export const MAX_ESCROW_FEE_DROPS = 2000;
export { CTT_CURRENCY };

/** PREIMAGE-SHA-256 crypto-condition (RFC draft, as used by XRPL): condition A0258020<sha256>810120, fulfillment A0228020<preimage>. */
export function conditionFromPreimage(preimageHex: string): { condition: string; fulfillment: string } {
  const pre = Buffer.from(preimageHex, "hex");
  if (pre.length !== 32) throw new Error("preimage must be 32 bytes");
  const digest = crypto.createHash("sha256").update(pre).digest("hex");
  return { condition: `A0258020${digest}810120`.toUpperCase(), fulfillment: `A0228020${pre.toString("hex")}`.toUpperCase() };
}

export function newPreimage(): string {
  return crypto.randomBytes(32).toString("hex").toUpperCase();
}

/** Does this fulfillment satisfy this condition? */
export function fulfillmentMatches(condition: string, fulfillment: string): boolean {
  const m = /^A0228020([0-9A-F]{64})$/i.exec(fulfillment);
  if (!m) return false;
  return conditionFromPreimage(m[1]).condition === condition.toUpperCase();
}

export interface EscrowMemo {
  ms: string;
  ctr: string;
  ein: string;
  dh: string;
  rv: string;
}

export function escrowMemoJson(m: EscrowMemo): string {
  return JSON.stringify({ ms: m.ms, ctr: m.ctr, ein: m.ein, dh: m.dh, rv: m.rv });
}

export function escrowMemo(m: EscrowMemo): { Memo: { MemoType: string; MemoFormat: string; MemoData: string } } {
  return { Memo: { MemoType: toHex(ESCROW_MEMO_TYPE), MemoFormat: toHex(ESCROW_MEMO_FORMAT), MemoData: toHex(escrowMemoJson(m)) } };
}

export function parseEscrowMemo(tx: Record<string, unknown>): { data: EscrowMemo | null; problem: string | null } {
  const memos = tx.Memos as { Memo: { MemoType?: string; MemoFormat?: string; MemoData?: string } }[] | undefined;
  if (!Array.isArray(memos) || memos.length !== 1) return { data: null, problem: `expected exactly 1 memo, got ${Array.isArray(memos) ? memos.length : 0}` };
  const m = memos[0].Memo ?? {};
  let d: Record<string, unknown> | null = null;
  let type = "";
  let format = "";
  try {
    type = m.MemoType ? fromHex(m.MemoType) : "";
    format = m.MemoFormat ? fromHex(m.MemoFormat) : "";
    d = m.MemoData ? (JSON.parse(fromHex(m.MemoData)) as Record<string, unknown>) : null;
  } catch {
    d = null;
  }
  const keysOk = !!d && Object.keys(d).join(",") === "ms,ctr,ein,dh,rv" && ["ms", "ctr", "ein", "dh", "rv"].every((k) => typeof d![k] === "string");
  if (type !== ESCROW_MEMO_TYPE || format !== ESCROW_MEMO_FORMAT || !keysOk) return { data: null, problem: `memo must be type ${ESCROW_MEMO_TYPE}, format ${ESCROW_MEMO_FORMAT}, data {ms,ctr,ein,dh,rv}` };
  if (!/^[0-9a-f]{64}$/.test(String(d!.dh))) return { data: null, problem: "memo dh is not a SHA-256 hex digest" };
  return { data: d as unknown as EscrowMemo, problem: null };
}

/** An escrow object as read from the validated ledger (ledger_entry {escrow:{owner, seq}}). */
export type EscrowEntry =
  | { found: true; owner: string; seq: number; destination: string; amount: { currency?: string; issuer?: string; value?: string } | string; condition: string | null; cancel_after: number | null; finish_after: number | null }
  | { found: false; owner: string; seq: number };

export interface EscrowFacts {
  agentAccount: string;
  cityIssuer: string;
  sourceTag: number;
  signerAddresses: { agent: string; officer: string };
  /** Largest amount one milestone escrow may lock (AUTO_LIMIT, in CTT units). */
  maxAmount: number;
  ledger: { accountSequence: number; validatedLedger: number; closeTime: number };
  /** The condition the co-signer issued for this milestone (null if it never issued one). */
  issuedCondition: string | null;
  registry: RegistrySnapshot;
  registryDrift: string | null;
  allowlist: Set<string>;
  contract: ContractView | null;
  contractMissing?: string | null;
  contractDrift?: string | null;
  credential: CredentialFacts;
  holds: readonly ActiveHold[];
  exclusions: Map<string, ExclusionEntry>;
  /** Non-null if this milestone already has an EscrowCreate co-signature that is live or landed. */
  priorCreate?: string | null;
  /** Finish/Cancel: the escrow on the validated ledger and the create Sequence the co-signer recorded for this milestone. */
  escrow?: EscrowEntry;
  recordedOfferSequence?: number | null;
  /** Finish: non-null if a finish co-signature for this milestone is still live. */
  priorFinish?: string | null;
  /** Finish: the officer's release approval the co-signer holds for this milestone (null if none), whether it was already
   *  used for a finish co-signature, and the officer signer address to verify it against (pinned accounts file). */
  releaseApproval?: { approval: MilestoneReleaseApproval | null; used: boolean; officerAddress: string; nowMs: number } | null;
  /** Finish: agent_account's signer list configuration as read by the co-signer (CANONICAL / REVOKED / NONE / OTHER). */
  signerList?: string | null;
}

// ---------------------------------------------------------------- officer release approval
export const RELEASE_TYPE = "divhacks/milestone-release/v1" as const;
/** A release approval is valid for this long after the officer signed it. */
export const RELEASE_APPROVAL_MAX_AGE_MS = 30 * 60 * 1000;
const RELEASE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type ReleaseCore = Omit<MilestoneReleaseApproval, "signer" | "public_key" | "signature">;

/** The exact text the officer signs: canonical JSON (sorted keys) of the approval core. */
export function releaseText(c: ReleaseCore): string {
  return canonicalText({
    type: c.type, milestone_id: c.milestone_id, owner: c.owner, offer_sequence: c.offer_sequence, condition: c.condition,
    destination: c.destination, amount: c.amount, currency: c.currency, issuer: c.issuer, ts: c.ts,
  });
}

/** Officer side: signs a release approval with the officer signer key. */
export function signReleaseApproval(core: Omit<ReleaseCore, "type">, officer: Wallet): MilestoneReleaseApproval {
  const full: ReleaseCore = { type: RELEASE_TYPE, ...core, condition: core.condition.toUpperCase() };
  const s = signText(officer, releaseText(full));
  return { ...full, signer: officer.address, public_key: s.public_key, signature: s.signature };
}

/** What a release approval must be bound to: the escrow as the verifier itself knows it. */
export interface ReleaseBinding {
  milestone_id: string;
  owner: string;
  offer_sequence: number;
  condition: string;
  destination: string;
  amount: string;
  issuer: string;
}

const microUnits = (v: string) => (AMOUNT_RE.test(v) ? Math.round(Number(v) * 1e6) : NaN);

/** Verifies an officer release approval against the escrow the verifier knows (never against the requester's copy). */
export function verifyReleaseApproval(a: unknown, want: ReleaseBinding, officerAddress: string, nowMs = Date.now()): { ok: boolean; why: string | null } {
  const r = a as Partial<MilestoneReleaseApproval> | null;
  if (!r || typeof r !== "object") return { ok: false, why: "no release approval object" };
  if (r.type !== RELEASE_TYPE) return { ok: false, why: `approval type ${JSON.stringify(r.type)} is not ${RELEASE_TYPE}` };
  if (r.milestone_id !== want.milestone_id) return { ok: false, why: `approval is for milestone ${JSON.stringify(r.milestone_id)}, not ${want.milestone_id}` };
  if (r.owner !== want.owner || r.offer_sequence !== want.offer_sequence) return { ok: false, why: `approval is for escrow ${String(r.owner)}/${String(r.offer_sequence)}, not ${want.owner}/${want.offer_sequence}` };
  if (typeof r.condition !== "string" || r.condition.toUpperCase() !== want.condition.toUpperCase()) return { ok: false, why: "approval names another Condition" };
  if (r.destination !== want.destination) return { ok: false, why: `approval names destination ${String(r.destination)}, the escrow pays ${want.destination}` };
  if (r.currency !== CTT_CURRENCY || r.issuer !== want.issuer) return { ok: false, why: `approval is not for ${CTT_CURRENCY} from city_issuer` };
  if (typeof r.amount !== "string" || microUnits(r.amount) !== microUnits(want.amount)) return { ok: false, why: `approval amount ${String(r.amount)} is not the escrowed ${want.amount}` };
  const ts = typeof r.ts === "string" ? Date.parse(r.ts) : NaN;
  if (!Number.isFinite(ts)) return { ok: false, why: "approval ts is not a date" };
  if (ts > nowMs + RELEASE_MAX_FUTURE_SKEW_MS) return { ok: false, why: `approval is dated in the future (${r.ts})` };
  if (nowMs - ts > RELEASE_APPROVAL_MAX_AGE_MS) return { ok: false, why: `approval signed at ${r.ts} is older than ${RELEASE_APPROVAL_MAX_AGE_MS / 60000} minutes` };
  if (r.signer !== officerAddress) return { ok: false, why: `approval signer ${String(r.signer)} is not the registry officer ${officerAddress}` };
  const v = verifyText(releaseText(r as ReleaseCore), String(r.signature ?? ""), String(r.public_key ?? ""), officerAddress);
  return v.ok ? { ok: true, why: null } : { ok: false, why: `officer signature invalid: ${v.why}` };
}

export interface EscrowCheckResult {
  checks: Check[];
  refusal_reasons: RefusalCode[];
}

type Tx = Record<string, unknown>;

class Collector {
  checks: Check[] = [];
  codes: RefusalCode[] = [];
  set(name: string, why: string[], passDetail: string, codes: RefusalCode[]) {
    const passed = why.length === 0;
    this.checks.push({ name, passed, detail: passed ? passDetail : why.join("; ") });
    if (!passed) for (const c of codes) if (!this.codes.includes(c)) this.codes.push(c);
  }
  result(): EscrowCheckResult {
    return { checks: this.checks, refusal_reasons: this.codes };
  }
}

/** Field whitelist, Flags, Fee, multisig form, freshness, signatures. */
function formatProblems(tx: Tx, f: EscrowFacts, allowed: string[], opts: { requireAgentSig: boolean; unsigned?: boolean }): { why: string[]; codes: RefusalCode[] } {
  const why: string[] = [];
  const codes = new Set<RefusalCode>();
  const add = (c: RefusalCode, m: string) => {
    why.push(m);
    codes.add(c);
  };
  if (tx.Account !== f.agentAccount) add("bad_tx_fields", `Account ${String(tx.Account)} is not agent_account ${f.agentAccount}`);
  const extra = Object.keys(tx).filter((k) => !allowed.includes(k));
  if (extra.length) add("bad_tx_fields", `fields not allowed: ${extra.join(", ")}`);
  const flags = tx.Flags === undefined ? 0 : Number(tx.Flags);
  if (flags !== 0 && flags !== 0x80000000) add("bad_tx_fields", `Flags 0x${flags.toString(16)} not allowed (must be 0)`);
  const fee = typeof tx.Fee === "string" && /^\d+$/.test(tx.Fee) ? Number(tx.Fee) : NaN;
  if (!(fee > 0 && fee <= MAX_ESCROW_FEE_DROPS)) add("bad_tx_fields", `Fee ${String(tx.Fee)} drops is outside 1..${MAX_ESCROW_FEE_DROPS}`);
  if (tx.SigningPubKey !== "" || tx.TxnSignature !== undefined) add("bad_tx_fields", "not in multisig form (SigningPubKey must be empty and there must be no TxnSignature)");
  if (tx.Sequence !== f.ledger.accountSequence) add("tx_not_fresh", `Sequence ${String(tx.Sequence)} is not agent_account's current Sequence ${f.ledger.accountSequence}`);
  const lls = typeof tx.LastLedgerSequence === "number" ? tx.LastLedgerSequence : NaN;
  if (!(lls > f.ledger.validatedLedger && lls <= f.ledger.validatedLedger + MAX_LLS_AHEAD)) {
    add("tx_not_fresh", `LastLedgerSequence ${String(tx.LastLedgerSequence ?? "(missing)")} must be in (${f.ledger.validatedLedger}, ${f.ledger.validatedLedger + MAX_LLS_AHEAD}]`);
  }
  if (tx.SourceTag !== f.sourceTag) add("bad_source_tag", `SourceTag ${String(tx.SourceTag)} is not ${f.sourceTag}`);
  if (opts.unsigned) {
    if (tx.Signers !== undefined) add("bad_tx_fields", "the EscrowFinish template must be unsigned (the co-signer adds the fulfillment before anyone signs)");
  } else {
    const sigs = verifySigners(tx, f.signerAddresses);
    const accounts = sigs.map((s) => s.account);
    if (new Set(accounts).size !== accounts.length) add("bad_tx_fields", "a signer appears twice in Signers");
    for (const s of sigs) {
      if (s.role === "unknown") add("bad_tx_fields", `Signer ${s.account} is not the agent or the officer`);
      else if (!s.valid) add("bad_tx_fields", `the ${s.role}'s signature does not verify`);
    }
    if (opts.requireAgentSig && !sigs.some((s) => s.role === "agent" && s.valid)) add("bad_tx_fields", "the agent's multisig signature is missing");
  }
  return { why, codes: [...codes] };
}

/** Destination checks shared by create and finish: credential on-ledger, registry wallet for the contract's EIN, holds, exclusions. */
function destinationChecks(c: Collector, dest: string, ein: string | null, f: EscrowFacts): void {
  const cred = f.credential;
  const credWhy = cred.subject === dest && cred.issuer === f.cityIssuer ? credentialProblems(cred, [ein, f.contract?.nonprofit_ein]) : [`the credential facts are for ${cred.subject}, not Destination ${dest || "(none)"}`];
  c.set(
    "escrow_destination_credentialed",
    credWhy,
    cred.found ? `On-ledger credential ${cred.index} (NYC_VERIFIED_NONPROFIT from city_issuer) for ${dest}: accepted, expires ${cred.expiration ? rippleToIso(cred.expiration) : "?"}, URI EIN ${cred.uri_ein}` : "",
    ["credential_invalid"],
  );
  const why: string[] = [];
  const codes: RefusalCode[] = [];
  if (f.registryDrift) {
    why.push(`the registry changed since the co-signer pinned it (${f.registryDrift})`);
    codes.push("registry_drift");
  }
  if (f.contractDrift) {
    why.push(f.contractDrift);
    codes.push("registry_drift");
  }
  if (!f.allowlist.has(dest)) {
    why.push(`Destination ${dest || "(missing)"} is not on the pinned allowlist`);
    codes.push("destination_not_registry_wallet");
  }
  if (!f.contract) {
    why.push(f.contractMissing ?? "no contract for this milestone");
    codes.push("contract_not_found");
  } else {
    const reg = f.registry.byEin.get(f.contract.nonprofit_ein);
    if (ein && ein !== f.contract.nonprofit_ein) {
      why.push(`memo ein ${ein} is not contract ${f.contract.contract_id}'s payee EIN ${f.contract.nonprofit_ein}`);
      codes.push("destination_not_registry_wallet");
    }
    if (!reg || reg.address !== dest) {
      why.push(`Destination ${dest || "(missing)"} is not the registry wallet ${reg?.address ?? "(none)"} for EIN ${f.contract.nonprofit_ein}`);
      codes.push("destination_not_registry_wallet");
    }
  }
  const regDest = f.registry.byAddress.get(dest);
  const eins = new Set([ein, f.contract?.nonprofit_ein, regDest?.ein].filter((e): e is string => !!e));
  for (const h of f.holds.filter((x) => eins.has(x.ein))) {
    why.push(`${describeHold(h)}; escrow actions for this EIN are frozen until an officer-signed resolution`);
    codes.push("payee_change_on_hold");
  }
  const ex = [...eins].map((e) => f.exclusions.get(e)).find(Boolean);
  if (ex) {
    why.push(`EIN ${ex.ein} (${ex.name}) is on the exclusion list (${ex.list})`);
    codes.push("payee_excluded");
  }
  c.set(
    "escrow_destination_is_registry_wallet",
    why,
    `Destination ${dest} is the pinned registry wallet for EIN ${f.contract?.nonprofit_ein} (contract ${f.contract?.contract_id}); on the allowlist; no payee change hold; not excluded`,
    codes,
  );
}

const CREATE_FIELDS = ["TransactionType", "Account", "Destination", "Amount", "Fee", "Sequence", "LastLedgerSequence", "SigningPubKey", "Condition", "CancelAfter", "SourceTag", "Memos", "Flags", "NetworkID", "Signers"];

/** Co-signer rules for an EscrowCreate of a milestone. */
export function checkEscrowCreate(tx: Tx, milestoneId: string, f: EscrowFacts): EscrowCheckResult {
  const c = new Collector();
  const dest = typeof tx.Destination === "string" ? tx.Destination : "";
  const memo = parseEscrowMemo(tx);
  destinationChecks(c, dest, memo.data?.ein ?? null, f);

  // amount: CTT from city_issuer, plain decimal, <= maxAmount
  {
    const a = tx.Amount as { currency?: string; issuer?: string; value?: string } | string | undefined;
    const why: string[] = [];
    const codes: RefusalCode[] = [];
    if (typeof a !== "object" || !a || a.currency !== CTT_CURRENCY || a.issuer !== f.cityIssuer) {
      why.push(`Amount must be ${CTT_CURRENCY} issued by city_issuer ${f.cityIssuer} (${SIMULATED_ESCROW_LABEL}); got ${JSON.stringify(a ?? null)}`);
      codes.push("bad_currency");
    } else if (typeof a.value !== "string" || !AMOUNT_RE.test(a.value) || !(Number(a.value) > 0)) {
      why.push(`Amount value ${JSON.stringify(a.value)} must be a plain positive decimal with at most 6 decimals`);
      codes.push("bad_tx_fields");
    } else if (Number(a.value) > f.maxAmount) {
      why.push(`${a.value} ${CTT_CURRENCY} > the per-milestone limit ${f.maxAmount} (AUTO_LIMIT); a larger escrow needs the officer`);
      codes.push("over_auto_limit_needs_officer");
    }
    const value = typeof a === "object" && a ? a.value : String(a);
    c.set("escrow_amount_ctt_within_limit", why, `${value} ${CTT_CURRENCY} (city test token from city_issuer, ${SIMULATED_ESCROW_LABEL}) <= ${f.maxAmount}`, codes);
  }

  // condition: exactly the one the co-signer issued for this milestone; the milestone is not escrowed twice
  {
    const why: string[] = [];
    if (!f.issuedCondition) why.push(`the co-signer never issued a condition for milestone ${milestoneId} (POST /escrow/condition first)`);
    else if (String(tx.Condition ?? "").toUpperCase() !== f.issuedCondition) why.push(`Condition is not the PREIMAGE-SHA-256 condition the co-signer issued for milestone ${milestoneId}`);
    if (f.priorCreate) why.push(f.priorCreate);
    if (memo.data && memo.data.ms !== milestoneId) why.push(`memo ms ${memo.data.ms} is not milestone ${milestoneId}`);
    c.set("escrow_condition_issued_by_cosigner", why, `Condition ${String(tx.Condition).slice(0, 16)}... is the one the co-signer issued for milestone ${milestoneId} (it alone holds the preimage)`, ["escrow_condition_invalid"]);
  }

  // timing: CancelAfter in [close + 1 h, close + 72 h], no FinishAfter
  {
    const why: string[] = [];
    const ca = typeof tx.CancelAfter === "number" ? tx.CancelAfter : NaN;
    const lo = f.ledger.closeTime + MIN_CANCEL_AFTER_S;
    const hi = f.ledger.closeTime + MAX_CANCEL_AFTER_S;
    if (!(ca >= lo && ca <= hi)) why.push(`CancelAfter ${Number.isFinite(ca) ? rippleToIso(ca) : "(missing)"} must be 1..72 h after the validated ledger close ${rippleToIso(f.ledger.closeTime)}`);
    if (tx.FinishAfter !== undefined) why.push("FinishAfter is not allowed (release is by the co-signer's fulfillment only)");
    c.set("escrow_cancel_after_window", why, `CancelAfter ${Number.isFinite(ca) ? rippleToIso(ca) : "?"} is within 1..72 h; after it the tokens can only return to agent_account (EscrowCancel)`, ["escrow_timing_invalid"]);
  }

  // format
  {
    const fp = formatProblems(tx, f, CREATE_FIELDS, { requireAgentSig: true });
    if (tx.TransactionType !== "EscrowCreate") {
      fp.why.push(`TransactionType ${String(tx.TransactionType)} is not EscrowCreate`);
      fp.codes.push("bad_tx_fields");
    }
    if (memo.problem) {
      fp.why.push(memo.problem);
      fp.codes.push("bad_memo");
    } else if (!isCanonicalInvoiceId(memo.data!.ms)) {
      fp.why.push(`memo ms ${JSON.stringify(memo.data!.ms)} is not in canonical form`);
      fp.codes.push("bad_memo");
    }
    c.set("escrow_tx_format_valid", fp.why, `Plain multisig-form EscrowCreate from agent_account, SourceTag ${f.sourceTag}, memo ${ESCROW_MEMO_TYPE} {ms,ctr,ein,dh,rv}, fresh Sequence/LastLedgerSequence, agent signature verified`, fp.codes);
  }
  return c.result();
}

type FoundEscrow = Extract<EscrowEntry, { found: true }>;

function escrowOnLedger(c: Collector, tx: Tx, f: EscrowFacts, milestoneId: string, wantCondition: boolean): FoundEscrow | null {
  const why: string[] = [];
  const e = f.escrow;
  const off = typeof tx.OfferSequence === "number" ? tx.OfferSequence : NaN;
  if (tx.Owner !== f.agentAccount) why.push(`Owner ${String(tx.Owner)} is not agent_account`);
  if (!e || !e.found) why.push(`no escrow owned by agent_account with Sequence ${String(tx.OfferSequence)} on validated ledger ${f.ledger.validatedLedger}`);
  if (f.recordedOfferSequence == null) why.push(`the co-signer has no EscrowCreate record for milestone ${milestoneId}`);
  else if (f.recordedOfferSequence !== off) why.push(`OfferSequence ${off} is not the escrow the co-signer co-signed for milestone ${milestoneId} (Sequence ${f.recordedOfferSequence})`);
  if (e?.found && wantCondition && (e.condition ?? "").toUpperCase() !== (f.issuedCondition ?? "-")) why.push("the escrow's Condition is not the one the co-signer issued for this milestone");
  if (e?.found) {
    const a = e.amount as { currency?: string; issuer?: string };
    if (typeof a !== "object" || a.currency !== CTT_CURRENCY || a.issuer !== f.cityIssuer) why.push(`the escrow does not hold ${CTT_CURRENCY} from city_issuer`);
  }
  c.set(
    "escrow_on_ledger",
    why,
    e?.found ? `Escrow agent_account/${e.seq} on validated ledger ${f.ledger.validatedLedger}: ${(e.amount as { value?: string }).value} ${CTT_CURRENCY} -> ${e.destination}, condition issued by the co-signer for ${milestoneId}` : "",
    ["escrow_not_found"],
  );
  return e && e.found ? e : null;
}

const FINISH_FIELDS = ["TransactionType", "Account", "Owner", "OfferSequence", "Condition", "Fee", "Sequence", "LastLedgerSequence", "SigningPubKey", "Flags", "NetworkID", "SourceTag"];

/** Co-signer rules for the UNSIGNED EscrowFinish template it will complete with the fulfillment and co-sign. */
export function checkEscrowFinish(tx: Tx, milestoneId: string, f: EscrowFacts): EscrowCheckResult {
  const c = new Collector();
  const e = escrowOnLedger(c, tx, f, milestoneId, true);
  destinationChecks(c, e?.destination ?? "", f.contract?.nonprofit_ein ?? null, f);
  {
    const why: string[] = [];
    if (e?.cancel_after != null && !(e.cancel_after > f.ledger.closeTime)) why.push(`the escrow's CancelAfter ${rippleToIso(e.cancel_after)} has passed (validated ledger close ${rippleToIso(f.ledger.closeTime)}): it can only be cancelled`);
    if (e?.finish_after != null && e.finish_after > f.ledger.closeTime) why.push(`the escrow's FinishAfter ${rippleToIso(e.finish_after)} has not passed`);
    c.set("escrow_timing", why, `before CancelAfter ${e?.cancel_after != null ? rippleToIso(e.cancel_after) : "?"} (validated ledger close ${rippleToIso(f.ledger.closeTime)})`, ["escrow_timing_invalid"]);
  }
  {
    // The officer (a key the agent does not hold) must have approved THIS escrow's release, and the kill switch must not be
    // engaged: once the fulfillment leaves the co-signer, anyone can submit it.
    const why: string[] = [];
    const codes: RefusalCode[] = [];
    const ra = f.releaseApproval;
    if (!ra || !ra.approval) {
      why.push(`no officer-signed release approval for milestone ${milestoneId} (the officer approves with POST $OFFICER_URL/escrow/milestones/${milestoneId}/approve-release)`);
      codes.push("escrow_release_not_approved");
    } else if (ra.used) {
      why.push(`the officer's release approval for milestone ${milestoneId} (signed ${ra.approval.ts}) was already used for a finish co-signature; a retry needs a new approval`);
      codes.push("escrow_release_not_approved");
    } else if (!e) {
      why.push("no escrow on the validated ledger to bind the officer's release approval to");
      codes.push("escrow_release_not_approved");
    } else {
      const a = e.amount as { value?: string };
      const v = verifyReleaseApproval(ra.approval, { milestone_id: milestoneId, owner: f.agentAccount, offer_sequence: e.seq, condition: e.condition ?? "", destination: e.destination, amount: String(a.value ?? ""), issuer: f.cityIssuer }, ra.officerAddress, ra.nowMs);
      if (!v.ok) {
        why.push(`officer release approval rejected: ${v.why}`);
        codes.push("escrow_release_not_approved");
      }
    }
    if (f.signerList !== "CANONICAL") {
      why.push(`agent_account's signer list is ${f.signerList ?? "unknown"}, not CANONICAL (kill switch engaged?): no fulfillment is revealed while the agent key is revoked`);
      codes.push("agent_key_revoked");
    }
    c.set(
      "escrow_release_approved_by_officer",
      why,
      `officer ${ra?.approval?.signer ?? "?"} signed the release of escrow agent_account/${e?.seq ?? "?"} for milestone ${milestoneId} at ${ra?.approval?.ts ?? "?"} (verified against the pinned officer key; single use); agent_account's signer list is CANONICAL`,
      codes,
    );
  }
  {
    const fp = formatProblems(tx, f, FINISH_FIELDS, { requireAgentSig: false, unsigned: true });
    if (tx.TransactionType !== "EscrowFinish") {
      fp.why.push(`TransactionType ${String(tx.TransactionType)} is not EscrowFinish`);
      fp.codes.push("bad_tx_fields");
    }
    if (String(tx.Condition ?? "").toUpperCase() !== (f.issuedCondition ?? "-")) {
      fp.why.push("Condition is not the one the co-signer issued for this milestone");
      fp.codes.push("escrow_condition_invalid");
    }
    if (tx.Fulfillment !== undefined) {
      fp.why.push("the template already carries a Fulfillment (only the co-signer adds it)");
      fp.codes.push("bad_tx_fields");
    }
    if (f.priorFinish) {
      fp.why.push(f.priorFinish);
      fp.codes.push("tx_not_fresh");
    }
    c.set("escrow_tx_format_valid", fp.why, `Unsigned multisig-form EscrowFinish template from agent_account (Owner agent_account, OfferSequence ${String(tx.OfferSequence)}), fresh Sequence/LastLedgerSequence; the co-signer adds the Fulfillment`, fp.codes);
  }
  return c.result();
}

const CANCEL_FIELDS = ["TransactionType", "Account", "Owner", "OfferSequence", "Fee", "Sequence", "LastLedgerSequence", "SigningPubKey", "Flags", "NetworkID", "SourceTag", "Signers"];

/** Co-signer rules for an EscrowCancel (after CancelAfter; the tokens return to agent_account). */
export function checkEscrowCancel(tx: Tx, milestoneId: string, f: EscrowFacts): EscrowCheckResult {
  const c = new Collector();
  const e = escrowOnLedger(c, tx, f, milestoneId, false);
  {
    const why: string[] = [];
    if (e && !(e.cancel_after != null && e.cancel_after <= f.ledger.closeTime)) why.push(`CancelAfter ${e.cancel_after != null ? rippleToIso(e.cancel_after) : "(none)"} has not passed (validated ledger close ${rippleToIso(f.ledger.closeTime)})`);
    c.set("escrow_timing", why, `CancelAfter ${e?.cancel_after != null ? rippleToIso(e.cancel_after) : "?"} has passed; the tokens return to agent_account`, ["escrow_timing_invalid"]);
  }
  {
    const fp = formatProblems(tx, f, CANCEL_FIELDS, { requireAgentSig: true });
    if (tx.TransactionType !== "EscrowCancel") {
      fp.why.push(`TransactionType ${String(tx.TransactionType)} is not EscrowCancel`);
      fp.codes.push("bad_tx_fields");
    }
    c.set("escrow_tx_format_valid", fp.why, "Plain multisig-form EscrowCancel from agent_account, fresh, agent signature verified", fp.codes);
  }
  return c.result();
}
