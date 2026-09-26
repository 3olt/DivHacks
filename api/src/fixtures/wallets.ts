// PLACEHOLDER XRPL addresses. Each one is a checksum-valid classic address whose 20-byte account ID is
// sha256("divhacks-fixture-wallet:<EIN>") (etc.) truncated, so nobody holds a key for it and it does not
// exist on Testnet. Phase 1-3 replace these with the real Testnet wallets created by xrpl/scripts/setup.ts.

/** Registry wallet per payee EIN (the only place the payment builder takes a destination from). */
export const REGISTRY_WALLETS: Record<string, string> = {
  "00-0000001": "rJzQafbEJQivVaECbsFRyFPKaStoYmf4aX",
  "00-0000002": "rGzb8PTYiJ41vt1jCyTpo1EwV39rCJUexg",
  "00-0000003": "rwLUNsLBPQxB72hidhbQkHG3Jev7naE8YL",
  "00-0000004": "reNTT1WSmJ1rigNeTUUrfR9BDdfmaKySq",
  "00-0000005": "rDA52jD9B3UiZzoZ6K8xNviHWCoGeDY91E",
  "00-0000006": "rpEQaBH86bFVjR37otc1G5KSzDUZknAAuD",
  "00-0000007": "rnyoovU6USeGgMgRgAQgetrUeQz6NSe16k",
  "00-0000008": "rassEeiE7SvGYzsvPCr77BbgNgEBq8YAgp",
  "00-0000009": "rfSfYSW9N6zGUynu1NqKKDgrY1YvNUkS1q",
  "00-0000010": "rHY36T29MukkzD1JByXijja2YAq5egrgTV",
  "00-0000011": "rEEDcDc7iCf8yuAVG8HXE4TezGWeN7azgv",
  "00-0000012": "rKuqjsN1HK6VNBfxBkN4dipPdCCVypAqxW",
};

/** The address an injected invoice tries to redirect money to. */
export const ATTACKER_WALLET = "rLdExkkqZnqbuL9mv9bWrbu8PvzEEW37Cz";

/** The "new wallet" named in the fake payee-change request for EIN 00-0000004 (address-swap scenario). */
export const SWAP_REQUEST_WALLET = "rDQEBQwL1kPczdrAWDoy9dqPi5vQ7qKXfa";

/** Public RLUSD Testnet issuer (docs.ripple.com, "RLUSD on the XRPL", Testnet). */
export const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";

/**
 * Testnet-scale guardrails in RLUSD, the same values as AUTO_LIMIT / DAILY_CAP in the root .env (Phase 1).
 * Fixed here, not read from env, so fixture decisions and their hashes are reproducible; server.ts warns at
 * boot if the env disagrees. Agent/XRPL amounts are testnet-scale; Checkbook USD amounts stay real dollars.
 */
export const AUTO_LIMIT = 25;
export const DAILY_CAP = 100;
export const SOURCE_TAG = 26092026;
export { MEMO_TYPE } from "../lib/hash";
export const FIXTURE_RULE_VERSION = "fixture-0";
