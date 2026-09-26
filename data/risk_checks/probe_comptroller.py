"""D3b/D3c: NYC Comptroller contract-registration lateness (retroactivity) per agency.

Source (official, downloadable, no sign-in):
  Report page : https://comptroller.nyc.gov/reports/annual-summary-contracts-report-for-the-city-of-new-york-fiscal-year-2024/
  Appendix 1  : https://comptroller.nyc.gov/wp-content/uploads/2025/01/Appendix-1-FY22-24-Parent-Contracts.xlsx
  Narrative   : https://comptroller.nyc.gov/reports/nyc-contracts/  ("Caught in the Slow Lane", Feb 2025, PDF:
                https://comptroller.nyc.gov/wp-content/uploads/documents/NYC-Contracts-Caught-in-the-Slow-Lane-1.pdf)
  Live dash   : https://www.checkbooknyc.com/late-contracts  (Comptroller Late Contracts Dashboard; behind Imperva for scripts)

The appendix is contract-level, so we compute agency metrics ourselves (reproducible) instead of
hand-copying chart figures. Parsed with the stdlib (xlsx = zip of XML), no openpyxl needed.

Usage:
  python risk_checks/probe_comptroller.py                   # downloads to data/.cache/ once
  python risk_checks/probe_comptroller.py --agencies HRA DHS DYCD --fy 2024
"""
from __future__ import annotations

import argparse
import re
import statistics
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from datetime import date, timedelta

from common import DATA_DIR, result, save_json, session

