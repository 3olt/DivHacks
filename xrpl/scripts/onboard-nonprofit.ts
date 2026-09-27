// Nonprofit onboarding (Phase 3.1). Idempotent: one run per nonprofit; a re-run skips every step that is already done.
//
//   a. EIN match: np_N or an EIN (NN-NNNNNNN) -> the Mongo `nonprofits` record with exactly that EIN. Names are never
//      matched; records with a look-alike name and another EIN are listed as ignored.
//   b. Bank (Capital One Nessie, src/nessie/client.ts): find-or-create one Nessie customer per EIN (the org's public name +
//      address) and a Checking account; the account holder's name + address (GET /accounts/{id}/customer) must match our
//      public record (case/punctuation-insensitive) -> bank_name_address_match; then a micro-deposit: two random integer
//      amounts 1..99 ("cents") as Nessie deposits. [NONPROFIT SIDE - SIMULATED] reads its deposits and reports the two
//      amounts; we verify them against a salted commitment -> bank_verified. The Nessie ids (tied to our API key) and the
//      commitment's salt go ONLY into the gitignored city-side file xrpl/data/onboarding-bank.local.json (never Mongo, never
//      printed); Mongo keeps an HMAC account_ref, the statement reference and the commitment (src/onboarding/bankLocal.ts).
//      `npm run onboard -- migrate-bank-ids` moves ids an earlier build wrote into Mongo out of it (every run does this too).
//   c. Wallet ownership: a one-time challenge {nonce, EIN, wallet, expiry} stored server-side (Mongo
//      `onboarding_challenges`); [NONPROFIT SIDE - SIMULATED] signs it with the wallet key (NP_N_SEED, xrpl/.env.local);
//      verified with ripple-keypairs verify + deriveAddress(public_key) == wallet, consumed atomically. Every run also
//      proves the negatives: the same answer replayed, an expired challenge and a signature by another key are rejected.
//   d. city_issuer CredentialCreate {Subject: wallet, CredentialType: hex NYC_VERIFIED_NONPROFIT, Expiration: now + 90 d,
//      URI: hex "ein:<EIN>;https://projects.propublica.org/nonprofits/organizations/<digits>"} -> [NONPROFIT SIDE -
//      SIMULATED] CredentialAccept. Skipped if an accepted, unexpired credential for this EIN exists; an expired one (or one
//      for another EIN) is deleted (CredentialDelete) and recreated.
//   e. nonprofits.wallet = {address, credential_status "valid", credential_expires, bank_verified true}.
//
// ORDER: onboard first, then (re)start the co-signer. The co-signer pins the registry's wallet mapping {ein, name, address}
// at startup; onboarding does not change it (the status fields are not in the pinned hash and the credential itself is read
// on-ledger per payment), so a running co-signer keeps working. Onboarding a NEW wallet for an EIN changes the mapping:
// update accounts.testnet.json + allowlist.json, run seed-registry, then restart the co-signer.
//
// Keys: this is a city-side setup script. It loads the root .env + xrpl/.env.local (CITY_ISSUER_SEED, NP_N_SEED for the
// simulated nonprofit side) and never any signer seed (agent / cosigner / officer).
//
// Run: npm run onboard -- np_1      (repo root; also: an EIN such as 00-0000001)
//      NESSIE_STUB=1 ...            fall back to the in-memory stub bank (labelled "stub" everywhere)
import { Wallet, isValidClassicAddress, type Client, type SubmittableTransaction } from "xrpl";
import { loadEnv } from "../src/env";
import { connect, submitWait, explorerTx, type Outcome } from "../src/lib/xrpl";
import { loadRegistry, type NonprofitKey } from "../src/lib/registry";
import { COLL, ensureIndexes, openMongo, type NonprofitDoc } from "../src/lib/mongo";
import { CRED_TYPE_HEX, CREDENTIAL_DAYS, credentialProblems, credentialUriText, readCredential, rippleNow, rippleToIso, type CredentialFacts } from "../src/lib/credentials";
import { issueChallenge, mongoChallengeStore, verifyChallenge } from "../src/lib/challenge";
import { signText } from "../src/lib/signedMessage";
import { bankFromEnv, normalizeForMatch, formatUsAddress, parseUsAddress, type BankProvider } from "../src/nessie/client";
import { depositDescription, matchNonprofitByEin, newMicroDeposit, verifyMicroDeposit } from "../src/onboarding/lib";
import { accountRef, migrateBankIdsOutOfMongo, newRefKey, readBankLocal, writeBankLocal, BANK_LOCAL_PATH, type BankLocal } from "../src/onboarding/bankLocal";
import { toHex } from "../src/lib/xrpl";
import path from "node:path";
import { paths } from "../src/env";

