"""Batch version of risk_checks/probe_irs_990_xml.py: real cash on hand (Form 990 Part X lines 1+2) for the seed EINs.

  python data/fetch_irs_cash.py            # every seed EIN without an extract yet

Streams the IRS TEOS index CSVs (2026, then 2025) ONCE for all EINs, picks each EIN's newest Form 990, then reads only
that one XML member from the ~500 MB batch zip via HTTP Range requests. Writes
data/raw/public/irs990/<ein9>_extract.json (values only + source zip/object id). ingest.py uses it for cash_months:
  cash_months = (CashNonInterestBearingGrp/EOYAmt + SavingsAndTempCashInvstGrp/EOYAmt) / (TotalFunctionalExpensesGrp/TotalAmt / 12)
EINs with no e-filed 990 in those years get no file (ingest then leaves cash_months null: never a guessed number).
"""
from __future__ import annotations

import csv
import io
import json
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "risk_checks"))

from probe_irs_990_xml import FIELDS, IRS_BASE, NS, HttpRangeFile, read_member  # noqa: E402
from common import session  # noqa: E402

OUT = HERE / "raw" / "public" / "irs990"
SEED = HERE / "seed" / "nonprofits.csv"


def scan_index(s, year: int, eins: set[str]) -> dict[str, list[dict]]:
    url = f"{IRS_BASE}/{year}/index_{year}.csv"
    hits: dict[str, list[dict]] = {}
    with s.get(url, stream=True, timeout=180) as r:
        r.raise_for_status()
        header = None
        for line in r.iter_lines(decode_unicode=True):
            if header is None:
                header = line.split(",")
                continue
            parts = line.split(",")
            if len(parts) < 4 or parts[2] not in eins:
                continue
            row = dict(zip(header, parts))
            if row.get("RETURN_TYPE") == "990":
                row["_year"] = year
                hits.setdefault(parts[2], []).append(row)
    return hits


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    seed = list(csv.DictReader(open(SEED, encoding="utf-8", newline="")))
    todo = {r["ein"].replace("-", "") for r in seed if not (OUT / f"{r['ein'].replace('-', '')}_extract.json").exists()}
    print(f"{len(todo)} EINs to fetch", flush=True)
    if not todo:
        return
    s = session()
    best: dict[str, dict] = {}
    for year in (2026, 2025):
        t0 = time.time()
        hits = scan_index(s, year, todo)
        print(f"index_{year}: hits for {len(hits)} EINs ({time.time() - t0:.0f}s)", flush=True)
        for ein, rows in hits.items():
            rows.sort(key=lambda r: r["TAX_PERIOD"], reverse=True)
            if ein not in best or rows[0]["TAX_PERIOD"] > best[ein]["TAX_PERIOD"]:
                best[ein] = rows[0]

    for ein in sorted(todo):
        row = best.get(ein)
        if not row:
            print(f"{ein}: no Form 990 in index 2025/2026", flush=True)
            continue
        year, batch, object_id = row["_year"], row["XML_BATCH_ID"], row["OBJECT_ID"]
        base = batch[:-1] if batch[-1].isalpha() else batch
        candidates = [batch] + [base + c for c in "ABCDEFGH" if base + c != batch]
        member = zf = f = zip_url = None
        try:
            for b in candidates:
                zip_url = f"{IRS_BASE}/{year}/{b}.zip"
                # A fresh reader per EIN: sharing one across EINs failed ("seek of closed file").
                head = s.head(zip_url, timeout=30, allow_redirects=False)
                if head.status_code != 200:
                    break
                f = HttpRangeFile(zip_url, s)
                zf = zipfile.ZipFile(io.BufferedReader(f, buffer_size=1 << 16))
                member = next((n for n in zf.namelist() if n.endswith(f"{object_id}_public.xml")), None)
                if member:
                    break
            if not member:
                print(f"{ein}: object {object_id} not found near batch {batch}", flush=True)
                continue
            root = ET.fromstring(read_member(f, zf.getinfo(member)))
        except Exception as e:  # network / zip quirks: skip this EIN, never guess
            print(f"{ein}: failed {type(e).__name__}: {str(e)[:150]}", flush=True)
            continue
        vals = {}
        for k, path in FIELDS.items():
            el = root.find(path, NS)
            vals[k] = el.text if el is not None else None

        def num(k):
            v = vals.get(k)
            return float(v) if v not in (None, "") else None

        expenses = num("TotalFunctionalExpensesGrp/TotalAmt") or num("CYTotalExpensesAmt")
        c1, c2 = num("CashNonInterestBearingGrp/EOYAmt"), num("SavingsAndTempCashInvstGrp/EOYAmt")
        cash = None if c1 is None and c2 is None else (c1 or 0) + (c2 or 0)
        cash_months = round(cash / (expenses / 12), 2) if cash is not None and expenses else None
        rec = {"ein": ein, "object_id": object_id, "tax_period": row["TAX_PERIOD"], "index_year": year,
               "source": "IRS Form 990 e-file XML (IRS TEOS)", "source_url": zip_url, "member": member,
               "index_url": f"{IRS_BASE}/{year}/index_{year}.csv", "values": vals, "cash": cash,
               "expenses": expenses, "cash_months": cash_months,
               "formula": "(CashNonInterestBearingGrp/EOYAmt + SavingsAndTempCashInvstGrp/EOYAmt) / (TotalFunctionalExpensesGrp/TotalAmt / 12)",
               "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        (OUT / f"{ein}_extract.json").write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")
        print(f"{ein}: FY end {vals.get('tax_period_end')} cash_months={cash_months} ({zip_url})", flush=True)


if __name__ == "__main__":
    main()
