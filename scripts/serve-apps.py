#!/usr/bin/env python3
"""
serve-apps.py — daily application review dashboard.
Shows built resume/cover letter pairs with apply links, PDFs, and checklist.

Run: python3 scripts/serve-apps.py [--port PORT]
     Then open http://localhost:7474
"""
import argparse, json, os, re, webbrowser
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote

SCRIPT_DIR = Path(__file__).resolve().parent
REPO       = SCRIPT_DIR.parent
QUEUE_PATH = REPO / "applied" / "_queue" / "queue.json"
APPLIED    = REPO / "applied"

def load_queue():
    if not QUEUE_PATH.exists(): return []
    data = json.loads(QUEUE_PATH.read_text())
    return data.get("items", data) if isinstance(data, dict) else data

def available_dates():
    dates = sorted({it["date"] for it in load_queue()
                    if it.get("status") == "built" and it.get("date")}, reverse=True)
    return dates

def items_for_date(d):
    return [it for it in load_queue()
            if it.get("date") == d and it.get("status") == "built"]

def find_field_map(item):
    """Read field-map.json — tries flat structure first, then legacy subfolder."""
    d, fn = item.get("date", ""), item.get("folderName", "")
    for p in [APPLIED / d / f"{fn}_field-map.json",
              APPLIED / d / fn / "field-map.json"]:
        if p.exists(): return json.loads(p.read_text())
    return {}

def find_app_md(item):
    d, fn = item.get("date", ""), item.get("folderName", "")
    for p in [APPLIED / d / f"{fn}_application.md",
              APPLIED / d / fn / "application.md"]:
        if p.exists(): return p.read_text()
    return ""

def parse_checklist(md):
    items = []
    for line in md.splitlines():
        m = re.match(r'\s*-\s*\[( |x|X)\]\s*(.*)', line)
        if m:
            items.append((m.group(1).lower() == 'x', m.group(2).strip()))
    return items

def parse_coverage(md):
    m = re.search(r'\*\*Coverage:\*\*\s*(\d+)%', md)
    return int(m.group(1)) if m else None

# ── HTML ─────────────────────────────────────────────────────────────────────

CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #f5f6f8; color: #1a1a1a; }
header { background: #fff; border-bottom: 1px solid #e0e0e0;
         padding: 16px 32px; display: flex; align-items: center; justify-content: space-between; }
