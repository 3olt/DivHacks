# GlassLedger backend: status (Sat 2026-09-26, 20:45 EDT)

What's built, how it works, what's real, and what's next. The pitch and product context are in [`../context.md`](../context.md), the API contract in [`API.md`](API.md), and the XRPL details in [`../xrpl/README.md`](../xrpl/README.md).

## In one paragraph

GlassLedger makes NYC's community-services money visible. A map shows food pantries, shelters and youth programs, colored by how stuck the city money behind each one is. An open-data page shows every record behind the map. An AI agent pays nonprofits' verified invoices in **RLUSD on the XRP Ledger**. The agent works on its own, but it cannot pay by itself: its key is **1 of 3** signature weights. An independent co-signer (weight 2) re-checks every payment against the ledger before signing. A human officer (weight 1) signs only payments over the limit and holds the kill switch. On Testnet, the ledger itself rejects the agent acting alone (`tefBAD_QUORUM`) and a revoked agent (`tefBAD_SIGNATURE`).

## The three layers

| Layer | Where | Owner | Status |
|---|---|---|---|
| **Money map** | `web/` → `/map` | Noel | live against the API: pins, money trail, live ledger feed, demo buttons |
| **Text interface** (iMessage) | `imessage/` (:4003) | Noel | sign-up, "why?" answers via Grok, "funded ✅" alerts |
| **Open data** | `web/` → **`/data`** | Gagan | every record in plain tables (search, sort, JSON/CSV download) + **real XRPL Testnet data straight from the ledger** |

## Phases done

