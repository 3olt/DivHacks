"""D2: ProPublica Nonprofit Explorer API v2 -- EIN lookup + 990 financial fields.

Usage:
  python risk_checks/probe_propublica.py                       # default: Food Bank For New York City
  python risk_checks/probe_propublica.py --q "city harvest" --state NY
  python risk_checks/probe_propublica.py --ein 133179546

Findings are summarised in risk_checks/README.md. Key one: `filings_with_data` has NO cash or
savings fields, so cash_months needs the IRS e-file XML (see probe_irs_990_xml.py).
"""
from __future__ import annotations

import argparse

from common import result, save_json, session, timed

API = "https://projects.propublica.org/nonprofits/api/v2"
ORG_PAGE = "https://projects.propublica.org/nonprofits/organizations/{ein}"

# The 990 fields we would use from filings_with_data (IRS SOI extract column names).
WANTED = ["tax_prd", "tax_prd_yr", "formtype", "totrevenue", "totfuncexpns", "totassetsend",
          "totliabend", "totnetassetend", "pdf_url", "updated"]
CASHLIKE_HINTS = ("cash", "sav", "bank")  # note: invstmntinc = investment INCOME, not cash


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--q", default="food bank for new york city")
    ap.add_argument("--state", default="NY")
    ap.add_argument("--ein", help="skip search; 9 digits, no dash")
    args = ap.parse_args()
    s = session()

    ein = args.ein
    if not ein:
        url = f"{API}/search.json"
        r, secs = timed(s.get, url, params={"q": args.q, "state[id]": args.state}, timeout=30)
        r.raise_for_status()
        d = r.json()
        orgs = d.get("organizations", [])
        print(f"GET {r.url} -> {r.status_code} in {secs}s; total_results={d.get('total_results')}")
        for o in orgs[:5]:
            print(f"  ein={o.get('ein')} strein={o.get('strein')} name={o.get('name')!r} "
                  f"city={o.get('city')} ntee={o.get('ntee_code')} score={o.get('score')}")
        if not orgs:
            return result("D2", "FAIL", reason="no search hits", url=r.url)
        ein = str(orgs[0]["ein"]).zfill(9)
        save_json("propublica_search_sample.json", {**{k: d[k] for k in d if k != "organizations"},
                                                    "organizations": orgs[:3]})

    url = f"{API}/organizations/{ein}.json"
    r, secs = timed(s.get, url, timeout=30)
    r.raise_for_status()
    d = r.json()
    org = d["organization"]
    fwd = d.get("filings_with_data", [])
    fwod = d.get("filings_without_data", [])
    print(f"GET {url} -> {r.status_code} in {secs}s; filings_with_data={len(fwd)} filings_without_data={len(fwod)}")

    latest = max(fwd, key=lambda f: f["tax_prd"]) if fwd else {}
    all_keys = sorted({k for f in fwd for k in f})
    cash_like = [k for k in all_keys if any(h in k.lower() for h in CASHLIKE_HINTS)]
    exp = latest.get("totfuncexpns") or 0
    net_asset_months = round(latest["totnetassetend"] / (exp / 12), 2) if exp else None

    # Trimmed sample: organization header + the 2 newest filings, WANTED fields only.
    save_json(f"propublica_org_{ein}_trimmed.json", {
        "_source": url,
        "organization": {k: org.get(k) for k in ["ein", "name", "address", "city", "state", "zipcode",
                                                  "ntee_code", "subsection_code", "ruling_date",
                                                  "tax_period", "revenue_amount", "asset_amount",
                                                  "income_amount", "latest_object_id", "updated_at"]},
        "filings_with_data": [{k: f.get(k) for k in WANTED}
                              for f in sorted(fwd, key=lambda f: f["tax_prd"], reverse=True)[:2]],
        "filings_without_data": fwod[:2],
        "data_source": d.get("data_source"),
        "api_version": d.get("api_version"),
    })

    return result(
        "D2",
        "PASS" if fwd else "PARTIAL",
        ein=ein,
        name=org.get("name"),
        address=f"{org.get('address')}, {org.get('city')}, {org.get('state')} {org.get('zipcode')}",
        ntee_code=org.get("ntee_code"),
        org_page_url=ORG_PAGE.format(ein=ein),
        api_url=url,
        latest_filing_with_data={k: latest.get(k) for k in WANTED},
        newest_filing_any=max([f.get("tax_prd") for f in fwd + fwod] or [None]),
        organization_tax_period=org.get("tax_period"),
        cash_like_fields_in_filings_with_data=cash_like,
        filing_keys=all_keys,
        net_asset_months_proxy=net_asset_months,
        pdf_urls_in_filings_with_data=sum(1 for f in fwd if f.get("pdf_url")),
        pdf_urls_in_filings_without_data=[f.get("pdf_url") for f in fwod[:3]],
    )


if __name__ == "__main__":
    main()
