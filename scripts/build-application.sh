#!/usr/bin/env bash
# build-application.sh — assemble ONE complete tailored application from a scout's
# resume swaps + a writer's cover-letter fields. Deterministic glue over
# tailor-resume.py, fill-cover-letter.py, and build-pdfs.sh.
#
# Usage:
#   build-application.sh \
#     --company "Figma" --title "Product Designer, AI Models" \
#     --master PM \
#     --swaps  /path/swaps.json \
#     --fields /path/cover_fields.json \
#     [--date 2026-06-10] [--jd-url URL] [--coverage 92] [--role-type "Domain 2"]
#
# Output: applied/DATE/Company/ containing
#   <Name>_Resume_<Title>_<Company>.docx + .pdf
#   <Name>_Cover_Letter_<Title>_<Company>.docx + .pdf
#   application.md
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="$REPO/scripts"

# Derive applicant name slug from private/applicant-profile.json (identity.fullName).
# Spaces and punctuation become underscores. Falls back to "Applicant" if the file
# is absent (e.g. gitignored in a fresh clone) or the key is missing.
NAME_SLUG="$(python3 - "$REPO/private/applicant-profile.json" <<'PY' 2>/dev/null || echo Applicant
import json,re,sys
try:
    n=json.load(open(sys.argv[1]))["identity"]["fullName"]
    s=re.sub(r"[^A-Za-z0-9]+","_",n.strip()).strip("_")
    print(s or "Applicant")
except Exception:
    print("Applicant")
PY
)"

TOKENS="$REPO/cover-letter-template/${NAME_SLUG}_Cover_Letter_Template_TOKENS.docx"

DATE="$(date +%F)"; COMPANY=""; TITLE=""; MASTER=""; SWAPS=""; FIELDS=""
JD_URL=""; COVERAGE=""; ROLE_TYPE=""; FOLDER_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --company) COMPANY="$2"; shift 2;;
    --title) TITLE="$2"; shift 2;;
    --master) MASTER="$2"; shift 2;;
    --swaps) SWAPS="$2"; shift 2;;
    --fields) FIELDS="$2"; shift 2;;
    --date) DATE="$2"; shift 2;;
    --jd-url) JD_URL="$2"; shift 2;;
    --coverage) COVERAGE="$2"; shift 2;;
    --role-type) ROLE_TYPE="$2"; shift 2;;
    # Override the per-company folder name (for >1 role at one company same day,
    # e.g. "Linear_Product-Manager" vs "Linear_Senior-Product-Designer").
    --folder-name) FOLDER_NAME="$2"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done
: "${COMPANY:?--company required}"; : "${TITLE:?--title required}"
: "${MASTER:?--master required (PM|Design)}"; : "${SWAPS:?--swaps required}"; : "${FIELDS:?--fields required}"

case "$MASTER" in
  PM)     M="$REPO/master-resumes/${NAME_SLUG}_Resume_PM_Master.docx";;
  Design) M="$REPO/master-resumes/${NAME_SLUG}_Resume_Design_Master.docx";;
  *) echo "--master must be PM or Design" >&2; exit 1;;
esac

# filename token: spaces->hyphens, & -> and, drop other punctuation
slug() { echo "$1" | sed -e 's/&/and/g' -e 's/[^A-Za-z0-9 -]//g' -e 's/  */ /g' -e 's/^ //; s/ $//' -e 's/ /-/g'; }
CO="$(slug "$COMPANY")"; TI="$(slug "$TITLE")"
FOLDER="$REPO/applied/$DATE/${FOLDER_NAME:-$CO}"
mkdir -p "$FOLDER"
R="$FOLDER/${NAME_SLUG}_Resume_${TI}_${CO}.docx"
C="$FOLDER/${NAME_SLUG}_Cover_Letter_${TI}_${CO}.docx"

echo "▶ Building application: $TITLE @ $COMPANY  ($MASTER master)  → $FOLDER"
echo "1/3 resume"
python3 "$SCRIPTS/tailor-resume.py"     --master "$M"     --out "$R" --swaps  "$SWAPS"
echo "2/3 cover letter"
python3 "$SCRIPTS/fill-cover-letter.py" --template "$TOKENS" --out "$C" --fields "$FIELDS" --date "$DATE"
echo "3/3 PDFs (LibreOffice engine)"
bash "$SCRIPTS/build-pdfs.sh" "$FOLDER"

cat > "$FOLDER/application.md" <<EOF
# ${TITLE} — ${COMPANY}

- **JD URL:** ${JD_URL}
- **Role type:** ${ROLE_TYPE}
- **Master used:** ${MASTER}
- **Coverage:** ${COVERAGE}
- **Status:** READY — tailored resume + cover letter (.docx + tagged PDF); pending Rob review + submit.
EOF

# Tidy any Word lock files left behind.
rm -f "$FOLDER"/~\$*.docx 2>/dev/null || true

echo "✓ Done. Folder contents:"
ls -1 "$FOLDER"
