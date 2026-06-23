#!/usr/bin/env python3
"""
serve-review.py — local keyword-bank review server

Routes:
  GET  /          → review.html
  GET  /bank      → keyword-bank.json (read fresh on every request)
  POST /decision  → update one keyword's status + evidence
  GET  /typeface/* → static font files (for Source Sans 3 in the HTML)

Run:
  python3 serve-review.py [--port PORT]
  PORT env var is also respected.

The server resolves all file paths relative to its own location (__file__),
so it works correctly regardless of the working directory you launch it from.
"""

import argparse
import json
import os
import sys
import tempfile
import webbrowser
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

# ── Path resolution ──────────────────────────────────────────────────────────
# __file__ is  …/applications/scripts/serve-review.py
# REPO_ROOT is  …/applications/
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT  = SCRIPT_DIR.parent

BANK_PATH  = REPO_ROOT / "keyword-bank" / "keyword-bank.json"
HTML_PATH  = REPO_ROOT / "keyword-bank" / "review.html"
FONT_DIR   = REPO_ROOT / "typeface" / "Source_Sans_3"

EMPTY_BANK = {"version": 1, "updated": str(date.today()), "keywords": []}


# ── Bank I/O ─────────────────────────────────────────────────────────────────

def read_bank() -> dict:
    """Read and parse the keyword bank. Returns EMPTY_BANK on missing/corrupt file."""
    try:
        text = BANK_PATH.read_text(encoding="utf-8").strip()
        if not text:
            return dict(EMPTY_BANK)
        return json.loads(text)
    except (FileNotFoundError, json.JSONDecodeError):
        return dict(EMPTY_BANK)


def write_bank(bank: dict) -> None:
    """
    Write the bank atomically: write to a temp file in the same directory,
    then rename over the target. This prevents a corrupt file if the process
    dies mid-write.
    """
    bank["updated"] = str(date.today())
    payload = json.dumps(bank, indent=2, ensure_ascii=False) + "\n"

    # Use the same directory as the target so os.replace is atomic (same FS).
    fd, tmp_path = tempfile.mkstemp(dir=BANK_PATH.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp_path, BANK_PATH)  # atomic on POSIX
    except Exception:
        # Clean up the temp file if something went wrong before the rename.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Request handler ───────────────────────────────────────────────────────────

class ReviewHandler(BaseHTTPRequestHandler):

    # Suppress the default per-request log line; we print our own for decisions.
    def log_message(self, fmt, *args):  # noqa: N802
        pass

    # ── GET ───────────────────────────────────────────────────────────────

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path   = parsed.path

        if path == "/":
            self._serve_file(HTML_PATH, "text/html; charset=utf-8")

        elif path == "/bank":
            # Read fresh on every request so edits to the file are reflected
            # immediately without restarting the server.
            bank = read_bank()
            body = json.dumps(bank, ensure_ascii=False).encode("utf-8")
            self._respond(200, "application/json", body)

        elif path.startswith("/typeface/"):
            # Strip leading /typeface/ and resolve against FONT_DIR.
            # Guard against directory traversal: reject any path containing "..".
            rel = path[len("/typeface/"):]
            if ".." in rel:
                self._respond(400, "text/plain", b"Bad request")
                return
            font_file = FONT_DIR / rel
            if font_file.is_file():
                self._serve_file(font_file, "font/ttf")
            else:
                self._respond(404, "text/plain", b"Font not found")

        else:
            self._respond(404, "text/plain", b"Not found")

    # ── POST ──────────────────────────────────────────────────────────────

    def do_POST(self):  # noqa: N802
        if urlparse(self.path).path != "/decision":
            self._respond(404, "text/plain", b"Not found")
            return

        # Read and parse the request body.
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._respond(400, "text/plain", b"Invalid JSON")
            return

        term     = str(payload.get("term", "")).strip()
        status   = str(payload.get("status", "")).strip()
        evidence = str(payload.get("evidence", "")).strip()

        # ── Server-side validation ────────────────────────────────────────
        if not term:
            self._respond(400, "text/plain", b"Missing 'term'")
            return

        if status not in ("confirmed", "rejected"):
            self._respond(400, "text/plain", b"'status' must be 'confirmed' or 'rejected'")
            return

        # The anti-fabrication rule: confirmed requires non-empty evidence.
        if status == "confirmed" and not evidence:
            self._respond(
                400,
                "text/plain",
                b"Evidence is required when confirming a keyword.",
            )
            return

        # ── Update the bank ───────────────────────────────────────────────
        bank    = read_bank()
        matched = False
        for kw in bank.get("keywords", []):
            if kw.get("term") == term:
                kw["status"]   = status
                kw["evidence"] = evidence
                matched = True
                break

        if not matched:
            self._respond(404, "text/plain", b"Term not found in bank")
            return

        write_bank(bank)

        # Human-readable summary to stdout for easy log scanning.
        if status == "confirmed":
            print(f'  confirmed "{term}" — evidence: {evidence}')
        else:
            print(f'  rejected  "{term}"')

        ok = json.dumps({"ok": True}).encode("utf-8")
        self._respond(200, "application/json", ok)

    # ── Shared response helpers ───────────────────────────────────────────

    def _respond(self, code: int, content_type: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, path: Path, content_type: str) -> None:
        try:
            body = path.read_bytes()
            self._respond(200, content_type, body)
        except FileNotFoundError:
            self._respond(404, "text/plain", b"File not found")


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Keyword-bank review server")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", 8765)),
        help="TCP port to bind (default 8765, or $PORT)",
    )
    args = parser.parse_args()

    host = "127.0.0.1"
    port = args.port
    url  = f"http://{host}:{port}"

    server = HTTPServer((host, port), ReviewHandler)
    print(f"Keyword Review  →  {url}")
    print(f"Bank file       →  {BANK_PATH}")
    print("Press Ctrl+C to stop.\n")

    # Best-effort browser open — don't crash if it fails (e.g. headless env).
    try:
        webbrowser.open(url)
    except Exception:
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