| Phase | What it delivered | Proof |
|---|---|---|
| **0: setup + risk checks** | repo layout, shared types, fixture API + `docs/API.md`, every integration tested | [`RISK_CHECKS.md`](RISK_CHECKS.md) |
| **1: autonomous payment** | multisig agent account (agent 1, co-signer 2, officer 1, quorum 3, **master key disabled**); co-signer as a separate process; RLUSD payment with memo + SourceTag | [payment](https://testnet.xrpl.org/transactions/147C5E48F183AD9C9E56804C807983BC950FA75214360117FA4DFC31AE31788C) · [signer list](https://testnet.xrpl.org/transactions/AF277E0FDBA770047CD70C11E3CEA93D69D0871F06D663A31F41647B6D2DA23F) · [master disabled](https://testnet.xrpl.org/transactions/D7AEB4B83D54ED8610291259C7B154B779482B79EC03EC8C9CD0E9EA78E902DF) |
| **2: guardrails + Grok** | Grok invoice verifier (JSON/text/PDF/image, never outputs an address); co-signer runs **8 checks** from the ledger + a pinned registry; every attempt recorded in MongoDB | [Grok-verified payment](https://testnet.xrpl.org/transactions/4FC19C902FC8C19F6BCA9DC31C4B06E1EF6823083A110792260CD0E60E077D09) |
| **3: payee verification, human over the limit, kill switch** | nonprofit onboarding (EIN match → Nessie bank check + micro-deposit → signed wallet challenge → on-ledger **`NYC_VERIFIED_NONPROFIT` credential**); co-signer reads credentials **on-ledger**; 72 h address-swap hold; officer service (:4004) for over-limit approval (3-signer payment), kill switch and hold resolution; simulated milestone escrow with a city test token; **`npm run demo all` passes 26/26** | table below |
| **/data page** | the third layer + `GET /xrpl/accounts` | `web/src/app/data/` |
| **Public data pull** | full raw public datasets committed (Comptroller, Checkbook, ProPublica, NYC Open Data) | [`../data/raw/public/README.md`](../data/raw/public/README.md) |

## How a payment works (and where it gets stopped)

```
invoice (JSON/text/PDF/image, untrusted)
  → Grok verifier: structured proposal only, no address field; flags injected instructions
  → payment builder (agent): destination looked up ONLY from the registry by EIN
  → agent signs (weight 1)
  → co-signer (separate process + key, never sees AI text): 8 checks incl. on-ledger credential,
       holds, duplicates, contract budget, caps; signs (weight 2) or refuses
  → over AUTO_LIMIT: pending_approval → the officer (weight 1) signs only the exact approved payment
  → XRP Ledger: needs weight 3 → agent + co-signer (autonomous) or + officer (over the limit)
```

## Guardrails, with real Testnet evidence (`npm run demo all`, 26/26, 2026-09-27 00:29 UTC)

| Guardrail | Enforced by | Scenario | Result |
|---|---|---|---|
| Autonomous payment, no human | agent + **co-signer** multisig | `happy` | [paid](https://testnet.xrpl.org/transactions/B145667D92506DE7F2F1A86B32A3A18F1907386D15B642BBB25566CEE0F29688) |
| Prompt injection in the invoice | agent policy (Grok flag, nothing signed) | `injection` a | refused `suspicious_instructions_in_invoice` |
| A tricked agent tries to pay the attacker | **co-signer** | `injection` b | refused `credential_invalid`, `destination_not_registry_wallet` |
| Leaked agent key: agent submits alone | **the ledger** | `injection` c | **`tefBAD_QUORUM`** |
| Same invoice twice | **co-signer**, from on-ledger memo history | `duplicate` | second refused `invoice_already_paid` |
| Contract budget exceeded | **co-signer**, on-ledger sum | `over-contract` | refused `contract_amount_exceeded` |
| Payee without an on-ledger credential | **co-signer**, `ledger_entry` credential | `uncredentialed` | refused `credential_invalid` (np_4 was never onboarded) |
| "We changed our bank details" | **hold** (co-signer's own record; the agent can't lift it, even by editing the database) | `address-swap` | refused `payee_change_on_hold` → officer rejects → [paid to the ORIGINAL wallet](https://testnet.xrpl.org/transactions/115FF60076BC4624EE677E7642C786AF6390E081ED9F30B8AECFCC187AA64A83) |
| Over AUTO_LIMIT (25 RLUSD) | **co-signer** + **officer** | `over-limit` | `pending_approval`; the agent pressing the officer's button gets 401; a rewritten request gets 409; officer approves → [3-signer payment](https://testnet.xrpl.org/transactions/9D87476B7F891BB370B986596D3C91796BB1B91911BFF10CEC4E5A4A4ECC2A49); replay gets 409 |
| Kill switch | **officer + co-signer** rewrite the signer list | `kill-switch` | [revoke](https://testnet.xrpl.org/transactions/9DACA09BFF0C4D02EB81748908945DA2DC180DB3444E925913AEC2AA01196FF5) → agent + co-signer get **`tefBAD_SIGNATURE`** from the ledger → [restore](https://testnet.xrpl.org/transactions/C705B7739F49712841898CF5CFD4CD16CA2A58ADE7DA3B35D7FCCFA595A62EEC) → [paid again](https://testnet.xrpl.org/transactions/1D4DF8A53A1AB596D30A75C269B4D5CB547443543970E16D25E84E737F7B4625) |
| Milestone escrow (**simulated: test token, not RLUSD**) | **co-signer** holds the unlock secret; **officer** approves the release | `escrow` | [locked](https://testnet.xrpl.org/transactions/7468E4AB2A938771AC9CC73FBF33C7B89B9D309262EB6FDD21D865DFADC890BF) → wrong report refused → release without officer refused → [released](https://testnet.xrpl.org/transactions/202D53A5FCB1EA476206F46D497ADF962ACF7B3A9E1189613330848E9A5B44F9) |
| Replay / pre-signed / extra fields / registry tampering / caps / exclusions | **co-signer** | `npm run redteam`, `npm run test:checks` (186 cases) | refused with machine-readable codes |

## What's real, what's testnet, what's demo

| Real public records | Testnet (real transactions, no monetary value) | Demo / simulated (labelled) |
|---|---|---|
| Comptroller contract appendix (42,438 contracts, registration lateness) | every agent payment, the multisig setup, kill switch, credentials, escrow | the 15 map sites and 14 nonprofits the API serves today |
| Checkbook NYC payments to Food Bank For NYC (19 checks, FY2026) | RLUSD from the real Testnet issuer, bought through the Testnet AMM | invoices, events, the exclusion list, the 4 demo nonprofits and their contracts |
| ProPublica / IRS 990 financials (10 orgs) | Grok verifications (real model, demo invoices) | the nonprofit side of onboarding (reading deposits, signing the challenge), the compromised-agent steps, the officer's "clicks" during `demo all` |
| NYC Open Data providers, contracts, sites, food supply gap | Nessie bank checks (Capital One's sandbox bank) | escrow uses a city test token (CTT) because RLUSD escrow is impossible on Testnet |

Honest limits: agent, co-signer and officer are separate processes with separate keys on one laptop, not separate machines. Approving an address change freezes that payee until it is re-onboarded (the re-onboarding flow is documented, not automated). Amounts are testnet-scale (AUTO_LIMIT 25 RLUSD).

## Run it

```bash
npm install
npm run dev:api                     # API on :4000 (fixtures)
cd web && npm run dev               # http://localhost:3000, /map, /data
npm run demo all                    # every XRPL scenario, 26 steps (auto-starts co-signer, xrpl service, officer)
# judged-demo mode: each service in its own terminal
npm run cosigner                    # :4002
npm run xrpl:service                # :4001 (agent)
npm run officer                     # :4004 (human approver)
npm run demo happy no-spawn
npm run agent:status                # signer list + master key, read from the ledger
npm run setup:xrpl                  # top up the agent's RLUSD working balance when needed
```

Testnet accounts (public): [agent account](https://testnet.xrpl.org/accounts/rE9y8ZrG9vVznrw7QyGMvWVr6TsfuSWKwN) · [treasury](https://testnet.xrpl.org/accounts/rLfrnvDZ4WsFybU8yCbA16jEvsMCQc6mkJ) · [city issuer](https://testnet.xrpl.org/accounts/rHEvmzksu87KDm8SuNt5iSWL9xSN9o9KEL) · full list: `GET /xrpl/accounts`.

## Next

| Phase | What |
|---|---|
| **4** | real nonprofits (golden: Food Bank For NYC, EIN 13-3179546), ingest the public data into Mongo, `data/risk.py` risk scores, Grok summaries |
| **5** | API reads Mongo (same shapes); agent decisions flip pins live via `/events/payment`; `/demo/:scenario` runs the real XRPL demos (replaces the escrow placeholder); golden-path test |
| 7 | demo script, reset script, deploy |

## Notes for the frontend (Noel)

The full review of both halves, the fix list before judging (frontend, iMessage and backend) and the timeline with owners are in [`../context.md`](../context.md#goals--plan-to-the-deadline).

- `/demo/escrow` in the API is still your fixture placeholder. The real simulated escrow now exists in `xrpl/` (`npm run demo escrow`); Phase 5 wires `/demo/:scenario` to it, and then the placeholder can be deleted.
- New values to show: `Decision.currency` can be **`CTT`** (simulated escrow only; label it "test token, not RLUSD"); `outcome: "pending_approval"` now really happens (officer approval, then a new `released` decision with signers agent + co-signer + officer); `enforced_by: "hold"` for the address-swap hold. New refusal codes are listed in [`API.md`](API.md#refusal-codes). Re-copy `shared/contracts.ts`.
- The officer's approve / revoke / restore buttons need an officer token header, so a browser page (or the agent) can't press them. If you want an "Approve" button in the UI, it has to go through a backend route that holds that token; don't put it in the browser.
