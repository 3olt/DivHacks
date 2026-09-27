// Governance transactions on agent_account (Phase 3, builder B). PURE: no keys, no network.
//
// The co-signer's POST /governance/cosign co-signs ONLY these, each in exactly one shape:
//   SignerListSet  on agent_account, SignerQuorum 3, SignerEntries EXACTLY one of two configurations (addresses from the
//                  pinned accounts.testnet.json):
//                    CANONICAL = {agent:1, cosigner:2, officer:1}   (normal operation)
//                    REVOKED   = {cosigner:2, officer:1}            (kill switch: the agent key no longer counts)
//                  signed by the OFFICER (verified) and nobody else. officer 1 + cosigner 2 = 3 reaches the quorum under
//                  both lists, so the agent is never needed (and cannot sign once revoked).
//   TrustSet       on agent_account for EXACTLY CTT / city_issuer (the city test token of the SIMULATED escrow), fixed limit,
//                  tfSetNoRipple, no quality fields; signed by the agent or the officer (verified).
// Both also follow the Phase 1/2 transaction rules: exact field whitelist, Flags, Fee cap, multisig form, and freshness
// (Sequence == agent_account's current Sequence, LastLedgerSequence within 30 ledgers of the validated ledger).
import { TrustSetFlags } from "xrpl";
import { verifySigners, MAX_FEE_DROPS, MAX_LLS_AHEAD } from "../cosigner/checks";

export const GOVERNANCE_RULE_VERSION = "p3-gov-1";
export const GOV_QUORUM = 3;

/** City Test Token: a 3-letter currency code issued by our city_issuer (SIMULATED escrow only; never RLUSD). */
export const CTT_CURRENCY = "CTT";
/** The only trust line limit the co-signer accepts for agent_account's CTT line. */
export const CTT_TRUST_LIMIT = "1000000";

export type SignerListName = "CANONICAL" | "REVOKED";
export interface SignerListShape {
  quorum: number;
  entries: { account: string; weight: number }[];
}

export interface GovSigners {
  agent: string;
  cosigner: string;
  officer: string;
}

export function signerListConfigs(s: GovSigners): Record<SignerListName, SignerListShape> {
  return {
    CANONICAL: { quorum: GOV_QUORUM, entries: [{ account: s.agent, weight: 1 }, { account: s.cosigner, weight: 2 }, { account: s.officer, weight: 1 }] },
    REVOKED: { quorum: GOV_QUORUM, entries: [{ account: s.cosigner, weight: 2 }, { account: s.officer, weight: 1 }] },
  };
}

function sameList(a: SignerListShape, b: SignerListShape): boolean {
  if (a.quorum !== b.quorum || a.entries.length !== b.entries.length) return false;
  const want = new Map(b.entries.map((e) => [e.account, e.weight]));
  return new Set(a.entries.map((e) => e.account)).size === a.entries.length && a.entries.every((e) => want.get(e.account) === e.weight);
}

/** Which configuration an on-ledger signer list is: CANONICAL, REVOKED, NONE (no list) or OTHER. */
export function classifySignerList(sl: SignerListShape | null, s: GovSigners): SignerListName | "NONE" | "OTHER" {
  if (!sl) return "NONE";
  const c = signerListConfigs(s);
  if (sameList(sl, c.CANONICAL)) return "CANONICAL";
  if (sameList(sl, c.REVOKED)) return "REVOKED";
  return "OTHER";
}

/** SignerEntries in the transaction format for one configuration. */
export function signerEntriesFor(name: SignerListName, s: GovSigners): { SignerEntry: { Account: string; SignerWeight: number } }[] {
  return signerListConfigs(s)[name].entries.map((e) => ({ SignerEntry: { Account: e.account, SignerWeight: e.weight } }));
}

export type GovPurpose = "revoke_agent" | "restore_agent" | "ctt_trust_line";

export interface GovContext {
  agentAccount: string;
  cityIssuer: string;
  signers: GovSigners;
  /** agent_account's current Sequence and the latest validated ledger, read by the caller itself. */
  ledger: { accountSequence: number; validatedLedger: number };
}

export interface GovResult {
  ok: boolean;
  /** What the tx is, if recognisable: revoke_agent (-> REVOKED), restore_agent (-> CANONICAL) or ctt_trust_line. */
  purpose: GovPurpose | null;
  problems: string[];
  detail: string;
}

const COMMON = ["TransactionType", "Account", "Fee", "Sequence", "LastLedgerSequence", "SigningPubKey", "Flags", "NetworkID", "Signers"];
const FIELDS: Record<string, Set<string>> = {
  SignerListSet: new Set([...COMMON, "SignerQuorum", "SignerEntries"]),
  TrustSet: new Set([...COMMON, "LimitAmount"]),
};
const FULLY_CANONICAL = 0x80000000;

