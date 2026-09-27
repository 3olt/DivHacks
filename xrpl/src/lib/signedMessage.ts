// Signing and verifying short off-ledger messages with an XRPL keypair (ripple-keypairs sign / verify), plus the
// check that the public key really belongs to the claimed address (deriveAddress(publicKey) === address).
// Used for (a) the onboarding wallet-ownership challenge (the nonprofit signs with its wallet key) and (b) the officer's
// resolution of a payee change request (the officer signs with the officer signer key; the co-signer verifies).
import { sign as keypairSign } from "ripple-keypairs";
import { deriveAddress, verifyKeypairSignature, type Wallet } from "xrpl";
import { canonicalJson } from "../../../shared/hash";

export const utf8Hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

/** Signs the UTF-8 bytes of `message`. Returns {public_key, signature} (hex). */
export function signText(wallet: Wallet, message: string): { public_key: string; signature: string } {
  return { public_key: wallet.publicKey, signature: keypairSign(utf8Hex(message), wallet.privateKey) };
}

/** Verifies `signature` over the UTF-8 bytes of `message` AND that `publicKey` derives `address`. */
export function verifyText(message: string, signature: string, publicKey: string, address: string): { ok: boolean; why: string | null } {
  try {
    if (!/^[0-9A-Fa-f]{66}$/.test(publicKey)) return { ok: false, why: "public key is not a 33-byte hex key" };
    const derived = deriveAddress(publicKey);
    if (derived !== address) return { ok: false, why: `public key derives ${derived}, not ${address}` };
    if (!/^[0-9A-Fa-f]{2,200}$/.test(signature)) return { ok: false, why: "signature is not hex" };
    if (!verifyKeypairSignature(utf8Hex(message), signature, publicKey)) return { ok: false, why: "signature does not verify" };
    return { ok: true, why: null };
  } catch (e) {
    return { ok: false, why: `signature check failed (${(e as Error).message})` };
  }
}

/** Canonical JSON text of an object (keys sorted): what gets signed for structured messages. */
export const canonicalText = (o: unknown) => canonicalJson(o);
