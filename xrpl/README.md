# xrpl/: autonomous, ledger-guarded RLUSD payments (XRPL Testnet)

Phase 1: the agent pays an invoice in RLUSD **on its own**, with no human in the loop. It can only do that
together with a separate compliance co-signer, because the XRP Ledger itself enforces the quorum.
Everything here runs on **XRPL Testnet only**. Testnet tokens have no value. Invoices and payments are demo data (`is_demo_data: true`).

## Architecture (Phase 1)

```
invoice (payee EIN)            agent process (holds AGENT_SEED only)              co-signer process :4002 (holds COSIGNER_SEED only)
      │                        ─────────────────────────────────────              ──────────────────────────────────────────────
      └──► payInvoice() ──► destination = registry wallet for the EIN
                        ──► decision core + decision_hash (dh)
                        ──► RLUSD Payment + SourceTag 26092026 + memo {inv,ctr,ein,dh,rv}
                        ──► autofill(tx, 2); sign as "agent" (multisig form)
                        ──► pre-flight: agent_account RLUSD balance >= amount
                        ──► POST /cosign {tx_blob, invoice_id, decision_id} ───► decode tx_blob, read the ledger itself, run its checks:
                                                                                  destination_is_registry_wallet (pinned allowlist)
                                                                                  invoice_not_already_paid (own signing record)
                                                                                  within_auto_limit_or_officer_signed (<= AUTO_LIMIT)
                                                                                  tx_format_valid (field whitelist, Flags 0, Fee cap,
                                                                                    RLUSD, SourceTag, memo, multisig form, Sequence ==
                                                                                    current, LastLedgerSequence <= validated + 30)
                                                        signed_blob ◄──────────── pass: record it, then sign the SAME tx (weight 2)
                                                        HTTP 422    ◄──────────── fail: refuse, never sign
                        ──► multisign([agent, cosigner]) ──► submit ──► XRPL Testnet
                        ──► wait until validated or the ledger passes LastLedgerSequence (final either way)
                        ──► Decision + Payment ──► data/decisions.local.jsonl
```

**The multisig account.** `agent_account` holds the RLUSD working balance. Its signer list is
`agent` weight 1, `cosigner` weight 2, `officer` weight 1, **quorum 3**, and its **master key is disabled**
(`lsfDisableMaster`). So:

| Signatures | Weight | Result |
|---|---|---|
| agent alone (tricked, prompt-injected, or leaked key) | 1 | **`tefBAD_QUORUM`**: the ledger rejects it |
| agent + cosigner | 3 | autonomous payment, no human |
| agent + cosigner + officer | 4 | over-limit payment a human approved (Phase 3) |
| agent_account master key | – | **`tefMASTER_DISABLED`** |

The limit does not live in the agent's code, so the agent cannot be argued out of it: the co-signer is a
different process with a different key, and it never receives LLM text. It only decodes the transaction it is
asked to sign and checks it against the public registry and the allowlist. It signs exactly the transaction it checked.
Verified against the real `agent_account` on Testnet on 2026-09-26: an agent-only signed payment to the attacker returned
`tefBAD_QUORUM` ("Signatures provided do not meet the quorum."), and a payment signed with its master key returned
`tefMASTER_DISABLED`. `tef` results never reach a ledger, so these two have no explorer page; the evidence is the `engine_result`.

`city_treasury` is the parent that holds RLUSD and funds the agent's working balance. The agent never holds a treasury key.

## The co-signer (Phase 1)

`src/cosigner/server.ts` + `src/cosigner/checks.ts`, rule version `p1-allowlist-2`. It gets `{tx_blob, invoice_id, decision_id}` and
nothing else (any other body field is a 400). It decodes the blob and signs **only** if every check passes:

| Check | Refuses when | Refusal code |
|---|---|---|
| `destination_is_registry_wallet` | `Destination` is not one of np_1..np_4 on the allowlist | `destination_not_registry_wallet` |
| `invoice_not_already_paid` | it has already co-signed this `invoice_id` (its own record; fails closed even if that tx never landed). Phase 2 adds the on-ledger memo-history scan | `invoice_already_paid` |
| `within_auto_limit_or_officer_signed` | amount is not > 0, or is over `AUTO_LIMIT` (25 RLUSD). The officer path is Phase 3 | `over_auto_limit_needs_officer` |
| `tx_format_valid` | any field outside {TransactionType, Account, Destination, Amount, Fee, Sequence, LastLedgerSequence, SigningPubKey, SourceTag, Memos, Flags, NetworkID, Signers} (so no `SendMax`, `DeliverMin`, `Paths`, `TicketSequence`, `DestinationTag`, `InvoiceID`, `Delegate`, `CredentialIDs`...); `Flags` other than 0 (no `tfPartialPayment`); `Fee` over 1000 drops; not a multisig-form Payment from agent_account; `Sequence` is not agent_account's **current** Sequence; `LastLedgerSequence` missing or not in (validated, validated + 30]; a co-signature for the same Sequence is still live; wrong currency/issuer, SourceTag or memo | `verifier_rejected` (structural/freshness), `bad_currency`, `bad_source_tag`, `bad_memo` |

