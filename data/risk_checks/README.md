# data/risk_checks: Phase 0 data risk probes

Read-only probes against **public** city/nonprofit data. No sign-in, no API keys, no forms.
Every probe prints one JSON result line (`id`, `status`, evidence) and writes small trimmed
samples to `data/raw/samples/`. Full responses are cached in `data/.cache/` (gitignored).

Last run: 2026-09-26 (EDT), from the DivHacks venue network.

## Setup and run

```bash
cd data
python -m venv .venv                         # already created
.venv/Scripts/python -m pip install -r requirements.txt   # Windows; use .venv/bin/python on mac/linux
export PYTHONIOENCODING=utf-8

.venv/Scripts/python risk_checks/probe_checkbook.py --only spending                       # D1 (slow! see below)
.venv/Scripts/python risk_checks/probe_checkbook.py --only contracts --vendor-code 0000822784 --fy 2026
.venv/Scripts/python risk_checks/probe_propublica.py                                       # D2
.venv/Scripts/python risk_checks/probe_irs_990_xml.py --ein 133179546                     # D2b (cash fields)
.venv/Scripts/python risk_checks/probe_nyc_open_data.py                                    # D3a
.venv/Scripts/python risk_checks/probe_comptroller.py --fy 2024                            # D3b / D3c
```

`requirements.txt`: `requests`, `python-dotenv`, and `inflate64`. `inflate64` is needed only because
the IRS 990 XML zips use Deflate64, which the stdlib `zipfile` cannot decode.

| Probe | Check | Status |
|---|---|---|
| `probe_checkbook.py` | D1: Checkbook NYC XML API, contracts + spending for one nonprofit | see D1 below |
| `probe_propublica.py` | D2: ProPublica search → org → 990 fields | PASS |
| `probe_irs_990_xml.py` | D2b: cash + savings from the IRS e-file XML → `cash_months` | PASS |
| `probe_nyc_open_data.py` | D3a: NYC Open Data food/site locations + EIN crosswalk | PASS (no pantry-site dataset; see notes) |
| `probe_comptroller.py` | D3b/D3c: per-agency registration lateness + contract-ID join | PASS |

---

## D1: Checkbook NYC XML API

