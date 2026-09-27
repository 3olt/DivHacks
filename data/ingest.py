"""Phase 4 ingest: committed public records -> MongoDB (db divhacks). Idempotent upserts; safe to re-run.

  python data/ingest.py            # everything, then risk.py for all sites
  python data/ingest.py --no-risk  # skip the risk recompute at the end

Reads ONLY committed files (data/seed/nonprofits.csv, data/raw/public/**, data/raw/samples/irs990_*); no network.
Writes (Builder A fields only; see data/README.md "Shared Mongo contract"):
  demo_state   {_id:"golden"}: golden ids + Option B scale; `epoch` only on insert (demo_reset.py moves it)
  agency_stats HRA / DHS / DYCD from the Comptroller appendix computation
  nonprofits   public fields by EIN ($set; never touches `wallet`, never touches demo EINs 00-000000N)
  contracts    Comptroller appendix contracts (+ Checkbook current terms for the golden contract when cached)
  payments     the 19 real FY2026 Checkbook checks to Food Bank For NYC (source "checkbook", USD)
  sites        one real location per nonprofit (+ seeded events flagged is_demo_data)
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import xml.etree.ElementTree as ET
from datetime import date

from pymongo import UpdateOne

from gl_common import (AGENCIES, APPENDIX_REPORT_URL, APPENDIX_SOURCE, APPENDIX_URL, CHECKBOOK_API, GEOSEARCH_URL,
                       GOLDEN_CONTRACT_ID, GOLDEN_EIN, GOLDEN_SITE_ID, IRS_ADDRESS_FIXES, OPEN_DATA_SITES_URL,
                       PROPUBLICA_API, PROPUBLICA_ORG_PAGE, RAW, SAMPLES, SCALE_USD_PER_RLUSD, SEED_CSV, db, ein9,
                       irs_street, utcnow_iso)

TODAY = date.today()
CHECKBOOK_SPENDING_XML = RAW / "checkbook" / "spending_FOOD_BANK_FOR_NEW_YORK_CITY_HRA_FY2026.xml"
CHECKBOOK_SPENDING_REQ = "data/raw/public/checkbook/spending_FOOD_BANK_FOR_NEW_YORK_CITY_HRA_FY2026.request.xml"
CHECKBOOK_CONTRACTS_GLOB = "contracts_*.xml"
# If a loaded contract term has ended but the city is still paying it, the co-signer's contract_not_active check would
# refuse every payment. For the GOLDEN contract only we then assume this end date and DISCLOSE it on the doc + in docs.
ASSUMED_END = "2027-06-30"

BORO = {"manhattan": "Manhattan", "bronx": "Bronx", "brooklyn": "Brooklyn", "queens": "Queens",
        "staten is": "Staten Island", "staten island": "Staten Island"}

EVENT_TEMPLATES = {
    "food_pantry": [("Pantry distribution day", "2026-10-03T10:00:00-04:00"),
                    ("Weekday pantry hours", "2026-10-08T14:00:00-04:00")],
    "grocery_giveaway": [("Free produce Mobile Market", "2026-10-02T11:00:00-04:00"),
                         ("Free produce Mobile Market", "2026-10-09T11:00:00-04:00")],
    "shelter": [("Community resource and benefits table", "2026-10-06T13:00:00-04:00")],
    "youth_program": [("After-school program open house", "2026-10-01T16:00:00-04:00"),
                      ("Family enrollment night", "2026-10-14T18:00:00-04:00")],
}


# ---------------------------------------------------------------------------------------------------------------
# loaders (committed files only)
# ---------------------------------------------------------------------------------------------------------------
def load_seed() -> list[dict]:
    with open(SEED_CSV, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def load_propublica(ein: str) -> dict:
    return json.loads((RAW / "propublica" / f"org_{ein9(ein)}.json").read_text(encoding="utf-8"))


def load_irs_extract(ein: str) -> dict | None:
    p = RAW / "irs990" / f"{ein9(ein)}_extract.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def load_appendix(codes: set[str]) -> list[dict]:
    with open(RAW / "comptroller" / "appendix1_fy22_24_parent_contracts.csv", encoding="utf-8-sig", newline="") as f:
        return [r for r in csv.DictReader(f) if r["Vend Cust CD"] in codes]


def load_open_data_sites() -> dict[str, dict]:
    with open(RAW / "nyc_open_data" / "y9si-s7ab.csv", encoding="utf-8-sig", newline="") as f:
        return {r["site_id"]: r for r in csv.DictReader(f)}


def xml_rows(path) -> list[dict]:
    root = ET.fromstring(path.read_text(encoding="utf-8"))
    return [{c.tag: (c.text or "").strip() for c in tx} for tx in root.iter("transaction")]


def load_checkbook_contract_terms() -> dict[str, dict]:
    """Current Checkbook terms by contract id, from fetch_checkbook_contracts.py output (if it arrived)."""
    out: dict[str, dict] = {}
    for p in sorted((RAW / "checkbook").glob(CHECKBOOK_CONTRACTS_GLOB)):
        if p.name.endswith(".request.xml"):
            continue
        try:
            rows = xml_rows(p)
        except ET.ParseError:
            continue
        for r in rows:
            cid = r.get("prime_contract_id") or r.get("contract_id")
            if not cid:
                continue
            r["_file"] = f"data/raw/public/checkbook/{p.name}"
            r["_registered_fy2026_query"] = "_FY2026" in p.name
            prev = out.get(cid)
            if prev is None or int(num(r.get("prime_contract_version")) or 0) >= int(num(prev.get("prime_contract_version")) or 0):
                r["_registered_fy2026_query"] = r["_registered_fy2026_query"] or bool(prev and prev["_registered_fy2026_query"])
                out[cid] = r
    return out


# ---------------------------------------------------------------------------------------------------------------
# builders
# ---------------------------------------------------------------------------------------------------------------
def num(x) -> float | None:
    try:
        return float(str(x).replace(",", "").replace("$", ""))
    except (TypeError, ValueError):
        return None


def checkbook_id(row: dict) -> str:
    """Appendix (Doc CD, Doc Dept CD, Doc ID) -> Checkbook contract id, using Checkbook's agency code (HRA 069 != 096)."""
    dept_to_cb = {v[0]: v[1] for v in AGENCIES.values()}
    return f"{row['Doc CD']}{dept_to_cb[row['DEPT NAME']]}{row['Doc ID']}"


