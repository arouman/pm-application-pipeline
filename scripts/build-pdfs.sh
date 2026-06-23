#!/usr/bin/env bash
# build-pdfs.sh — convert .docx → tagged PDF via LibreOffice (headless).
#
# We use LibreOffice, NOT Microsoft Word. Word's macOS automation proved
# unreliable (App-Sandbox "Grant File Access" powerbox per folder, transient
# "Can't export file" failures, AppleEvent -1708/-600/-1712) AND it silently
# substituted the font (it embedded Calibri instead of the variable Source Sans 3).
# LibreOffice runs headless, is fully local + robust, writes directly to the target
# folder (not sandboxed), and renders the real Source Sans 3 design faithfully.
#
# Embed caveat: on macOS LibreOffice embeds fonts as Type 3 (correct glyph shapes +
# clean extractable text, but unhinted). This is fine for ATS + recruiters. For a
# gold-standard TrueType embed, the documented upgrade is a Dockerized LibreOffice
# (Gotenberg) running on Linux — see applications/CLAUDE.md. The Word converter
# (scripts/word-to-pdf.applescript) is kept only as an optional manual pixel path.
#
# Usage:
#   ./build-pdfs.sh /path/to/applied/2026-06-10/Company   # every .docx in the folder
#   ./build-pdfs.sh /path/to/one_file.docx                # a single file
set -euo pipefail

SOFFICE="/Applications/LibreOffice.app/Contents/MacOS/soffice"
[ -x "$SOFFICE" ] || { echo "LibreOffice not found at $SOFFICE (brew install --cask libreoffice)" >&2; exit 1; }

# Tagged PDF export (accessibility + ATS-friendly).
FILTER='pdf:writer_pdf_Export:{"UseTaggedPDF":{"type":"boolean","value":"true"}}'
# Isolated, UNIQUE-per-invocation profile so a GUI instance AND concurrent batch
# runs (parallel application builds) never collide on the same profile lock.
PROFILE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lo_prof.XXXXXX")"
PROFILE="-env:UserInstallation=file://$PROFILE_DIR"
trap 'rm -rf "$PROFILE_DIR"' EXIT

TARGET="${1:?Usage: build-pdfs.sh <folder-or-.docx>}"

convert_one() {
  local docx="$1" dir pdf
  dir="$(cd "$(dirname "$docx")" && pwd)"
  pdf="${docx%.docx}.pdf"
  echo "→ ${docx##*/}"
  "$SOFFICE" --headless "$PROFILE" --convert-to "$FILTER" --outdir "$dir" "$docx" >/dev/null 2>&1 || true
  if [[ -f "$pdf" ]]; then
    echo "  ✓ ${pdf##*/}"
  else
    echo "  ✗ export FAILED: ${pdf##*/}" >&2
    return 1
  fi
}

if [[ -d "$TARGET" ]]; then
  count=0
  while IFS= read -r -d '' f; do
    convert_one "$f"
    count=$((count + 1))
  done < <(find "$TARGET" -type f -name '*.docx' ! -name '~$*' -print0)
  echo "Converted ${count} file(s) in ${TARGET}"
elif [[ -f "$TARGET" && "$TARGET" == *.docx ]]; then
  convert_one "$TARGET"
else
  echo "Error: not a folder or .docx file: $TARGET" >&2
  exit 1
fi
