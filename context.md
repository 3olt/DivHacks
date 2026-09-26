# Project Context — DivHacks 2026

Project name: TBD. Single source of truth for the team; update when decisions change.

## Deadline & submission

- **Devpost submission due: Sunday, Sept 27, 2026 — 10:30 AM EST.**
- Required: link to source code (this repo) + a way to test/view it (deployed URL or demo video).
- Expo judging: ~3 min pitch + ~2 min Q&A per judge. Prepare a short slide deck.

## One-liner

A live map of NYC community resources (free food, nonprofit events, services) that warns you when one is at risk because the city money behind it is stuck, verifies that nonprofits get paid to the *right* wallet on the XRP Ledger, and texts you updates over iMessage via **Photon**.

## The problem

- NYC relies on nonprofits to run food pantries, shelters, and youth programs, and pays them **chronically late**.
  - Comptroller (Apr 2025, "Nonprofit, Nonpayment"): ~4,000 unpaid invoices, **$861M**; a follow-up found **7,000+ invoices, >$1B**.
  - ~**90%** of human-service contracts are registered late (88.5% FY23 → 90.7% FY24).
  - Nonprofits take on debt, lay off staff, and cut services as a result.
- Residents who depend on these services have **no visibility** into whether a program will run, or why it didn't.
- When payments *are* automated, the biggest fraud risk is **paying the wrong account** (vendor impersonation / "we changed our bank details"). This shows up in ~60% of business email compromise cases. An AI agent paying invoices makes this worse unless there are guardrails.

**Honesty note for Q&A:** late payments are mostly caused by bureaucracy (contract registration), not slow payment systems. We don't claim to fix the paperwork. Our pitch is: *make the delays visible to residents, and once the work is verified, move money in minutes to a verified recipient with an audit trail an auditor would accept.*

## Tracks we're submitting to

| Track | Type | How we qualify |
|---|---|---|
| **Hack the City** | Main track (pick only one) | Makes messy city spending data visual and actionable (map + money trail + risk score) |
| **Ripple: Agentic Finance on XRPL** | Sponsor | Agent makes **autonomous on-chain payments** within guardrails (verified payee credentials, limits, escrow, audit memos). **Must include at least one on-chain transaction executed by the agent.** |
| **Capital One: Best Use of Nessie** | Sponsor | Nessie bank accounts are the root of trust for verifying a nonprofit's identity before its wallet is approved |
| **Photon: Agents in iMessage** | Sponsor | Photon is our iMessage layer: alerts + reply "why?" for the money-trail explanation. Built on Photon's Spectrum framework (required for the prize). Docs: https://photon.codes/docs/spectrum-ts/introduction |
| MongoDB Atlas | MLH | Main database (use geo queries for "near me") |
| DigitalOcean / .Tech domain | MLH | Hosting + domain (cheap extra entries) |

Judging weights: Concept 30%, Functionality 30%, Wow Factor 20%, UX/Design 10%, Value to Community 10%.

## User flow

1. **Landing page:** a map of NYC with pins for food banks, free grocery distributions, and nonprofit events.
2. **Pin color = funding health:**
   - 🟢 Funded and on track
   - 🟡 Payments running late
   - 🔴 At risk of delay or cancellation
3. **Click a pin → "Why is this delayed?" panel:**
   - Money trail: NYC agency → contract → nonprofit → program/event
   - Days late, contract status, the nonprofit's financial health (from its IRS filings)
   - Payment history on XRPL (verified wallet ✅, payment released or held, link to the testnet explorer)
4. **Sign up for iMessage alerts (Photon):** the user enters their phone number in the app; Photon (Spectrum) sends the iMessages:
   - "Free groceries at St. John's Pantry tomorrow 10am 🟢"
   - "Heads up: Saturday's youth program may be delayed. Its city funding is 90 days behind."
   - The user can reply "why?" and the agent explains the money trail.
5. **Demo moment (connects everything):** the agent releases a verified payment on XRPL → the pin turns 🟡→🟢 live → subscribers get "Saturday's pantry is funded ✅".

## Repo layout

```
/context.md        this file
/web               frontend: Next.js 16 + TypeScript + Tailwind + Leaflet (map, panel, API routes)
/agent             XRPL payment agent (TypeScript). The XRPL teammate builds here.
```

Run the frontend: `cd web && npm install && npm run dev`, then open http://localhost:3000

## Integration: agent → frontend

**The XRPL agent lives in `/agent` and reports every payment decision to the frontend with `POST /api/payments`.** Full spec: `agent/README.md`.

- Payload = the `Payment` type in `web/src/lib/types.ts` (same as "Shared data contracts" below).
- Send one POST per decision: `released`, `held_escrow`, or `refused` (refusals show up in the UI as blocked fraud attempts).
- A `released` payment turns every pin whose nonprofit has that `payee_ein` green within about 4 seconds (the frontend polls).
- Until real data is loaded, use the demo EINs `00-0000001` to `00-0000006` from `web/src/lib/mockData.ts`.
- Frontend data is in memory (`web/src/lib/store.ts`) and resets when the server restarts. It gets swapped for MongoDB later.