def agency_stats_docs() -> list[dict]:
    j = json.loads((RAW / "comptroller" / "agency_lateness_fy2024_computed.json").read_text(encoding="utf-8"))
    docs = []
    for code, (dept, cb, name) in AGENCIES.items():
        hs = j["agencies"][dept]["human_services"]
        docs.append({
            "code": code, "name": name,
            "pct_contracts_registered_late": round(hs["pct_registered_late"] / 100, 3),
            "avg_days_registered_late": round(hs["avg_days_late_among_late"]),
            "fiscal_year": j["registration_fy"],
            "source": j["source"] + " (our computation: FY2024 registrations, industry HUMAN SERVICES)",
            "source_url": j["source_url"], "report_url": j["report_url"],
            "n_contracts": hs["n_contracts"], "median_days_registered_late": hs["median_days_late_among_late"],
            "pct_more_than_1yr_late": round(hs["pct_more_than_1yr_late"] / 100, 3),
            "definition": j["definition"], "checkbook_agency_code": cb, "appendix_dept_name": dept,
            "computed_by": "data/risk_checks/probe_comptroller.py -> data/raw/public/comptroller/agency_lateness_fy2024_computed.json",
            "is_demo_data": False,
        })
    return docs


def financials_for(ein: str, pp: dict) -> dict:
    irs = load_irs_extract(ein)
    if irs is None and ein == GOLDEN_EIN:  # the Phase 0 extract committed under raw/samples/
        x = ET.fromstring((SAMPLES / "irs990_133179546_2025-06-30_extract.xml").read_text(encoding="utf-8"))
        v = {c.tag: c.text for c in x}
        exp = float(v["TotalFunctionalExpensesGrp_TotalAmt"])
        irs = {"values": {"tax_period_end": v["tax_period_end"], "CYTotalRevenueAmt": v["CYTotalRevenueAmt"],
                          "NetAssetsOrFundBalancesEOYAmt": v["NetAssetsOrFundBalancesEOYAmt"]},
               "expenses": exp, "cash": float(v["CashNonInterestBearingGrp_EOYAmt"]) + float(v["SavingsAndTempCashInvstGrp_EOYAmt"]),
               "source_url": "https://apps.irs.gov/pub/epostcard/990/xml/2026/2026_TEOS_XML_05B.zip",
               "object_id": "202621349349304557"}
        irs["cash_months"] = round(irs["cash"] / (exp / 12), 2)
    org_page = PROPUBLICA_ORG_PAGE.format(ein9=ein9(ein))
    if irs and irs.get("expenses"):
        v = irs["values"]
        return {
            "fiscal_year": int(v["tax_period_end"][:4]),
            "revenue": num(v.get("CYTotalRevenueAmt")), "expenses": irs["expenses"],
            "net_assets": num(v.get("NetAssetsOrFundBalancesEOYAmt")),
            "cash_months": irs.get("cash_months"), "cash_on_hand": irs.get("cash"),
            "tax_period_end": v["tax_period_end"],
            "cash_basis": "IRS Form 990 e-file XML, Part X lines 1+2 (cash + savings/temporary cash investments) / (Part IX line 25 total expenses / 12)",
            "source": "IRS Form 990 e-file XML (IRS TEOS)",
            "source_url": org_page, "irs_xml_url": irs["source_url"], "irs_object_id": irs.get("object_id"),
        }
    # No e-file XML: ProPublica's extract has no cash field, so cash_months stays null (never guessed).
    fw = sorted(pp.get("filings_with_data", []), key=lambda f: f["tax_prd"], reverse=True)
    if not fw:
        return {}
    f = fw[0]
    exp = f.get("totfuncexpns") or 0
    return {
        "fiscal_year": int(str(f["tax_prd"])[:4]), "revenue": f.get("totrevenue"), "expenses": exp,
        "net_assets": f.get("totnetassetend"), "cash_months": None,
        "net_asset_months_proxy": round(f["totnetassetend"] / (exp / 12), 2) if exp else None,
        "cash_basis": "not loaded: no IRS 990 XML parsed; net_asset_months_proxy is NOT cash and is not scored",
        "source": "IRS Form 990 extract (ProPublica Nonprofit Explorer API)", "source_url": org_page,
    }


