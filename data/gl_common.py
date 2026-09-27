"""Shared helpers for the Phase 4 data pipeline (ingest.py, risk.py, summaries.py, demo_reset.py)."""
from __future__ import annotations

import os
from datetime import date, datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

DATA_DIR = Path(__file__).resolve().parent
REPO = DATA_DIR.parent
RAW = DATA_DIR / "raw" / "public"
SAMPLES = DATA_DIR / "raw" / "samples"
SEED_CSV = DATA_DIR / "seed" / "nonprofits.csv"

load_dotenv(REPO / ".env")

DB_NAME = "divhacks"

GOLDEN_EIN = "13-3179546"
GOLDEN_SITE_ID = "site_fbnyc"
# HRA/DSS "Prov of SNAP and emergency food assistance benefits": $2,932,500, 2023-07-01..2026-06-30, registered
# 2024-08-26, $2,066,705 spent (Checkbook NYC, all-years contracts query, fetched 2026-09-26). The task's preferred
# golden contract once Checkbook terms loaded. (CT106920228800360 is 99.5% paid, so it scores 0 pace points.)
GOLDEN_CONTRACT_ID = "CT106920258801736"

# Option B (user decision): for the GOLDEN site only, the agent's real XRPL Testnet RLUSD payments count toward the
# contract's "paid" at this DISCLOSED demo scale. Chosen so that one 12.50 RLUSD payment is material next to the real
# Checkbook numbers (see data/README.md "Option B"). Testnet RLUSD has no monetary value.
SCALE_USD_PER_RLUSD = 10_000

APPENDIX_URL = "https://comptroller.nyc.gov/wp-content/uploads/2025/01/Appendix-1-FY22-24-Parent-Contracts.xlsx"
APPENDIX_REPORT_URL = ("https://comptroller.nyc.gov/reports/"
                       "annual-summary-contracts-report-for-the-city-of-new-york-fiscal-year-2024/")
APPENDIX_SOURCE = "NYC Comptroller, FY2024 Annual Summary Contracts Report, Appendix 1 (FY22-24 parent contracts)"
CHECKBOOK_API = "https://www.checkbooknyc.com/api"
PROPUBLICA_ORG_PAGE = "https://projects.propublica.org/nonprofits/organizations/{ein9}"
PROPUBLICA_API = "https://projects.propublica.org/nonprofits/api/v2/organizations/{ein9}.json"
OPEN_DATA_SITES_URL = "https://data.cityofnewyork.us/d/y9si-s7ab"
GEOSEARCH_URL = "https://geosearch.planninglabs.nyc/v2/search"

# Agency: our code -> (Comptroller appendix DEPT NAME, Checkbook 3-digit agency code, display name).
# QUIRK: the appendix files HRA/DSS contracts under Doc Dept CD 096, Checkbook under 069 (CT1069...).
AGENCIES = {
    "HRA": ("DSS/HRA", "069", "Human Resources Administration / Dept. of Social Services"),
    "DHS": ("DHS", "071", "Department of Homeless Services"),
    "DYCD": ("DYCD", "260", "Department of Youth and Community Development"),
}


# IRS/ProPublica street addresses the IRS record garbles, keyed by EIN: (as filed, corrected, why). Used for the geocode
# query (fetch_public_extras.py) and the displayed address (ingest.py); the as-filed text is kept on the documents.
IRS_ADDRESS_FIXES = {
    "13-5596811": ("34 12 EAST 12TH STREET", "34 1/2 EAST 12TH STREET",
                   "the IRS record drops the slash of the half number: Police Athletic League HQ is 34 1/2 East 12th Street"),
}


def irs_street(ein: str, address: str) -> str:
    fix = IRS_ADDRESS_FIXES.get(ein)
    return fix[1] if fix and address.strip().upper() == fix[0] else address


def db():
    from pymongo import MongoClient

    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise SystemExit("MONGODB_URI is not set (root .env)")
    return MongoClient(uri, serverSelectionTimeoutMS=20000)[DB_NAME]


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_dt(s: str | None) -> datetime | None:
    """ISO date or datetime (Z or offset) -> aware UTC datetime."""
    if not s:
        return None
    s = s.strip().replace("Z", "+00:00")
    if len(s) == 10:
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    d = datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def parse_date(s: str | None) -> date | None:
    return date.fromisoformat(s[:10]) if s else None


def ein9(ein: str) -> str:
    return ein.replace("-", "")


def money(n: float) -> str:
    """$1,234,567 (no cents) for reasons."""
    return f"${n:,.0f}"