The freshness rules mean a co-signature is only good for agent_account's next Sequence and for about 20 ledgers
(~70 s), so a compromised agent cannot collect co-signatures in advance for Sequence N+1, N+2, ... and replay them later
to get around the duplicate and cap checks.

What the co-signer trusts, and from where:

- **Policy** (`data/accounts.testnet.json`, `data/allowlist.json`): read **once at startup** and pinned by SHA-256. Later edits on
  disk (for example by a compromised agent process running as the same OS user) have no effect until a restart. `/health` shows
  the pinned hashes and `*_on_disk_matches: false` if a file has drifted; every `/cosign` logs a warning while it has.
- **Ledger state**: its own XRPL connection (`account_info` ledger `current` for the Sequence, `ledger` validated for the index).
  If it cannot read the ledger it answers 503 and signs nothing.
- **What it already signed**: `data/cosigner-signed.local.jsonl`, appended **before** the signature is returned (if the write
  fails it answers 500 and returns no signature). Requests are handled one at a time, so two concurrent requests cannot both pass.

## What is real and what is simulated

- **Real, on XRPL Testnet**: the multisig account, quorum, disabled master key, signer weights, every payment, and the ledger's
  `tefBAD_QUORUM` / `tefMASTER_DISABLED` refusals.
- **Simulated separation**: the agent and the co-signer are separate OS processes with separate keys and separate env files,
  but on a hackathon laptop they run as **the same OS user on the same machine**, so the co-signer's key file and policy files are
  readable and writable by the agent's user. The pinned policy and the "no other `*_SEED` in my environment" startup check narrow
  this; they do not replace an OS boundary. In production the co-signer runs on a different host (or HSM/container) under a
  different identity, and the policy comes from the ledger (Phase 3 credentials) rather than from local files.
- **Auto-spawn is a dev convenience**: when `npm run demo happy` finds no co-signer it starts one itself, so the agent process
  controls the co-signer's lifetime, environment and code path. For the judged demo run the co-signer yourself (below).

## Keys: who holds what

| Process | Loads | Seeds it can see |
|---|---|---|
| `scripts/setup.ts` (admin, setup only) | root `.env` + `xrpl/.env.local` (`loadEnv()`) | `TREASURY_SEED`, `CITY_ISSUER_SEED`, `AGENT_ACCOUNT_SEED` (master key of agent_account, now disabled), `NP_1..NP_4_SEED`, `ATTACKER_SEED`. **No signer seeds**: from `.env.agent/.env.cosigner/.env.officer` it reads only the `*_ADDRESS` value |
| agent (`scripts/demo.ts`, `src/agent/`) | root `.env` + `xrpl/.env.agent` (`loadEnv("agent")`) | `AGENT_SEED` only |
| co-signer (`src/cosigner/server.ts`) | root `.env` + `xrpl/.env.cosigner` (`loadEnv("cosigner")`) | `COSIGNER_SEED` only. It refuses to start if any other `*_SEED` variable is in its environment |
| officer (Phase 3) | root `.env` + `xrpl/.env.officer` | `OFFICER_SEED` only |

All of these files are gitignored. The root `.env` holds no seeds. Setup generates each signer keypair only if its
file is missing (signer keys are unfunded keypairs, not accounts). **In production each party would generate
its own key on its own machine and hand over only the address**. Setup generating all three is a hackathon convenience.

## Run it

```bash
npm run setup:xrpl        # idempotent; a second run submits 0 transactions and makes 0 faucet calls
npm run demo happy        # agent pays the seeded 12.50 RLUSD invoice; prints EXPLORER: https://testnet.xrpl.org/transactions/<hash>
npm run cosigner          # optional: run the co-signer yourself (port from COSIGNER_URL, default 4002)
npm run verify -w xrpl    # read-only on-ledger check of the latest released payment (or pass a tx hash after --)
```

**Judged demo (co-signer in its own terminal):**

