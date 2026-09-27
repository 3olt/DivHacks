# data/: Phase 4 pipeline (real public data -> MongoDB -> financial status rating)

Loads real public records for **15 real NYC nonprofits** into MongoDB (db `divhacks`), scores every site with a
deterministic, explainable 0-100 **financial status rating**, and writes a Grok summary grounded only in the score's reasons.
The raw sources and how they join are in [`raw/public/README.md`](raw/public/README.md) and
[`risk_checks/README.md`](risk_checks/README.md).

## Run it

```bash
cd data
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # Windows; .venv/bin/python on mac/linux
export PYTHONIOENCODING=utf-8                                # MONGODB_URI, XAI_API_KEY, GROK_MODEL come from the root .env

# (optional) refresh the committed public records; ingest itself never touches the network
.venv/Scripts/python fetch_public_extras.py          # ProPublica org JSON + GeoSearch for seed rows (fast, cached)
.venv/Scripts/python fetch_irs_cash.py               # IRS 990 e-file XML cash for each seed EIN (~1 min, Range requests)
.venv/Scripts/python fetch_checkbook_contracts.py --fy none --max-records 1000
                                                     # Checkbook NYC: every registered contract of the golden vendor,
                                                     # current terms + spent-to-date (~24 min! one request at a time)
.venv/Scripts/python fetch_checkbook_contracts.py    # (FY2026 variant: only contracts REGISTERED in FY2026)

.venv/Scripts/python ingest.py                 # idempotent upserts, then risk for every site
.venv/Scripts/python risk.py                   # recompute + print the table (--site <id>, --dry-run, --json)
.venv/Scripts/python summaries.py              # Grok summaries (cached by reasons hash; template on any error)
.venv/Scripts/python risk.py --simulate-xrpl 12.50   # golden: before/after one 12.50 RLUSD payment (dry run)
.venv/Scripts/python demo_reset.py             # Phase 7 reset: golden pin back to its pre-demo level
.venv/Scripts/python verify_phase4.py          # read-only: Mongo vs raw files + independent score (0 FAIL expected)
```

| File | What |
|---|---|
| `seed/nonprofits.csv` | the 15 organizations: EIN, type, agency, Checkbook vendor code, crosswalk method, why chosen, pin source |
| `ingest.py` | committed files -> `demo_state`, `agency_stats`, `nonprofits`, `contracts`, `payments`, `sites` (then `risk.py`) |
| `risk.py` | the score (`sites.risk` incl. `components`), CLI above |
| `summaries.py` | Grok (`grok-4.3`, Responses API, `store:false`, strict `json_schema`) summaries <= 25 words; cache `risk_summaries` |
| `demo_reset.py` | `demo_state.epoch = now` + recompute the golden site |
| `verify_phase4.py` | read-only check: every Mongo doc against the committed raw files (ProPublica, IRS XML, appendix, Checkbook, y9si, GeoSearch), agency_stats recomputed, provenance sweep, and the score re-implemented independently for all 15 sites; exit 1 on any FAIL |
| `gl_common.py` | constants (golden ids, demo scale, agency code map, source URLs) + Mongo helper |
| `fetch_*.py` | the three fetchers above; outputs committed under `raw/public/{propublica,geosearch,irs990,checkbook}/` |

## The 15 organizations

5 food (4 at HRA + City Harvest, whose city food contracts are at DYCD), 5 shelter providers at DHS, 5 youth
providers at DYCD. **Golden:** Food Bank For New York City (EIN 13-3179546, Checkbook vendor `0000822784`), site
`site_fbnyc` (its Hunts Point warehouse, 355 Food Center Drive, Bronx), golden contract **`CT106920258801736`** (HRA/DSS
"Prov of SNAP and emergency food assistance benefits": $2,932,500, 2023-07-01..2026-06-30, registered 2024-08-26 = 422
days late, $2,066,705 spent to date, 14 FY2026 checks = $1,309,299). The site also lists four more real FBNYC HRA
contracts from Checkbook: two SNAP Outreach contracts registered 855 and 598 days after their start with **$0 spent**,
an FY2023 SNAP Outreach contract ($375,610 of $973,700 spent), and the warehouse-and-delivery contract
`CT106920228800360` (99.5% spent, yet still receiving checks in FY2026, four years after its 2022 term).

