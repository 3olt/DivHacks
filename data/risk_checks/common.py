"""Shared helpers for the data risk-check probes (read-only, public data only)."""
from __future__ import annotations

import json
import time
from pathlib import Path

import requests

DATA_DIR = Path(__file__).resolve().parents[1]
SAMPLES_DIR = DATA_DIR / "raw" / "samples"
SAMPLES_DIR.mkdir(parents=True, exist_ok=True)

UA = "DivHacks2026-risk-check/0.1 (+https://github.com/3olt/DivHacks)"


def session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = UA
    return s


def timed(fn, *args, **kwargs):
    """Run fn and return (result, seconds)."""
    t0 = time.perf_counter()
    out = fn(*args, **kwargs)
    return out, round(time.perf_counter() - t0, 3)


def save_text(name: str, text: str) -> Path:
    p = SAMPLES_DIR / name
    p.write_text(text, encoding="utf-8")
    return p


def save_json(name: str, obj) -> Path:
    return save_text(name, json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def result(check_id: str, status: str, **evidence) -> dict:
    """Uniform result line printed by every probe."""
    out = {"id": check_id, "status": status, **evidence}
    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
    return out