FOOD_WORDS = re.compile(r"FOOD|SNAP|PANTR|MEAL|SOUP|HUNGER", re.I)


def pick_contracts(rows: list[dict], dept: str, limit: int = 3, site_type: str | None = None) -> list[dict]:
    """Most recent contracts at the agency (latest end, then start, then amount). Food sites prefer food contracts."""
    rs = [r for r in rows if r["DEPT NAME"] == dept]
    if site_type in ("food_pantry", "grocery_giveaway") and any(FOOD_WORDS.search(r["Contract Purpose"]) for r in rs):
        rs = [r for r in rs if FOOD_WORDS.search(r["Contract Purpose"])]
    rs.sort(key=lambda r: (r["Contract End Date"], r["Contract Start Date"], num(r["Contract Registered Amount"]) or 0),
            reverse=True)
    return rs[:limit]


def contract_doc(row: dict, agency: str, ein: str) -> dict:
    cid = checkbook_id(row)
    return {
        "contract_id": cid, "agency_code": agency, "nonprofit_ein": ein,
        "amount": f"{num(row['Contract Registered Amount']):.2f}",
        "start_date": row["Contract Start Date"][:10], "end_date": row["Contract End Date"][:10],
        "registered_date": (row["Original Registration Date"] or "")[:10] or None,
        "spent_to_date": None,
        "spent_to_date_note": "not loaded: Checkbook NYC spending for this contract has not been fetched yet",
        "purpose": row["Contract Purpose"].strip(),
        "source": APPENDIX_SOURCE, "source_url": APPENDIX_URL, "report_url": APPENDIX_REPORT_URL,
        "vendor_legal_name": row["Vendor Legal Name"], "checkbook_vendor_code": row["Vend Cust CD"],
        "registration_delta_days": int(num(row["Registration Delta"]) or 0) if row["Registration Delta"] else None,
        "registration_fy": int(num(row["Registration FY"]) or 0) or None,
        "retroactivity_category": row["Retroactivity Category"], "industry": row["Industry"],
        "appendix_key": {"doc_cd": row["Doc CD"], "doc_dept_cd": row["Doc Dept CD"], "doc_id": row["Doc ID"]},
        "contract_id_basis": "Checkbook form: Doc CD + Checkbook agency code + Doc ID (appendix dept code differs for HRA: 096 vs 069)",
        "is_demo_data": False,
    }


