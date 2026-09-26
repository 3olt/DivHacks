"""D1: Checkbook NYC XML API -- contracts + spending (payments) for one nonprofit vendor.

Documented API (source of truth = the official open-source repo, because the checkbooknyc.com
HTML pages sit behind an Imperva/Incapsula JavaScript challenge):
  https://github.com/NYCComptroller/Checkbook/blob/master/source/web/modules/custom/checkbook_api/checkbook_api.routing.yml   (path: /api)
  .../checkbook_api/src/Controller/DefaultController.php   (reads the raw XML body from php://input)
  .../checkbook_api/src/HTMLDocumenation/contracts.html + spending.html   (the "API" docs page content)
  .../checkbook_api/src/config/contracts.json + spending.json   (criteria -> DB column maps, response columns)

  POST https://www.checkbooknyc.com/api
  Content-Type: application/xml     (body = <request>...</request>; no API key, no auth)
  max_records <= 1000 per call (error 1003 above that); paginate with <records_from> (1-based).

Strategy (Checkbook has NO EIN; citywide Contracts cannot filter by vendor NAME, only vendor_code):
  1. Spending: payee_name "contains" match (+ agency_code) -> check-level payments incl. contract_id.
  2. Contracts: agency_code (+ fiscal_year) and/or contract_id -> contract terms.

LIVE QUIRKS (observed 2026-09-26, see README):
  * status must be 'registered' or 'pending' (the docs' sample value 'active' returns error 1001).
  * Latency is extreme: a plain POST took 1390 s (23 min) to return even a validation error.
    Requests overlapping an in-flight request got an Imperva 503 page (edet=20) after ~15 s or
    hung. So: ONE request at a time, very long timeout, no parallelism, cache every response.

Usage:
  python risk_checks/probe_checkbook.py                                   # FBNYC @ HRA (069), both calls
  python risk_checks/probe_checkbook.py --only spending
  python risk_checks/probe_checkbook.py --only contracts --vendor-code 0000822784 --fy 2026
  python risk_checks/probe_checkbook.py --payee "COALITION FOR THE HOMELESS" --agency 071
"""
from __future__ import annotations

import argparse
import re
import time
import xml.etree.ElementTree as ET

import requests

from common import DATA_DIR, result, save_text, session

API = "https://www.checkbooknyc.com/api"
CACHE = DATA_DIR / ".cache" / "checkbook"  # full responses (gitignored via data/.gitignore)

SPENDING_COLS = ["agency", "payee_name", "associated_prime_vendor", "check_amount", "issue_date",
                 "contract_id", "contract_purpose", "document_id", "expense_category", "department",
                 "fiscal_year", "spending_category", "industry", "mocs_registered"]
CONTRACT_COLS = ["prime_contract_id", "prime_vendor", "prime_contracting_agency", "prime_contract_purpose",
                 "prime_contract_original_amount", "prime_contract_current_amount",
                 "prime_vendor_spent_to_date", "prime_contract_start_date", "prime_contract_end_date",
                 "prime_contract_registration_date", "prime_contract_version", "parent_contract_id",
                 "prime_contract_type", "prime_contract_award_method", "prime_contract_industry",
                 "prime_contract_pin", "document_code", "mocs_registered", "year"]


def xml_request(type_of_data: str, criteria: list[tuple], columns: list[str], start=1, max_records=100) -> str:
    def crit(c):
        if c[1] == "range":
            return (f"    <criteria><name>{c[0]}</name><type>range</type>"
                    f"<start>{c[2]}</start><end>{c[3]}</end></criteria>")
        return f"    <criteria><name>{c[0]}</name><type>value</type><value>{c[2]}</value></criteria>"

    return "\n".join([
        '<?xml version="1.0"?>',
        "<request>",
        f"  <type_of_data>{type_of_data}</type_of_data>",
        f"  <records_from>{start}</records_from>",
        f"  <max_records>{max_records}</max_records>",
        "  <search_criteria>",
        *[crit(c) for c in criteria],
        "  </search_criteria>",
        "  <response_columns>",
        *[f"    <column>{c}</column>" for c in columns],
        "  </response_columns>",
        "</request>",
        "",
    ])


def post(s, body: str, timeout: float, tries: int) -> dict:
    """POST one request; classify the outcome (checkbook XML vs Imperva wall vs timeout)."""
    attempts = []
    for i in range(tries):
        t0 = time.perf_counter()
        try:
            r = s.post(API, data=body.encode(), headers={"Content-Type": "application/xml"}, timeout=timeout)
            secs = round(time.perf_counter() - t0, 2)
            text = r.text
            a = {"http": r.status_code, "seconds": secs, "bytes": len(r.content),
                 "content_type": r.headers.get("Content-Type"), "server_hint": r.headers.get("X-Iinfo", "")[:40],
                 "cdn": r.headers.get("X-CDN")}
            if "Incapsula incident ID" in text or "_Incapsula_Resource" in text:
                a["outcome"] = "imperva_block"
                a["incident_id"] = (re.search(r"incident_id=([0-9-]+)", text) or [None, None])[1]
                a["edet"] = (re.search(r"edet=(\d+)", text) or [None, None])[1]
            elif "<response" in text or "<status>" in text:
                a["outcome"] = "checkbook_xml"
                a["text"] = text
            else:
                a["outcome"] = "unexpected"
                a["head"] = text[:300]
        except requests.RequestException as e:
            a = {"outcome": "network_error", "error": type(e).__name__, "detail": str(e)[:200],
                 "seconds": round(time.perf_counter() - t0, 2)}
        attempts.append(a)
        print(f"  attempt {i + 1}: " + ", ".join(f"{k}={v}" for k, v in a.items() if k != "text"), flush=True)
        if a["outcome"] == "checkbook_xml":
            break
        time.sleep(3)
    return {"attempts": attempts, "ok": attempts[-1]["outcome"] == "checkbook_xml",
            "text": attempts[-1].get("text")}