loadEnv(); // root .env + xrpl/.env.local (setup-only seeds)

const SIGNER_SEEDS = ["AGENT_SEED", "COSIGNER_SEED", "OFFICER_SEED"].filter((k) => process.env[k]);
if (SIGNER_SEEDS.length) {
  console.error(`refusing to run: signer seeds present in this process (${SIGNER_SEEDS.join(", ")}); onboarding is city-side only`);
  process.exit(1);
}

const SIM = "[NONPROFIT SIDE - SIMULATED]";
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

interface OnboardingDoc {
  ein: string;
  np_key: string | null;
  name: string;
  wallet: string;
  status: "in_progress" | "complete" | "failed";
  started_at: string;
  updated_at: string;
  completed_at?: string;
  failure?: string;
  bank?: {
    provider: "nessie" | "stub";
    /** HMAC-SHA256 of the Nessie account id under a per-EIN key; the ids themselves are only in the local bank file. */
    account_ref: string;
    ids_location?: string;
    name_address_match?: { ok: boolean; at: string; ours: { name: string; address: string }; bank: { name: string; address: string } };
    /** The amounts are not stored; the salt of the commitment is only in the local bank file. */
    micro_deposit?: { ref: string; commitment_sha256: string; sent_at: string; attempts: number; verified_at?: string };
    verified?: boolean;
    verified_at?: string;
  };
  wallet_ownership?: { challenge_id: string; public_key: string; verified_at: string; negative_tests: Record<string, string> };
  credential?: { index: string; issuer: string; expires: string; uri: string; create_tx?: string; accept_tx?: string; delete_tx?: string; checked_at: string };
  simulated: string[];
  steps: { at: string; step: string; result: string }[];
  is_demo_data: true;
}