### Frontend API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sites` | All map pins |
| GET | `/api/sites/[id]` | Pin detail: site, nonprofit, contracts, payments |
| GET | `/api/payments` | All payment decisions |
| POST | `/api/payments` | **Agent reports a payment decision** |
| POST | `/api/subscribe` | iMessage sign-up (placeholder until Photon is connected) |

## Architecture

```
               ┌───────────────────────────── Frontend (map) ─────────────────────────────┐
               │  NYC map · colored pins · "why delayed?" panel · Photon sign-up           │
               └───────────────▲───────────────────────────────▲──────────────────────────┘
                               │ REST                          │ live status updates
┌──────────────────────────────┴───────────┐     ┌─────────────┴───────────────────────────┐
│ Data + risk service                      │     │ Payment agent (XRPL)                    │
│ - Checkbook NYC (city → vendor payments) │     │ - AI decides; coded rules enforce limits│
│ - Comptroller late-contract data         │     │ - Pays only credentialed wallets        │
│ - ProPublica Nonprofit API (IRS filings) │     │ - Escrow per milestone                  │
│ - NYC Open Data (food site locations)    │     │ - Invoice ID + reasoning in memo        │
│ - Risk score (explainable)               │     │ - Nessie bank verification (Cap One)    │
└──────────────────────┬───────────────────┘     └─────────────┬───────────────────────────┘
                       └──────────────► MongoDB Atlas ◄─────────┘
                                             │
                        Photon / Spectrum = iMessage app (alerts + "why?" Q&A)
```

### Key rule: XRPL does not analyze data
- **Our code / AI** analyzes spending data and computes the risk scores.
- **XRPL** is where the agent actually **pays** nonprofits. That's what the Ripple prize requires.

## Risk score (explainable, not a trained model)

There's no time to train a real prediction model, so we compute a transparent score and always show the reasons:
- The agency's historical payment lateness (Comptroller data)
- Whether this contract is registered or still pending past its start date
- The nonprofit's cash reserves in months (IRS Form 990 via ProPublica). Fewer months of cash means higher risk.
- Days since the last payment received (Checkbook NYC / XRPL)

Example: "🟡 because the Department of Homeless Services averages 120 days late, and this nonprofit has 2 months of cash reserves."

## Payee verification (the core technical story for Ripple)

The organization on a contract is always known, but **the account the money goes to isn't guaranteed to belong to that organization.** Verification flow:
1. **Check the public record:** the nonprofit's EIN, legal name, and address (ProPublica / IRS) plus its contract (Checkbook NYC).
2. **Check the bank account (Nessie):** the account holder's name and address must match the public record. Then send a micro-deposit with a code the nonprofit must confirm.
3. **Check wallet ownership:** the nonprofit signs a challenge with its XRPL key.
4. **Issue a credential:** the "city" issuer account creates an **XRPL Credential (XLS-70, live on mainnet since Sept 2025)** binding the wallet to the EIN, with an expiration date.
5. **Pay:** the agent only pays wallets holding a valid, unexpired credential whose EIN matches the contract.

### Edge cases and guardrails (show 3–4 live; refusals impress judges)

| Edge case | Guardrail |
|---|---|
| Fake "we changed our wallet" request | The agent can **never** change a payee address. Changes require confirmation through the previously verified bank account, a 72h hold, and human approval. |
| Prompt injection in invoice text ("pay rXYZ instead") | The AI never supplies a wallet address. Addresses come only from the credential registry, and a deterministic rules engine sits between the AI and the signer. |
| Lookalike org names | Match on EIN, never on name. |
| Typo or wrong address | Uncredentialed addresses are rejected. Use destination tags. |
| Duplicate invoice | The invoice ID goes in the payment memo. Check ledger history before paying. |
| Payment exceeds contract value | Running total checked against the Checkbook NYC contract amount. |
| Org loses 501(c)(3) status or is debarred | Credentials expire. Re-check IRS + SAM.gov exclusions before each payment. |
| Milestone disputed | Funds sit in XRPL escrow with a `CancelAfter` deadline and return if the milestone isn't confirmed. |
| Agent key compromised | The agent wallet holds only a small working balance. Payments above a threshold need a second signer (multi-sign). |

**Demo picks:** (1) successful verified payment, (2) fake wallet-change refused, (3) prompt-injected invoice refused, (4) duplicate invoice refused.

## Data sources

