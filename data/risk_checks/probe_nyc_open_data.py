"""D3a (+ EIN crosswalk): NYC Open Data (Socrata SODA 2.x, no key needed for light use).

What exists (found via the Socrata catalog API, 2026-09-26):
  mpqk-skis  Community Food Connection (Quarterly Report), DSS -- citywide totals only, NO site locations
  4kc9-zrs2  Emergency Food Supply Gap, MOFP -- per-NTA (neighborhood) unmet food need, no sites
  x882-mwt5  Verified Locations ... Social Service Contracts - Providers -- provider_ein + HQ lat/lng (2021 snapshot)
  2bvn-ky2h  Verified Locations ... - Contracts -- contract_number in Checkbook format (CT1 + agency + year + seq)
  y9si-s7ab  Verified Locations ... - Sites -- service sites with lat/lng, serves_food, joined by provider_id/contract_id
  4d7f-74pe  City Council Discretionary Funding (FY2009-2021) -- ein + legal_name_of_organization + lat/lng
Geocoding without a key: NYC Planning Labs GeoSearch https://geosearch.planninglabs.nyc/v2/search?text=...

Usage:
  python risk_checks/probe_nyc_open_data.py                 # default EIN 13-3179546 (Food Bank For NYC)
  python risk_checks/probe_nyc_open_data.py --ein 13-3072967
"""
from __future__ import annotations

import argparse

from common import result, save_json, session, timed

SODA = "https://data.cityofnewyork.us/resource/{id}.json"
VIEW = "https://data.cityofnewyork.us/api/views/{id}.json"
GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search"

DATASETS = {
    "cfc_quarterly": "mpqk-skis",
    "supply_gap": "4kc9-zrs2",
    "providers": "x882-mwt5",
    "contracts": "2bvn-ky2h",
    "sites": "y9si-s7ab",
    "council_discretionary": "4d7f-74pe",
}


def q(s, ds, **params):
    r, secs = timed(s.get, SODA.format(id=DATASETS[ds]), params=params, timeout=60)
    r.raise_for_status()
    return r.json(), secs, r.url


def meta(s, ds):
    v = s.get(VIEW.format(id=DATASETS[ds]), timeout=60).json()
    rows = q(s, ds, **{"$select": "count(*)"})[0][0]
    return {"id": DATASETS[ds], "name": v.get("name"), "rows": int(list(rows.values())[0]),
            "fields": [c["fieldName"] for c in v.get("columns", [])],
            "page": f"https://data.cityofnewyork.us/d/{DATASETS[ds]}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ein", default="13-3179546", help="with dash (Providers) -- dash is stripped for 4d7f-74pe")
    ap.add_argument("--address", default="355 Food Center Drive, Bronx, NY")
    args = ap.parse_args()
    s = session()
    ein_dash, ein_plain = args.ein, args.ein.replace("-", "")
    out = {"datasets": {k: meta(s, k) for k in DATASETS}}

    # CFC: latest quarter, citywide
    cfc, _, url = q(s, "cfc_quarterly", **{"$order": "report_end_date DESC", "$limit": 2})
    out["cfc_latest_quarter"] = {"rows": cfc, "query": url}

    # Supply gap: latest year, top 3 neighborhoods by weighted_score rank
    sg_year = q(s, "supply_gap", **{"$select": "max(year)"})[0][0]
    y = list(sg_year.values())[0]
    sg, _, url = q(s, "supply_gap", **{"$where": f"year={y}", "$order": "rank ASC", "$limit": 3})
    out["supply_gap_top3"] = {"year": y, "rows": sg, "query": url}

    # EIN -> provider -> contracts (Checkbook-format ids) -> sites
    prov, _, url = q(s, "providers", provider_ein=ein_dash)
    out["providers_for_ein"] = {"rows": prov, "query": url,
                                "ein_coverage": q(s, "providers", **{"$select": "count(*),count(provider_ein)"})[0][0]}
    if prov:
        pid = prov[0]["provider_id"]
        ctr, _, url = q(s, "contracts", provider_id=pid, **{"$order": "amount DESC"})
        out["contracts_for_provider"] = {"rows": ctr, "query": url}
        sites, _, url = q(s, "sites", provider_id=pid, **{
            "$select": "site_id,contract_id,program_id,agency_name,site_name,address_1,borough,zip,"
                       "latitude,longitude,serves_food,bp_category"})
        out["sites_for_provider"] = {"rows": sites, "query": url}

    # City Council discretionary: EIN <-> legal name(s) seen by the city
    names, _, url = q(s, "council_discretionary", ein=ein_plain, **{
        "$select": "legal_name_of_organization,count(*),min(fiscal_year),max(fiscal_year),sum(amount)",
        "$group": "legal_name_of_organization"})
    out["council_discretionary_names_for_ein"] = {"rows": names, "query": url}

    # Geocode (no key)
    g = s.get(GEOSEARCH, params={"text": args.address, "size": 1}, timeout=30).json()
    f = (g.get("features") or [None])[0]
    out["geosearch"] = {"text": args.address,
                        "result": f and {"coordinates_lng_lat": f["geometry"]["coordinates"],
                                         "label": f["properties"].get("label"),
                                         "confidence": f["properties"].get("confidence"),
                                         "bbl": ((f["properties"].get("addendum") or {}).get("pad") or {}).get("bbl")}}

    save_json(f"nyc_open_data_{ein_plain}_sample.json", out)
    ok = bool(prov) and bool(out.get("contracts_for_provider", {}).get("rows"))
    return result("D3a", "PASS" if ok else "PARTIAL",
                  summary={k: {"rows": v["rows"], "id": v["id"]} for k, v in out["datasets"].items()},
                  cfc_latest_quarter=out["cfc_latest_quarter"]["rows"],
                  provider=prov[:1], contract_ids=[c["contract_number"] for c in out.get("contracts_for_provider", {}).get("rows", [])],
                  sites_with_coords=sum(1 for x in out.get("sites_for_provider", {}).get("rows", []) if x.get("latitude")),
                  council_names=out["council_discretionary_names_for_ein"]["rows"],
                  geosearch=out["geosearch"]["result"])


if __name__ == "__main__":
    main()
