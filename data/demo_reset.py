"""Phase 7 reset hook: start a new demo epoch and clear every demo score.

  python data/demo_reset.py            # demo_state.epoch = now, $unset sites.demo_risk on every site
  python data/demo_reset.py --dry-run  # show what would be cleared, write nothing

risk vs demo_risk (Sun 04:50): sites.risk is PUBLIC RECORDS ONLY and XRPL Testnet payments never change it, so a reset does
not need to touch it. sites.demo_risk is the /demo what-if score (the golden's Option B score from data/risk.py --demo-risk,
the demo sites' fixture release rule from the API); it is removed here, so /demo shows every pin at its public risk again.
Only XRPL payments dated at/after demo_state.epoch count toward the golden's demo_risk, so the next demo starts clean.
No ledger or payment records are deleted: the Testnet payments stay on the ledger and in `payments`/`decisions`.

Self-heal: the golden's public risk is re-scored (public records only) and written ONLY if its level/score/reasons differ
from the stored one (e.g. a score written by older code that counted Testnet payments). Normally nothing changes.
"""
from __future__ import annotations

import argparse

import risk as riskmod
from gl_common import db, utcnow_iso


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    d = db()
    demo = d.demo_state.find_one({"_id": "golden"})
    if not demo:
        raise SystemExit("no demo_state {_id:'golden'}: run data/ingest.py first")
    with_demo = [s["id"] for s in d.sites.find({"demo_risk": {"$exists": True}}, {"_id": 0, "id": 1})]
    site = d.sites.find_one({"id": demo["golden_site_id"]}, {"_id": 0})
    before = site.get("risk") or {}
    public = riskmod.risk_for_site(d, site)  # public records only (no XRPL credit)
    heal = not riskmod.same_score(before, public)
    now = utcnow_iso()
    if args.dry_run:
        print(f"DRY RUN: would set demo_state.epoch = {now} and clear demo_risk on {len(with_demo)} site(s): {', '.join(with_demo) or '-'}")
        change = f" -> {public['level']} {public['score']} (would self-heal)" if heal else " (unchanged)"
        print(f"DRY RUN: {site['id']} public risk {before.get('level')} {before.get('score')}{change}")
        return
    d.demo_state.update_one({"_id": "golden"}, {"$set": {"epoch": now, "last_reset_at": now}})
    cleared = d.sites.update_many({"demo_risk": {"$exists": True}}, {"$unset": {"demo_risk": ""}}).modified_count
    print(f"demo_state.epoch = {now}")
    print(f"demo_risk cleared on {cleared} site(s): {', '.join(with_demo) or '-'}")
    if heal:
        riskmod.write_risk(d, site["id"], public)
        print(f"{site['id']}: public risk re-scored {before.get('level')} {before.get('score')} -> {public['level']} {public['score']} "
              f"(public records only)")
    else:
        print(f"{site['id']}: public risk unchanged {before.get('level')} {before.get('score')} (public records only)")


if __name__ == "__main__":
    main()