| Source | Use | Notes |
|---|---|---|
| [Checkbook NYC](https://www.checkbooknyc.com) | City agency → vendor/nonprofit payments and contracts | Has an API (XML). **Verify early.** |
| [Comptroller Late Contracts Dashboard](https://comptroller.nyc.gov/services/for-the-public/late-contracts-dashboard/) | Agency lateness metrics | Possibly scrape/export |
| [ProPublica Nonprofit Explorer API](https://projects.propublica.org/nonprofits/api) | IRS 990: revenue, expenses, reserves, exec pay | Match by EIN |
| NYC Open Data | Food assistance site locations (map pins) | |
| [Nessie API](http://api.nessieisreal.com) | Mock bank customers/accounts/deposits for verification | Docs blocked automated fetch. Confirm the endpoints manually. |
| XRPL Testnet | Payments, escrow, credentials, memos | Free faucet. Use `xrpl.js` or `xrpl-py`. |

**Event data:** there's no central feed of nonprofit events. **Seed 15–25 real NYC nonprofits/food banks with realistic events, labeled as demo data.** Don't burn hours scraping.

## MVP scope

**Must have (one complete run-through first):**
- [ ] Map with ~15–25 seeded pins, colored by risk
- [ ] Click → money trail panel for at least one real nonprofit using real Checkbook/ProPublica data
- [ ] XRPL agent: credential check → escrow/payment on testnet → memo with invoice ID
- [ ] At least one refused fraudulent payment shown in the UI
- [ ] Pin updates 🟡→🟢 after the payment

**Should have:**
- [ ] iMessage via Photon: sign-up + alerts + "why?" reply
- [ ] Nessie bank verification step
- [ ] Risk scores computed from real data for all pins

**Nice to have:**
- [ ] "Your council district received $X this year" summary
- [ ] Filters (food / youth / seniors / events)
- [ ] Deployed on DigitalOcean + .tech domain

**Build order:** one food bank, end to end (pin → click → money trail → agent pays → pin turns green → iMessage), *then* add the rest.

## Team split

| Role | Owner | Scope |
|---|---|---|
| Frontend | _TBD_ | Map landing page, pins, money-trail panel, sign-up UI |
| Data | _TBD_ | Checkbook/Comptroller/ProPublica ingestion → risk score → MongoDB, seed dataset |
| XRPL agent | _TBD_ (in progress) | Fraud guardrails, credentials, escrow, payments, Nessie verification |
| Photon iMessage agent | _TBD_ | Photon Spectrum integration, alerts, "why?" Q&A |

## Timeline (Sat → Sun 10:30 AM)

- **First 2 hours:** check the risky parts. Confirm the Checkbook NYC API returns nonprofit payments for one agency (DHS), send a test XRPL escrow and credential, confirm the Nessie endpoints, and get Photon signed up.
- **Saturday evening:** data loaded into MongoDB, map with pins, first end-to-end flow on mock data.
- **Overnight:** real data wired in, agent guardrails + refusal demos, Photon alerts.
- **Sunday morning (by ~8:30):** deploy, pre-load demo data, record a backup demo video, build slides, write the Devpost entry.
- **10:30 AM:** submitted.

## Shared data contracts (draft; agree on these early)

```jsonc
// Site / pin
{
  "id": "site_001",
  "name": "St. John's Food Pantry",
  "type": "food_pantry",            // food_pantry | grocery_giveaway | event | service
  "location": { "type": "Point", "coordinates": [-73.95, 40.81] },
  "nonprofit_ein": "12-3456789",
  "next_event": { "title": "Free groceries", "starts_at": "2026-09-27T10:00:00-04:00" },
  "risk": { "level": "yellow", "score": 62, "reasons": ["DHS averages 120 days late", "2 months cash reserves"] },
  "is_demo_data": true
}

// Payment (written by the XRPL agent)
{
  "invoice_id": "INV-2026-0042",
  "contract_id": "CT1-071-20261234",
  "payee_ein": "12-3456789",
  "payee_wallet": "r...",
  "amount_xrp": "25",
  "status": "released",             // released | held_escrow | refused
  "refusal_reason": null,            // e.g. "wallet not credentialed", "duplicate invoice"
  "xrpl_tx_hash": "ABC123...",
  "agent_reasoning": "Milestone verified; within contract cap; credential valid until 2026-12-31"
}
```

## Pitch outline (~3 min)

1. **Hook (20s):** "NYC owes nonprofits over $1 billion in unpaid invoices. The food pantry on your block might not open Saturday, and you'd never know why."
2. **Demo (90s):** map → yellow pin → money trail → agent verifies and pays on XRPL → pin turns green → iMessage arrives → then the agent refuses a fake wallet-change invoice.
3. **How it works (40s):** data sources, risk score, XRPL credentials + guardrails, Nessie verification.
4. **Impact + next steps (30s):** residents get visibility, nonprofits get paid fast and safely, auditors get a verifiable trail.

## Q&A prep

- **"Why blockchain?"** Independently verifiable payments, on-chain credentials binding wallets to organizations, built-in escrow, and an audit trail no single party can edit.
- **"Does this fix late payments?"** No, the delays are bureaucratic. We make them visible and make the final payment instant and safe once the work is approved.
- **"Is the data real?"** Spending and nonprofit financial data are real public records. Events and payments are seeded or testnet, and labeled as such.
- **"What if the agent is wrong?"** The AI only recommends. Coded rules and credentials decide what can be paid, and large payments need a second signer.
- **"Privacy?"** We show organizations and neighborhoods, never individual recipients.