```bash
npm run cosigner                 # terminal 1: holds COSIGNER_SEED only; prints its pinned policy hashes
npm run demo happy no-spawn      # terminal 2: the agent; refuses to start a co-signer itself
```

`npm run demo happy` first calls `GET $COSIGNER_URL/health`. If a co-signer answers, it uses that one
(`co-signer mode: EXTERNAL`). Otherwise it spawns one as a child process (`node --import tsx src/cosigner/server.ts`,
cwd `xrpl/`) with every `*_SEED` variable removed from the child's environment, waits for `/health`, runs the scenario and
kills the child (`co-signer mode: AUTO-SPAWNED`, a dev convenience). Modifiers, as positional words so they work in every shell:

| Modifier | Also | Effect |
|---|---|---|
| `keep` | `--keep-cosigner`, `KEEP_COSIGNER=1` | leave the auto-spawned co-signer running; its log goes to `xrpl/data/cosigner.local.log` |
| `no-spawn` | `--no-spawn`, `COSIGNER_NO_SPAWN=1` | never spawn: fail unless a co-signer already answers |

Windows PowerShell drops a bare `--` (`npm run demo happy -- --keep-cosigner` loses the flag there; `'--'` quoted works), so prefer
the positional words. Other scenarios (`injection`, `duplicate`, `over-contract`, `address-swap`, `over-limit`, `kill-switch`)
print "not implemented until Phase 2/3" and exit 2.

Each run gets a unique invoice id (`INV-P1-<UTC yyyymmdd-HHMMss>`), so repeated runs are not duplicates. Each run moves
12.50 RLUSD from `agent_account` to `np_1`. With the default 60 RLUSD working balance that is 4 runs. Before signing, the agent
checks the balance and stops with `agent_account holds X RLUSD, less than the 12.50 RLUSD invoice; run "npm run setup:xrpl"`
instead of submitting a payment that would fail on-ledger (`tecPATH_PARTIAL`). Re-run `npm run setup:xrpl` to top it up.

**Finality.** After submitting, the agent waits until the tx is validated **or** the validated ledger passes the tx's
`LastLedgerSequence` (autofill sets validated + 20, about 60-70 s on Testnet); only then is the result final. `EXPLORER:` is
printed only for a released (`tesSUCCESS`) payment; a tx that is on-ledger but failed (`tec...`) is printed as `NOT PAID`. If the
co-signer refuses, errors, times out or cannot be reached, the agent still writes a refused Decision with a readable reason
(`xrpl.cosigner_message` in the log line) and submits nothing.

### What setup does (each step checks the ledger first and skips work that is already done)

1. Creates and faucet-funds (100 XRP each, with retry/backoff) `city_issuer`, `agent_account`, `np_1..np_4` and `attacker`. `city_treasury` already exists.
2. RLUSD trust lines (limit 1e9, `tfSetNoRipple`) for agent_account, np_1..np_4 and attacker.
3. Treasury RLUSD: while the treasury is below `RLUSD_TREASURY_TARGET` (default 150) **plus** the pending agent top-up,
   it funds a throwaway swapper wallet from the faucet and sends a cross-currency Payment (XRP → RLUSD through the Testnet
   XRP/RLUSD AMM, `tfPartialPayment`, `SendMax` = balance − (reserve + 1 XRP)) straight to the treasury. If the default path
   fails with `tecPATH_DRY`/`tecPATH_PARTIAL` it retries with `ripple_path_find` paths. At most `SETUP_MAX_SWAPS` (default 8)
   per run; after that the treasury may swap its own spare XRP (it keeps at least 30 XRP).
4. Tops `agent_account` up to `AGENT_RLUSD_TARGET` (default 60) with a plain RLUSD Payment from the treasury.
5. `SignerListSet` {agent:1, cosigner:2, officer:1}, quorum 3, signed with agent_account's master key. Skipped if the on-ledger list already matches.
6. Only after the signer list is verified on-ledger: `AccountSet SetFlag 4` (asfDisableMaster). If the master key is
   already disabled and the signer list is wrong, setup stops with an error and exits non-zero (fixing that needs a multisigned
   `SignerListSet`, the Phase 3 kill-switch tooling). It never bricks the account.
7. Writes `data/accounts.testnet.json` and `data/allowlist.json` (only if their content changed).

It ends with a summary table (role, address, XRP, RLUSD, explorer link), the on-ledger signer list, the master-disabled flag and
the number of transactions and faucet calls it made.

