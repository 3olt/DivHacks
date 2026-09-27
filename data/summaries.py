"""Grok-written risk summaries (<= 25 words) grounded ONLY in each site's risk.reasons. Cached; falls back to the template.

  python data/summaries.py                      # every real site whose reasons changed since the last call
  python data/summaries.py --site site_fbnyc
  python data/summaries.py --prewarm-golden 12.50   # also cache the golden site's summary for "after one 12.50 RLUSD payment"

xAI Responses API (POST https://api.x.ai/v1/responses), model GROK_MODEL (grok-4.3), store:false, structured output
(json_schema, strict). Cache: Mongo `risk_summaries`, _id = sha256(level + reasons) (risk.reasons_hash); no call when the
reasons are unchanged. risk.py uses a cached summary only for identical reasons, otherwise its template.
Post-checks (else fallback to the template): starts with the rating label, <= 25 words, and every number in the summary
appears in the reasons (grounding).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time

import requests

import risk as riskmod
from gl_common import db, utcnow_iso

LABELS = riskmod.LABELS
SYSTEM = (
    "You write one-sentence status summaries for a public map of NYC nonprofit services and their city funding. "
    "Use ONLY the facts in the provided reasons; add nothing else (no causes, predictions, advice, or people). "
    "Keep numbers exactly as written in the reasons. Reasons are ordered biggest driver first: mention only the one or "
    "two most important facts. HARD LIMIT: 20 words in total. The summary MUST start with the given label followed by a "
    "colon. Plain English for residents; drop parenthetical source notes. Keep who each fact is about: agency figures "
    "(e.g. 'HRA registered 87% ... late') describe the city agency, not this nonprofit; say the agency's name. Join facts with a semicolon; never "
    "imply that one fact causes another. If a reason is about an XRPL Testnet payment, mention it first and keep the "
    "words 'Testnet' and 'demo scale'."
)
SCHEMA = {"type": "object", "additionalProperties": False, "properties": {"summary": {"type": "string"}},
          "required": ["summary"]}


def numbers(s: str) -> set[str]:
    return {n.replace(",", "") for n in re.findall(r"\d[\d,]*(?:\.\d+)?", s)}


def grounded(summary: str, label: str, reasons: list[str]) -> str | None:
    """None if OK, else why it failed."""
    if not summary.startswith(label + ":"):
        return "does not start with the label"
    if len(summary.split()) > 25:
        return f"{len(summary.split())} words"
    extra = numbers(summary) - numbers(" ".join(reasons))
    if extra:
        return f"numbers not in reasons: {sorted(extra)}"
    return None


def call_grok(label: str, reasons: list[str], timeout: float = 45) -> tuple[str, dict]:
    key = (os.environ.get("XAI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("XAI_API_KEY not set")
    model = os.environ.get("GROK_MODEL", "grok-4.3")
    base = os.environ.get("XAI_BASE_URL", "https://api.x.ai/v1").rstrip("/")
    body = {
        "model": model, "store": False,
        "input": [{"role": "system", "content": SYSTEM},
                  {"role": "user", "content": json.dumps({"label": label, "reasons": reasons})}],
        "text": {"format": {"type": "json_schema", "name": "risk_summary", "schema": SCHEMA, "strict": True}},
    }
    t0 = time.perf_counter()
    r = requests.post(f"{base}/responses", json=body, timeout=timeout,
                      headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    if r.status_code != 200:
        raise RuntimeError(f"xAI HTTP {r.status_code}: {r.text[:160]}")
    j = r.json()
    out = j.get("output_text")
    if not out:
        for o in j.get("output", []):
            if o.get("type") == "message":
                for c in o.get("content", []):
                    if c.get("type") == "output_text":
                        out = c.get("text")
    if not out:
        raise RuntimeError("no output_text")
    return json.loads(out)["summary"].strip(), {"model": model, "seconds": round(time.perf_counter() - t0, 1),
                                                 "response_id": j.get("id")}


def summarize(d, site_id: str, risk: dict, force: bool = False) -> tuple[str, str]:
    """Ensure a cached Grok summary exists for these reasons. Returns (summary, source)."""
    rh = risk["reasons_hash"]
    hit = d.risk_summaries.find_one({"_id": rh})
    if hit and not force:
        return hit["summary"], "cache"
    label = LABELS[risk["level"]]
    try:
        text, meta = call_grok(label, risk["reasons"])
        why = grounded(text, label, risk["reasons"])
        if why:  # one retry with the rejection reason
            text, meta = call_grok(label, risk["reasons"] + [f"(previous draft rejected: {why}; be shorter and exact)"])
            why = grounded(text, label, risk["reasons"])
        if why:
            raise RuntimeError(f"rejected Grok summary ({why}): {text!r}")
    except Exception as e:  # any error -> the templated summary stays
        print(f"  {site_id}: Grok failed, keeping template: {str(e)[:200]}")
        return risk["summary"], "template"
    d.risk_summaries.update_one({"_id": rh}, {"$set": {
        "site_id": site_id, "level": risk["level"], "score": risk["score"], "reasons": risk["reasons"], "summary": text,
        "model": meta["model"], "response_id": meta["response_id"], "created_at": utcnow_iso(),
        "grounding": "reasons only; label prefix, <=25 words and numbers-subset checks passed"}}, upsert=True)
    print(f"  {site_id}: Grok {meta['seconds']}s")
    return text, "grok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site")
    ap.add_argument("--force", action="store_true", help="call Grok even if cached")
    ap.add_argument("--prewarm-golden", type=float, metavar="RLUSD")
    args = ap.parse_args()
    d = db()
    q = {"is_demo_data": False, **({"id": args.site} if args.site else {})}
    for s in d.sites.find(q, {"_id": 0}).sort("id", 1):
        r = riskmod.risk_for_site(d, s)
        text, src = summarize(d, s["id"], r, args.force)
        if src != "template":
            # risk.py would pick the cached summary up anyway; write it now so sites.risk is current.
            r["summary"], r["summary_source"] = text, f"grok ({os.environ.get('GROK_MODEL', 'grok-4.3')})"
        riskmod.write_risk(d, s["id"], r)
        print(f"{s['id']:30} [{src:8}] {r['summary']}")
    if args.prewarm_golden:
        demo = d.demo_state.find_one({"_id": "golden"}) or {}
        s = d.sites.find_one({"id": demo.get("golden_site_id")}, {"_id": 0})
        after = riskmod.risk_for_site(d, s, extra_xrpl=args.prewarm_golden)
        text, src = summarize(d, s["id"], after, args.force)
        print(f"prewarm golden after +{args.prewarm_golden:.2f} RLUSD [{src}]: {text}")


if __name__ == "__main__":
    main()