def fy2026_checks(doc: dict, checks: list[dict]) -> list[dict]:
    """Attach the loaded FY2026 Checkbook checks summary to a contract doc; returns those checks."""
    mine = [c for c in checks if c["contract_id"] == doc["contract_id"]]
    if mine:
        doc["checkbook_fy2026_checks"] = {
            "count": len(mine), "total": f"{round(sum(num(c['check_amount']) or 0 for c in mine), 2):.2f}",
            "first_issue_date": min(c["issue_date"] for c in mine), "last_issue_date": max(c["issue_date"] for c in mine)}
    return mine


def golden_contract_overrides(doc: dict, checks: list[dict]) -> dict:
    """The disclosed open-term assumption for the GOLDEN contract only (so the co-signer's contract_not_active check
    lets the demo payment through). The score always uses the real term (end_date_loaded)."""
    mine = fy2026_checks(doc, checks)
    doc["end_date_loaded"] = doc["end_date"]
    doc["end_date_assumed"] = False
    if doc["end_date"] < TODAY.isoformat() and mine:
        last = doc["checkbook_fy2026_checks"]["last_issue_date"]
        amt, spent = num(doc["amount"]) or 0, num(doc.get("spent_to_date"))
        unpaid = f" with {money_str(amt - spent)} of {money_str(amt)} not yet paid" if spent is not None else ""
        after = (f"the city kept paying it after its term (last FY2026 check {last})" if last > doc["end_date"] else
                 f"its last loaded check was {last}; FY2027 checks are not loaded, and the city often pays after a "
                 f"term ends (e.g. CT106920228800360 got FY2026 checks four years after its 2022 end)")
        doc["end_date"] = ASSUMED_END
        doc["end_date_assumed"] = True
        doc["end_date_note"] = (
            f"DEMO ASSUMPTION (disclosed): the real term ended {doc['end_date_loaded']}{unpaid}; {after}. Treated as "
            f"open through {ASSUMED_END} ONLY so the co-signer's contract_not_active check admits the XRPL Testnet demo "
            f"payment. The risk score uses the real end date {doc['end_date_loaded']}.")
    return doc


def money_str(x: float) -> str:
    return f"${x:,.0f}"


def checkbook_contract_doc(t: dict, agency: str, ein: str) -> dict:
    """A contract exactly as the Checkbook NYC Contracts API returned it (current version, spent-to-date)."""
    start, reg = t["prime_contract_start_date"][:10], (t.get("prime_contract_registration_date") or "")[:10] or None
    return {
        "contract_id": t["prime_contract_id"], "agency_code": agency, "nonprofit_ein": ein,
        "amount": f"{num(t['prime_contract_current_amount']):.2f}",
        "original_amount": t.get("prime_contract_original_amount"),
        "start_date": start, "end_date": t["prime_contract_end_date"][:10], "registered_date": reg,
        "spent_to_date": f"{num(t['prime_vendor_spent_to_date']):.2f}",
        "spent_to_date_note": "Checkbook NYC prime_vendor_spent_to_date (all years)",
        "purpose": t.get("prime_contract_purpose"), "vendor_legal_name": t.get("prime_vendor"),
        "registration_delta_days": (date.fromisoformat(reg) - date.fromisoformat(start)).days if reg else None,
        "checkbook_version": t.get("prime_contract_version"), "award_method": t.get("prime_contract_award_method"),
        "contracting_agency": t.get("prime_contracting_agency"),
        "source": "Checkbook NYC Contracts API (registered expense contracts)", "source_url": CHECKBOOK_API,
        "checkbook_request_file": t["_file"].replace(".xml", ".request.xml"),
        "is_demo_data": False,
    }


def payment_docs(checks: list[dict]) -> list[dict]:
    out, seen = [], {}
    for c in checks:
        base = "cb_" + re.sub(r"[^A-Za-z0-9-]", "", c["document_id"] or "nodoc")
        seen[base] = seen.get(base, 0) + 1
        pid = base if seen[base] == 1 else f"{base}_{seen[base]}"
        out.append({
            "payment_id": pid, "source": "checkbook", "contract_id": c["contract_id"], "payee_ein": GOLDEN_EIN,
            "amount": f"{num(c['check_amount']):.2f}", "currency": "USD", "date": c["issue_date"][:10],
            "status": "released", "is_demo_data": False,
            "agency": c.get("agency"), "department": c.get("department"), "document_id": c.get("document_id"),
            "expense_category": c.get("expense_category"), "fiscal_year": int(c["fiscal_year"]),
            "contract_purpose": c.get("contract_purpose"), "payee_name": c.get("payee_name"),
            "source_url": CHECKBOOK_API, "source_request_file": CHECKBOOK_SPENDING_REQ,
            "source_note": "Checkbook NYC Spending API (POST, no key): FY2026, agency 069 (HRA/DSS), payee FOOD BANK FOR NEW YORK CITY",
        })
    return out


