// X5: XLS-70 Credentials on Testnet: CredentialCreate -> CredentialAccept -> ledger_entry read-back
// (lsfAccepted + Expiration), plus a CredentialCreate with an Expiration in the past.
// Re-runnable: an existing credential from a previous run is deleted (CredentialDelete) and recreated.
// Run: cd xrpl && npx tsx scripts/risk/credentials.ts
import type { Client, SubmittableTransaction } from "xrpl";
import { connect, fundedWallet, submitWait, submitBlob, toHex, header, rippleNow, RIPPLE_EPOCH } from "./_lib";

const CRED_TYPE = toHex("NYC_VERIFIED_NONPROFIT");
const URI = toHex("ein:00-0000001;https://projects.propublica.org/nonprofits/");
const LSF_ACCEPTED = 0x00010000;

async function readCred(client: Client, subject: string, issuer: string) {
  try {
    const r = await client.request({ command: "ledger_entry", credential: { subject, issuer, credential_type: CRED_TYPE }, ledger_index: "validated" } as never);
    return (r as { result: { index: string; ledger_index: number; node: Record<string, unknown> } }).result;
  } catch (e) {
    const err = (e as { data?: { error?: string } }).data?.error;
    if (err === "entryNotFound") return null;
    throw e;
  }
}

async function main() {
  header("X5 Credentials (XLS-70)");
  const client = await connect();
  try {
    const issuer = await fundedWallet(client, "CRED_ISSUER");
    const subject = await fundedWallet(client, "CRED_SUBJECT");

    const existing = await readCred(client, subject.address, issuer.address);
    if (existing) {
      console.log("  credential from a previous run exists; deleting it so this run proves create+accept again");
      await submitWait(client, { TransactionType: "CredentialDelete", Account: issuer.address, Subject: subject.address, Issuer: issuer.address, CredentialType: CRED_TYPE }, issuer, "CredentialDelete (cleanup)");
    }

    const expiration = rippleNow() + 30 * 24 * 3600;
    const create = await submitWait(client, {
      TransactionType: "CredentialCreate", Account: issuer.address, Subject: subject.address,
      CredentialType: CRED_TYPE, Expiration: expiration, URI,
    }, issuer, "CredentialCreate");
    const afterCreate = await readCred(client, subject.address, issuer.address);
    const accept = await submitWait(client, {
      TransactionType: "CredentialAccept", Account: subject.address, Issuer: issuer.address, CredentialType: CRED_TYPE,
    }, subject, "CredentialAccept");
    const cred = await readCred(client, subject.address, issuer.address);
    const node = cred?.node ?? {};
    const flags = Number(node.Flags ?? 0);

    // Expiration in the past (fresh subject so it can't collide with tecDUPLICATE)
    const pastSubject = await fundedWallet(client, "CRED_SUBJECT2");
    const pastTx: SubmittableTransaction = {
      TransactionType: "CredentialCreate", Account: issuer.address, Subject: pastSubject.address,
      CredentialType: CRED_TYPE, Expiration: rippleNow() - 3600, URI,
    };
    const prepared = await client.autofill(pastTx);
    const signed = issuer.sign(prepared);
    const past = await submitBlob(client, signed.tx_blob, signed.hash, "CredentialCreate (Expiration 1h in the past)");

    console.log(JSON.stringify({
      check: "X5",
      issuer: issuer.address, subject: subject.address,
      CredentialCreate: { hash: create.hash, result: create.result, link: create.link },
      accepted_flag_before_accept: afterCreate ? (Number(afterCreate.node.Flags) & LSF_ACCEPTED) !== 0 : null,
      CredentialAccept: { hash: accept.hash, result: accept.result, link: accept.link },
      ledger_entry: cred ? { index: cred.index, ledger_index: cred.ledger_index, node } : null,
      lsfAccepted: (flags & LSF_ACCEPTED) !== 0,
      Expiration: node.Expiration,
      Expiration_iso: node.Expiration ? new Date((Number(node.Expiration) + RIPPLE_EPOCH) * 1000).toISOString() : null,
      expiration_matches: Number(node.Expiration) === expiration,
      URI_decoded: node.URI ? Buffer.from(String(node.URI), "hex").toString() : null,
      past_expiration_create: past,
      pass: create.result === "tesSUCCESS" && accept.result === "tesSUCCESS" && (flags & LSF_ACCEPTED) !== 0 && Number(node.Expiration) === expiration,
    }, null, 2));
  } finally {
    await client.disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