EIN <-> Checkbook vendor links: the Comptroller appendix `Vend Cust CD` whose legal name matches the IRS/ProPublica name
(case, punctuation and "Inc" normalized; YMCA's IRS name is the long form). Only the golden row is marked reviewed (it is
also corroborated by NYC Open Data `x882-mwt5.provider_ein`); the others say `pending_human_review`. Nothing matches by
name at runtime: ingest reads the vendor code from the CSV. Candidate Comunilife was dropped (its contracts are mostly
HRA/DOHMH, not DHS) in favor of Women In Need.

## What is real, proxy, assumed, or demo

| Thing | Status | Where it comes from |
|---|---|---|
| Nonprofit name, address, revenue, expenses, net assets | **real** | IRS Form 990 e-file XML (IRS TEOS) for all 15 (`raw/public/irs990/`), ProPublica for identity |
| `financials.cash_months` | **real** for all 15 | 990 Part X lines 1+2 (cash + savings) / (Part IX line 25 expenses / 12). No proxy is scored; if an org had no XML it would be `null` and the cash factor excluded |
| Contracts (amount, start, end, registration date, purpose) | **real** | Golden org: Checkbook NYC Contracts API (current version, all years; `raw/public/checkbook/contracts_vendor_0000822784_FYnone.xml`). Other 14 orgs: Comptroller FY2024 Annual Summary Contracts Report, Appendix 1 (FY22-24 registrations), the 3 most recent contracts at the org's agency (food sites prefer food/SNAP/pantry contracts). `contract_id` in Checkbook form (`CT1` + Checkbook agency code + Doc ID; HRA is 069 in Checkbook but 096 in the appendix) |
| `contracts.spent_to_date` | **real** for the 5 golden-site contracts (Checkbook `prime_vendor_spent_to_date`); **null (not loaded)** for the other 14 orgs | `null` means "not loaded", never zero; their pace factor is excluded |
| Payments | **real**: 19 FY2026 Checkbook checks to Food Bank For NYC (`source: "checkbook"`, USD) | `raw/public/checkbook/spending_...FY2026.xml` |
| Agency lateness (`agency_stats`) | **real** (our computation, reproduces the published 90.7% citywide human-services figure) | appendix; HRA 87.4%, DHS 85.0%, DYCD 98.6% of FY2024 human-services contracts registered late |
| Site locations | **real addresses** | NYC Open Data `y9si-s7ab` service sites (City Harvest, Campaign Against Hunger, NY Common Pantry, YMCA Bed-Stuy) or the org's IRS address geocoded with NYC Planning Labs GeoSearch. **Shelter pins are the provider's public HQ**, never a shelter (DHS shelter addresses are confidential). One IRS address is corrected before geocoding (`gl_common.IRS_ADDRESS_FIXES`): PAL's IRS record reads "34 12 EAST 12TH STREET" (the slash of 34 1/2 is dropped), which GeoSearch had matched to 12 East 12th Street. The as-filed text stays in `nonprofits.address_irs_as_filed` |
| Golden contract end date | **assumed, disclosed** (see below) | `contracts.end_date_assumed`, `end_date_loaded`, `end_date_note` |
| Events on sites | **demo** (`is_demo_data: true` on each event) | seeded by `ingest.py` for 2026-10-01..10-14 |
| XRPL payments counted for the golden site | **Testnet, demo scale** (Option B) | `demo_state` |

### Golden contract end date (disclosed assumption, co-signer only)

`CT106920258801736`'s real term ended 2026-06-30 with $865,795 of $2,932,500 not yet paid; its last loaded check was
2026-06-23 and FY2027 checks are not loaded (the city often pays after a term ends: `CT106920228800360` got FY2026 checks
four years after its 2022 end). So that the co-signer's `contract_not_active` check admits the XRPL Testnet demo payment,
`ingest.py` stores `end_date: 2027-06-30` with `end_date_assumed: true`, `end_date_loaded: 2026-06-30` and an
`end_date_note` saying exactly this. **The score never uses the assumed date**: the pace factor uses `end_date_loaded`
("100% of contract term elapsed (term ended 2026-06-30)"). Only the golden contract can carry an assumed end date.

## Option B: XRPL payments on the golden site (DISCLOSED demo scale)

For the **golden site only**, the agent's real XRPL **Testnet** RLUSD payments count toward the golden contract's "paid"
at a disclosed demo scale: **1 RLUSD = $10,000** (`demo_state.scale_usd_per_rlusd`). Only `released`, `currency: "RLUSD"`,
`source: "xrpl"` payments on `demo_state.golden_contract_id` dated at/after `demo_state.epoch` count. Every other site
counts only real Checkbook USD. Testnet RLUSD has no monetary value. The disclosure appears in:
- the reasons: e.g. "RLUSD 12.50 Testnet payment counted as $125,000 at demo scale (1 RLUSD = $10,000)", and
  `risk.xrpl_counted {rlusd, usd_at_demo_scale, scale_usd_per_rlusd, note}`;
