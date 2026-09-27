"""Fetch current Checkbook NYC contract terms for one vendor (by FMS vendor code) and cache the raw XML.

One request only (the live API takes ~20-25 min and rejects overlapping requests). Reuses the
request builder + classifier from risk_checks/probe_checkbook.py.

  python data/fetch_checkbook_contracts.py                       # Food Bank For NYC, FY2026
  python data/fetch_checkbook_contracts.py --vendor-code 0000822784 --fy 2027
  python data/fetch_checkbook_contracts.py --contract-id CT106920228800360 --fy none   # one contract, any FY
  python data/fetch_checkbook_contracts.py --fy none --max-records 1000                # every registered contract of the vendor

NOTE (observed 2026-09-26): with fiscal_year=2026 the API returns the contracts REGISTERED in FY2026 (4 for this
vendor), not every contract active in FY2026, so older multi-year contracts need a contract_id query.

Output: data/raw/public/checkbook/contracts_vendor_<code>_FY<fy>.xml (+ .request.xml)
ingest.py reads it if present (current start/end, current amount, spent-to-date).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "risk_checks"))

from probe_checkbook import API, CONTRACT_COLS, post, xml_request  # noqa: E402
from common import session  # noqa: E402

OUT_DIR = HERE / "raw" / "public" / "checkbook"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vendor-code", default="0000822784")
    ap.add_argument("--fy", default="2026", help='"none" = no fiscal_year criterion')
    ap.add_argument("--contract-id", help="query one contract instead of the vendor")
    ap.add_argument("--max-records", type=int, default=100, help="<= 1000")
    ap.add_argument("--timeout", type=float, default=2400)
    args = ap.parse_args()
    crit = [("status", "value", "registered"), ("category", "value", "expense")]
    if args.fy != "none":
        crit.append(("fiscal_year", "value", args.fy))
    crit.append(("contract_id", "value", args.contract_id) if args.contract_id else ("vendor_code", "value", args.vendor_code))
    # QUIRK (observed): without fiscal_year the API uses its "Registered Contracts (expense) All Years" domain, which
    # rejects the response column `year` (error 1106, after a 24-minute wait).
    cols = CONTRACT_COLS if args.fy != "none" else [c for c in CONTRACT_COLS if c != "year"]
    body = xml_request("Contracts", crit, cols, max_records=args.max_records)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = (f"contracts_{args.contract_id}_FY{args.fy}" if args.contract_id
            else f"contracts_vendor_{args.vendor_code}_FY{args.fy}")
    (OUT_DIR / f"{stem}.request.xml").write_text(body, encoding="utf-8")
    print(f"POST {API} Contracts {crit}", flush=True)
    out = post(session(), body, args.timeout, 1)
    if out["ok"]:
        (OUT_DIR / f"{stem}.xml").write_text(out["text"], encoding="utf-8")
        print(f"saved {OUT_DIR / (stem + '.xml')}", flush=True)
    else:
        print("no checkbook XML returned", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
