#!/usr/bin/env python3
"""Fill a tokenized cover-letter TOKENS.docx with per-application field values.

Reads the TOKENS template, substitutes {{TOKEN}} placeholders in word/document.xml
with XML-escaped field values, and writes a new filled .docx. Never modifies the
template. Warns (exit 2) if any {{...}} token remains unfilled in the output.

Usage:
  fill-cover-letter.py --template TOKENS.docx --out OUT.docx --fields FIELDS.json

FIELDS.json keys (all required):
  date          — e.g. "Wednesday, June 11, 2026" (computed from --date, LLM value ignored)
  re_line       — e.g. "Senior Product Manager at Valon" (follows literal "Re: " in template)
  hook          — opening paragraph (plain text, no markup)
  map_1_lead    — bold lead-in for credential paragraph 1 (no trailing period/space)
  map_1_body    — normal-weight body for credential paragraph 1
  map_2_lead    — bold lead-in for credential paragraph 2
  map_2_body    — normal-weight body for credential paragraph 2
  why           — closing paragraph ("why this role, why now")

Smart-quote handling: straight apostrophes/quotes in field values are converted
to proper typographic entities before XML insertion.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

# Path to the shared office scripts (unpack only — pack is called inline here
# because pack.py uses Python 3.10+ type syntax that breaks on 3.9).
DOCX_SCRIPTS = str(Path.home() / ".claude" / "skills" / "docx" / "scripts" / "office")

# Map FIELDS.json key → template token (token is uppercase of key, with _ preserved)
TOKEN_FIELD_MAP = {
    "DATE":       "date",
    "RE_LINE":    "re_line",
    "HOOK":       "hook",
    "MAP_1_LEAD": "map_1_lead",
    "MAP_1_BODY": "map_1_body",
    "MAP_2_LEAD": "map_2_lead",
    "MAP_2_BODY": "map_2_body",
    "WHY":        "why",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def format_letter_date(iso_date: str) -> str:
    """Turn a YYYY-MM-DD string into 'Weekday, Month D, YYYY' deterministically.

    The cover-letter date MUST be computed here, never hand-typed by the LLM
    builder agent: language models reliably get day-of-week math wrong (e.g.
    labelling 2026-06-18 "Wednesday" when it was a Thursday), and a weekday that
    doesn't match the calendar date is an instant red flag to a recruiter.
    Day is formatted without a leading zero, portably (avoids strftime %-d which
    isn't supported on every platform).
    """
    d = datetime.strptime(iso_date, "%Y-%m-%d")
    return f"{d.strftime('%A')}, {d.strftime('%B')} {d.day}, {d.year}"


def xml_escape(s: str) -> str:
    """Escape the three XML special characters for safe insertion into <w:t>."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def apply_smart_quotes(s: str) -> str:
    """Convert straight apostrophes and quotation marks to typographic XML entities.

    Rules applied in order so they don't interfere with each other:
    - em dash (—) is left as-is
    - straight double quote (") → &#x201C; or &#x201D; (open/close heuristic)
    - straight single quote / apostrophe (') → &#x2019; (right single, most common)
    """
    # Double quotes: open before a word character, close after one
    result = re.sub(r'"(?=\w)', "&#x201C;", s)
    result = re.sub(r'"', "&#x201D;", result)
    # Straight apostrophe → right single (apostrophe or closing quote)
    result = result.replace("'", "&#x2019;")
    return result


def prepare_field_value(raw: str) -> str:
    """XML-escape and apply smart quotes to a raw field string."""
    # Apply smart quotes first (operates on plain text), then XML-escape
    # the resulting non-entity characters. Entities contain & which must
    # not be double-escaped, so we do xml_escape first then smart quotes.
    # But xml_escape would turn & into &amp; breaking our entities.
    # Correct order: smart_quotes first (inserts &# entities), then xml_escape
    # on the non-entity portions. Simplest safe approach: xml_escape the raw
    # string EXCEPT for the apostrophe/quote chars, then apply smart quotes.
    escaped = xml_escape(raw)       # & < > are now safe
    quoted = apply_smart_quotes(escaped)  # ' and " become XML entities (contain &)
    return quoted


def drop_empty_paragraphs(text: str, empty_tokens: set, all_tokens: set) -> str:
    """Remove any <w:p> whose ONLY token content maps to an empty value.

    Without this, an unused field (e.g. risk_3="") leaves a blank <w:t></w:t>
    inside its paragraph — which still carries spacing, so it renders as an
    empty gap mid-letter. Dropping the whole paragraph is the canonical fix
    (it's what Rob does by hand). A paragraph with NO tokens (a deliberate
    spacer, e.g. the date→body gap) is never touched; a paragraph that mixes an
    empty token with a filled one is kept (only all-empty paragraphs vanish).
    """
    def repl(m: "re.Match") -> str:
        block = m.group(0)
        toks = [t for t in all_tokens if t in block]
        if toks and all(t in empty_tokens for t in toks):
            return ""  # every token in this paragraph is empty → drop it
        return block
    return re.sub(r"<w:p\b[^>]*>.*?</w:p>", repl, text, flags=re.DOTALL)


def pack_docx(unpacked_dir: Path, output_path: Path) -> None:
    """Zip an unpacked directory into a .docx file (stdlib, no validation).

    Mirrors the core of pack.py without the Python 3.10 type annotation requirement.
    Content types and relationships are preserved as-is from the unpacked directory.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in unpacked_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(unpacked_dir))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Fill a tokenized cover-letter .docx with per-application values."
    )
    ap.add_argument("--template", required=True,
                    help="Path to the TOKENS.docx template")
    ap.add_argument("--out", required=True,
                    help="Output path for the filled .docx")
    ap.add_argument("--fields", required=True,
                    help="Path to FIELDS.json with field values")
    ap.add_argument("--date", default=None,
                    help="Application date as YYYY-MM-DD. When given, the {{DATE}} "
                         "token is computed deterministically (correct weekday) and "
                         "OVERRIDES fields['date'] — the LLM never sets the weekday.")
    args = ap.parse_args()

    # --- Load fields ---
    with open(args.fields, encoding="utf-8") as fh:
        fields: dict = json.load(fh)

    # The date is authoritative from --date, not from the (LLM-written) fields
    # JSON. This is the firewall against wrong-weekday dates reaching a recruiter.
    if args.date:
        computed = format_letter_date(args.date)
        if fields.get("date") and fields["date"] != computed:
            print(f"Overriding fields['date']={fields['date']!r} → {computed!r} "
                  f"(deterministic from --date {args.date})")
        fields["date"] = computed

    missing_keys = [fk for fk in TOKEN_FIELD_MAP.values() if fk not in fields]
    if missing_keys:
        print(f"ERROR: FIELDS.json is missing keys: {missing_keys}", file=sys.stderr)
        return 1

    # --- Unpack template to a temp dir ---
    tmp = tempfile.mkdtemp(prefix="fill_cl_")
    try:
        unpack_result = subprocess.run(
            ["python3", f"{DOCX_SCRIPTS}/unpack.py", args.template, tmp],
            check=True, capture_output=True, text=True,
        )
        print(unpack_result.stdout.strip())

        doc_path = os.path.join(tmp, "word", "document.xml")
        text = open(doc_path, encoding="utf-8").read()

        # Build token → replacement mapping (longest token first to avoid
        # partial matches, though our tokens are non-overlapping).
        mapping = {}
        for token_key, field_key in TOKEN_FIELD_MAP.items():
            token = "{{" + token_key + "}}"
            value = prepare_field_value(fields[field_key])
            mapping[token] = value

        # Drop paragraphs whose only content is an empty field, so unused
        # RISK_*/MAP_* fields don't leave blank gaps mid-letter.
        all_tokens = set(mapping.keys())
        empty_tokens = {tok for tok, val in mapping.items() if val == ""}
        if empty_tokens:
            text = drop_empty_paragraphs(text, empty_tokens, all_tokens)
            print(f"Dropped empty-field paragraphs: {sorted(empty_tokens)}")

        # Count occurrences before substitution for reporting
        counts = {tok: text.count(tok) for tok in mapping}

        # Single-pass substitution (longest-key-first for safety)
        pattern = re.compile(
            "|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True))
        )
        text = pattern.sub(lambda m: mapping[m.group(0)], text)
        open(doc_path, "w", encoding="utf-8").write(text)

        # --- Report fills ---
        print("\nToken fill report:")
        unfilled_in_output = re.findall(r'\{\{[A-Z_0-9]+\}\}', text)
        all_ok = True
        for token, field_key in TOKEN_FIELD_MAP.items():
            tok = "{{" + token + "}}"
            n = counts[tok]
            if n > 0:
                status = "OK  "
            elif tok in empty_tokens:
                status = "DROP"          # intentionally empty → paragraph removed
            else:
                status = "MISS"; all_ok = False
            print(f"  {status} x{n}: {tok} ← fields[{field_key!r}]")

        # --- Pack output via the skill's pack.py (XML condense + auto-repair that
        # Word's PDF export requires; a raw zip opens but won't export). pack.py is
        # patched for Python 3.9. ---
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        _r = subprocess.run(
            ["python3", f"{DOCX_SCRIPTS}/pack.py", tmp, os.path.abspath(args.out),
             "--original", args.template],
            capture_output=True, text=True,
        )
        if _r.returncode != 0:
            sys.stderr.write(_r.stdout + _r.stderr + "\npack.py failed\n")
            return 1
        print(f"\nWrote {args.out}")

        # --- Check for leftover tokens ---
        if unfilled_in_output:
            print(
                f"\nWARNING: {len(unfilled_in_output)} token(s) still unfilled in output: "
                f"{unfilled_in_output}",
                file=sys.stderr,
            )
            return 2

        return 0

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
