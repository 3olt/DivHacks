"""Fetch the small public records ingest.py needs for the seed list, and commit them under data/raw/public/.

  python data/fetch_public_extras.py

1. ProPublica Nonprofit Explorer org JSON for every seed EIN that has no file yet
   (organization.careofname is blanked: it is often a person's name).
2. NYC Planning Labs GeoSearch for every seed row whose location_source is "irs_address"
   (the IRS/ProPublica street address) -> raw/public/geosearch/<site_id>.json.
3. Prints a name check: Comptroller appendix vendor name vs IRS/ProPublica name (crosswalk review aid).

Idempotent: files that already exist are not fetched again (pass --refresh to refetch).
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import time
from pathlib import Path

import requests

from gl_common import irs_street

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw" / "public"
SEED = HERE / "seed" / "nonprofits.csv"
UA = "DivHacks2026-ingest/0.1 (+https://github.com/3olt/DivHacks)"
PP_API = "https://projects.propublica.org/nonprofits/api/v2/organizations/{ein}.json"
GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search"


def norm(s: str) -> str:
    s = re.sub(r"[^A-Z0-9 ]", " ", s.upper())
    s = re.sub(r"\b(INC|INCORPORATED|CORP|THE)\b", " ", s)
    return " ".join(s.split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    s = requests.Session()
    s.headers["User-Agent"] = UA
    seed = list(csv.DictReader(open(SEED, encoding="utf-8", newline="")))

    (RAW / "propublica").mkdir(parents=True, exist_ok=True)
    for r in seed:
        digits = r["ein"].replace("-", "")
        out = RAW / "propublica" / f"org_{digits}.json"
        if out.exists() and not args.refresh:
            continue
        resp = s.get(PP_API.format(ein=digits), timeout=30)
        resp.raise_for_status()
        d = resp.json()
        if d.get("organization", {}).get("careofname"):
            d["organization"]["careofname"] = None
        out.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"propublica {r['ein']}: {d['organization']['name']}")
        time.sleep(0.3)

    (RAW / "geosearch").mkdir(parents=True, exist_ok=True)
    for r in seed:
        if r["location_source"] != "irs_address":
            continue
        out = RAW / "geosearch" / f"{r['site_id']}.json"
        if out.exists() and not args.refresh:
            continue
        o = json.loads((RAW / "propublica" / f"org_{r['ein'].replace('-', '')}.json").read_text(encoding="utf-8"))["organization"]
        text = f"{irs_street(r['ein'], o['address'])}, {o['city']}, NY {str(o.get('zipcode') or '')[:5]}"
        resp = s.get(GEOSEARCH, params={"text": text, "size": 1}, timeout=30)
        resp.raise_for_status()
        d = resp.json()
        feats = d.get("features") or []
        rec = {"query": text, "request_url": resp.url, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
               "feature": feats[0] if feats else None}
        out.write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")
        if feats:
            p = feats[0]["properties"]
            print(f"geosearch {r['site_id']}: {text!r} -> {feats[0]['geometry']['coordinates']} {p.get('label')} (confidence {p.get('confidence')})")
        else:
            print(f"geosearch {r['site_id']}: {text!r} -> NO MATCH")
        time.sleep(0.2)

    # Crosswalk review aid: appendix legal name vs IRS name for each vendor code.
    appx = RAW / "comptroller" / "appendix1_fy22_24_parent_contracts.csv"
    names = {}
    with open(appx, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if row["Vend Cust CD"]:
                names.setdefault(row["Vend Cust CD"], row["Vendor Legal Name"])
    for r in seed:
        o = json.loads((RAW / "propublica" / f"org_{r['ein'].replace('-', '')}.json").read_text(encoding="utf-8"))["organization"]
        a = names.get(r["checkbook_vendor_code"], "")
        same = "EXACT(normalized)" if norm(a) == norm(o["name"]) else "DIFFERENT"
        print(f"crosswalk {r['ein']} {r['checkbook_vendor_code']}: appendix={a!r} irs={o['name']!r} -> {same}")


if __name__ == "__main__":
    main()
