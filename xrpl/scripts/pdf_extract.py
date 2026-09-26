"""PDF -> text (or PNG for text-less pages) for the Grok invoice verifier.

Usage: python pdf_extract.py <file.pdf>
Prints one JSON object on stdout:
  {"engine": "pypdf"|"pymupdf", "page_count": N, "pages": [{"page": 1, "text": "..."} | {"page": 2, "png_base64": "..."}]}

Text comes from pypdf first, PyMuPDF (fitz) as the fallback. A page with (almost) no extractable text, e.g. a scan,
is rasterized with PyMuPDF at 150 dpi and returned as a base64 PNG so the verifier can send it as an image.
The PDF is untrusted input: this script only reads it; nothing in it is executed or interpreted.
"""
import base64
import json
import sys

MAX_PAGES = 10
MIN_TEXT_CHARS = 20


def main(path: str) -> int:
    texts = None
    engine = None
    try:
        from pypdf import PdfReader

        reader = PdfReader(path)
        texts = [(p.extract_text() or "") for p in reader.pages]
        engine = "pypdf"
    except Exception as e:  # noqa: BLE001 - any pypdf failure falls back to PyMuPDF
        sys.stderr.write(f"pypdf failed ({type(e).__name__}: {e}); falling back to PyMuPDF\n")

    try:
        import fitz  # PyMuPDF
    except Exception as e:  # noqa: BLE001
        fitz = None
        sys.stderr.write(f"PyMuPDF unavailable ({e})\n")

    doc = fitz.open(path) if fitz else None
    if texts is None:
        if doc is None:
            raise RuntimeError("neither pypdf nor PyMuPDF could read the PDF")
        texts = [doc[i].get_text() for i in range(doc.page_count)]
        engine = "pymupdf"

    page_count = len(texts)
    pages = []
    for i in range(min(page_count, MAX_PAGES)):
        text = (texts[i] or "").strip()
        if len(text) >= MIN_TEXT_CHARS:
            pages.append({"page": i + 1, "text": text})
        elif doc is not None and i < doc.page_count:
            png = doc[i].get_pixmap(dpi=150).tobytes("png")
            pages.append({"page": i + 1, "png_base64": base64.b64encode(png).decode("ascii")})
        else:
            pages.append({"page": i + 1, "text": text})
    json.dump({"engine": engine, "page_count": page_count, "pages": pages}, sys.stdout)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.stderr.write("usage: python pdf_extract.py <file.pdf>\n")
        sys.exit(2)
    try:
        sys.exit(main(sys.argv[1]))
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"pdf_extract failed: {type(e).__name__}: {e}\n")
        sys.exit(1)