def street(s: str) -> str:
    return " ".join(w.capitalize() for w in s.split())


def site_location(seed_row: dict, pp_org: dict, od_sites: dict) -> dict:
    src = seed_row["location_source"]
    if src.startswith("y9si:"):
        s = od_sites[src.split(":", 1)[1]]
        addr = street(s["address_1"].strip())
        return {
            "coordinates": [round(float(s["longitude"]), 6), round(float(s["latitude"]), 6)],
            "address": f"{addr}, {BORO.get(s['borough'].lower(), s['borough'].title())}, NY {s['postcode']}",
            "borough": BORO.get(s["borough"].lower(), s["borough"].title()), "zip": s["postcode"][:5],
            "location_source": "NYC Open Data: Verified Locations for Social Service Contracts, Sites (y9si-s7ab), 2021 snapshot",
            "location_source_url": f"https://data.cityofnewyork.us/resource/y9si-s7ab.json?site_id={s['site_id']}",
            "open_data_site_id": s["site_id"], "nta_2010": s.get("nta") or None,
            "open_data_capacity": {"capacity": s.get("capacity") or None, "units": s.get("capacity_units") or None},
        }
    g = json.loads((RAW / "geosearch" / f"{seed_row['site_id']}.json").read_text(encoding="utf-8"))
    feat = g["feature"]
    p = feat["properties"]
    boro = p.get("borough") or pp_org.get("city")
    return {
        "coordinates": [round(c, 6) for c in feat["geometry"]["coordinates"]],
        "address": f"{street(irs_street(seed_row['ein'], pp_org['address']))}, {pp_org['city']}, NY {str(pp_org.get('zipcode'))[:5]}",
        "borough": boro, "zip": str(p.get("postalcode") or pp_org.get("zipcode"))[:5],
        "location_source": "IRS/ProPublica organization address, geocoded with NYC Planning Labs GeoSearch",
        "location_source_url": g["request_url"], "geosearch_label": p.get("label"),
    }


def site_doc(seed_row: dict, pp_org: dict, od_sites: dict, contract_ids: list[str]) -> dict:
    loc = site_location(seed_row, pp_org, od_sites)
    typ = seed_row["type"]
    note = None
    if typ == "shelter":
        note = ("Pin is the provider's public headquarters, not a shelter: NYC DHS shelter addresses are confidential "
                "and are never shown.")
    elif loc["location_source"].startswith("IRS"):
        note = "Pin is the organization's IRS-listed address (headquarters/main facility)."
    else:
        note = ("Pin is a service site of this provider from NYC Open Data (2021 snapshot); contract_ids are the "
                "provider's contracts at this agency, not necessarily this exact site's.")
    if seed_row["site_id"] == GOLDEN_SITE_ID:
        note = ("Food Bank For NYC's Hunts Point warehouse, its IRS-listed address. Its HRA contracts (SNAP and "
                "emergency food assistance, warehouse and delivery) fund organization-wide services, not only this address.")
    events = [{"title": t, "starts_at": ts, "is_demo_data": True} for t, ts in EVENT_TEMPLATES.get(typ, [])]
    return {
        "id": seed_row["site_id"], "name": seed_row["site_name"], "type": typ,
        "location": {"type": "Point", "coordinates": loc.pop("coordinates")},
        "address": loc.pop("address"), "borough": loc.pop("borough"), "zip": loc.pop("zip"),
        "nonprofit_ein": seed_row["ein"], "agency_code": seed_row["agency_code"], "contract_ids": contract_ids,
        "events": events, "events_note": "Events are SEEDED demo data (is_demo_data: true), not a real schedule.",
        "location_note": note, **loc,
        "source": loc["location_source"], "source_url": loc["location_source_url"],
        "is_golden": seed_row["site_id"] == GOLDEN_SITE_ID,
        "is_demo_data": False,
    }


