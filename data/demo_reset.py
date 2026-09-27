"""Phase 7 reset hook: forget earlier demo payments for the golden pin and recompute it.

  python data/demo_reset.py            # demo_state.epoch = now, recompute + write the golden site's risk
  python data/demo_reset.py --dry-run  # show what the golden site would score after the reset, write nothing

Only XRPL payments dated at/after demo_state.epoch count toward the golden contract (Option B), so moving the epoch to
now sends the golden pin back to its pre-demo level (the real Checkbook data is untouched). No ledger or payment records
are deleted: the Testnet payments stay on the ledger and in `payments`/`decisions`, they just stop counting.
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
    site = d.sites.find_one({"id": demo["golden_site_id"]}, {"_id": 0})
    before = site.get("risk") or {}
    now = utcnow_iso()
    if args.dry_run:
        demo_now = {**demo, "epoch": now}
        contract, nonprofit, agency, _ = riskmod.inputs_for(d, site)
        r = riskmod.compute(site, contract, nonprofit, agency, as_of=__import__("datetime").date.today(),
                            paid_checkbook=riskmod.checkbook_paid(d, contract or {}),
                            xrpl=riskmod.golden_xrpl(d, demo_now, site, contract),
                            scale=demo.get("scale_usd_per_rlusd"))
        print(f"DRY RUN: {site['id']} now {before.get('level')} {before.get('score')} -> after reset {r['level']} {r['score']}")
        return
    d.demo_state.update_one({"_id": "golden"}, {"$set": {"epoch": now, "last_reset_at": now}})
    r = riskmod.risk_for_site(d, site)
    riskmod.write_risk(d, site["id"], r)
    print(f"demo_state.epoch = {now}")
    print(f"{site['id']}: {before.get('level')} {before.get('score')} -> {r['level']} {r['score']}  ({r['summary']})")


if __name__ == "__main__":
    main()