async function main(): Promise<number> {
  const arg = process.argv.slice(2).find((a) => a !== "--");
  if (!arg) {
    console.error("usage: npm run onboard -- <np_N | EIN>");
    return 2;
  }
  const reg = loadRegistry();
  const mongo = await openMongo("divhacks-onboarding");
  let client: Client | null = null;
  try {
    const db = mongo.db;
    await ensureIndexes(db);
    // Nessie ids and micro-deposit salts never stay in Mongo: move any an earlier build wrote there to the local bank file.
    const migrated = await migrateBankIdsOutOfMongo(db);
    if (migrated.length) console.log(`moved the Nessie ids / micro-deposit salts of ${migrated.join(", ")} out of Mongo into ${path.relative(paths.rootDir, BANK_LOCAL_PATH)} (gitignored)`);
    if (arg === "migrate-bank-ids") return 0;

    // a. EIN match (never on name)
    const records = await db.collection<NonprofitDoc>(COLL.nonprofits).find({}, { projection: { _id: 0 } }).toArray();
    const m = matchNonprofitByEin(records, arg, reg);
    console.log(`\n=== onboarding ${arg} (XRPL Testnet; demo nonprofit; nonprofit side SIMULATED with its demo key) ===`);
    if (!m.ok) {
      console.log(`[a] EIN match: REFUSED: ${m.why}`);
      return 1;
    }
    const np = m.record;
    const key = m.np_key;
    const regNp = key ? reg.nonprofits[key as NonprofitKey] : null;
    if (!key || !regNp) {
      console.log(`[a] EIN match: REFUSED: EIN ${m.ein} has no demo wallet in accounts.testnet.json (only np_1..np_5 can be onboarded here)`);
      return 1;
    }
    const wallet = regNp.address;
    if (np.wallet?.address && np.wallet.address !== wallet) {
      console.log(`[a] REFUSED: the Mongo registry wallet for ${m.ein} (${np.wallet.address}) differs from accounts.testnet.json (${wallet}); run seed-registry and review`);
      return 1;
    }
    console.log(`[a] EIN match: ${m.ein} -> "${np.name}" (${key}, wallet ${wallet}); matched on EIN only` + (m.lookalikes_ignored.length ? `; ignored look-alike names with other EINs: ${m.lookalikes_ignored.map((r) => `"${r.name}" (${r.ein})`).join(", ")}` : "; no look-alike names in the registry"));
    if (regNp.label) {
      console.log(`[a] NOTE: ${m.ein} is a REAL organization (public record from builder A's ingestion; public fields are never changed here). ` +
        `Its wallet ${wallet} is a ${regNp.label}. Only the "wallet" field of its nonprofits record is written.`);
    }

    const coll = db.collection<OnboardingDoc>(COLL.onboarding);
    const now0 = iso();
    const existing = await coll.findOne({ ein: m.ein }, { projection: { _id: 0 } });
    const doc: OnboardingDoc = existing ?? {
      ein: m.ein, np_key: key, name: np.name, wallet, status: "in_progress", started_at: now0, updated_at: now0,
      simulated: [
        "the nonprofit side (reading its Nessie deposits, signing the wallet challenge, CredentialAccept) is simulated with the demo keys in xrpl/.env.local",
        "the Nessie customer + account are created by us from the organization's public record (Nessie is a sandbox bank)",
        ...(regNp.label
          ? [`REAL organization, DEMO wallet: ${np.name} (EIN ${m.ein}) has not onboarded with GlassLedger; ${wallet} is a ${regNp.label} (its key is ours, ${key.toUpperCase()}_SEED). The EIN, name and address are its public record`]
          : []),
      ],
      steps: [], is_demo_data: true,
    };
    if (doc.wallet !== wallet) {
      console.log(`[a] REFUSED: an onboarding record for ${m.ein} exists for another wallet (${doc.wallet}); a wallet change goes through POST /payees/:ein/change-request`);
      return 1;
    }
    const step = async (name: string, result: string) => {
      doc.steps.push({ at: iso(), step: name, result });
      doc.updated_at = iso();
      await coll.replaceOne({ ein: m.ein }, doc, { upsert: true });
    };
    await step("ein_match", `matched ${m.ein} on EIN only`);

    // b. Bank: Nessie customer + Checking account, name/address match, micro-deposit
    const bank: BankProvider = bankFromEnv();
    if (bank.kind === "stub") console.log("\n!!! NESSIE_STUB=1: using the IN-MEMORY STUB BANK, not Nessie. bank_verified below comes from a stub. !!!\n");
    const ref = await bank.findOrCreateAccount({ ein: m.ein, name: np.name, address: np.address });
    console.log(`[b] bank (${bank.kind}): customer "EIN ${m.ein}" ${ref.created.customer ? "created" : "found"}, Checking account ${ref.created.account ? "created" : "found"} (ids kept only in the gitignored local bank file, never in Mongo or logs)`);
    const prevLocal = readBankLocal()[m.ein];
    const local: BankLocal = {
      ...(prevLocal && prevLocal.account_id === ref.account_id && prevLocal.provider === bank.kind ? prevLocal : {}),
      provider: bank.kind, customer_id: ref.customer_id, account_id: ref.account_id, ref_key: prevLocal?.ref_key ?? newRefKey(), updated_at: iso(),
    };
    writeBankLocal(m.ein, local);
    const account_ref = accountRef(local.ref_key, bank.kind, ref.account_id);
    if (doc.bank && (doc.bank.account_ref !== account_ref || doc.bank.provider !== bank.kind)) doc.bank = undefined; // a different bank account: verify again
    doc.bank = { ...(doc.bank ?? {}), provider: bank.kind, account_ref, ids_location: "xrpl/data/onboarding-bank.local.json (gitignored, city side)" };
    const holder = await bank.accountHolder(ref.account_id);
    const ours = { name: np.name, address: formatUsAddress(parseUsAddress(np.address)) };
    const nameOk = normalizeForMatch(holder.name) === normalizeForMatch(ours.name);
    const addrOk = normalizeForMatch(holder.address) === normalizeForMatch(ours.address);
    doc.bank.name_address_match = { ok: nameOk && addrOk, at: iso(), ours, bank: holder };
    console.log(`[b] bank_name_address_match: ${nameOk && addrOk ? "YES" : "NO"}: bank says "${holder.name}", ${holder.address}; our public record says "${ours.name}", ${ours.address}`);
    if (!(nameOk && addrOk)) {
      doc.status = "failed";
      doc.failure = "bank account holder name/address does not match the public record";
      await step("bank_name_address_match", "MISMATCH");
      return 1;
    }
    await step("bank_name_address_match", "match");

    if (doc.bank.verified && doc.bank.verified_at) {
      console.log(`[b] micro-deposit: already verified at ${doc.bank.verified_at}; skipping`);
    } else {
      const md = newMicroDeposit(m.ein);
      const desc = depositDescription(md.ref);
      const ids: string[] = [];
      for (const a of md.amounts) ids.push((await bank.deposit(ref.account_id, a, desc)).deposit_id);
      const sent_at = iso();
      writeBankLocal(m.ein, { ...local, micro_deposit: { ref: md.ref, salt: md.salt, deposit_ids: ids, sent_at }, updated_at: sent_at });
      doc.bank.micro_deposit = { ref: md.ref, commitment_sha256: md.commitment_sha256, sent_at, attempts: 0 };
      await step("micro_deposit_sent", `2 deposits (integers 1..99, cents) with reference ${md.ref}; amounts kept only as a salted SHA-256 commitment (the salt stays in the local bank file)`);
      console.log(`[b] micro-deposit: 2 deposits sent to the Nessie account with statement reference "${desc}"`);
      // SIMULATED nonprofit: looks at its bank statement for the two GlassLedger deposits and reports the amounts.
      const seenOnStatement = (await bank.listDeposits(ref.account_id)).filter((d) => d.description === desc).map((d) => d.amount);
      console.log(`[b] ${SIM} reads its deposits: found ${seenOnStatement.length} with reference ${md.ref}; reports the two amounts`);
      doc.bank.micro_deposit.attempts++;
      const commitmentOnly = { ref: md.ref, salt: md.salt, commitment_sha256: doc.bank.micro_deposit.commitment_sha256 };
      const ok = verifyMicroDeposit(commitmentOnly, m.ein, seenOnStatement);
      // Negative control: a wrong pair must not verify.
      const wrong = [((md.amounts[0] % 99) + 1), md.amounts[1]];
      const wrongOk = verifyMicroDeposit(commitmentOnly, m.ein, wrong);
      console.log(`[b] micro-deposit verification: ${ok ? "CONFIRMED" : "FAILED"} (a wrong pair is ${wrongOk ? "ACCEPTED (BUG)" : "rejected"})`);
      if (!ok || wrongOk) {
        doc.status = "failed";
        doc.failure = "micro-deposit amounts did not verify";
        await step("bank_verified", "FAILED");
        return 1;
      }
      doc.bank.micro_deposit.verified_at = iso();
      doc.bank.verified = true;
      doc.bank.verified_at = doc.bank.micro_deposit.verified_at;
      await step("bank_verified", `micro-deposit amounts confirmed (${bank.kind})`);
    }

    // c. Wallet ownership: signed one-time challenge
    const npSeed = process.env[`${key.toUpperCase()}_SEED`];
    if (!npSeed) throw new Error(`${key.toUpperCase()}_SEED missing from xrpl/.env.local (the simulated nonprofit's key)`);
    const npWallet = Wallet.fromSeed(npSeed);
    if (npWallet.address !== wallet) throw new Error(`${key.toUpperCase()}_SEED derives ${npWallet.address}, not the registry wallet ${wallet}`);
    const store = mongoChallengeStore(db);
    const ch = await issueChallenge(store, m.ein, wallet);
    console.log(`[c] challenge ${ch.challenge_id} issued for EIN ${m.ein} / ${wallet} (expires ${ch.expires_at}; stored server-side)`);
    const answer = { challenge_id: ch.challenge_id, ...signText(npWallet, ch.message) };
    console.log(`[c] ${SIM} signs the challenge text with the wallet key`);
    const v = await verifyChallenge(store, answer, { ein: m.ein, wallet });
    if (!v.ok) {
      doc.status = "failed";
      doc.failure = `wallet ownership: ${v.why}`;
      await step("wallet_ownership", `FAILED ${v.code}`);
      console.log(`[c] wallet ownership: FAILED (${v.code}): ${v.why}`);
      return 1;
    }
    console.log(`[c] wallet ownership: VERIFIED (signature valid, deriveAddress(public_key) = ${wallet}, challenge consumed)`);
    // Negatives, proven on every run.
    const replay = await verifyChallenge(store, answer, { ein: m.ein, wallet });
    const expired = await issueChallenge(store, m.ein, wallet, Date.now(), -1000);
    const exp = await verifyChallenge(store, { challenge_id: expired.challenge_id, ...signText(npWallet, expired.message) }, { ein: m.ein, wallet });
    const other = await issueChallenge(store, m.ein, wallet);
    const wrongKey = await verifyChallenge(store, { challenge_id: other.challenge_id, ...signText(Wallet.generate(), other.message) }, { ein: m.ein, wallet });
    const negatives = {
      replayed_answer: replay.ok ? "ACCEPTED (BUG)" : `rejected: ${replay.code}`,
      expired_challenge: exp.ok ? "ACCEPTED (BUG)" : `rejected: ${exp.code}`,
      signed_by_another_key: wrongKey.ok ? "ACCEPTED (BUG)" : `rejected: ${wrongKey.code}`,
    };
    console.log(`[c] negatives: replayed answer -> ${negatives.replayed_answer}; expired challenge -> ${negatives.expired_challenge}; another key -> ${negatives.signed_by_another_key}`);
    if (replay.ok || exp.ok || wrongKey.ok) throw new Error("a negative challenge test was accepted");
    doc.wallet_ownership = { challenge_id: ch.challenge_id, public_key: answer.public_key, verified_at: iso(), negative_tests: negatives };
    await step("wallet_ownership", "verified (signed challenge)");

    // d. On-ledger City Credential
    const issuerSeed = process.env.CITY_ISSUER_SEED;
    if (!issuerSeed) throw new Error("CITY_ISSUER_SEED missing from xrpl/.env.local");
    const issuer = Wallet.fromSeed(issuerSeed);
    if (issuer.address !== reg.city_issuer) throw new Error(`CITY_ISSUER_SEED derives ${issuer.address}, not city_issuer ${reg.city_issuer}`);
    client = await connect();
    const uri = credentialUriText(m.ein);
    let cred: CredentialFacts = await readCredential(client, wallet, issuer.address);
    const credTx: { create?: Outcome; accept?: Outcome; del?: Outcome } = {};
    const send = async (tx: SubmittableTransaction, w: Wallet, label: string) => {
      const out = await submitWait(client!, tx, w, label);
      if (out.result !== "tesSUCCESS") throw new Error(`${label} failed on-ledger: ${out.result} (${out.link})`);
      return out;
    };
    if (cred.found && (cred.expiration === null || cred.expiration <= cred.close_time || cred.uri_ein !== m.ein)) {
      console.log(`[d] existing credential ${cred.index} is ${cred.uri_ein !== m.ein ? `for EIN ${cred.uri_ein}` : "expired"}; deleting it to recreate`);
      credTx.del = await send({ TransactionType: "CredentialDelete", Account: issuer.address, Subject: wallet, Issuer: issuer.address, CredentialType: CRED_TYPE_HEX } as SubmittableTransaction, issuer, "CredentialDelete (city_issuer)");
      cred = await readCredential(client, wallet, issuer.address);
    }
    if (!cred.found) {
      const expiration = rippleNow() + CREDENTIAL_DAYS * 24 * 3600;
      credTx.create = await send({ TransactionType: "CredentialCreate", Account: issuer.address, Subject: wallet, CredentialType: CRED_TYPE_HEX, Expiration: expiration, URI: toHex(uri) } as SubmittableTransaction, issuer, "CredentialCreate (city_issuer)");
      cred = await readCredential(client, wallet, issuer.address);
    } else {
      console.log(`[d] credential ${cred.index} already exists (created earlier)`);
    }
    if (cred.found && !cred.accepted) {
      console.log(`[d] ${SIM} accepts the credential with its wallet key`);
      credTx.accept = await send({ TransactionType: "CredentialAccept", Account: wallet, Issuer: issuer.address, CredentialType: CRED_TYPE_HEX } as SubmittableTransaction, npWallet, "CredentialAccept (nonprofit)");
      cred = await readCredential(client, wallet, issuer.address);
    } else if (cred.found && !credTx.create && !credTx.del) {
      console.log(`[d] credential already accepted and valid: skipping CredentialCreate/Accept`);
    }
    const problems = credentialProblems(cred, [m.ein]);
    if (!cred.found || problems.length) throw new Error(`the credential read back from the ledger is not valid: ${problems.join("; ")}`);
    const expires = rippleToIso(cred.expiration!);
    console.log(`[d] on-ledger credential ${cred.index}: NYC_VERIFIED_NONPROFIT, issuer ${issuer.address}, subject ${wallet}, accepted, expires ${expires}, URI "${cred.uri_text}" (validated ledger ${cred.ledger_index})`);
    doc.credential = {
      index: cred.index, issuer: issuer.address, expires, uri,
      ...(credTx.create ? { create_tx: credTx.create.hash } : doc.credential?.create_tx ? { create_tx: doc.credential.create_tx } : {}),
      ...(credTx.accept ? { accept_tx: credTx.accept.hash } : doc.credential?.accept_tx ? { accept_tx: doc.credential.accept_tx } : {}),
      ...(credTx.del ? { delete_tx: credTx.del.hash } : {}),
      checked_at: iso(),
    };
    await step("credential", credTx.create || credTx.accept ? `created/accepted on-ledger ${cred.index}` : `already valid ${cred.index}`);

    // e. Registry record (Nonprofit shape)
    if (!isValidClassicAddress(wallet)) throw new Error("bad wallet");
    const w = {
      address: wallet, credential_status: "valid" as const, credential_expires: expires, bank_verified: true,
      // np_5: a REAL organization's DEMO wallet: say so wherever the wallet is shown (extra fields; not in the pinned hash).
      ...(regNp.label ? { label: regNp.label, is_demo_data: true } : {}),
    };
    const r = await db.collection<NonprofitDoc>(COLL.nonprofits).updateOne({ ein: m.ein }, { $set: { wallet: w } });
    console.log(`[e] nonprofits ${m.ein}.wallet = {address ${wallet}, credential_status "valid", credential_expires ${expires}, bank_verified true} (${r.modifiedCount ? "updated" : "unchanged"})`);
    doc.status = "complete";
    doc.completed_at = doc.completed_at ?? iso();
    delete doc.failure;
    await step("registry", "nonprofits.wallet written");

    console.log(`\nONBOARDED ${m.ein} (${np.name}) -> ${wallet}`);
    if (credTx.create) console.log(`  CredentialCreate: ${explorerTx(credTx.create.hash)}`);
    if (credTx.accept) console.log(`  CredentialAccept: ${explorerTx(credTx.accept.hash)}`);
    const cosigner = (process.env.COSIGNER_URL ?? "http://localhost:4002").replace(/\/$/, "");
    const up = await fetch(`${cosigner}/health`, { signal: AbortSignal.timeout(1500) }).then((x) => x.ok).catch(() => false);
    console.log(
      `  next: (re)start the co-signer ("npm run cosigner"). It pins the wallet mapping at startup; this run did not change it, and it reads credentials on-ledger per payment` +
        (up ? ` (a co-signer is running at ${cosigner}; it keeps working, restart it to be safe)` : ""),
    );
    return 0;
  } finally {
    await client?.disconnect().catch(() => undefined);
    await mongo.close().catch(() => undefined);
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("onboarding failed:", e instanceof Error ? e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>").replace(/([?&]key=)[^&\s"']+/g, "$1***") : e);
    process.exit(1);
  },
);
