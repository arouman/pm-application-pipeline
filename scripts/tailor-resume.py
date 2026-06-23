#!/usr/bin/env python3
"""Deterministically tailor a resume by applying exact text swaps to a COPY of a
master .docx. Fast (no LLM). Never modifies the master.

Usage:
  tailor-resume.py --master MASTER.docx --out OUT.docx --swaps SWAPS.json

SWAPS.json:
  {"replacements": [
     {"old": "Senior Product Manager", "new": "AI Product & Innovation Managing Consultant"},
     {"old": "GTM & Experimentation", "new": "Executive & VP-Level Advisory", "required": true},
     ...
  ]}

Each `old` must be the exact run text as it appears in the résumé (what pandoc shows).
Replacements are applied in a SINGLE pass (longest-match-first) so swaps that reuse
each other's text (A→B while C→A) don't cascade. & < > are XML-escaped automatically.
Exit 2 if any required swap matched 0 times (catches master drift).
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path

DOCX = str(Path.home() / ".claude" / "skills" / "docx" / "scripts" / "office")


def xml_escape(s: str) -> str:
    # Match how OOXML stores literal text inside <w:t>.
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--swaps", required=True)
    a = ap.parse_args()

    reps = json.load(open(a.swaps))["replacements"]
    if not reps:
        print("No replacements given.", file=sys.stderr)
        return 1

    tmp = tempfile.mkdtemp(prefix="tailor_")
    try:
        subprocess.run(["python3", f"{DOCX}/unpack.py", a.master, tmp],
                       check=True, capture_output=True, text=True)
        doc = os.path.join(tmp, "word", "document.xml")
        text = open(doc, encoding="utf-8").read()

        mapping = {xml_escape(r["old"]): xml_escape(r["new"]) for r in reps}
        # Per-swap counts BEFORE editing (single-pass sub loses individual counts).
        counts = {r["old"]: text.count(xml_escape(r["old"])) for r in reps}

        pattern = re.compile("|".join(re.escape(k) for k in
                                      sorted(mapping, key=len, reverse=True)))
        text = pattern.sub(lambda m: mapping[m.group(0)], text)
        open(doc, "w", encoding="utf-8").write(text)

        # Pack via the skill's pack.py — it condenses the XML and runs auto-repair,
        # which Word's PDF-export engine REQUIRES (a raw zip opens but won't export).
        # pack.py is patched for Python 3.9 (added `from __future__ import annotations`).
        out_abs = os.path.abspath(a.out)
        os.makedirs(os.path.dirname(out_abs), exist_ok=True)
        r = subprocess.run(["python3", f"{DOCX}/pack.py", tmp, out_abs, "--original", a.master],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.stderr.write(r.stdout + r.stderr + "\npack.py failed\n")
            return 1

        missing = []
        for r in reps:
            n = counts[r["old"]]
            flag = "OK  " if n else "MISS"
            if n == 0 and r.get("required", True):
                missing.append(r["old"])
            print(f"  {flag} x{n}: {r['old'][:55]}")
        if missing:
            print(f"WARNING: {len(missing)} required swap(s) matched 0 times "
                  f"(master may have drifted).", file=sys.stderr)
            return 2
        print(f"Wrote {a.out}")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