**Faucet cost.** A first run from scratch makes 15 faucet calls (1,500 test XRP): 7 accounts + 8 swappers. Each swap turned
98 XRP into about 29.2 RLUSD (AMM ≈ 0.30 RLUSD/XRP, 0.5% fee), about 233 RLUSD in total. A re-run makes none.

## Files

| Path | What | Git |
|---|---|---|
| `data/accounts.testnet.json` | Public registry: network, RLUSD issuer/currency, `city_issuer`, `city_treasury`, `agent_account`, `signers` {agent, cosigner, officer: {address, weight}}, `quorum`, `nonprofits` np_1..np_4 {address, ein, name, contract_id}, `attacker`, `source_tag`. Addresses only | committed |
| `data/allowlist.json` | Phase 1 co-signer allowlist: the np_1..np_4 addresses. The co-signer reads it once at startup and pins its SHA-256 (restart it after a change) | committed |
| `data/invoices/happy.json` | Seeded `Invoice` (EIN 00-0000001, contract CT1-069-20261409087, 12.50 RLUSD, `is_demo_data: true`) | committed |
| `data/decisions.local.jsonl` | One JSON line per decision: `{decision, payment, xrpl}` (`Decision`/`Payment` shapes from `shared/contracts.ts`). MongoDB replaces it in Phase 2 | gitignored |
| `data/cosigner-signed.local.jsonl` | The co-signer's own record of every co-signature (`invoice_id`, `decision_id`, `sequence`, `last_ledger_sequence`, `destination`, `amount`). It refuses a second signature for an invoice, and for a Sequence while an earlier co-signature is still live | gitignored |
| `src/lib/xrpl.ts`, `src/lib/registry.ts` | XRPL helpers (no env loading, no seeds) and registry/allowlist loaders | |
| `src/agent/decision.ts`, `src/agent/payInvoice.ts` | Decision core, memo, `payInvoice()`, `loadAgentWallet()` | |
| `src/cosigner/checks.ts`, `src/cosigner/server.ts` | Co-signer checks (pure) and the Fastify service | |
| `scripts/setup.ts`, `scripts/demo.ts`, `scripts/verify.ts` | Setup, demo runner, read-only verifier | |
| `scripts/risk/` | Phase 0 risk checks (see its README) | |

np_1..np_4 map to the API fixture nonprofits EIN 00-0000001..00-0000004 (names and current contract ids from
`api/src/fixtures/`); np_1 is the golden site `site_001` (Burnside Heights Food Collective (demo), contract CT1-069-20261409087).

## Memo format

Each agent payment carries exactly one memo (under 1 KB; about 208 bytes in practice):

| Field | Value |
|---|---|
| `MemoType` | hex of `divhacks/payment/v1` (`MEMO_TYPE`) |
| `MemoFormat` | hex of `application/json` (`MEMO_FORMAT`) |
| `MemoData` | hex of `memoJson(...)` = `{"inv":<invoice_id>,"ctr":<contract_id>,"ein":<payee_ein>,"dh":<decision_hash>,"rv":<rule_version>}` (key order fixed) |

plus `SourceTag` 26092026 (`AGENT_SOURCE_TAG`). `Payment.memo_hash` = SHA-256 (lowercase hex) of the MemoData JSON string exactly as written on-ledger.

## decision_hash

`decision_hash` (the memo's `dh`) = SHA-256 (lowercase hex) of the canonical JSON (keys sorted recursively, no whitespace)
of **only the pre-signing fields**, `DECISION_HASH_FIELDS` in `shared/hash.ts`:
`decision_id, invoice_id, contract_id, payee_ein, amount, currency, agent_reasoning, rule_version, source_tag, created_at`.

`checks`, `outcome`, `refusal_reasons`, `enforced_by`, `signers`, `xrpl_tx_hash` and `ledger_result` are excluded. They are only known
after signing (from the co-signer and the ledger), and the transaction carries `dh` in its memo, so hashing them would be circular.
The ledger itself is their proof. Anyone can recompute `dh` from a logged decision and compare it with the on-ledger memo
(`npm run verify -w xrpl` does exactly that).

In Phase 1 the agent is rule-based (no LLM), so `agent_reasoning` is short deterministic text. Phase 1 decisions carry only the
4 checks the co-signer runs (`destination_is_registry_wallet`, `invoice_not_already_paid`, `within_auto_limit_or_officer_signed`, `tx_format_valid`). Phase 2 adds `credential_valid`, `within_contract_amount`, `within_daily_caps` and `payee_not_excluded`, and replaces the local signing record with the on-ledger memo-history scan for duplicates.
