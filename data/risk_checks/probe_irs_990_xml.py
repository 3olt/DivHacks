"""D2b: cash fields for cash_months come from the IRS e-file XML (Form 990 Part X), not ProPublica.

ProPublica's `filings_with_data` has NO cash / savings fields, and its `download-xml` route
serves a "Security Check" page to scripts. The IRS publishes the same e-file XML at
https://apps.irs.gov/pub/epostcard/990/xml/<YEAR>/ as monthly batch zips (~500 MB each) plus
an index CSV. The server supports HTTP Range requests, so we read ONLY the zip's central
directory and the one <OBJECT_ID>_public.xml member (a few hundred KB) instead of 500 MB.

Usage:
  python risk_checks/probe_irs_990_xml.py --ein 133179546
  python risk_checks/probe_irs_990_xml.py --ein 133179546 --year 2026 --object-id 202621349349304557 --batch 2026_TEOS_XML_05A
"""
from __future__ import annotations

import argparse
import io
import re
import xml.etree.ElementTree as ET
import zipfile

from common import result, save_text, session, timed

IRS_BASE = "https://apps.irs.gov/pub/epostcard/990/xml"
NS = {"irs": "http://www.irs.gov/efile"}

# Form 990 element paths we care about (Part I summary, Part IX, Part X balance sheet).
FIELDS = {
    "tax_period_begin": ".//irs:ReturnHeader/irs:TaxPeriodBeginDt",
    "tax_period_end": ".//irs:ReturnHeader/irs:TaxPeriodEndDt",
    "filer_ein": ".//irs:ReturnHeader/irs:Filer/irs:EIN",
    "filer_name": ".//irs:ReturnHeader/irs:Filer/irs:BusinessName/irs:BusinessNameLine1Txt",
    "return_type": ".//irs:ReturnHeader/irs:ReturnTypeCd",
    # Part I
    "CYTotalRevenueAmt": ".//irs:IRS990/irs:CYTotalRevenueAmt",
    "CYTotalExpensesAmt": ".//irs:IRS990/irs:CYTotalExpensesAmt",
    "NetAssetsOrFundBalancesEOYAmt": ".//irs:IRS990/irs:NetAssetsOrFundBalancesEOYAmt",
    # Part IX line 25
    "TotalFunctionalExpensesGrp/TotalAmt": ".//irs:IRS990/irs:TotalFunctionalExpensesGrp/irs:TotalAmt",
    # Part X lines 1, 2, 16, 26
    "CashNonInterestBearingGrp/EOYAmt": ".//irs:IRS990/irs:CashNonInterestBearingGrp/irs:EOYAmt",
    "SavingsAndTempCashInvstGrp/EOYAmt": ".//irs:IRS990/irs:SavingsAndTempCashInvstGrp/irs:EOYAmt",
    "TotalAssetsGrp/EOYAmt": ".//irs:IRS990/irs:TotalAssetsGrp/irs:EOYAmt",
    "TotalLiabilitiesGrp/EOYAmt": ".//irs:IRS990/irs:TotalLiabilitiesGrp/irs:EOYAmt",
    # Part X line 11 (not cash; shown for context only)
    "InvestmentsPubTradedSecGrp/EOYAmt": ".//irs:IRS990/irs:InvestmentsPubTradedSecGrp/irs:EOYAmt",
    # Part VIII line 1e: government grants (contributions) -- how much of revenue is gov money
    "GovernmentGrantsAmt": ".//irs:IRS990/irs:GovernmentGrantsAmt",
}


class HttpRangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP Range requests (enough for zipfile)."""

    def __init__(self, url: str, s):
        self.url, self.s, self.pos = url, s, 0
        r = s.head(url, timeout=30)
        r.raise_for_status()
        if r.headers.get("Accept-Ranges") != "bytes":
            raise RuntimeError("server does not advertise Accept-Ranges: bytes")
        self.size = int(r.headers["Content-Length"])
        self.bytes_fetched = 0
        self.requests = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = {0: off, 1: self.pos + off, 2: self.size + off}[whence]
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.pos + n, self.size) - 1
        r = self.s.get(self.url, headers={"Range": f"bytes={self.pos}-{end}"}, timeout=60)
        if r.status_code != 206:
            raise RuntimeError(f"expected 206 Partial Content, got {r.status_code}")
        data = r.content
        self.pos += len(data)
        self.bytes_fetched += len(data)
        self.requests += 1
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def read_member(f: HttpRangeFile, info: zipfile.ZipInfo) -> bytes:
    """Read one member's bytes. QUIRK: IRS TEOS zips use Deflate64 (method 9), which the
    stdlib cannot decode, so we pull the raw compressed bytes and inflate with `inflate64`."""
    if info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        return zipfile.ZipFile(io.BufferedReader(f, buffer_size=1 << 16)).read(info.filename)
    if info.compress_type != 9:
        raise NotImplementedError(f"zip compression method {info.compress_type}")
    import inflate64  # pip install inflate64 (listed in data/requirements.txt)

    f.seek(info.header_offset)
    local = f.read(30)
    if local[:4] != b"PK\x03\x04":
        raise RuntimeError("bad local file header signature")
    name_len = int.from_bytes(local[26:28], "little")
    extra_len = int.from_bytes(local[28:30], "little")
    f.seek(info.header_offset + 30 + name_len + extra_len)
    raw = f.read(info.compress_size)
    out = inflate64.Inflater().inflate(raw)
    if len(out) != info.file_size:
        raise RuntimeError(f"inflated {len(out)} bytes, expected {info.file_size}")
    return out


def find_in_index(s, year: int, ein: str):
    """Stream index_<year>.csv and return the newest Form 990 row for this EIN."""
    url = f"{IRS_BASE}/{year}/index_{year}.csv"
    hits = []
    with s.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        header = None
        for line in r.iter_lines(decode_unicode=True):
            if header is None:
                header = line.split(",")
                continue
            if f",{ein}," in line:
                row = dict(zip(header, line.split(",")))
                if row.get("RETURN_TYPE") == "990":
                    hits.append(row)
    hits.sort(key=lambda r: r["TAX_PERIOD"], reverse=True)
    return url, hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ein", default="133179546", help="9 digits, no dash")
    ap.add_argument("--year", type=int, default=2026, help="IRS processing year folder")
    ap.add_argument("--object-id")
    ap.add_argument("--batch")
    args = ap.parse_args()
    s = session()

    if not (args.object_id and args.batch):
        (index_url, hits), secs = timed(find_in_index, s, args.year, args.ein)
        print(f"index {index_url}: {len(hits)} Form 990 rows for EIN {args.ein} ({secs}s)")
        if not hits:
            return result("D2b", "FAIL", reason=f"EIN not in index_{args.year}.csv; try --year {args.year - 1}")
        row = hits[0]
        args.object_id, args.batch = row["OBJECT_ID"], row["XML_BATCH_ID"]
        print("index row:", row)

    # QUIRK: the index's XML_BATCH_ID can name "..._05A" while the IRS split that batch into
    # several zips (05A, 05B, ...). Try the named zip, then sibling letters.
    base = args.batch[:-1] if args.batch[-1].isalpha() else args.batch
    candidates = [args.batch] + [base + c for c in "ABCDEFGH" if base + c != args.batch]
    member = zf = f = zip_url = None
    for batch in candidates:
        zip_url = f"{IRS_BASE}/{args.year}/{batch}.zip"
        head = s.head(zip_url, timeout=30, allow_redirects=False)
        if head.status_code != 200:
            print(f"{zip_url} -> HTTP {head.status_code}; stopping batch search")
            break
        f = HttpRangeFile(zip_url, s)
        zf = zipfile.ZipFile(io.BufferedReader(f, buffer_size=1 << 16))
        member = next((n for n in zf.namelist() if n.endswith(f"{args.object_id}_public.xml")), None)
        print(f"{zip_url}: {len(zf.namelist())} members, object {'FOUND' if member else 'not here'}")
        if member:
            break
    if member is None:
        return result("D2b", "FAIL", batch=args.batch, reason="object id not found in any sibling zip")
    xml_bytes = read_member(f, zf.getinfo(member))
    print(f"read {member} ({len(xml_bytes)} bytes) from {zip_url} "
          f"(zip size {f.size:,} bytes; fetched {f.bytes_fetched:,} bytes in {f.requests} range requests)")

    root = ET.fromstring(xml_bytes)
    vals = {}
    for k, path in FIELDS.items():
        el = root.find(path, NS)
        vals[k] = el.text if el is not None else None

    def num(k):
        v = vals.get(k)
        return float(v) if v not in (None, "") else 0.0

    expenses = num("TotalFunctionalExpensesGrp/TotalAmt") or num("CYTotalExpensesAmt")
    cash = num("CashNonInterestBearingGrp/EOYAmt") + num("SavingsAndTempCashInvstGrp/EOYAmt")
    cash_months = round(cash / (expenses / 12), 2) if expenses else None

    # Save a trimmed sample: header + the Part I / Part IX / Part X values we use (not the whole return).
    trimmed = "\n".join(
        [f"<!-- trimmed from {zip_url} member {member}; values only -->", "<irs990_extract>"]
        + [f"  <{re.sub(r'[^A-Za-z0-9_]', '_', k)}>{v}</{re.sub(r'[^A-Za-z0-9_]', '_', k)}>" for k, v in vals.items()]
        + ["</irs990_extract>", ""]
    )
    save_text(f"irs990_{args.ein}_{vals.get('tax_period_end') or 'latest'}_extract.xml", trimmed)

    return result(
        "D2b",
        "PASS" if cash_months is not None and vals["CashNonInterestBearingGrp/EOYAmt"] is not None else "PARTIAL",
        ein=args.ein,
        object_id=args.object_id,
        zip_url=zip_url,
        member=member,
        values=vals,
        cash_months=cash_months,
        formula="(CashNonInterestBearingGrp/EOYAmt + SavingsAndTempCashInvstGrp/EOYAmt) / (TotalFunctionalExpensesGrp/TotalAmt / 12)",
    )


if __name__ == "__main__":
    main()