header h1 { font-size: 18px; font-weight: 700; color: #1a56db; }
.nav { display: flex; align-items: center; gap: 28px; }
.nav-btn { color: #1a56db; text-decoration: none; font-size: 14px; font-weight: 500; }
.nav-btn:hover { text-decoration: underline; }
.nav-center { text-align: center; }
.date-label { font-size: 15px; font-weight: 600; }
.count { font-size: 12px; color: #888; margin-top: 2px; }
main { max-width: 900px; margin: 28px auto; padding: 0 24px;
       display: flex; flex-direction: column; gap: 18px; }
.card { background: #fff; border: 1px solid #e2e4e8; border-radius: 10px; padding: 22px 26px; }
.card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 5px; }
.company { font-size: 11px; font-weight: 700; color: #1a56db;
           text-transform: uppercase; letter-spacing: .06em; }
.title { font-size: 17px; font-weight: 600; margin-top: 3px; }
.badges { display: flex; gap: 7px; flex-shrink: 0; margin-left: 16px; padding-top: 2px; }
.badge { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 20px; white-space: nowrap; }
.badge.fit  { background: #e8f0fe; color: #1a56db; }
.badge.cov  { background: #e6f4ea; color: #1a7a30; }
.badge.cov.warn { background: #fff3cd; color: #856404; }
.fitnote { font-size: 13px; color: #555; margin: 8px 0 16px; line-height: 1.45; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.btn { display: inline-block; padding: 8px 16px; border-radius: 7px;
       font-size: 13px; font-weight: 600; text-decoration: none; line-height: 1; }
.btn.apply { background: #1a56db; color: #fff; }
.btn.apply:hover { background: #1246b8; }
.btn.pdf { background: #f0f2f5; color: #333; }
.btn.pdf:hover { background: #e2e5ea; }
.checklist { margin-top: 16px; padding-top: 16px; border-top: 1px solid #f0f0f0;
             list-style: none; display: flex; flex-direction: column; gap: 6px; }
.checklist li { font-size: 13px; display: flex; gap: 8px; align-items: baseline; line-height: 1.4; }
.checklist li.done { color: #aaa; text-decoration: line-through; }
.checklist li.todo { color: #333; }
.chk { flex-shrink: 0; }
.empty { color: #999; font-size: 15px; text-align: center; padding: 60px; }
"""

def render_card(item):
    fm  = find_field_map(item)
    md  = find_app_md(item)
    cov = parse_coverage(md)
    checks = parse_checklist(md)

    apply_url  = fm.get("applyUrl") or item.get("jdUrl", "#")
    resume_pdf = quote(fm.get("resumePdf", ""), safe="")
    cl_pdf     = quote(fm.get("coverLetterPdf", ""), safe="")
    fit        = item.get("fitScore", "?")
    fitnote    = item.get("fitNote", "")

    cov_badge = ""
    if cov is not None:
        cls = "cov" if cov >= 90 else "cov warn"
        cov_badge = f'<span class="badge {cls}">{cov}% coverage</span>'

    pdf_links = ""
    if resume_pdf:
        pdf_links += f'<a class="btn pdf" href="/pdf?p={resume_pdf}" target="_blank">Resume PDF</a>'
    if cl_pdf:
        pdf_links += f'<a class="btn pdf" href="/pdf?p={cl_pdf}" target="_blank">Cover Letter PDF</a>'

    checklist_html = ""
    if checks:
        lis = "".join(
            f'<li class="{"done" if ok else "todo"}"><span class="chk">{"☑" if ok else "☐"}</span>{text}</li>'
            for ok, text in checks
        )
        checklist_html = f'<ul class="checklist">{lis}</ul>'

    return f"""
<div class="card">
  <div class="card-header">
    <div>
      <div class="company">{item.get("company","")}</div>
      <div class="title">{item.get("title","")}</div>
    </div>
    <div class="badges">
      <span class="badge fit">Fit: {fit}</span>
      {cov_badge}
    </div>
  </div>
  <div class="fitnote">{fitnote}</div>
  <div class="actions">
    <a class="btn apply" href="{apply_url}" target="_blank">Apply ↗</a>
    {pdf_links}
  </div>
  {checklist_html}
</div>"""

def render_page(d):
    dates  = available_dates()
    items  = items_for_date(d)
    idx    = dates.index(d) if d in dates else -1
    prev_d = dates[idx + 1] if idx >= 0 and idx < len(dates) - 1 else None
    next_d = dates[idx - 1] if idx > 0 else None

    nav_prev = f'<a class="nav-btn" href="/?d={prev_d}">← {prev_d}</a>' if prev_d else '<span></span>'
    nav_next = f'<a class="nav-btn" href="/?d={next_d}">{next_d} →</a>' if next_d else '<span></span>'
    cards    = "".join(render_card(it) for it in items)
    empty    = "<p class='empty'>No built applications for this date.</p>" if not items else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Applications — {d}</title>
<style>{CSS}</style>
</head>
<body>
<header>
  <h1>Applications</h1>
  <div class="nav">
    {nav_prev}
    <div class="nav-center">
      <div class="date-label">{d}</div>
      <div class="count">{len(items)} built</div>
    </div>
    {nav_next}
  </div>
</header>
<main>{empty}{cards}</main>
</body>
</html>"""

# ── Server ────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass  # suppress per-request noise

    def do_GET(self):
        parsed = urlparse(self.path)
        qs     = parse_qs(parsed.query)

        if parsed.path == "/pdf":
            raw = qs.get("p", [""])[0]
            pdf = Path(raw)
            try: pdf.resolve().relative_to(APPLIED.resolve())
            except ValueError: self.send_error(403); return
            if not pdf.exists(): self.send_error(404); return
            data = pdf.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if parsed.path == "/":
            dates = available_dates()
            d = qs.get("d", [None])[0] or (dates[0] if dates else str(date.today()))
            html = render_page(d).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return

        self.send_error(404)

def main():
    ap = argparse.ArgumentParser(description="Application review dashboard")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 7474)))
    ap.add_argument("--no-browser", action="store_true", dest="no_browser")
    args = ap.parse_args()
    url = f"http://localhost:{args.port}"
    print(f"Dashboard → {url}  (Ctrl-C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    HTTPServer(("", args.port), Handler).serve_forever()

if __name__ == "__main__":
    main()
