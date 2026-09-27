"""Independent Phase 4 verifier (read-only): Mongo docs vs the committed raw public files, plus an independent
re-implementation of the risk score. Never writes to Mongo, never touches the network (except Mongo reads).

  python data/verify_phase4.py            # prints every check; exit 1 if any FAIL

It deliberately does NOT import risk.py or ingest.py logic: the score is recomputed from the spec in data/README.md.
"""
from __future__ import annotations

import csv
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone

from gl_common import RAW, SEED_CSV, db, irs_street

FAILS: list[str] = []
WARNS: list[str] = []


def ok(cond: bool, msg: str, warn: bool = False):
    if cond:
        return True
    (WARNS if warn else FAILS).append(msg)
    print(("WARN " if warn else "FAIL ") + msg)
    return False


def norm(s: str) -> str:
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    s = re.sub(r"\b(inc|incorporated|the|of)\b", " ", s)
    return " ".join(s.split())


def f(x) -> float | None:
    try:
        return float(str(x).replace(",", "").replace("$", ""))
    except (TypeError, ValueError):
        return None


def haversine_m(a, b) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def main():
    d = db()
    seed = list(csv.DictReader(open(SEED_CSV, encoding="utf-8", newline="")))
    by_ein = {r["ein"]: r for r in seed}
    print(f"seed rows: {len(seed)}  types: " + json.dumps({t: sum(r['type'] == t for r in seed) for t in
                                                         sorted({r['type'] for r in seed})}))
    ok(len(seed) == 15, "seed must have 15 rows")

    # ---------------- raw files ----------------
    appendix = list(csv.DictReader(open(RAW / "comptroller" / "appendix1_fy22_24_parent_contracts.csv",
                                        encoding="utf-8-sig", newline="")))
    x882 = {r["provider_ein"]: r for r in csv.DictReader(open(RAW / "nyc_open_data" / "x882-mwt5.csv",
                                                               encoding="utf-8-sig", newline="")) if r["provider_ein"]}
    y9si = {r["site_id"]: r for r in csv.DictReader(open(RAW / "nyc_open_data" / "y9si-s7ab.csv",
                                                           encoding="utf-8-sig", newline=""))}

    def xml_rows(p):
        return [{c.tag: (c.text or "").strip() for c in t} for t in ET.fromstring(p.read_text(encoding="utf-8")).iter("transaction")]

    cb_contracts: dict[str, dict] = {}
    for p in sorted((RAW / "checkbook").glob("contracts_*.xml")):
        if p.name.endswith(".request.xml"):
            continue
        for r in xml_rows(p):
            cid = r.get("prime_contract_id")
            if cid and int(f(r.get("prime_contract_version")) or 0) >= int(f((cb_contracts.get(cid) or {}).get("prime_contract_version")) or 0):
                cb_contracts[cid] = r
    checks = xml_rows(RAW / "checkbook" / "spending_FOOD_BANK_FOR_NEW_YORK_CITY_HRA_FY2026.xml")

    # ---------------- 1. nonprofits ----------------
    print("\n== nonprofits")
    nps = {n["ein"]: n for n in d.nonprofits.find({"is_demo_data": False}, {"_id": 0})}
    ok(set(nps) == set(by_ein), f"nonprofits(real) EINs != seed EINs: {set(nps) ^ set(by_ein)}")
    for ein, r in by_ein.items():
        n = nps.get(ein) or {}
        pp = json.loads((RAW / "propublica" / f"org_{ein.replace('-', '')}.json").read_text(encoding="utf-8"))["organization"]
        ok(str(pp["ein"]).zfill(9) == ein.replace("-", ""), f"{ein}: ProPublica ein {pp['ein']}")
        ok(norm(pp["name"]) == norm(n.get("name_irs", "")), f"{ein}: name_irs {n.get('name_irs')!r} != ProPublica {pp['name']!r}")
        ok(norm(n.get("name", "")) == norm(pp["name"]), f"{ein}: name {n.get('name')!r} != ProPublica {pp['name']!r}", warn=True)
        irs = json.loads((RAW / "irs990" / f"{ein.replace('-', '')}_extract.json").read_text(encoding="utf-8"))
        v = irs["values"]
        ok(v["filer_ein"] == ein.replace("-", ""), f"{ein}: IRS XML filer_ein {v['filer_ein']}")
        cash = f(v.get("CashNonInterestBearingGrp/EOYAmt")) or 0
        sav = f(v.get("SavingsAndTempCashInvstGrp/EOYAmt")) or 0
        exp = f(v.get("TotalFunctionalExpensesGrp/TotalAmt"))
        cm = round((cash + sav) / (exp / 12), 2)
        fin = n.get("financials") or {}
        ok(fin.get("cash_months") == cm, f"{ein}: cash_months {fin.get('cash_months')} != recomputed {cm}")
        ok(f(fin.get("revenue")) == f(v.get("CYTotalRevenueAmt")), f"{ein}: revenue mismatch")
        ok(f(fin.get("expenses")) == exp, f"{ein}: expenses mismatch")
        ok(int(v["tax_period_end"][:4]) == fin.get("fiscal_year"), f"{ein}: fiscal_year mismatch")
        # vendor code crosswalk: appendix vendor name for that code == IRS name
        vnames = {a["Vendor Legal Name"] for a in appendix if a["Vend Cust CD"] == r["checkbook_vendor_code"]}
        ok(any(norm(x) == norm(pp["name"]) or norm(x).startswith(norm(pp["name"])[:20]) for x in vnames) or
           (ein == "13-1624228" and vnames == {"YMCA OF GREATER NEW YORK"}),
           f"{ein}: appendix vendor names {vnames} for code {r['checkbook_vendor_code']} do not match {pp['name']!r}")
        same_name = {a["Vend Cust CD"] for a in appendix if norm(a["Vendor Legal Name"]) in {norm(v) for v in vnames}}
        ok(same_name == {r["checkbook_vendor_code"]}, f"{ein}: vendor name also used by codes {same_name}")
        x = x882.get(ein)
        xtxt = f"x882 provider_ein -> {x['provider_name']!r}" if x else "not in x882-mwt5"
        if x:
            ok(norm(x["provider_name"])[:15] == norm(pp["name"])[:15] or ein == "13-1624228",
               f"{ein}: x882 provider_name {x['provider_name']!r} vs {pp['name']!r}", warn=True)
        for k in ("source", "source_url"):
            ok(bool(n.get(k)), f"{ein}: nonprofit missing {k}")
        ok(n.get("is_demo_data") is False, f"{ein}: is_demo_data not false")
        ok(all(k in n for k in ("ein", "name", "address", "service_types")), f"{ein}: Nonprofit shape")
        print(f"  ok {ein} {pp['name'][:40]:40} vendor {r['checkbook_vendor_code']} cash_months {cm} ({xtxt})")
    demo_np = d.nonprofits.count_documents({"ein": {"$regex": "^00-000000"}})
    ok(demo_np == 4, f"demo nonprofits np_1..np_4 count {demo_np}")

    # ---------------- 2. contracts ----------------
    print("\n== contracts")
    cons = list(d.contracts.find({"is_demo_data": False}, {"_id": 0}))
    by_cid = {c["contract_id"]: c for c in cons}
    app_by_key = {(a["Doc CD"], a["Doc ID"]): a for a in appendix}
    n_app = n_cb = 0
    for c in cons:
        cid = c["contract_id"]
        for k in ("contract_id", "agency_code", "nonprofit_ein", "amount", "start_date", "end_date", "source", "source_url"):
            ok(c.get(k) not in (None, ""), f"{cid}: missing {k}")
        ok("registered_date" in c, f"{cid}: missing registered_date")
        if c.get("end_date_assumed"):
            ok(cid == "CT106920258801736", f"{cid}: only the golden contract may carry an assumed end date")
            ok(bool(c.get("end_date_note")) and c.get("end_date_loaded"), f"{cid}: assumed end date not disclosed")
        real_end = c.get("end_date_loaded") if c.get("end_date_assumed") else c["end_date"]
        if c["source"].startswith("Checkbook"):
            n_cb += 1
            t = cb_contracts.get(cid)
            if not ok(t is not None, f"{cid}: not in committed Checkbook contract XML"):
                continue
            ok(f(c["amount"]) == f(t["prime_contract_current_amount"]), f"{cid}: amount {c['amount']} != {t['prime_contract_current_amount']}")
            ok(c["start_date"] == t["prime_contract_start_date"][:10], f"{cid}: start")
            ok(real_end == t["prime_contract_end_date"][:10], f"{cid}: end {real_end} != {t['prime_contract_end_date']}")
            ok((c["registered_date"] or "") == (t.get("prime_contract_registration_date") or "")[:10], f"{cid}: registered")
            ok(f(c["spent_to_date"]) == f(t["prime_vendor_spent_to_date"]), f"{cid}: spent_to_date")
            ok((t.get("prime_vendor") or "").upper() == "FOOD BANK FOR NEW YORK CITY", f"{cid}: vendor {t.get('prime_vendor')}")
        else:
            n_app += 1
            k = c.get("appendix_key") or {}
            a = app_by_key.get((k.get("doc_cd"), k.get("doc_id")))
            if not ok(a is not None, f"{cid}: appendix row not found"):
                continue
            ok(f(c["amount"]) == f(a["Contract Registered Amount"]), f"{cid}: amount")
            ok(c["start_date"] == a["Contract Start Date"][:10], f"{cid}: start")
            ok(c["end_date"] == a["Contract End Date"][:10], f"{cid}: end")
            ok((c["registered_date"] or "") == (a["Original Registration Date"] or "")[:10], f"{cid}: registered")
            ok(a["Vend Cust CD"] == by_ein[c["nonprofit_ein"]]["checkbook_vendor_code"], f"{cid}: vendor code not the org's")
            want_dept = {"HRA": "DSS/HRA", "DHS": "DHS", "DYCD": "DYCD"}[c["agency_code"]]
            ok(a["DEPT NAME"] == want_dept, f"{cid}: dept {a['DEPT NAME']} != {want_dept}")
            ok(c.get("spent_to_date") is None, f"{cid}: appendix contract has a spent_to_date that no file supports")
            cb_agency = {"HRA": "069", "DHS": "071", "DYCD": "260"}[c["agency_code"]]
            ok(cid == f"{a['Doc CD']}{cb_agency}{a['Doc ID']}", f"{cid}: id form")
    print(f"  {len(cons)} real contracts: {n_cb} from Checkbook XML, {n_app} from the Comptroller appendix; all fields match")
    ok(d.contracts.count_documents({"is_demo_data": True}) >= 15, "demo contracts missing")

    # ---------------- 3. payments ----------------
    print("\n== payments (Checkbook)")
    pays = list(d.payments.find({"source": "checkbook"}, {"_id": 0}))
    raw_sum = round(sum(f(c["check_amount"]) for c in checks), 2)
    db_sum = round(sum(f(p["amount"]) for p in pays), 2)
    ok(len(pays) == len(checks) == 19, f"checkbook payments {len(pays)} vs raw {len(checks)}")
    ok(abs(raw_sum - db_sum) < 0.005, f"payments sum {db_sum} != raw {raw_sum}")
    raw_keys = sorted((c["contract_id"], f"{f(c['check_amount']):.2f}", c["issue_date"][:10]) for c in checks)
    db_keys = sorted((p["contract_id"], p["amount"], p["date"]) for p in pays)
    ok(raw_keys == db_keys, "payment (contract, amount, date) tuples differ from the raw XML")
    ok(len({p["payment_id"] for p in pays}) == len(pays), "duplicate payment_id")
    for p in pays:
        ok(p.get("currency") == "USD" and p.get("is_demo_data") is False and p.get("source_url"), f"{p['payment_id']}: fields")
        ok(p["contract_id"] in by_cid, f"{p['payment_id']}: contract {p['contract_id']} not loaded", warn=True)
    per = {}
    for p in pays:
        per[p["contract_id"]] = round(per.get(p["contract_id"], 0) + f(p["amount"]), 2)
    print(f"  19 checks, total ${db_sum:,.2f} (raw ${raw_sum:,.2f}); by contract {per}")

    # ---------------- 4. agency_stats ----------------
    print("\n== agency_stats (recomputed from the appendix)")
    for code, dept in (("HRA", "DSS/HRA"), ("DHS", "DHS"), ("DYCD", "DYCD")):
        rows = [a for a in appendix if a["DEPT NAME"] == dept and a["Registration FY"] == "2024"
                and a["Industry"].strip().upper() == "HUMAN SERVICES"]
        deltas = [int(f(a["Registration Delta"])) for a in rows if a["Registration Delta"] not in ("", None)]
        late = [x for x in deltas if x > 0]
        pctl = round(len(late) / len(deltas), 3)
        avg = round(sum(late) / len(late))
        s = d.agency_stats.find_one({"code": code}, {"_id": 0})
        ok(abs(s["pct_contracts_registered_late"] - pctl) <= 0.001, f"{code}: pct {s['pct_contracts_registered_late']} != {pctl}")
        ok(abs(s["avg_days_registered_late"] - avg) <= 1, f"{code}: avg {s['avg_days_registered_late']} != {avg}")
        ok(s.get("source") and s.get("source_url") and s.get("is_demo_data") is False, f"{code}: provenance")
        print(f"  {code}: n={len(deltas)} late={pctl:.3f} avg_days={avg}  (mongo {s['pct_contracts_registered_late']}, {s['avg_days_registered_late']})")

    # ---------------- 5. sites ----------------
    print("\n== sites")
    # Phase 5: the API also seeds 4 DEMO sites (site_001..site_004, is_demo_data true, api/scripts/seed-demo-sites.ts)
    # into this collection; they are fixtures, not public records, so only the real sites are verified here.
    sites = list(d.sites.find({"is_demo_data": False}, {"_id": 0}))
    demo_sites = d.sites.count_documents({"is_demo_data": True})
    ok(len(sites) == 15, f"sites {len(sites)}")
    ok(d.sites.count_documents({"is_demo_data": {"$ne": True}}) == len(sites), "sites without an is_demo_data flag")
    print(f"  ({demo_sites} demo sites skipped: seeded by the API, is_demo_data true)")
    for s in sites:
        sid = s["id"]
        r = next((x for x in seed if x["site_id"] == sid), None)
        if not ok(r is not None, f"{sid}: not in seed"):
            continue
        lon, lat = s["location"]["coordinates"]
        ok(-74.26 <= lon <= -73.70 and 40.49 <= lat <= 40.92, f"{sid}: outside NYC bbox {lon},{lat}")
        ok(s["nonprofit_ein"] == r["ein"] and s["agency_code"] == r["agency_code"] and s["type"] == r["type"], f"{sid}: seed mismatch")
        ok(all(e.get("is_demo_data") is True for e in s.get("events", [])), f"{sid}: event not flagged demo")
        ok(s.get("source") and s.get("source_url") and s.get("is_demo_data") is False, f"{sid}: provenance")
        ok(all(cid in by_cid for cid in s["contract_ids"]) and s["contract_ids"], f"{sid}: contract_ids not all loaded")
        ok(all(by_cid[c]["nonprofit_ein"] == s["nonprofit_ein"] and by_cid[c]["agency_code"] == s["agency_code"]
               for c in s["contract_ids"] if c in by_cid), f"{sid}: contract of another org/agency listed")
        src = r["location_source"]
        if src.startswith("y9si:"):
            y = y9si[src.split(":", 1)[1]]
            dist = haversine_m((lon, lat), (float(y["longitude"]), float(y["latitude"])))
            ok(dist < 30, f"{sid}: pin {dist:.0f} m from its y9si site")
            where = f"y9si site {y['site_id']} ({y['site_name'][:30]}, {y['address_1']}, agency {y['agency_name']}) {dist:.0f} m"
            ok(s["type"] != "shelter", f"{sid}: shelter pinned at a service site")
        else:
            g = json.loads((RAW / "geosearch" / f"{sid}.json").read_text(encoding="utf-8"))
            gc = g["feature"]["geometry"]["coordinates"]
            dist = haversine_m((lon, lat), gc)
            ok(dist < 30, f"{sid}: pin {dist:.0f} m from GeoSearch result")
            pp = json.loads((RAW / "propublica" / f"org_{r['ein'].replace('-', '')}.json").read_text(encoding="utf-8"))["organization"]
            ok(norm(irs_street(r["ein"], pp["address"]))[:10] in norm(g["query"]), f"{sid}: GeoSearch query {g['query']!r} is not the IRS address {pp['address']!r}")
            lab = g["feature"]["properties"].get("label", "")
            ok(norm(irs_street(r["ein"], pp["address"])).split()[0] in norm(lab), f"{sid}: GeoSearch label {lab!r} vs IRS {pp['address']!r}", warn=True)
            where = f"IRS address {pp['address']!r} -> GeoSearch {lab!r} {dist:.0f} m"
            if s["type"] == "shelter":
                x = x882.get(r["ein"])
                if x:
                    hq = (float(x["Longitude"]), float(x["Latitude"])) if x.get("Longitude") else None
                    if hq:
                        dd = haversine_m((lon, lat), hq)
                        where += f"; x882 HQ {x['hq_address_1']!r} {dd:.0f} m"
                        ok(dd < 400, f"{sid}: shelter pin {dd:.0f} m from the city's listed HQ ({x['hq_address_1']})", warn=True)
        print(f"  ok {sid:28} {s['type']:16} {lon:.5f},{lat:.5f}  {where}")

    # provenance sweep
    for coll in ("nonprofits", "contracts", "payments", "sites", "agency_stats"):
        q = {"is_demo_data": False}
        bad = d[coll].count_documents({**q, "$or": [{"source": {"$in": [None, ""]}}, {"source_url": {"$in": [None, ""]}}]})
        ok(bad == 0, f"{coll}: {bad} public docs missing source/source_url")
    ds = d.demo_state.find_one({"_id": "golden"})
    ok(ds and ds.get("is_demo_data") is True and "DEMO SCALE" in ds.get("note", ""), "demo_state disclosure")

    # ---------------- 6. independent risk ----------------
    print("\n== risk (independent re-implementation vs sites.risk)")
    labels = {"green": "Financially stable", "yellow": "Financially strained", "red": "Financially critical"}
    for s in sorted(sites, key=lambda x: x["id"]):
        rk = s["risk"]
        as_of = date.fromisoformat(rk.get("as_of") or date.today().isoformat())
        c = by_cid.get(s["contract_ids"][0])
        np_ = nps.get(s["nonprofit_ein"])
        ag = d.agency_stats.find_one({"code": s["agency_code"]})
        pts = {}
        # pace
        xrpl_usd = 0.0
        if ds and s["id"] == ds["golden_site_id"] and c["contract_id"] == ds["golden_contract_id"]:
            ep = datetime.fromisoformat(ds["epoch"].replace("Z", "+00:00"))
            for p in d.payments.find({"source": "xrpl", "contract_id": c["contract_id"], "status": "released", "currency": "RLUSD"}):
                if datetime.fromisoformat(p["date"].replace("Z", "+00:00")) >= ep:
                    xrpl_usd += float(p["amount"]) * ds["scale_usd_per_rlusd"]
        if c.get("spent_to_date") is None:
            pts["payment_pace"] = None
        else:
            st = date.fromisoformat(c["start_date"])
            en = date.fromisoformat(c.get("end_date_loaded") or c["end_date"]) if c.get("end_date_assumed") else date.fromisoformat(c["end_date"])
            el = min(1, max(0, (as_of - st).days / max(1, (en - st).days)))
            paid = min(1, max(0, (float(c["spent_to_date"]) + xrpl_usd) / float(c["amount"])))
            pts["payment_pace"] = round(40 * min(1, max(0, (el - paid) / 0.5)))
        st = date.fromisoformat(c["start_date"])
        if c.get("registered_date"):
            late = (date.fromisoformat(c["registered_date"]) - st).days
            pts["registration"] = 0 if late <= 0 else round(10 * min(1, late / 365))
        else:
            days = (as_of - st).days
            pts["registration"] = 0 if days <= 0 else round(20 * min(1, days / 90))
        pts["agency"] = round(20 * ag["pct_contracts_registered_late"]) if ag else None
        cm = ((np_ or {}).get("financials") or {}).get("cash_months")
        pts["cash"] = None if cm is None else 20 if cm < 2 else 0 if cm > 6 else round(20 * (6 - cm) / 4)
        mx = {"payment_pace": 40, "registration": 20, "agency": 20, "cash": 20}
        have = {k: v for k, v in pts.items() if v is not None}
        raw = sum(have.values())
        score = raw if len(have) == 4 else round(raw * 100 / sum(mx[k] for k in have))
        lvl = "red" if score >= 70 else "yellow" if score >= 40 else "green"
        match = (score == rk["score"] and lvl == rk["level"] and pts == rk.get("components"))
        ok(match, f"{s['id']}: independent {lvl} {score} {pts} != stored {rk['level']} {rk['score']} {rk.get('components')}")
        ok(rk["summary"].startswith(labels[rk["level"]]), f"{s['id']}: summary does not start with the label")
        ok(len(rk["summary"].split()) <= 25, f"{s['id']}: summary > 25 words")
        rs = " ".join(rk["reasons"])
        nums = re.findall(r"\d[\d,]*(?:\.\d+)?", rk["summary"])
        ok(all(n in rs for n in nums), f"{s['id']}: summary numbers {nums} not all in reasons")
        ok(all(re.search(r"\d", x) for x in rk["reasons"]), f"{s['id']}: a reason has no number", warn=True)
        if len(have) < 4:
            ok(any("not loaded" in x and f"{len(have)} of 4" in x for x in rk["reasons"]), f"{s['id']}: missing factor not disclosed")
        for k in ("level", "score", "reasons", "summary", "computed_at"):
            ok(k in rk, f"{s['id']}: risk.{k} missing")
        print(f"  {'ok' if match else 'XX'} {s['id']:28} {lvl:6} {score:3} {pts}  xrpl_usd={xrpl_usd:,.0f}")

    print(f"\n{len(FAILS)} FAIL, {len(WARNS)} WARN")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
