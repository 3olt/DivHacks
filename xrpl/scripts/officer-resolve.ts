// The officer (a human) resolves a payee change request: signs {type, request_id, ein, requested_address, decision, ts}
// with the OFFICER signer key, records it on the request (Mongo payee_change_requests) and delivers it to the co-signer
// (POST $COSIGNER_URL/holds/resolution), which verifies the signature against signers.officer in the pinned
// accounts.testnet.json before it lifts anything. This process loads ONLY the root .env + xrpl/.env.officer (OFFICER_SEED).
//
//   reject   -> request closed, registry unchanged, the hold is lifted
//   approve  -> resolution recorded, re-onboarding required (Nessie re-confirmation + signed challenge + on-ledger credential
//               for the requested wallet); payments to the EIN stay frozen until then. NOT automated in this build, so an
//               approve freezes the EIN for good (resolutions are final): it needs --confirm-freeze.
//
// Run: npm run officer:resolve -- <request_id> reject                      (repo root)
//      npm run officer:resolve -- <request_id> approve --confirm-freeze
import { Wallet } from "xrpl";
import { loadEnv } from "../src/env";
import { loadRegistry } from "../src/lib/registry";
import { openMongo } from "../src/lib/mongo";
import { resolvePayeeChange } from "../src/officer/resolve";

loadEnv("officer");

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const [request_id, decision] = args;
  if (!request_id || (decision !== "approve" && decision !== "reject")) {
    console.error("usage: npm run officer:resolve -- <request_id> reject   |   <request_id> approve --confirm-freeze");
    return 2;
  }
  if (decision === "approve" && !args.includes("--confirm-freeze") && !args.includes("confirm-freeze")) {
    console.error(
      "approve is final and keeps every payment to this EIN frozen until the requested wallet has been re-onboarded (Nessie " +
        "re-confirmation + signed challenge + credential) and the registry switched, which this build does NOT automate. " +
        "Add --confirm-freeze to do it anyway; reject is the normal answer to an unverified request.",
    );
    return 2;
  }
  const foreign = Object.keys(process.env).filter((k) => k.endsWith("_SEED") && k !== "OFFICER_SEED");
  if (foreign.length) throw new Error(`refusing to run: other seeds are present in this process's environment (${foreign.join(", ")})`);
  const seed = process.env.OFFICER_SEED;
  if (!seed) throw new Error('OFFICER_SEED missing: run "npm run setup:xrpl" to generate xrpl/.env.officer');
  const officer = Wallet.fromSeed(seed);
  delete process.env.OFFICER_SEED;
  const reg = loadRegistry();
  if (officer.address !== reg.signers.officer.address) throw new Error(`OFFICER_SEED derives ${officer.address}, not the registry officer ${reg.signers.officer.address}`);

  const mongo = await openMongo("divhacks-officer");
  try {
    const cosignerUrl = (process.env.COSIGNER_URL ?? "http://localhost:4002").replace(/\/$/, "");
    const r = await resolvePayeeChange(mongo.db, officer, request_id, decision, cosignerUrl);
    if (!r.ok) {
      console.log(`officer: ${r.error}: ${r.message}`);
      return r.status === 409 ? 0 : 1;
    }
    console.log(`officer ${officer.address} signed "${decision}" for payee change request ${request_id} (EIN ${r.request.ein}, requested wallet ${r.request.requested_address})`);
    console.log(`  signature ${r.resolution.signature.slice(0, 24)}... over the canonical JSON {type, request_id, ein, requested_address, decision, ts: ${r.resolution.ts}}`);
    console.log(`  request status: ${r.request.status}: ${r.message}`);
    console.log(
      `  co-signer: ${r.cosigner.delivered ? "verified the officer signature and recorded the resolution" : `not confirmed (${r.cosigner.status ?? "no HTTP"}${r.cosigner.message ? `: ${r.cosigner.message}` : ""})`}`,
    );
    return r.cosigner.delivered || r.cosigner.status === null ? 0 : 1;
  } finally {
    await mongo.close();
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("officer-resolve failed:", e instanceof Error ? e.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>") : e);
    process.exit(1);
  },
);