- Mongo `demo_state {_id:"golden", golden_ein, golden_site_id, golden_contract_id, scale_usd_per_rlusd, epoch, note,
  is_demo_data:true}`;
- this README.

If the contract's real paid-to-date is not loaded, the pace factor is excluded and the payment is shown as "recorded but
not scored" (it never moves a score it cannot honestly compute).

### Golden result (dry run: `risk.py --simulate-xrpl 12.50`, as of 2026-09-26)

| | level | score | pace | registration | agency | cash | first reason |
|---|---|---|---|---|---|---|---|
| before | **red** "Financially critical" | 71 | 24 | 10 | 17 | 20 | 100% of contract term elapsed (term ended 2026-06-30), 70% paid ($2,066,705 of $2,932,500) |
| after one 12.50 RLUSD payment | **yellow** "Financially strained" | 67 | 20 | 10 | 17 | 20 | RLUSD 12.50 Testnet payment counted as $125,000 at demo scale (1 RLUSD = $10,000); then "75% paid ($2,191,705 of $2,932,500)" |

**Yellow -> green is impossible for Food Bank For NYC without distorting real numbers**, so this is the closest honest
outcome (red -> yellow). Its floor is 37 points before any payment factor: 0.35 months of cash (20) + HRA's 87% late
registrations (17). Green (< 40) would need a contract registered <= 73 days late and paid on pace. Its only such HRA
contract, `CT106920228800360` (42 days late), is already 99.5% paid, so the site would start green (38) and a payment
would change nothing. Its other HRA contracts from FY2022 on were registered 138-855 days late (4-10 points), which puts
the floor at 41-47 (yellow at best). Scale choice: 1 RLUSD = $10,000 is the smallest round scale where ONE 12.50 RLUSD payment crosses a level
(`risk.py --suggest-scale`: $5,000 -> 69, $10,000 -> 67, $100,000+ -> 47; $2,500 or less stays red 70). A 1.00 RLUSD
rehearsal payment moves it 71 -> 70 (still red). The term has ended, so the elapsed share is fixed at 100%: the numbers do
not drift before the demo. `demo_reset.py` moves the epoch so the pin returns to red 71.

