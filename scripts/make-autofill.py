#!/usr/bin/env python3
"""make-autofill.py — bundle the autofill engine + one application's field-map
into a paste-ready console snippet (and a bookmarklet).

For each application folder that has a `field-map.json`, this writes:
  <folder>/autofill-snippet.js   — paste this into the job tab's DevTools console
The snippet = extension/autofill.js (the engine) + an auto-invoke with the
field-map baked in. No server, no extension, no CORS.

Usage:
  make-autofill.py /path/to/applied/2026-06-11/Anthropic_PM-Consumer   # one folder
  make-autofill.py --all /path/to/applied/2026-06-11                   # every sub-folder
"""
import argparse, json, os, sys
from pathlib import Path

REPO = str(Path(__file__).resolve().parent.parent)
ENGINE = os.path.join(REPO, "extension", "autofill.js")


def build(folder: str) -> bool:
    fm_path = os.path.join(folder, "field-map.json")
    if not os.path.isfile(fm_path):
        return False
    with open(fm_path, encoding="utf-8") as fh:
        fm = json.load(fh)
    with open(ENGINE, encoding="utf-8") as fh:
        engine = fh.read()
    # JSON is valid JS; embed directly. </script> can't occur in JSON, safe for console.
    payload = json.dumps(fm, ensure_ascii=False)
    snippet = (
        "/* Rob autofill — paste into the job tab's DevTools console.\n"
        "   If Chrome blocks the paste, type `allow pasting` once, then paste again. */\n"
        + engine
        + f"\nrobAutofill({payload});\n"
    )
    out = os.path.join(folder, "autofill-snippet.js")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(snippet)
    print(f"  ✓ {os.path.relpath(out, REPO)}  ({fm.get('company','?')})")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--all", action="store_true", help="treat path as a date dir; process every sub-folder")
    a = ap.parse_args()
    if a.all:
        n = 0
        for name in sorted(os.listdir(a.path)):
            sub = os.path.join(a.path, name)
            if os.path.isdir(sub) and build(sub):
                n += 1
        print(f"Wrote {n} autofill snippet(s).")
    else:
        if not build(a.path):
            print(f"No field-map.json in {a.path}", file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