**Docs.** The HTML docs at checkbooknyc.com are behind an Imperva/Incapsula JavaScript challenge for
scripts: HTTP 403 with `Incapsula incident ID`, `edet=15`. We did not try to get past it. The same
docs ship in the official open-source repo, which we used as the reference:
- route `/api`: [`checkbook_api.routing.yml`](https://github.com/NYCComptroller/Checkbook/blob/master/source/web/modules/custom/checkbook_api/checkbook_api.routing.yml)
- controller reads the raw XML body (`php://input`): [`DefaultController.php`](https://github.com/NYCComptroller/Checkbook/blob/master/source/web/modules/custom/checkbook_api/src/Controller/DefaultController.php)
- parameter and column docs: [`HTMLDocumenation/contracts.html`](https://github.com/NYCComptroller/Checkbook/blob/master/source/web/modules/custom/checkbook_api/src/HTMLDocumenation/contracts.html), [`spending.html`](https://github.com/NYCComptroller/Checkbook/blob/master/source/web/modules/custom/checkbook_api/src/HTMLDocumenation/spending.html)
- criteria → DB column maps and allowed response columns: [`config/contracts.json`](https://github.com/NYCComptroller/Checkbook/blob/master/source/web/modules/custom/checkbook_api/src/config/contracts.json), [`config/spending.json`](https://github.com/NYCComptroller/Checkbook/blob/master/source/web/modules/custom/checkbook_api/src/config/spending.json)

**Request.** `POST https://www.checkbooknyc.com/api` with header `Content-Type: application/xml`
(`text/xml` also worked). No key and no auth. The body is:

```xml
<request>
  <type_of_data>Contracts|Spending|Budget|Revenue|Payroll|...</type_of_data>
  <records_from>1</records_from>          <!-- 1-based offset -->
  <max_records>100</max_records>          <!-- at most 1000 per call (error 1003: "'1001' exceeds allowed limit of '1000'") -->
  <search_criteria>
    <criteria><name>vendor_code</name><type>value</type><value>0000822784</value></criteria>
    <criteria><name>issue_date</name><type>range</type><start>2025-07-01</start><end>2026-06-30</end></criteria>
  </search_criteria>
  <response_columns><column>prime_contract_id</column>...</response_columns>
</request>
```

The response is `<response><status><result>success|failure</result><messages>…</messages></status>`
followed by `<request_criteria>` (your request echoed back) and `<result_records><record_count>N</record_count>`
with `<contract_transactions>` or `<spending_transactions>` containing one `<transaction>` per row.
To paginate, repeat the call with `records_from += max_records` until you pass `record_count`.

**Live quirks, observed 2026-09-26 (these matter for Phase 4):**
1. **Latency is extreme.** The first plain POST returned HTTP 200 `application/xml` after **1390 s
   (23 min)**, and that response was only a validation error. Sample:
   `raw/samples/checkbook_response_validation_error_1001.xml` and `.headers.txt`
   (`X-CDN: Imperva`, `Server: Apache`).
2. **One request at a time.** Every request sent while another was in flight came back as an
   Imperva 503 page (`edet=20`) after about 15 s, or hung for more than 100 s. The ingestion job
   must run strictly sequentially, cache every response, and never run on a page load.
3. **`status` must be `registered` or `pending`.** The docs' own sample request uses `active`, and
   the live API rejects it: code `1001`, "Invalid value 'active' is provided for 'status'. Valid
   values are 'pending,registered'."
4. **Citywide contracts cannot be filtered by vendor name.** `prime_vendor` exists only for NYCEDC.
   Use `vendor_code` (the 10-digit FMS vendor code). Spending supports `payee_name`
   ("contains" match) and `payee_code`.
5. **HRA agency code.** Checkbook uses agency code **069** for HRA/DSS. The API returns agency
   "Department of Social Services" and contract IDs `CT1069…`. The Comptroller appendix lists the
   same contracts under `Doc Dept CD` **96**, so never join on the 3-digit segment (see D3c).

**Fields available.**
- Contracts: `prime_contract_id`, `prime_vendor`, `prime_contracting_agency`, `prime_contract_purpose`,
  `prime_contract_original_amount`, `prime_contract_current_amount`, `prime_vendor_spent_to_date`,
  `prime_contract_start_date`, `prime_contract_end_date`, `prime_contract_registration_date`,
  `prime_contract_version`, `parent_contract_id`, `prime_contract_type`, `prime_contract_award_method`,
  `prime_contract_industry`, `prime_contract_pin`, `document_code`, `mocs_registered`, `year`, plus
  `sub_*` columns.
- Spending: `agency`, `payee_name`, `associated_prime_vendor`, `check_amount`, `issue_date`,
  `contract_id`, `contract_purpose`, `document_id`, `expense_category`, `department`, `fiscal_year`,
  `spending_category`, `industry`, `mocs_registered`, `budget_code`, `capital_project`.

**EIN: not exposed.** No Contracts or Spending response column carries an EIN or TIN. We checked
every column in `config/contracts.json` and `config/spending.json` and the two HTML docs. Vendors
appear only as a name (`prime_vendor` / `payee_name`) and an FMS code (`vendor_code` / `payee_code`;
the `vendor_code_list` reference SQL returns only `vendor_customer_code, legal_name`).
→ We link vendors to EINs through a curated crosswalk. See "Linking Checkbook vendors to EINs" below.

**Fallback.** Checkbook's web "Export" buttons and the Data Feeds page (`/data-feeds`) need no
sign-in for humans, but scripts hit the same Imperva wall. The spec's fallback, a manual CSV export
into `data/raw/`, is therefore a human step done in a browser. The Comptroller's contract-level
appendix (D3b) is a second fallback that needs no Checkbook access, for contract IDs, amounts,
dates, and registration lateness (FY22–24).

**Live result, Spending: PASS.** Request `raw/samples/checkbook_request_spending_food_bank_for_new_york_city.xml`
(`fiscal_year=2026`, `agency_code=069`, `payee_name=FOOD BANK FOR NEW YORK CITY`). Response: HTTP 200
`application/xml` after **1428.6 s**, 17,321 bytes, `<result>success</result>`, `record_count=19`, one
page. Rows are checks issued 2025-07-17 → 2026-06-23, agency "Department of Social Services",
department e.g. "EMERGENCY FOOD - OTPS":

| contract_id | contract_purpose | checks | sum(check_amount) |
|---|---|---|---|
| `CT106920258801736` | Prov of SNAP and emergency food assistance benefits | 14 | $1,309,299.38 |
| `CT106920228800360` | Prov. of warehouse and delivery of non-perishable food | 4 | $411,258.00 |
| `CT106920258802539` | SNAP Outreach services to low-income households | 1 | $26,412.67 |

Trimmed sample: `raw/samples/checkbook_response_spending_food_bank_for_new_york_city_trimmed.xml`.
Full response: `data/.cache/checkbook/`.

**Live result, Contracts:** _see "D1 contracts run" at the bottom._

---

## D2: ProPublica Nonprofit Explorer API v2 (+ IRS e-file XML for cash)

- Search: `GET https://projects.propublica.org/nonprofits/api/v2/search.json?q=food+bank+for+new+york+city&state[id]=NY`
  → 200 in 0.39 s, 1 hit: `ein=133179546`, `strein=13-3179546`, "Food Bank For New York City", Bronx, NTEE S50.
- Org: `GET https://projects.propublica.org/nonprofits/api/v2/organizations/133179546.json` → 200 in 0.04 s.
  Top-level keys: `organization`, `filings_with_data` (13), `filings_without_data` (11), `data_source`, `api_version`.
- `filings_with_data` field names:
  - total revenue → `totrevenue`
  - total functional expenses → `totfuncexpns`
  - net assets, end of year → `totnetassetend` (also `totassetsend`, `totliabend`)
  - period → `tax_prd` (YYYYMM), `tax_prd_yr`; form → `formtype` (0 = 990)
  - **cash / savings / temporary cash investments → NONE.** There is no such field (`invstmntinc` is
    investment *income*). ProPublica cannot give `cash_months` on its own.
- Most recent year with extracted data: **FY2023** (`tax_prd` 202306): revenue $164,260,366, expenses
  $168,654,639, net assets $43,532,434. The API already knows about newer returns
  (`organization.tax_period` = 2025-06-01; `filings_without_data` has the FY2024 PDF), but they are not
  extracted yet.
- **Cash comes from the IRS e-file XML** (`probe_irs_990_xml.py`). ProPublica's `download-xml` route
  shows a "Security Check" page (403) to scripts, so we go to the source: IRS TEOS at
  `https://apps.irs.gov/pub/epostcard/990/xml/<YEAR>/`. The index CSV (`index_<YEAR>.csv`, 54 MB,
  columns `RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID,XML_BATCH_ID`)
  maps an EIN to its `OBJECT_ID` and batch zip. The zips are about 500 MB, but the server supports
  Range requests, so we read only the central directory and the one member: about 6.3 MB transferred
  instead of 513 MB.
  - Quirk: the index said `2026_TEOS_XML_05A`, but the IRS split that batch; the file was in `…_05B.zip`.
    The probe tries sibling letters.
  - Quirk: members use Deflate64 (zip method 9), hence `inflate64`.
- FBNYC, FY ending 2025-06-30 (object `202621349349304557`):

  | XML path (Form 990) | value |
  |---|---|
  | `IRS990/CYTotalRevenueAmt` | 173,505,104 |
  | `IRS990/TotalFunctionalExpensesGrp/TotalAmt` (Part IX line 25) | 175,667,473 |
  | `IRS990/NetAssetsOrFundBalancesEOYAmt` | 38,879,439 |
  | `IRS990/CashNonInterestBearingGrp/EOYAmt` (Part X line 1) | 311,986 |
  | `IRS990/SavingsAndTempCashInvstGrp/EOYAmt` (Part X line 2) | 4,771,942 |
  | `IRS990/GovernmentGrantsAmt` (Part VIII 1e) | 60,859,579 |

- **Proposed formula**, where line 2 already *is* "savings and temporary cash investments":
  `cash_months = (CashNonInterestBearingGrp/EOYAmt + SavingsAndTempCashInvstGrp/EOYAmt) / (TotalFunctionalExpensesGrp/TotalAmt / 12)`
  → FBNYC FY2025: (311,986 + 4,771,942) / (175,667,473 / 12) = **0.35 months**, which scores the
  maximum in the 20-point cash-cushion component.
  Fallback when there is no XML, clearly labelled as a proxy and *not* cash:
  `net_asset_months = totnetassetend / (totfuncexpns / 12)`. FBNYC FY2023 = 3.1.
- `source_url` values to store:
  - org page (loads for scripts and humans): `https://projects.propublica.org/nonprofits/organizations/{ein}`
  - API: `https://projects.propublica.org/nonprofits/api/v2/organizations/{ein}.json`
  - filing PDF, from `filings_with_data[].pdf_url` / `filings_without_data[].pdf_url` when present, e.g.
    `https://projects.propublica.org/nonprofits/download-filing?path=IRS%2F133179546_202406_990_2025051223426611.pdf`.
    Human links only: scripts get a 403 "Security Check".
  - IRS XML: `https://apps.irs.gov/pub/epostcard/990/xml/2026/2026_TEOS_XML_05B.zip` + `object_id`.

---

## D3a: NYC Open Data (Socrata) locations

There is **no** open dataset of Community Food Connection / emergency-food pantry *site locations*.
Catalog searches for "food pantry", "emergency food", "community food connection", "soup kitchen",
"pantry", "food distribution", "get food" and "food help" found only the datasets below.

| id | dataset | rows | location? | use |
|---|---|---|---|---|
| `mpqk-skis` | Community Food Connection (Quarterly Report), DSS | 118 | no. Fields `facility, report_start_date, report_end_date, number` | citywide context: Apr–Jun 2026 = 8,291,839 pantry individuals served, 858,335 soup-kitchen meals |
| `4kc9-zrs2` | Emergency Food Supply Gap, MOFP | 786 | NTA-level (`nta, nta_name, supply_gap_lbs, food_insecure_percentage, weighted_score, rank, year`) | neighborhood unmet need |
| `x882-mwt5` | Verified Locations … Social Service Contracts, Providers | 1,809 | yes (`latitude, longitude`, HQ address) + **`provider_ein`** | EIN → provider_id (only 77/1,809 rows have an EIN) |
| `2bvn-ky2h` | Verified Locations … Contracts | 4,465 | no | `contract_number` is the **Checkbook contract id**, plus `provider_id, amount, start_date, end_date, agency_name, purpose` (FY2020 snapshot) |
| `y9si-s7ab` | Verified Locations … Sites | 5,635 | yes (`latitude, longitude, address_1, borough, zip, site_name, serves_food, bp_category`) | service sites by provider/contract. No DHS rows (shelter addresses are confidential) |
| `4d7f-74pe` | City Council Discretionary Funding (FY2009–2021) | 97,002 | yes | **`ein`** (no dash) + `legal_name_of_organization` + `agency`: city-side EIN↔name evidence |

Sample queries:
- `https://data.cityofnewyork.us/resource/x882-mwt5.json?provider_ein=13-3179546`
- `https://data.cityofnewyork.us/resource/2bvn-ky2h.json?provider_id=44`
- `https://data.cityofnewyork.us/resource/y9si-s7ab.json?provider_id=44`
- `https://data.cityofnewyork.us/resource/4d7f-74pe.json?ein=133179546&$select=legal_name_of_organization,count(*)&$group=legal_name_of_organization`

Quirks: the EIN format differs between datasets (`13-3179546` vs `133179546`). The data is dirty:
EIN 133072967 also appears once under "Heavenly Vision Christian Center". The Verified Locations
family was last updated 2021-05. Keyless geocoding works through NYC Planning Labs GeoSearch
(`https://geosearch.planninglabs.nyc/v2/search?text=355 Food Center Drive, Bronx, NY` →
`[-73.872917, 40.807808]`, BBL 2027810460). **Recommendation:** pins are nonprofit-run public sites
with real addresses from the IRS/ProPublica record or the org's site list, geocoded with GeoSearch.
Never show shelter addresses; for those, use neighborhood-level locations.

---

## D3b: Comptroller late-contract data (per agency)

- The Late Contracts Dashboard (`https://comptroller.nyc.gov/services/for-the-public/late-contracts-dashboard/`,
  FY2011–present) is served from **`https://www.checkbooknyc.com/late-contracts`**, behind the same
  Imperva wall, so scripts cannot read it.
- **Downloadable, contract-level data (used here):** FY2024 Annual Summary Contracts Report
  (`https://comptroller.nyc.gov/reports/annual-summary-contracts-report-for-the-city-of-new-york-fiscal-year-2024/`),
  Appendix 1: `https://comptroller.nyc.gov/wp-content/uploads/2025/01/Appendix-1-FY22-24-Parent-Contracts.xlsx`
  (8.9 MB, 42,438 rows). Columns include `Doc CD, Doc Dept CD, Doc ID, DEPT NAME, Vend Cust CD,
  Vendor Legal Name, 1099 Classification, Contract Purpose, Original Registration Date, Registration FY,
  Contract Registered Amount, Contract Start Date, Registration Delta, Retroactivity Category, Industry`.
- **Methodology check.** Excluding DOE award method 32, as the report does, our computation reproduces
  the published numbers. FY24 citywide: **80.69%** late (report text: "88.65% in FY23 to 80.65% in
  FY24"). FY24 human services: **90.7%** (matches the published 90.7%). FY23 human services: 88.46%
  (published 88.5%).
- **FY2024 registrations, Industry = HUMAN SERVICES**, "late" = registered after the contract start
  date (`raw/samples/comptroller_agency_lateness_fy2024.json`):

  | agency (dept code) | contracts | % late | avg days late (late ones) | median | % > 1 year late |
  |---|---|---|---|---|---|
  | DSS/HRA (096) | 222 | 87.4% | 193.8 | 94 | 17.6% |
  | DHS (071) | 133 | 85.0% | 178.1 | 178 | 7.5% |
  | DYCD (260) | 1,596 | 98.6% | 400.0 | 390 | 54.3% |
  | citywide HS | 3,527 | 90.7% | 346.2 | 318 | 39.3% |

  For comparison, the report says DYCD "registered over four-in-ten of their contracts more than a
  year late in FY24". Its per-agency chart (Chart 6) is an image, so quote *our computed* numbers
  with the appendix URL as `source_url`.
- Narrative source: "NYC Contracts: Caught in the Slow Lane", `https://comptroller.nyc.gov/reports/nyc-contracts/`
  (PDF `https://comptroller.nyc.gov/wp-content/uploads/documents/NYC-Contracts-Caught-in-the-Slow-Lane-1.pdf`).
  Note: the dashboard page's own link to it is relative and broken.

## D3c: joining Checkbook contracts to agency lateness

Yes, on the contract ID, **excluding the 3-digit department segment**. A Checkbook contract ID is
`Doc CD` + 3-digit dept + `Doc ID`, e.g. live `CT106920228800360` = `CT1` + `069` + `20228800360`.
The appendix has the same contract as `Doc CD=CT1, Doc Dept CD=96, Doc ID=20228800360`, so the dept
segment disagrees for HRA (069 vs 96). `(Doc CD, Doc ID)` is unique in the appendix (42,435 keys for
42,438 rows; no key maps to two depts). Join key = `(contract_id[:3], contract_id[6:])`; see
`checkbook_join_key()` in `probe_comptroller.py`. Result: FBNYC's HRA warehouse/delivery contract was
registered **42 days late**. The agency comes from Checkbook's agency name/code
(069 = HRA/DSS, 071 = DHS, 260 = DYCD) or from the appendix `DEPT NAME`, which keys `agency_stats`.
Per-contract lateness is available directly: from the appendix (`Registration Delta`, FY22–24
registrations) or from Checkbook (`prime_contract_registration_date - prime_contract_start_date`).
Contracts registered after FY24 (e.g. `CT106920258801736`) are only in Checkbook.

---

## Linking Checkbook vendors to EINs (never by name at runtime)

Checkbook has no EIN. We keep a **reviewed crosswalk** in `data/seed/nonprofits.csv` with
`ein, checkbook_vendor_code, legal_name, evidence_urls`, built once per nonprofit:
1. EIN from IRS/ProPublica (`organizations/{ein}.json`: legal name + address).
2. `checkbook_vendor_code` = the Comptroller appendix `Vend Cust CD` for the same legal name
   (`raw/samples/comptroller_appx1_candidate_vendors.csv`). FBNYC = `0000822784`,
   City Harvest = `0000822619`, Coalition for the Homeless = `0000813333`.
3. City-side corroboration where it exists: `x882-mwt5.provider_ein` or `4d7f-74pe.ein` with a
   matching legal name.
4. All Checkbook calls then use `vendor_code` / `payee_code`, never names. A person reviews each
   crosswalk row; the pipeline never auto-matches names.

## Golden nonprofit candidates

1. **Food Bank For New York City**. EIN 13-3179546, Checkbook vendor `0000822784`, NTEE S50.
   Live Checkbook FY2026: 19 HRA/DSS payments ($1.75M) on three contracts, including the emergency-food
   warehouse/delivery contract `CT106920228800360` ($4,393,582 registered, 42 days late; FY2020
   predecessor `CT106920201406469`) and `CT106920258801736` (SNAP and emergency food assistance),
   plus DYCD/ACS/DFTA pantry contracts. FY2025 990 shows 0.35 months of cash and $60.9M in government
   grants. Real address: 355 Food Center Drive, Bronx (IRS), HQ 39 Broadway (city providers dataset).
   All data sources line up.
2. **Coalition for the Homeless** (EIN 13-3072967, vendor `0000813333`, NY). Has DHS contracts,
   including the "Grand Central Food Pgm" mobile food program (`CT107120238805505`, 242 days late),
   and HRA homelessness prevention contracts.
3. **City Harvest** (EIN 13-3170676, vendor `0000822619`). DYCD food-pantry and food-rescue
   contracts registered 447–959 days late.

Larger FY24 human-service nonprofit vendors to consider for the 15–25 seed list. The vendor code
comes from the appendix; the EIN is the ProPublica search top hit with an exact legal-name match,
**still to be reviewed**:

| agency | vendor (appendix legal name) | vendor code | EIN (ProPublica) |
|---|---|---|---|
| DHS | ACACIA NETWORK HOUSING INC | 0002375758 | 26-0076866 |
| DHS | SAMARITAN DAYTOP VILLAGE INC | 0000519042 | 11-2635374 |
| DHS | PROJECT RENEWAL INC | 0000779131 | 13-2602882 |
| DYCD | NEW YORK EDGE INC | 0001539280 | 11-3112635 |
| DYCD | YMCA OF GREATER NEW YORK | 0000758190 | 13-1624228 |
| HRA | RISEBORO COMMUNITY PARTNERSHIP INC | 0000498210 | 11-2453853 |
| HRA | COMUNILIFE INC | 0000862903 | 13-3530299 |

## Samples in `data/raw/samples/`

| file | what |
|---|---|
| `checkbook_request_{spending,contracts}_food_bank_for_new_york_city.xml` | exact request bodies sent |
| `checkbook_response_validation_error_1001.xml` (+ `.headers.txt`) | live API response (23 min latency) |
| `checkbook_response_*_trimmed.xml` | live data responses, first 3 rows (if the D1 run succeeded) |
| `propublica_search_sample.json`, `propublica_org_133179546_trimmed.json` | ProPublica responses (trimmed) |
| `irs990_133179546_2025-06-30_extract.xml` | the Form 990 values we use (extracted, not the whole return) |
| `nyc_open_data_133179546_sample.json` | Socrata metadata + FBNYC provider/contracts/sites + GeoSearch |
| `comptroller_agency_lateness_fy2024.json` | computed agency lateness (HRA/DHS/DYCD + citywide) |
| `comptroller_appx1_candidate_vendors.csv` | 43 contract rows for FBNYC, City Harvest, Coalition for the Homeless |