/** Validates a governance tx for co-signing. `purpose` (from the request) must match what the tx actually is. */
export function checkGovernanceTx(tx: Record<string, unknown>, purpose: unknown, ctx: GovContext): GovResult {
  const problems: string[] = [];
  const type = String(tx.TransactionType ?? "");
  const allowed = FIELDS[type];
  if (!allowed) return { ok: false, purpose: null, problems: [`TransactionType ${type || "(missing)"} is not a governance transaction (SignerListSet or TrustSet only)`], detail: "" };
  if (tx.Account !== ctx.agentAccount) problems.push(`Account ${String(tx.Account)} is not agent_account ${ctx.agentAccount}`);
  const extra = Object.keys(tx).filter((k) => !allowed.has(k));
  if (extra.length) problems.push(`fields not allowed on a governance ${type}: ${extra.join(", ")}`);
  if (tx.SigningPubKey !== "" || tx.TxnSignature !== undefined) problems.push("not in multisig form (SigningPubKey must be empty and there must be no TxnSignature)");
  const fee = typeof tx.Fee === "string" && /^\d+$/.test(tx.Fee) ? Number(tx.Fee) : NaN;
  if (!(fee > 0 && fee <= MAX_FEE_DROPS)) problems.push(`Fee ${String(tx.Fee)} drops is outside 1..${MAX_FEE_DROPS}`);
  if (tx.Sequence !== ctx.ledger.accountSequence) problems.push(`Sequence ${String(tx.Sequence)} is not agent_account's current Sequence ${ctx.ledger.accountSequence}`);
  const lls = typeof tx.LastLedgerSequence === "number" ? tx.LastLedgerSequence : NaN;
  if (!(lls > ctx.ledger.validatedLedger && lls <= ctx.ledger.validatedLedger + MAX_LLS_AHEAD)) {
    problems.push(`LastLedgerSequence ${String(tx.LastLedgerSequence ?? "(missing)")} must be in (${ctx.ledger.validatedLedger}, ${ctx.ledger.validatedLedger + MAX_LLS_AHEAD}]`);
  }
  const sigs = verifySigners(tx, { agent: ctx.signers.agent, officer: ctx.signers.officer });
  const accounts = sigs.map((s) => s.account);
  if (new Set(accounts).size !== accounts.length) problems.push("a signer appears twice in Signers");
  for (const s of sigs) {
    if (s.role === "unknown") problems.push(`Signer ${s.account} is not the agent or the officer`);
    else if (!s.valid) problems.push(`the ${s.role}'s signature does not verify`);
  }
  const flags = tx.Flags === undefined ? 0 : Number(tx.Flags);

  let actual: GovPurpose | null = null;
  let detail = "";
  if (type === "SignerListSet") {
    if (flags !== 0 && flags !== FULLY_CANONICAL) problems.push(`Flags 0x${flags.toString(16)} not allowed on SignerListSet`);
    if (tx.SignerQuorum !== GOV_QUORUM) problems.push(`SignerQuorum ${String(tx.SignerQuorum)} is not ${GOV_QUORUM}`);
    const raw = Array.isArray(tx.SignerEntries) ? (tx.SignerEntries as { SignerEntry?: Record<string, unknown> }[]) : [];
    const badEntry = raw.some((e) => !e?.SignerEntry || Object.keys(e.SignerEntry).sort().join(",") !== "Account,SignerWeight");
    if (badEntry) problems.push("SignerEntries may only carry {Account, SignerWeight} (no WalletLocator or other fields)");
    const shape: SignerListShape = { quorum: Number(tx.SignerQuorum), entries: raw.map((e) => ({ account: String(e?.SignerEntry?.Account ?? ""), weight: Number(e?.SignerEntry?.SignerWeight) })) };
    const cls = classifySignerList({ ...shape, quorum: GOV_QUORUM }, ctx.signers);
    if (cls === "REVOKED") actual = "revoke_agent";
    else if (cls === "CANONICAL") actual = "restore_agent";
    else problems.push(`SignerEntries ${shape.entries.map((e) => `${e.account}:${e.weight}`).join(", ") || "(none)"} are neither REVOKED {cosigner:2, officer:1} nor CANONICAL {agent:1, cosigner:2, officer:1}`);
    const officer = sigs.find((s) => s.role === "officer");
    if (!officer) problems.push("a signer list change needs the officer's signature (the human approver); none present");
    if (sigs.some((s) => s.role === "agent")) problems.push("the agent may not sign a signer list change (governance is officer + co-signer only)");
    detail = actual ? `SignerListSet -> ${actual === "revoke_agent" ? "REVOKED {cosigner:2, officer:1}" : "CANONICAL {agent:1, cosigner:2, officer:1}"} quorum ${GOV_QUORUM}, signed by the officer (verified)` : "";
  } else {
    if (flags !== TrustSetFlags.tfSetNoRipple && flags !== (TrustSetFlags.tfSetNoRipple | FULLY_CANONICAL)) problems.push(`Flags 0x${flags.toString(16)} not allowed on TrustSet (must be tfSetNoRipple only)`);
    const la = tx.LimitAmount as { currency?: string; issuer?: string; value?: string } | undefined;
    if (!la || typeof la !== "object" || la.currency !== CTT_CURRENCY || la.issuer !== ctx.cityIssuer || la.value !== CTT_TRUST_LIMIT) {
      problems.push(`TrustSet is allowed only for ${CTT_CURRENCY} issued by city_issuer ${ctx.cityIssuer} with limit ${CTT_TRUST_LIMIT} (got ${JSON.stringify(la ?? null)})`);
    } else actual = "ctt_trust_line";
    if (!sigs.some((s) => s.role === "agent" || s.role === "officer")) problems.push("the TrustSet carries no agent or officer signature");
    detail = actual ? `TrustSet ${CTT_CURRENCY}/city_issuer limit ${CTT_TRUST_LIMIT} (tfSetNoRipple), signed by ${sigs.map((s) => s.role).join(" + ")} (verified)` : "";
  }
  if (actual && purpose !== actual) problems.push(`request purpose ${JSON.stringify(purpose)} does not match the transaction (${actual})`);
  return { ok: problems.length === 0, purpose: actual, problems, detail };
}