def summarize(xml_text: str, row_tag: str) -> dict:
    root = ET.fromstring(xml_text)
    status = root.findtext(".//status/result")
    msgs = [(m.findtext("code"), m.findtext("description")) for m in root.iter("message")]
    count = root.findtext(".//result_records/record_count")
    rows = [{c.tag: (c.text or "") for c in tx} for tx in root.iter(row_tag)]
    ids = sorted({r.get("contract_id") or r.get("prime_contract_id") for r in rows} - {None, "", "-"})
    return {"status": status, "messages": msgs, "record_count": count, "rows_returned": len(rows),
            "fields": sorted({k for r in rows for k in r}), "contract_ids": ids, "first_rows": rows[:3]}


def trim_xml(xml_text: str, keep=3) -> str:
    """Keep only the first `keep` <transaction> rows so committed samples stay small."""
    parts = re.split(r"(<transaction>.*?</transaction>)", xml_text, flags=re.S)
    out, n = [], 0
    for p in parts:
        if p.startswith("<transaction>"):
            n += 1
            if n > keep:
                continue
        out.append(p)
    return "".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payee", default="FOOD BANK FOR NEW YORK CITY")
    ap.add_argument("--agency", default="069", help="069 = HRA, 071 = DHS, 260 = DYCD")
    ap.add_argument("--fy", default="2026")
    ap.add_argument("--contract-id", help="query this contract (Contracts step)")
    ap.add_argument("--vendor-code", help="FMS vendor code, e.g. 0000822784 = FOOD BANK FOR NEW YORK CITY")
    ap.add_argument("--only", choices=["spending", "contracts", "both"], default="both")
    ap.add_argument("--timeout", type=float, default=1800, help="seconds; the live API can take 20+ min")
    ap.add_argument("--tries", type=int, default=1)
    args = ap.parse_args()
    s = session()
    slug = re.sub(r"[^a-z0-9]+", "_", args.payee.lower()).strip("_")[:30]
    skipped = {"attempts": [], "ok": False, "text": None, "skipped": True}

    def run(kind: str, body: str):
        save_text(f"checkbook_request_{kind}_{slug}.xml", body)
        out = post(s, body, args.timeout, args.tries)
        if out["ok"]:
            CACHE.mkdir(parents=True, exist_ok=True)
            (CACHE / f"{kind}_{slug}_{int(time.time())}.xml").write_text(out["text"], encoding="utf-8")
            save_text(f"checkbook_response_{kind}_{slug}_trimmed.xml", trim_xml(out["text"]))
        return out

    # --- 1. Spending (payments) by payee name ---------------------------------------------
    sp, sp_summary = skipped, None
    contract_ids = [args.contract_id] if args.contract_id else []
    if args.only in ("spending", "both"):
        sp_req = xml_request("Spending", [("fiscal_year", "value", args.fy), ("agency_code", "value", args.agency),
                                          ("payee_name", "value", args.payee)], SPENDING_COLS, max_records=100)
        print(f"POST {API} Spending payee={args.payee!r} agency={args.agency} fy={args.fy}", flush=True)
        sp = run("spending", sp_req)
        if sp["ok"]:
            sp_summary = summarize(sp["text"], "transaction")
            contract_ids += sp_summary["contract_ids"]

    # --- 2. Contracts (registered expense) at the agency, narrowed to one contract when known ---
    ct, ct_summary = skipped, None
    if args.only in ("contracts", "both"):
        crit = [("status", "value", "registered"), ("category", "value", "expense"),
                ("fiscal_year", "value", args.fy)]
        if args.vendor_code:
            # Preferred: the vendor's FMS code (from the Comptroller appendix "Vend Cust CD"); all agencies.
            crit.append(("vendor_code", "value", args.vendor_code))
        else:
            crit.append(("agency_code", "value", args.agency))
            if contract_ids:
                crit.append(("contract_id", "value", contract_ids[0]))
        ct_req = xml_request("Contracts", crit, CONTRACT_COLS, max_records=100)
        print(f"POST {API} Contracts criteria={crit}", flush=True)
        ct = run("contracts", ct_req)
        if ct["ok"]:
            ct_summary = summarize(ct["text"], "transaction")

    wanted = [x for x, k in ((sp, "spending"), (ct, "contracts")) if args.only in (k, "both")]
    ok = all(x["ok"] for x in wanted)
    return result(
        "D1",
        "PASS" if ok else ("PARTIAL" if any(x["ok"] for x in wanted) else "FAIL"),
        endpoint=f"POST {API}",
        headers={"Content-Type": "application/xml"},
        spending={"attempts": [{k: v for k, v in a.items() if k != "text"} for a in sp["attempts"]],
                  "summary": sp_summary},
        contracts={"attempts": [{k: v for k, v in a.items() if k != "text"} for a in ct["attempts"]],
                   "summary": ct_summary},
        vendor_ein_exposed=False,
        vendor_ein_note=("No EIN/TIN column exists in any Contracts or Spending response column "
                         "(checked config/contracts.json, config/spending.json, contracts.html, spending.html). "
                         "Vendors are identified by name (prime_vendor / payee_name) and a 10-digit FMS "
                         "vendor_customer_code (vendor_code / payee_code), e.g. 0000631395."),
    )


if __name__ == "__main__":
    main()