**Real run (verified 2026-09-27 02:54 UTC):** `npm run demo golden` paid 12.50 RLUSD on XRPL Testnet under
`CT106920258801736` to np_5 (agent + co-signer, 8/8 checks), tx
[F025742E...](https://testnet.xrpl.org/transactions/F025742EE49D76E0B15085DE6A3FCF799EC19F61F07D88FBC25BC02BC1EBEC2A).
`risk.py --site site_fbnyc`: **red 71 -> yellow 67**, with the Option B reason first. `demo_reset.py`: yellow 67 -> **red 71**
again. `demo_reset.py` resets only the scoring epoch. The co-signer's budget check still counts every RLUSD paid under the
contract, so 7 more 12.50 runs fit in the 100.00 RLUSD budget (see xrpl/README.md "Budget for repeat golden runs").

## The score (`risk.py`)

Deterministic, 0-100, higher = more financially strained. **Not** a trained model and not a prediction.

| Factor | Max | Rule |
|---|---|---|
| Payment pace | 40 | gap = share of contract term elapsed - share paid; `40 * clamp(gap / 0.5, 0, 1)` |
| Registration lateness | 20 | started but unregistered: `20 * min(1, days / 90)`; registered N days late: `10 * min(1, N / 365)` (a year late = 10: the Comptroller's worst bucket is "more than 1 year"); on time: 0 |
| Agency lateness | 20 | `20 * share of the agency's FY2024 human-services contracts registered late` |
| Cash cushion | 20 | months of cash: < 2 = 20, > 6 = 0, linear in between |

Each factor is rounded to whole points. **Missing data is never guessed:** a factor whose inputs are not loaded is
excluded, the score becomes `round(available points * 100 / available maximum)`, and a reason says so ("Payment data not
loaded yet; score uses 3 of 4 factors (rescaled to 100)"). Levels and labels match `api/src/risk.ts`: green < 40
"Financially stable", yellow 40-69 "Financially strained", red >= 70 "Financially critical"; the summary starts with the label.

Differences from the API's fixture engine (`api/src/risk.ts`), which Phase 5 should retire in favor of this:
registered-late scaling is over 365 days (fixture: 90), and missing factors are excluded + rescaled (fixture: a flat
10 points for "no 990" / "no agency data").

`sites.risk` = `{level, score, reasons[], summary, computed_at}` (the `Site` shape) **plus additive fields**:
`components {payment_pace, registration, agency, cash}` (points, or `null` when not loaded), `components_max`,
`factors_used`, `rescaled`, `summary_source` ("template" or "grok (grok-4.3)"), `reasons_hash`, `as_of`, `rule_version`,
`xrpl_counted` (golden only, else null).

Summaries: `summaries.py` asks Grok for <= 25 words using only the reasons, then checks it (starts with the label,
<= 25 words, every number appears in the reasons); one retry, else the template stays. Cached in `risk_summaries`
(`_id` = sha256 of level + reasons), so unchanged reasons never call Grok again; `risk.py` uses a cached summary only for
identical reasons. `--prewarm-golden 12.50` caches the golden site's post-payment summary ahead of a demo.

## Shared Mongo contract (builder A = data/, builder B = xrpl/)

| Collection | A writes (`$set`, keyed) | B writes |
|---|---|---|
| `nonprofits` (key `ein`) | public fields, `financials`, crosswalk, `is_demo_data:false` | only `wallet` on the golden EIN |
| `contracts` (key `contract_id`) | public terms, `source`, `source_url`, `is_demo_data:false`, end-date note | only `xrpl_budget_rlusd`, `xrpl_budget_note` on the golden contract |
| `demo_state` (`_id:"golden"`) | everything; `epoch` only on insert (then `demo_reset.py`) | reads |
| `payments` | Checkbook checks (`payment_id` `cb_<document_id>`) | XRPL payments (`source: "xrpl"`) |
| `sites`, `agency_stats`, `risk_summaries` | everything | - |

Never touched: demo nonprofits `np_1..np_4` (EIN `00-000000N`) and the demo contracts (`is_demo_data: true`; ingest
asserts it would not overwrite one). The co-signer pins the golden contract's `start_date`, `end_date`,
`nonprofit_ein`, `xrpl_budget_rlusd` at startup: re-running ingest writes the same values.

**Golden contract changed on 2026-09-26 ~22:40 EDT** from `CT106920228800360` to `CT106920258801736` once the Checkbook
all-years query returned (the first was 99.5% paid; see "Golden result"). `demo_state.golden_contract_id` now names the new
one. Done after the switch (Phase 4 verification): `npm run seed:registry` set `xrpl_budget_rlusd` 100.00 +
`xrpl_budget_note` on `CT106920258801736`; `xrpl/data/accounts.testnet.json` np_5.contract_id and
`xrpl/data/invoices/golden.json` now name it; the co-signer was restarted (it pins the new terms). A running co-signer
started before a re-ingestion that changes pinned terms reports `registry_drift` until it is restarted.
`CT106920228800360` keeps B's budget fields but is no longer golden: its term ended in 2022, so payments under it now
get `contract_not_active`.

## What Phase 5 (the API) needs

- Read `sites` (2dsphere index `location_2dsphere` exists; `id` unique), `nonprofits`, `contracts`, `payments`,
  `agency_stats` (key `code`), `decisions`. Real sites have `is_demo_data:false`; filter the demo contracts/nonprofits
  from public views or badge them.
- `GET /sites/:id/trail`: contracts = `site.contract_ids` (primary first); payments = `payments` with those
  `contract_id`s (Checkbook USD + XRPL RLUSD; never add RLUSD to the USD line); agency = `agency_stats[site.agency_code]`.
- Render `null` as "not loaded": `contracts.spent_to_date`, `risk.components.*`, `financials.cash_months`.
  (`Contract.spent_to_date` is typed `string` in shared/contracts.ts; 37 of the 42 real contracts have `null` there
  plus `spent_to_date_note`. Never coerce it to "0.00".)
- A contract with `end_date_assumed: true` (only the golden `CT106920258801736`) must be shown with its real end
  `end_date_loaded` (2026-06-30) and `end_date_note`; its `end_date` (2027-06-30) is the disclosed demo assumption that
  only the co-signer's active-term check uses.
- After `POST /events/payment` for the golden contract: recompute with `python data/risk.py --site <site_id> --json`
  (writes `sites.risk` and prints it) and broadcast `site_updated`. Any other site: same command; its score ignores XRPL.
- Reset hook (Phase 7): `python data/demo_reset.py`.
- `risk.components` is ready for the site report's stacked bar; target-vs-reach (`reach`) was not built (NTA codes in
  `y9si-s7ab` are 2010 NTAs, `4kc9-zrs2` uses 2020 NTAs; needs a crosswalk).
