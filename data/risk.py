"""Financial status rating (Phase 4): deterministic, explainable 0-100 score per site. NOT a trained model.

  python data/risk.py                          # all sites: compute + write sites.risk, print a table
  python data/risk.py --site site_fbnyc        # one site (writes)
  python data/risk.py --site site_fbnyc --json # ...and print the new risk JSON (for the API's recompute hook)
  python data/risk.py --dry-run                # compute + print, no writes
  python data/risk.py --simulate-xrpl 12.50    # golden site: before/after one extra RLUSD payment (dry run, no writes)
  python data/risk.py --suggest-scale          # golden site: which round demo scales flip it for a 12.50 payment

Factors (points; higher = more strained). Same weights, levels and labels as api/src/risk.ts:
  payment pace   40  gap = share of contract term elapsed - share paid; 40 * clamp(gap / 0.5, 0, 1) (a 50-point gap = max)
  registration   20  still unregistered after start: 20 * min(1, days / 90);
                     registered late: 10 * min(1, days_late / 365) (a year late = 10, the Comptroller's worst bucket);
                     registered on/before start: 0
  agency         20  20 * share of the agency's FY2024 human-services contracts registered late (Comptroller appendix)
  cash cushion   20  months of cash on hand (IRS 990 XML): < 2 = 20, > 6 = 0, linear in between
Each factor is rounded to whole points. A factor whose data is NOT loaded is excluded (never guessed): the score is then
round(sum of available points * 100 / sum of their maxima), and a reason says "score uses N of 4 factors".
Levels: green < 40 "Financially stable", yellow 40-69 "Financially strained", red >= 70 "Financially critical".

Option B (disclosed demo scale): for the GOLDEN site only (demo_state._id "golden"), released XRPL Testnet RLUSD payments on
the golden contract dated at/after demo_state.epoch count toward "paid" at demo_state.scale_usd_per_rlusd USD per RLUSD.
Every other site counts only real Checkbook NYC USD.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import date

from gl_common import GOLDEN_SITE_ID, db, money, parse_date, parse_dt, utcnow_iso

WEIGHTS = {"payment_pace": 40, "registration": 20, "agency": 20, "cash": 20}
LABELS = {"green": "Financially stable", "yellow": "Financially strained", "red": "Financially critical"}
RULE_VERSION = "p4-risk-1"


def level_for(score: int) -> str:
    return "red" if score >= 70 else "yellow" if score >= 40 else "green"


def clamp(x, lo, hi):
    return min(hi, max(lo, x))


def pct(x: float) -> str:
    return f"{round(x * 100)}%"


def num(x) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------------------------------------------
# factors: each returns (points | None, reason, positive)
# ---------------------------------------------------------------------------------------------------------------
def pace_factor(contract: dict, paid_checkbook: float | None, xrpl_usd: float, as_of: date):
    amount = num(contract.get("amount"))
    # A disclosed demo end date (golden only, for the co-signer's active check) never enters the score: use the real one.
    real_end = contract.get("end_date_loaded") if contract.get("end_date_assumed") else contract.get("end_date")
    start, end = parse_date(contract.get("start_date")), parse_date(real_end)
    cid = contract["contract_id"]
    if paid_checkbook is None or not amount or not start or not end:
        return None, f"Payment data not loaded yet for contract {cid}", False
    term = max(1, (end - start).days)
    elapsed = clamp((as_of - start).days / term, 0, 1)
    paid = paid_checkbook + xrpl_usd
    frac = clamp(paid / amount, 0, 1)
    gap = elapsed - frac
    pts = round(40 * clamp(gap / 0.5, 0, 1))
    ended = f" (term ended {end})" if as_of > end else ""
    reason = f"{pct(elapsed)} of contract term elapsed{ended}, {pct(frac)} paid ({money(paid)} of {money(amount)})"
    return pts, reason, gap <= 0.05


def registration_factor(contract: dict, as_of: date):
    start, reg = parse_date(contract.get("start_date")), parse_date(contract.get("registered_date"))
    if not start:
        return None, "Contract start date not loaded", False
    if not reg:
        days = (as_of - start).days
        if days <= 0:
            return 0, f"Contract starts {start}; not yet registered", True
        return round(20 * min(1, days / 90)), f"Contract started {start}, still unregistered ({days} days)", False
    late = (reg - start).days
    if late <= 0:
        return 0, f"Contract registered on time ({reg})", True
    return round(10 * min(1, late / 365)), f"Contract registered {late} days after its {start} start", False


def agency_factor(agency: dict | None, code: str):
    if not agency or agency.get("pct_contracts_registered_late") is None:
        return None, f"No lateness data loaded for agency {code}", False
    p = agency["pct_contracts_registered_late"]
    fy = f" of FY{agency['fiscal_year']}" if agency.get("fiscal_year") else ""
    avg = f" (avg {agency['avg_days_registered_late']} days)" if agency.get("avg_days_registered_late") is not None else ""
    return round(20 * p), f"{agency['code']} registered {pct(p)}{fy} human-services contracts late{avg}", False


def cash_factor(nonprofit: dict | None):
    f = (nonprofit or {}).get("financials") or {}
    m = f.get("cash_months")
    if m is None:
        return None, "Cash on hand not loaded (no IRS 990 XML parsed)", False
    pts = 20 if m < 2 else 0 if m > 6 else round(20 * (6 - m) / 4)
    return pts, f"{m:.2f} months of cash on hand (FY{f.get('fiscal_year')} IRS 990)", m >= 4


# ---------------------------------------------------------------------------------------------------------------
def words(s: str) -> int:
    return len(s.split())


def mid(s: str) -> str:
    return s[0].lower() + s[1:] if len(s) > 1 and s[0].isupper() and s[1].islower() else s


def template_summary(level: str, facts: list[str]) -> str:
    label = LABELS[level]
    facts = [mid(f) for f in facts]
    if len(facts) >= 2:
        two = f"{label}: {facts[0]}; {facts[1]}."
        if words(two) <= 25:
            return two
    if facts:
        one = f"{label}: {facts[0]}."
        if words(one) <= 25:
            return one
    return f"{label}."


def reasons_hash(level: str, reasons: list[str]) -> str:
    return hashlib.sha256(json.dumps({"level": level, "reasons": reasons}, sort_keys=True).encode()).hexdigest()


def compute(site: dict, contract: dict | None, nonprofit: dict | None, agency: dict | None, *, as_of: date,
            paid_checkbook: float | None, xrpl: list[dict] | None = None, scale: float | None = None) -> dict:
    """Pure: inputs -> risk. `xrpl` = counted golden RLUSD payments [{amount, date, ...}] (Option B), else None."""
    xrpl = xrpl or []
    xrpl_rlusd = round(sum(num(p["amount"]) or 0 for p in xrpl), 2)
    xrpl_usd = xrpl_rlusd * (scale or 0)
    lead = []
    if xrpl and scale:
        lead.append(f"RLUSD {xrpl_rlusd:.2f} Testnet payment{'s' if len(xrpl) > 1 else ''} counted as {money(xrpl_usd)} "
                    f"at demo scale (1 RLUSD = {money(scale)})")
    facs = {}
    if contract:
        facs["payment_pace"] = pace_factor(contract, paid_checkbook, xrpl_usd, as_of)
        facs["registration"] = registration_factor(contract, as_of)
    else:
        facs["payment_pace"] = (None, "No contract loaded for this site", False)
        facs["registration"] = (None, "No contract loaded for this site", False)
    facs["agency"] = agency_factor(agency, site.get("agency_code"))
    facs["cash"] = cash_factor(nonprofit)
    if lead and facs["payment_pace"][0] is None:
        # Never claim a payment moved the score when the pace factor cannot be computed.
        lead = [f"RLUSD {xrpl_rlusd:.2f} Testnet payment recorded but not scored: the contract's paid-to-date "
                f"is not loaded"]

    avail = {k: v for k, v in facs.items() if v[0] is not None}
    missing = [k for k in facs if k not in avail]
    raw = sum(v[0] for v in avail.values())
    max_avail = sum(WEIGHTS[k] for k in avail)
    score = min(100, raw if not missing else round(raw * 100 / max_avail)) if max_avail else 0
    level = level_for(score)

    ordered = sorted(avail.items(), key=lambda kv: -kv[1][0])
    reasons = lead + [v[1] for _, v in ordered]
    if missing:
        names = {"payment_pace": "payment data", "registration": "registration data", "agency": "agency data",
                 "cash": "cash on hand"}
        miss_txt = " and ".join(names[k] for k in missing)
        reasons.append(f"{miss_txt[0].upper() + miss_txt[1:]} not loaded yet; score uses {len(avail)} of 4 factors "
                       f"(rescaled to 100)")
    if level == "green":
        facts = lead + [v[1] for _, v in ordered if v[2]] + [v[1] for _, v in ordered if not v[2]]
    else:
        facts = lead + [v[1] for _, v in ordered]
    summary = template_summary(level, facts)
    rh = reasons_hash(level, reasons)
    summary_source = "template"
    return {
        "level": level, "score": int(score), "reasons": reasons, "summary": summary, "computed_at": utcnow_iso(),
        # additive fields (teammate request: per-factor points for the stacked bar)
        "components": {k: facs[k][0] for k in WEIGHTS},
        "components_max": dict(WEIGHTS),
        "factors_used": len(avail), "rescaled": bool(missing),
        "summary_source": summary_source, "reasons_hash": rh, "as_of": as_of.isoformat(), "rule_version": RULE_VERSION,
        "xrpl_counted": {"rlusd": f"{xrpl_rlusd:.2f}", "usd_at_demo_scale": round(xrpl_usd, 2),
                         "scale_usd_per_rlusd": scale, "payments": len(xrpl),
                         "scored": facs["payment_pace"][0] is not None,
                         "note": "Option B demo scale; golden site only; Testnet RLUSD has no monetary value"}
        if xrpl else None,
    }


# ---------------------------------------------------------------------------------------------------------------
# Mongo glue
# ---------------------------------------------------------------------------------------------------------------
def checkbook_paid(d, contract: dict) -> float | None:
    """Real Checkbook USD paid on the contract: spent_to_date when loaded, else None (pace factor excluded)."""
    v = contract.get("spent_to_date")
    return num(v) if v is not None else None


def golden_xrpl(d, demo: dict | None, site: dict, contract: dict | None) -> list[dict]:
    if not demo or not contract or site["id"] != demo.get("golden_site_id") \
            or contract["contract_id"] != demo.get("golden_contract_id"):
        return []
    epoch = parse_dt(demo.get("epoch"))
    out = []
    for p in d.payments.find({"source": "xrpl", "contract_id": contract["contract_id"], "status": "released",
                              "currency": "RLUSD"}, {"_id": 0}):
        t = parse_dt(p.get("date"))
        if t and epoch and t >= epoch:
            out.append(p)
    return out


def inputs_for(d, site: dict):
    cid = (site.get("contract_ids") or [None])[0]
    contract = d.contracts.find_one({"contract_id": cid}, {"_id": 0}) if cid else None
    nonprofit = d.nonprofits.find_one({"ein": site["nonprofit_ein"]}, {"_id": 0, "wallet": 0})
    agency = d.agency_stats.find_one({"code": site["agency_code"]}, {"_id": 0})
    demo = d.demo_state.find_one({"_id": "golden"})
    return contract, nonprofit, agency, demo


def risk_for_site(d, site: dict, as_of: date | None = None, extra_xrpl: float | None = None,
                  scale_override: float | None = None) -> dict:
    as_of = as_of or date.today()
    contract, nonprofit, agency, demo = inputs_for(d, site)
    xrpl = golden_xrpl(d, demo, site, contract)
    is_golden = bool(demo) and site["id"] == demo.get("golden_site_id")
    if extra_xrpl and is_golden:
        xrpl = xrpl + [{"amount": f"{extra_xrpl:.2f}", "date": utcnow_iso(), "simulated": True}]
    scale = (scale_override or (demo or {}).get("scale_usd_per_rlusd")) if is_golden else None
    r = compute(site, contract, nonprofit, agency, as_of=as_of, paid_checkbook=checkbook_paid(d, contract or {}),
                xrpl=xrpl, scale=scale)
    # Grok summary cache (summaries.py), keyed by the hash of level + reasons: used only for identical reasons.
    cached = d.risk_summaries.find_one({"_id": r["reasons_hash"]})
    if cached and cached.get("summary"):
        r["summary"], r["summary_source"] = cached["summary"], f"grok ({cached.get('model')})"
    return r


def write_risk(d, site_id: str, risk: dict):
    d.sites.update_one({"id": site_id}, {"$set": {"risk": risk}})


def fmt_components(c: dict) -> str:
    return " ".join(f"{k[:3]}={'-' if v is None else v}" for k, v in c.items())


def print_table(rows: list[tuple[dict, dict]]):
    print(f"{'site':30} {'type':16} {'agcy':5} {'level':7} {'score':>5}  {'components':32} first reason")
    for s, r in rows:
        print(f"{s['id']:30} {s['type']:16} {s['agency_code']:5} {r['level']:7} {r['score']:>5}  "
              f"{fmt_components(r['components']):32} {r['reasons'][0]}")


def run_all(d, write: bool = True):
    rows = []
    for s in d.sites.find({"is_demo_data": False}, {"_id": 0}).sort("id", 1):
        r = risk_for_site(d, s)
        if write:
            write_risk(d, s["id"], r)
        rows.append((s, r))
    print_table(rows)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--simulate-xrpl", type=float, metavar="RLUSD")
    ap.add_argument("--suggest-scale", action="store_true")
    ap.add_argument("--as-of", help="YYYY-MM-DD (default today)")
    args = ap.parse_args()
    d = db()
    as_of = date.fromisoformat(args.as_of) if args.as_of else None

    if args.simulate_xrpl is not None or args.suggest_scale:
        demo = d.demo_state.find_one({"_id": "golden"}) or {}
        sid = demo.get("golden_site_id", GOLDEN_SITE_ID)
        site = d.sites.find_one({"id": sid}, {"_id": 0})
        before = risk_for_site(d, site, as_of)
        if args.suggest_scale:
            amt = args.simulate_xrpl or 12.50
            print(f"golden {sid} before: {before['level']} {before['score']} {before['components']}")
            for sc in (1_000, 2_000, 2_500, 5_000, 10_000, 20_000, 25_000, 50_000, 100_000, 200_000, 250_000, 500_000):
                a = risk_for_site(d, site, as_of, extra_xrpl=amt, scale_override=sc)
                print(f"  scale ${sc:>7,}/RLUSD: +{amt:.2f} RLUSD = {money(amt * sc):>11} -> {a['level']:6} {a['score']:>3} "
                      f"{a['components']}")
            return
        after = risk_for_site(d, site, as_of, extra_xrpl=args.simulate_xrpl)
        print(f"DRY RUN (nothing written): golden site {sid}, contract {demo.get('golden_contract_id')}, "
              f"scale 1 RLUSD = {money(demo.get('scale_usd_per_rlusd') or 0)}, epoch {demo.get('epoch')}")
        for tag, r in (("BEFORE", before), (f"AFTER +{args.simulate_xrpl:.2f} RLUSD", after)):
            print(f"--- {tag}: {r['level']} {r['score']}  {fmt_components(r['components'])}")
            for x in r["reasons"]:
                print(f"     - {x}")
            print(f"     summary: {r['summary']}")
        return

    if args.site:
        site = d.sites.find_one({"id": args.site}, {"_id": 0})
        if not site:
            sys.exit(f"no site {args.site}")
        r = risk_for_site(d, site, as_of)
        if not args.dry_run:
            write_risk(d, site["id"], r)
        if args.json:
            print(json.dumps(r))
        else:
            print_table([(site, r)])
        return
    run_all(d, write=not args.dry_run)


if __name__ == "__main__":
    main()
