// The City Credential (XLS-70) on XRPL Testnet: city_issuer -> CredentialCreate {Subject: nonprofit wallet,
// CredentialType: hex("NYC_VERIFIED_NONPROFIT"), Expiration, URI: hex("ein:<EIN>;<ProPublica URL>")} -> the nonprofit's
// CredentialAccept. The co-signer's check 1 reads it back with ledger_entry on the VALIDATED ledger and compares its
// Expiration with that ledger's close time. Holds no keys.
import type { Client } from "xrpl";
import { CITY_CREDENTIAL_TYPE } from "../../../shared/contracts";
import { fromHex, toHex } from "./xrpl";

export const CRED_TYPE_HEX = toHex(CITY_CREDENTIAL_TYPE);
/** Credential ledger-entry flag: the subject has accepted it. */
export const LSF_ACCEPTED = 0x00010000;
export const RIPPLE_EPOCH = 946684800;
export const rippleNow = (ms = Date.now()) => Math.floor(ms / 1000) - RIPPLE_EPOCH;
export const rippleToIso = (t: number) => new Date((t + RIPPLE_EPOCH) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
export const CREDENTIAL_DAYS = 90;
export const MAX_URI_BYTES = 256;

/** Strict EIN form NN-NNNNNNN (ASCII digits only, so look-alike characters never match). */
export const EIN_RE = /^\d{2}-\d{7}$/;

/** "ein:00-0000001;https://projects.propublica.org/nonprofits/organizations/000000001" (hex-encoded in the tx). */
export function credentialUriText(ein: string): string {
  if (!EIN_RE.test(ein)) throw new Error(`EIN ${JSON.stringify(ein)} is not NN-NNNNNNN`);
  const text = `ein:${ein};https://projects.propublica.org/nonprofits/organizations/${ein.replace("-", "")}`;
  if (Buffer.byteLength(text, "utf8") > MAX_URI_BYTES) throw new Error(`credential URI is longer than ${MAX_URI_BYTES} bytes`);
  return text;
}

/** The EIN in a credential URI (hex or text), or null if the URI does not start with a well-formed "ein:NN-NNNNNNN;". */
export function einFromCredentialUri(uri: string | undefined | null, isHex = true): string | null {
  if (!uri) return null;
  let text: string;
  try {
    text = isHex ? fromHex(uri) : uri;
  } catch {
    return null;
  }
  const m = /^ein:(\d{2}-\d{7});/.exec(text);
  return m ? m[1] : null;
}

/** What a reader saw on the validated ledger for (subject, issuer, NYC_VERIFIED_NONPROFIT). */
export type CredentialFacts =
  | {
      found: true;
      subject: string;
      issuer: string;
      /** Ledger object id of the Credential entry. */
      index: string;
      flags: number;
      accepted: boolean;
      /** Ripple-epoch seconds, if set. */
      expiration: number | null;
      uri_text: string | null;
      uri_ein: string | null;
      /** The validated ledger the entry was read from, and its close time (ripple seconds). */
      ledger_index: number;
      close_time: number;
    }
  | { found: false; subject: string; issuer: string; ledger_index: number; close_time: number };

/** Validated ledger index + close time (ripple seconds), from one `ledger` request. */
export async function validatedLedger(client: Client): Promise<{ ledger_index: number; close_time: number }> {
  const r = (await client.request({ command: "ledger", ledger_index: "validated" } as never)) as { result: { ledger_index: number | string; ledger: { close_time: number; ledger_index?: number | string } } };
  return { ledger_index: Number(r.result.ledger_index ?? r.result.ledger.ledger_index), close_time: Number(r.result.ledger.close_time) };
}

/** ledger_entry {credential:{subject, issuer, credential_type}} on a validated ledger. Throws on transport/RPC errors other than entryNotFound. */
export async function readCredential(client: Client, subject: string, issuer: string, at?: { ledger_index: number; close_time: number }): Promise<CredentialFacts> {
  const v = at ?? (await validatedLedger(client));
  if (!subject) return { found: false, subject, issuer, ...v };
  try {
    const r = (await client.request({ command: "ledger_entry", credential: { subject, issuer, credential_type: CRED_TYPE_HEX }, ledger_index: v.ledger_index } as never)) as {
      result: { index: string; node: { Flags?: number; Expiration?: number; URI?: string; Subject?: string; Issuer?: string; CredentialType?: string } };
    };
    const n = r.result.node;
    let uriText: string | null = null;
    try {
      uriText = n.URI ? fromHex(n.URI) : null;
    } catch {
      uriText = null;
    }
    const flags = Number(n.Flags ?? 0);
    return {
      found: true, subject, issuer, index: r.result.index, flags, accepted: (flags & LSF_ACCEPTED) !== 0,
      expiration: typeof n.Expiration === "number" ? n.Expiration : null, uri_text: uriText, uri_ein: einFromCredentialUri(uriText, false), ...v,
    };
  } catch (e) {
    const err = (e as { data?: { error?: string } }).data?.error;
    // entryNotFound = no such credential. A malformed subject (not an account id) cannot hold one either.
    if (err === "entryNotFound" || err === "malformedRequest" || err === "invalidParams") return { found: false, subject, issuer, ...v };
    throw e;
  }
}

/** Is it usable for payments to `ein`? Returns the reasons it is not (empty = valid). */
export function credentialProblems(c: CredentialFacts, eins: (string | null | undefined)[]): string[] {
  const why: string[] = [];
  if (!c.found) return [`no ${CITY_CREDENTIAL_TYPE} credential from city_issuer ${c.issuer} for ${c.subject || "(no Destination)"} on validated ledger ${c.ledger_index} (ledger_entry: entryNotFound)`];
  if (!c.accepted) why.push(`credential ${c.index} was never accepted by its subject (lsfAccepted not set)`);
  if (c.expiration === null) why.push(`credential ${c.index} has no Expiration`);
  else if (!(c.expiration > c.close_time)) why.push(`credential ${c.index} expired at ${rippleToIso(c.expiration)} (validated ledger ${c.ledger_index} closed ${rippleToIso(c.close_time)})`);
  const want = [...new Set(eins.filter((e): e is string => !!e))];
  if (!c.uri_ein) why.push(`credential ${c.index} URI does not carry an EIN ("ein:NN-NNNNNNN;...")`);
  else if (want.length === 0) why.push(`no memo/contract EIN to compare with the credential's EIN ${c.uri_ein}`);
  else for (const e of want) if (e !== c.uri_ein) why.push(`credential ${c.index} is for EIN ${c.uri_ein}, not ${e}`);
  return why;
}