URL = "https://comptroller.nyc.gov/wp-content/uploads/2025/01/Appendix-1-FY22-24-Parent-Contracts.xlsx"
REPORT = "https://comptroller.nyc.gov/reports/annual-summary-contracts-report-for-the-city-of-new-york-fiscal-year-2024/"
CACHE = DATA_DIR / ".cache" / "appx1_fy22_24.xlsx"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def col_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_xlsx(path, sheet_name: str | None = None):
    """Yield rows (list of str) from one sheet of an .xlsx using only the stdlib."""
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iterfind("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_to_target = {r.get("Id"): r.get("Target") for r in rels}
    sheets = [(s.get("name"), s.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"))
              for s in wb.iterfind("m:sheets/m:sheet", NS)]
    name, rid = next((s for s in sheets if s[0] == sheet_name), sheets[-1])
    target = rid_to_target[rid].lstrip("/")
    target = target if target.startswith("xl/") else "xl/" + target
    for _, el in ET.iterparse(z.open(target)):
        if el.tag != f"{{{NS['m']}}}row":
            continue
        cells = {}
        for c in el.iterfind("m:c", NS):
            v = c.find("m:v", NS)
            t = c.get("t")
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
            else:
                val = v.text if v is not None else ""
            cells[col_index(c.get("r"))] = val
        el.clear()
        if cells:
            yield [cells.get(i, "") for i in range(max(cells) + 1)]


def excel_date(v: str):
    try:
        return date(1899, 12, 30) + timedelta(days=float(v))
    except (TypeError, ValueError):
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})", v or "")
        return date(*map(int, m.groups())) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agencies", nargs="*", default=["HRA", "DHS", "DYCD", "DSS"])
    ap.add_argument("--fy", type=int, default=2024)
    ap.add_argument("--show-header", action="store_true")
    ap.add_argument("--vendors", nargs="*", default=["FOOD BANK FOR NEW YORK CITY", "CITY HARVEST INC",
                                                      "COALITION FOR THE HOMELESS INC"])
    args = ap.parse_args()

    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        r = session().get(URL, timeout=120)
        r.raise_for_status()
        CACHE.write_bytes(r.content)
        print(f"downloaded {URL} ({len(r.content):,} bytes)")

    rows = read_xlsx(CACHE, "Appendix 1")
    header = None
    for row in rows:  # find the header row (first row with several non-empty text cells)
        if sum(1 for x in row if x.strip()) >= 5:
            header = [h.strip() for h in row]
            break
    print("columns:", header)
    data = [dict(zip(header, r)) for r in rows]
    print(f"rows: {len(data)}")
    if args.show_header:
        for r in data[:3]:
            print(r)

    def stats(rs):
        deltas = []
        for r in rs:
            try:
                deltas.append(float(r["Registration Delta"]))
            except ValueError:
                pass
        late = [d for d in deltas if d > 0]
        return {
            "n_contracts": len(deltas),
            "pct_registered_late": round(100 * len(late) / len(deltas), 1) if deltas else None,
            "avg_days_late_among_late": round(statistics.mean(late), 1) if late else None,
            "median_days_late_among_late": statistics.median(late) if late else None,
            "avg_registration_delta_all": round(statistics.mean(deltas), 1) if deltas else None,
            "pct_more_than_1yr_late": round(100 * sum(1 for d in deltas if d > 365) / len(deltas), 1) if deltas else None,
        }

    fy = str(args.fy)
    by_agency = defaultdict(list)
    for r in data:
        # Same exclusion as the Comptroller's report: DOE award method 32 (Small Purchase Written) are
        # really purchase orders. With it, FY24 citywide = 80.69% late (report text: 80.65%) and FY24
        # human services = 90.7% late (matches the published 90.7%). Agency figures below are unaffected.
        if r["DEPT NAME"].strip() == "DOE" and r["Award Method Code"] == "32":
            continue
        if r.get("Registration FY") == fy:
            by_agency[r["DEPT NAME"].strip()].append(r)

    out = {"source": "NYC Comptroller, Annual Summary Contracts Report FY2024, Appendix 1 (FY22-24 parent contracts)",
           "source_url": URL, "report_url": REPORT, "registration_fy": args.fy,
           "definition": "late = Registration Delta > 0, i.e. Original Registration Date after Contract Start Date "
                         "(the Comptroller's 'retroactive' registration). Days = Registration Delta. "
                         "Excludes DOE award method 32 like the report does.",
           "citywide_all": stats([r for rs in by_agency.values() for r in rs]),
           "citywide_human_services": stats([r for rs in by_agency.values() for r in rs if r["Industry"] == "HUMAN SERVICES"]),
           "agencies": {}}
    for a in args.agencies:
        key = next((k for k in by_agency if k == a or k.endswith("/" + a) or k.startswith(a + "/")), None)
        if not key:
            continue
        rs = by_agency[key]
        dept = sorted({r["Doc Dept CD"].zfill(3) for r in rs})
        out["agencies"][key] = {"doc_dept_cd": dept, "all": stats(rs),
                                "human_services": stats([r for r in rs if r["Industry"] == "HUMAN SERVICES"])}
    save_json(f"comptroller_agency_lateness_fy{args.fy}.json", out)

    # Vendor crosswalk sample: Checkbook vendor_code (Vend Cust CD) + contract ids for candidate nonprofits.
    import csv
    cols = ["Vend Cust CD", "Vendor Legal Name", "checkbook_contract_id", "DEPT NAME", "Contract Purpose",
            "Contract Registered Amount", "Contract Start Date", "Contract End Date", "Original Registration Date",
            "Registration FY", "Registration Delta", "Retroactivity Category", "Industry", "1099 Classification"]
    sample = []
    for r in data:
        if r["Vendor Legal Name"].strip().upper() in {v.upper() for v in args.vendors}:
            row = {c: r.get(c, "") for c in cols}
            # appendix-composed id; the dept segment may differ from Checkbook (HRA: 096 here vs 069 live)
            row["checkbook_contract_id"] = r["Doc CD"] + r["Doc Dept CD"].zfill(3) + r["Doc ID"]
            for c in ("Contract Start Date", "Contract End Date", "Original Registration Date"):
                d = excel_date(row[c])
                row[c] = d.isoformat() if d else row[c]
            sample.append(row)
    p = DATA_DIR / "raw" / "samples" / "comptroller_appx1_candidate_vendors.csv"
    with p.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(sorted(sample, key=lambda r: (r["Vendor Legal Name"], r["DEPT NAME"], r["Contract Start Date"])))
    print(f"wrote {len(sample)} rows -> {p}")

    # Largest FY-registered nonprofit human-service vendors per agency (candidate list for data/seed/)
    top = {}
    for a, key in (("HRA", "DSS/HRA"), ("DHS", "DHS"), ("DYCD", "DYCD")):
        agg = defaultdict(float)
        for r in by_agency.get(key, []):
            if r["Industry"] == "HUMAN SERVICES" and "Non-Profit" in r["1099 Classification"]:
                try:
                    agg[(r["Vend Cust CD"], r["Vendor Legal Name"].strip())] += float(r["Contract Registered Amount"])
                except ValueError:
                    pass
        top[a] = [{"vend_cust_cd": k[0], "name": k[1], "registered_amount": round(v)}
                  for k, v in sorted(agg.items(), key=lambda kv: -kv[1])[:5]]
    out["top_nonprofit_hs_vendors_by_registered_amount"] = top

    # Contract-ID join check. Checkbook contract id = Doc CD + 3-digit dept + Doc ID, BUT the dept segment
    # can differ: live Checkbook shows FBNYC's HRA contract as CT1-069-20228800360 while this appendix
    # has Doc Dept CD "96". (Doc CD, Doc ID) is unique here (42,435 keys / 42,438 rows), so join on that.
    ex = next(r for r in data if r["Vend Cust CD"] == "0000822784" and r["Doc ID"] == "20228800360")
    return result("D3b", "PASS", **out,
                  join_key_example={"vendor": ex["Vendor Legal Name"], "vend_cust_cd": ex["Vend Cust CD"],
                                    "appendix": [ex["Doc CD"], ex["Doc Dept CD"], ex["Doc ID"]],
                                    "checkbook_contract_id_live": "CT106920228800360",
                                    "join_key": checkbook_join_key("CT106920228800360"),
                                    "registration_delta_days": ex["Registration Delta"]})


def checkbook_join_key(contract_id: str) -> tuple[str, str]:
    """(Doc CD, Doc ID) from a Checkbook contract id; drops the 3-digit dept segment, which can drift."""
    doc_cd = contract_id[:4] if contract_id.startswith("RCT") else contract_id[:3]
    return doc_cd, contract_id[len(doc_cd) + 3:]


if __name__ == "__main__":
    main()
