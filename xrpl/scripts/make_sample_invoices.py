"""Renders the demo invoice text (xrpl/data/invoices/happy.txt by default) as a PDF and a PNG with PyMuPDF.

  python scripts/make_sample_invoices.py                      # regenerate the committed samples happy.pdf + happy.png
  python scripts/make_sample_invoices.py --invoice-id INV-P2-20260926-190000 --amount 1.00 --out-dir <dir>
                                                              # per-run copy with a fresh invoice id (npm run demo happy pdf|png)
  python scripts/make_sample_invoices.py --scanned            # also write happy-scan.pdf: an image-only page (no text layer),
                                                              # which the verifier rasterizes and sends as an image

All output is DEMO DATA: a fictional organization and a testnet-scale RLUSD amount.
"""
import argparse
import os
import sys

import fitz  # PyMuPDF

HERE = os.path.dirname(os.path.abspath(__file__))
INVOICES = os.path.normpath(os.path.join(HERE, "..", "data", "invoices"))
SAMPLE_ID = "INV-P2-SAMPLE-0001"
SAMPLE_AMOUNT = "12.50"


def render_text(template_path: str, invoice_id: str, amount: str) -> str:
    with open(template_path, encoding="utf-8") as f:
        text = f.read()
    return text.replace(SAMPLE_ID, invoice_id).replace(SAMPLE_AMOUNT, amount.rjust(len(SAMPLE_AMOUNT)))


def write_pdf(text: str, pdf_path: str) -> None:
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)  # US Letter
    # Header band
    page.draw_rect(fitz.Rect(36, 36, 576, 70), color=(0.15, 0.25, 0.45), fill=(0.15, 0.25, 0.45))
    page.insert_text((48, 59), "INVOICE  (demo data)", fontname="hebo", fontsize=14, color=(1, 1, 1))
    body = "\n".join(line for line in text.splitlines() if line.strip() not in ("INVOICE", "======="))
    rect = fitz.Rect(48, 86, 570, 760)
    left = page.insert_textbox(rect, body, fontname="cour", fontsize=9.2, lineheight=1.35)
    if left < 0:
        raise RuntimeError("invoice text does not fit on one page")
    doc.set_metadata({"title": "Demo invoice (fictional)", "author": "GlassLedger demo", "subject": "testnet-scale RLUSD invoice"})
    doc.save(pdf_path, garbage=3, deflate=True)
    doc.close()


def write_png(pdf_path: str, png_path: str, dpi: int = 110) -> None:
    doc = fitz.open(pdf_path)
    doc[0].get_pixmap(dpi=dpi).save(png_path)
    doc.close()


def write_scanned_pdf(png_path: str, pdf_path: str) -> None:
    """An image-only PDF (no text layer), like a scanned invoice."""
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_image(page.rect, filename=png_path)
    doc.save(pdf_path, garbage=3, deflate=True)
    doc.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", default=os.path.join(INVOICES, "happy.txt"))
    ap.add_argument("--invoice-id", default=SAMPLE_ID)
    ap.add_argument("--amount", default=SAMPLE_AMOUNT)
    ap.add_argument("--out-dir", default=INVOICES)
    ap.add_argument("--name", default="happy")
    ap.add_argument("--scanned", action="store_true", help="also write <name>-scan.pdf (image only)")
    a = ap.parse_args()

    os.makedirs(a.out_dir, exist_ok=True)
    text = render_text(a.template, a.invoice_id, a.amount)
    pdf_path = os.path.join(a.out_dir, f"{a.name}.pdf")
    png_path = os.path.join(a.out_dir, f"{a.name}.png")
    write_pdf(text, pdf_path)
    write_png(pdf_path, png_path)
    out = [pdf_path, png_path]
    if a.scanned:
        scan_path = os.path.join(a.out_dir, f"{a.name}-scan.pdf")
        write_scanned_pdf(png_path, scan_path)
        out.append(scan_path)
    for p in out:
        print(p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