# ---------------------------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-risk", action="store_true")
    args = ap.parse_args()
    d = db()
    now = utcnow_iso()
    seed = load_seed()
    assert len({r["ein"] for r in seed}) == len(seed), "duplicate EIN in seed"
    assert not any(r["ein"].startswith("00-000000") for r in seed), "seed must not contain demo EINs"
    counts = {}

    # 0. demo_state first (builder B reads it). epoch only on insert: demo_reset.py owns it after that.
    note = (f"DEMO SCALE (Option B, disclosed): for the golden site {GOLDEN_SITE_ID} only, released XRPL Testnet RLUSD "
            f"payments on contract {GOLDEN_CONTRACT_ID} dated at/after `epoch` count toward the contract's paid amount "
            f"at 1 RLUSD = ${SCALE_USD_PER_RLUSD:,} USD. Testnet RLUSD has no monetary value; every other site counts only "
            f"real Checkbook NYC USD. demo_reset.py sets epoch = now.")
    d.demo_state.update_one({"_id": "golden"}, {"$set": {
        "golden_ein": GOLDEN_EIN, "golden_site_id": GOLDEN_SITE_ID, "golden_contract_id": GOLDEN_CONTRACT_ID,
        "scale_usd_per_rlusd": SCALE_USD_PER_RLUSD, "note": note, "is_demo_data": True, "updated_at": now},
        "$setOnInsert": {"epoch": now}}, upsert=True)
    counts["demo_state"] = d.demo_state.count_documents({"_id": "golden"})

    # 1. agency_stats
    d.agency_stats.create_index("code", unique=True, name="code_unique")
    ops = [UpdateOne({"code": a["code"]}, {"$set": {**a, "updated_at": now}}, upsert=True) for a in agency_stats_docs()]
    d.agency_stats.bulk_write(ops)
    counts["agency_stats"] = len(ops)

    # 2. nonprofits (public fields only; `wallet` belongs to builder B / onboarding)
    ops = []
    for r in seed:
        pp = load_propublica(r["ein"])
        o = pp["organization"]
        doc = {
            "ein": r["ein"], "name": r["name"],
            "address": f"{street(irs_street(r['ein'], o['address']))}, {o['city']}, NY {str(o.get('zipcode'))[:5]}",
            "address_irs_as_filed": o["address"],
            "address_note": IRS_ADDRESS_FIXES[r["ein"]][2] if irs_street(r["ein"], o["address"]) != o["address"] else None,
            "service_types": [r["type"]], "financials": financials_for(r["ein"], pp),
            "name_irs": o["name"], "ntee_code": o.get("ntee_code"),
            "checkbook_vendor_code": r["checkbook_vendor_code"], "crosswalk_method": r["crosswalk_method"],
            "crosswalk_status": "reviewed" if r["ein"] == GOLDEN_EIN else "pending_human_review",
            "agency_code": r["agency_code"], "why_chosen": r["why_chosen"],
            "source": "IRS/ProPublica Nonprofit Explorer + NYC Comptroller appendix (vendor code crosswalk)",
            "source_url": PROPUBLICA_API.format(ein9=ein9(r["ein"])),
            "is_demo_data": False, "updated_at": now,
        }
        ops.append(UpdateOne({"ein": r["ein"]}, {"$set": doc}, upsert=True))
    d.nonprofits.bulk_write(ops)
    counts["nonprofits"] = len(ops)

    # 3. contracts
    appendix = load_appendix({r["checkbook_vendor_code"] for r in seed})
    cb_terms = load_checkbook_contract_terms()
    checks = xml_rows(CHECKBOOK_SPENDING_XML)
    site_contracts: dict[str, list[str]] = {}
    cdocs: list[dict] = []
    for r in seed:
        dept = AGENCIES[r["agency_code"]][0]
        rows = [x for x in appendix if x["Vend Cust CD"] == r["checkbook_vendor_code"] and x["DEPT NAME"] == dept]
        ids = []
        if r["ein"] == GOLDEN_EIN and GOLDEN_CONTRACT_ID in cb_terms:
            # Golden: the vendor's contracts at this agency exactly as Checkbook returned them (current version,
            # spent-to-date), limited to those paid in the loaded FY2026 checks or registered in FY2026. Golden first.
            paid_ids = {c["contract_id"] for c in checks}
            cb = AGENCIES[r["agency_code"]][1]
            picks = [cid for cid, t in cb_terms.items() if cid[3:6] == cb
                     and (t.get("prime_vendor") or "").upper() == "FOOD BANK FOR NEW YORK CITY"
                     and (t["_registered_fy2026_query"] or cid in paid_ids)]
            picks = [GOLDEN_CONTRACT_ID] + sorted([c for c in picks if c != GOLDEN_CONTRACT_ID],
                                                  key=lambda c: cb_terms[c]["prime_contract_start_date"], reverse=True)
            by_cb_id = {checkbook_id(x): x for x in rows}
            for cid in picks:
                doc = checkbook_contract_doc(cb_terms[cid], r["agency_code"], r["ein"])
                if cid in by_cb_id:  # also in the Comptroller appendix: keep its registration fields as extras
                    a = contract_doc(by_cb_id[cid], r["agency_code"], r["ein"])
                    for k in ("registration_fy", "retroactivity_category", "appendix_key", "industry"):
                        doc[k] = a[k]
                    doc["also_in"] = APPENDIX_SOURCE
                if cid == GOLDEN_CONTRACT_ID:
                    doc = golden_contract_overrides(doc, checks)
                else:
                    fy2026_checks(doc, checks)
                    doc["end_date_assumed"] = False
                    doc["end_date_loaded"] = doc["end_date"]
                cdocs.append(doc)
                ids.append(cid)
        else:
            for x in pick_contracts(rows, dept, 3, r["type"]):
                doc = contract_doc(x, r["agency_code"], r["ein"])
                cdocs.append(doc)
                ids.append(doc["contract_id"])
        site_contracts[r["site_id"]] = ids
    demo_ids = {c["contract_id"] for c in d.contracts.find({"is_demo_data": True}, {"contract_id": 1})}
    assert not demo_ids & {c["contract_id"] for c in cdocs}, "would overwrite a demo contract"
    # $set only A's fields; xrpl_budget_rlusd / xrpl_budget_note (builder B) are never in `doc`.
    ops = []
    for c in cdocs:
        upd = {"$set": {**c, "updated_at": now}}
        if not c.get("end_date_assumed"):
            upd["$unset"] = {"end_date_note": ""}  # a contract that is no longer golden loses the assumption note
        ops.append(UpdateOne({"contract_id": c["contract_id"]}, upd, upsert=True))
    d.contracts.bulk_write(ops)
    counts["contracts"] = len(cdocs)
    # Sync: drop real contracts an earlier ingest run wrote that the current selection no longer uses (A-owned only:
    # never demo contracts, never one carrying builder B's xrpl_budget_rlusd).
    stale = d.contracts.delete_many({"is_demo_data": False, "contract_id": {"$nin": [c["contract_id"] for c in cdocs]},
                                     "xrpl_budget_rlusd": {"$exists": False},
                                     "nonprofit_ein": {"$in": [r["ein"] for r in seed]}})
    counts["contracts_pruned"] = stale.deleted_count

    # 4. payments (real Checkbook checks)
    pdocs = payment_docs(checks)
    d.payments.bulk_write([UpdateOne({"payment_id": p["payment_id"]}, {"$set": {**p, "updated_at": now}}, upsert=True)
                           for p in pdocs])
    counts["payments(checkbook)"] = len(pdocs)

    # 5. sites (risk is filled by risk.py)
    od = load_open_data_sites()
    d.sites.create_index("id", unique=True, name="id_unique")
    d.sites.create_index([("location", "2dsphere")], name="location_2dsphere")
    ops = []
    for r in seed:
        o = load_propublica(r["ein"])["organization"]
        s = site_doc(r, o, od, site_contracts[r["site_id"]])
        ops.append(UpdateOne({"id": s["id"]}, {"$set": {**s, "updated_at": now}}, upsert=True))
    d.sites.bulk_write(ops)
    counts["sites"] = len(ops)

    print("ingest upserts:", json.dumps(counts))
    print(f"Checkbook contract terms cached: {len(cb_terms)} contracts" if cb_terms else
          "Checkbook contract terms cached: none (fetch_checkbook_contracts.py not run yet)")
    if not args.no_risk:
        import risk
        risk.run_all(d, write=True)


if __name__ == "__main__":
    main()
