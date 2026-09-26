# Public data we pulled (raw)

Everything here came from public government or nonprofit-disclosure sources during the DivHacks build on **2026-09-26 (EDT)**. No sign-in and no API keys were used. Nothing here is demo data. It hasn't been ingested yet: Phase 4 loads it into MongoDB with `source` + `source_url` on every record.

**Privacy (organizations only, never individuals):**
- In the Comptroller appendix, 1,894 rows whose vendor is a person (1099 classification Individual, Sole Proprietor, Sole Prop/Small Business, Employee, Estate or Nonresident Alien) have the vendor name replaced with `[individual vendor: name withheld]` and the vendor code blanked. All other columns are unchanged. The official unredacted file is at the source URL.
- In the ProPublica records, `organization.careofname` ("in care of", often a person's name) is blanked.

| File | What it is | Rows / size | Source |
|---|---|---|---|
| `comptroller/appendix1_fy22_24_parent_contracts.csv` | Every NYC parent contract registered FY2022–FY2024: vendor, agency, purpose, amount, start date, registration date, **Registration Delta** (days late), Industry. Converted from the official xlsx | 42,438 rows | [Comptroller FY2024 Annual Summary Contracts Report, Appendix 1](https://comptroller.nyc.gov/wp-content/uploads/2025/01/Appendix-1-FY22-24-Parent-Contracts.xlsx) ([report](https://comptroller.nyc.gov/reports/annual-summary-contracts-report-for-the-city-of-new-york-fiscal-year-2024/)) |
| `comptroller/agency_lateness_fy2024_computed.json` | Our computation from the appendix: FY2024 human-services contracts registered late. HRA 87.4%, DHS 85.0%, DYCD 98.6%, citywide 90.7% (matches the published figure) | 4 agencies | derived from the row above (`data/risk_checks/probe_comptroller.py`) |
| `checkbook/spending_FOOD_BANK_FOR_NEW_YORK_CITY_HRA_FY2026.xml` | **Full** Checkbook NYC API response: all 19 FY2026 HRA/DSS checks to Food Bank For New York City ($1.75M across 3 contracts) | 19 records | `POST https://www.checkbooknyc.com/api` with the body in `…request.xml` next to it |
| `propublica/org_<EIN>.json` | Full ProPublica Nonprofit Explorer records (IRS 990 extracts) for our golden candidate and 9 other large human-services vendors | 10 orgs | `https://projects.propublica.org/nonprofits/api/v2/organizations/<EIN>.json` |
| `nyc_open_data/x882-mwt5.csv` | Verified Locations for Social Service Contracts: **providers** (HQ address, lat/lng, `provider_ein`) | 1,809 | [data.cityofnewyork.us/d/x882-mwt5](https://data.cityofnewyork.us/d/x882-mwt5) |
| `nyc_open_data/2bvn-ky2h.csv` | …**contracts** (`contract_number` = Checkbook contract id, amount, dates, agency, purpose) | 4,465 | [data.cityofnewyork.us/d/2bvn-ky2h](https://data.cityofnewyork.us/d/2bvn-ky2h) |
| `nyc_open_data/y9si-s7ab.csv` | …**sites** (service site address, lat/lng, `serves_food`, program). No DHS shelter rows: those addresses are confidential | 5,635 | [data.cityofnewyork.us/d/y9si-s7ab](https://data.cityofnewyork.us/d/y9si-s7ab) |
| `nyc_open_data/mpqk-skis.csv` | Community Food Connection quarterly report (DSS): pantry individuals served and soup-kitchen meals, citywide | 118 | [data.cityofnewyork.us/d/mpqk-skis](https://data.cityofnewyork.us/d/mpqk-skis) |
| `nyc_open_data/4kc9-zrs2.csv` | Emergency Food Supply Gap by neighborhood (NTA): supply gap lbs, food-insecure %, rank | 786 | [data.cityofnewyork.us/d/4kc9-zrs2](https://data.cityofnewyork.us/d/4kc9-zrs2) |
| `nyc_open_data/*.metadata.json` | Socrata metadata (title, columns, last updated) for each dataset | | `https://data.cityofnewyork.us/api/views/<id>.json` |

Trimmed samples and the IRS 990 XML cash extract used for `cash_months` are in [`../samples/`](../samples/). How each source behaves (Checkbook's ~23-minute latency, no EIN in Checkbook, how contract IDs join) is in [`../../risk_checks/README.md`](../../risk_checks/README.md).

## Golden-site candidates (EINs in `propublica/`)

| EIN | Organization | Why |
|---|---|---|
| 13-3179546 | Food Bank For New York City | **Golden candidate.** Real HRA emergency-food contracts and 19 FY2026 payments in Checkbook; 0.35 months of cash (FY2025 990) |
| 13-3072967 | Coalition for the Homeless | DHS contracts (Grand Central Food Program, registered 242 days late) |
| 13-3170676 | City Harvest | DYCD food-pantry contracts registered 447–959 days late |
| 26-0076866, 11-2635374, 13-2602882 | Acacia Network Housing, Samaritan Daytop Village, Project Renewal | large DHS vendors |
| 11-3112635, 13-1624228 | New York Edge, YMCA of Greater New York | large DYCD vendors |
| 11-2453853, 13-3530299 | RiseBoro Community Partnership, Comunilife | large HRA vendors |

The EIN ↔ Checkbook vendor matches for the last 7 are ProPublica exact-name hits that still need human review before Phase 4 uses them. We never match on name at runtime.

## Checksums (SHA-256, first 16 hex; computed on the files as stored in git, LF line endings)

```
52697060095e3cd1  checkbook/spending_FOOD_BANK_FOR_NEW_YORK_CITY_HRA_FY2026.request.xml  1026 bytes
db97e0f14e1db73f  checkbook/spending_FOOD_BANK_FOR_NEW_YORK_CITY_HRA_FY2026.xml  17676 bytes
9a9bb98ffab40635  comptroller/agency_lateness_fy2024_computed.json  3021 bytes
32e4903a59e658e6  comptroller/appendix1_fy22_24_parent_contracts.csv  20279296 bytes
cd55aba4a8181367  nyc_open_data/2bvn-ky2h.csv  543122 bytes
e975aa96ea4be254  nyc_open_data/2bvn-ky2h.metadata.json  20377 bytes
ececa77a2cbe1ca1  nyc_open_data/4kc9-zrs2.csv  62446 bytes
73851558868f52f8  nyc_open_data/4kc9-zrs2.metadata.json  20195 bytes
5a9b1342e892c0f9  nyc_open_data/mpqk-skis.csv  7723 bytes
ac2766bcd019ba28  nyc_open_data/mpqk-skis.metadata.json  10589 bytes
dedae7a777394050  nyc_open_data/x882-mwt5.csv  108905 bytes
1ee38ee25aeefe23  nyc_open_data/x882-mwt5.metadata.json  33556 bytes
875a3a95a6263c64  nyc_open_data/y9si-s7ab.csv  1539523 bytes
cff778469c1e203d  nyc_open_data/y9si-s7ab.metadata.json  66984 bytes
b4062cc1b51cb185  propublica/org_112453853.json  28279 bytes
22914a95b8e15c11  propublica/org_112635374.json  27854 bytes
2265622acbd5dd48  propublica/org_113112635.json  28346 bytes
240f0a530a81210e  propublica/org_131624228.json  28679 bytes
efda3dbff9072116  propublica/org_132602882.json  27866 bytes
a20c8754e0f76c7f  propublica/org_133072967.json  28728 bytes
e59a90ff6939aacc  propublica/org_133170676.json  28623 bytes
40f96fc28e106b3c  propublica/org_133179546.json  28206 bytes
237fa1bf98af9954  propublica/org_133530299.json  26065 bytes
0a282c0340393068  propublica/org_260076866.json  27660 bytes
```
