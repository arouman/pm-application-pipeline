#!/usr/bin/env bash
# setup.sh — one-shot installer for the job-search automation starter kit.
#
# Usage (from the repo root or anywhere):
#   bash /path/to/starter-kit/setup.sh
#
# Idempotent: safe to re-run. Never overwrites your data without asking.
# Requires macOS. Tested on macOS 13+.

# ---------------------------------------------------------------------------
# Shell safety: pipefail + undefined-var protection, but NOT -e.
# Hard failures call fail() explicitly; soft warnings continue.
# ---------------------------------------------------------------------------
set -uo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root portably (works regardless of cwd or symlinks)
# ---------------------------------------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Color / output helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

section() { echo; echo -e "${BOLD}${CYAN}══════════════════════════════════════════════${RESET}"; echo -e "${BOLD}${CYAN}  $*${RESET}"; echo -e "${BOLD}${CYAN}══════════════════════════════════════════════${RESET}"; }
ok()      { echo -e "  ${GREEN}✔${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
info()    { echo -e "  ${CYAN}→${RESET}  $*"; }
fail()    { echo -e "\n  ${RED}✖  FATAL: $*${RESET}\n"; exit 1; }

# ---------------------------------------------------------------------------
# Section 1 — PREFLIGHT: dependency checks
# ---------------------------------------------------------------------------
section "1 / 5  PREFLIGHT — checking dependencies"

HARD_FAIL=0

# --- claude (Claude Code CLI) — REQUIRED ---
if command -v claude &>/dev/null; then
  ok "claude found: $(command -v claude)"
else
  warn "claude not found on PATH."
  info "Install Claude Code: https://claude.ai/code  (then add it to PATH)"
  HARD_FAIL=1
fi

# --- python3 >= 3.10 — REQUIRED ---
if command -v python3 &>/dev/null; then
  if python3 -c 'import sys; raise SystemExit(0 if sys.version_info>=(3,10) else 1)' 2>/dev/null; then
    PY_VER="$(python3 -c 'import sys; print(".".join(map(str,sys.version_info[:3])))')"
    ok "python3 found: ${PY_VER}"
  else
    PY_VER="$(python3 -c 'import sys; print(".".join(map(str,sys.version_info[:3])))' 2>/dev/null || echo "unknown")"
    fail "Python 3.10+ required (found ${PY_VER}). Install via Homebrew: brew install python@3.12 (and ensure it precedes /usr/bin on PATH)."
  fi
else
  fail "Python 3.10+ required. Install via Homebrew: brew install python@3.12 (and ensure it precedes /usr/bin on PATH)."
fi

# --- node >= 18 — REQUIRED ---
if command -v node &>/dev/null; then
  NODE_VER="$(node --version 2>/dev/null | tr -d 'v' | cut -d. -f1)"
  if [ -n "${NODE_VER}" ] && [ "${NODE_VER}" -ge 18 ] 2>/dev/null; then
    ok "node found: $(node --version)"
  else
    warn "node found but version is $(node --version 2>/dev/null) — need v18 or later."
    info "Upgrade: brew install node"
    HARD_FAIL=1
  fi
else
  warn "node not found."
  info "Install: brew install node"
  HARD_FAIL=1
fi

# --- soffice (LibreOffice) — REQUIRED for PDF export ---
if command -v soffice &>/dev/null || [ -x "/Applications/LibreOffice.app/Contents/MacOS/soffice" ]; then
  ok "LibreOffice (soffice) found."
else
  warn "soffice not found — LibreOffice is required for .docx → PDF export."
  info "Install: brew install --cask libreoffice"
  HARD_FAIL=1
fi

# --- Source Sans 3 font — WARN only ---
FONT_FOUND=0
for font_dir in "${HOME}/Library/Fonts" "/Library/Fonts"; do
  if [ -d "${font_dir}" ]; then
    if find "${font_dir}" \( -iname "*SourceSans3*" -o -iname "*Source_Sans_3*" -o -iname "*Source Sans 3*" \) 2>/dev/null | grep -q .; then
      FONT_FOUND=1
      ok "Source Sans 3 font detected in ${font_dir}."
      break
    fi
  fi
done
if [ "${FONT_FOUND}" -eq 0 ]; then
  warn "Source Sans 3 not detected in ~/Library/Fonts or /Library/Fonts."
  info "Install the variable font: double-click the .ttf files in ${ROOT}/typeface/Source_Sans_3/"
  info "IMPORTANT: do NOT install the static weights system-wide — they conflict with the variable font"
  info "and cause Word to render everything italic."
fi

# --- Google Chrome — optional warn ---
if [ -d "/Applications/Google Chrome.app" ]; then
  ok "Google Chrome found."
else
  warn "Google Chrome not found (optional — only needed for JS-heavy career-page scraping)."
fi

# Bail on hard failures (dependency blockers — user must fix before continuing)
if [ "${HARD_FAIL}" -ne 0 ]; then
  echo
  fail "One or more required dependencies are missing (see warnings above). Fix them and re-run setup.sh."
fi

echo
ok "All required dependencies present. Continuing..."

# ---------------------------------------------------------------------------
# Section 2 — INSTALL THE RECRUITER SKILL
# ---------------------------------------------------------------------------
section "2 / 5  RECRUITER SKILL — installing to ~/.claude/skills/recruiter/"

SKILL_SRC="${ROOT}/claude-assets/skills/recruiter"
SKILL_DST="${HOME}/.claude/skills/recruiter"

if [ ! -d "${SKILL_SRC}" ]; then
  warn "Recruiter skill source not found at ${SKILL_SRC} — skipping skill install."
else
  mkdir -p "${HOME}/.claude/skills"

  if [ -d "${SKILL_DST}" ]; then
    echo
    echo -e "  ${YELLOW}~/.claude/skills/recruiter already exists.${RESET}"
    read -rp "  Overwrite it? [y/N] " OVERWRITE_SKILL
    OVERWRITE_SKILL="${OVERWRITE_SKILL:-N}"

    if [[ "${OVERWRITE_SKILL}" =~ ^[Yy]$ ]]; then
      STAMP="$(date +%Y%m%d-%H%M%S)"
      BACKUP_DST="${HOME}/.claude/skills/recruiter.bak-${STAMP}"
      cp -r "${SKILL_DST}" "${BACKUP_DST}"
      ok "Backed up existing skill to ${BACKUP_DST}"
      rm -rf "${SKILL_DST}"
      cp -r "${SKILL_SRC}" "${SKILL_DST}"
      ok "Recruiter skill installed to ${SKILL_DST}"
    else
      info "Skipped recruiter skill install (existing copy kept)."
    fi
  else
    cp -r "${SKILL_SRC}" "${SKILL_DST}"
    ok "Recruiter skill installed to ${SKILL_DST}"
  fi
fi

# ---------------------------------------------------------------------------
# Section 3 — INITIALIZE LOCAL STATE (never clobber existing files)
# ---------------------------------------------------------------------------
section "3 / 5  LOCAL STATE — initializing empty state files (skips if already present)"

# --- private/applicant-profile.json ---
PROFILE_SRC="${ROOT}/templates/applicant-profile.example.json"
PROFILE_DST="${ROOT}/private/applicant-profile.json"
mkdir -p "${ROOT}/private"

if [ -f "${PROFILE_DST}" ]; then
  ok "private/applicant-profile.json already exists — not modified."
else
  if [ -f "${PROFILE_SRC}" ]; then
    cp "${PROFILE_SRC}" "${PROFILE_DST}"
    ok "Created private/applicant-profile.json from example template."
    warn "ACTION REQUIRED: edit ${PROFILE_DST} with your real name, email, phone, and location."
  else
    warn "Template not found at ${PROFILE_SRC} — could not seed applicant-profile.json."
    info "Create it manually at ${PROFILE_DST} (see templates/applicant-profile.example.json for schema)."
  fi
fi

# --- applied/_queue/queue.json ---
QUEUE_JSON="${ROOT}/applied/_queue/queue.json"
mkdir -p "${ROOT}/applied/_queue"
if [ -f "${QUEUE_JSON}" ]; then
  ok "applied/_queue/queue.json already exists — not modified."
else
  TODAY="$(date +%Y-%m-%d)"
  python3 -c "
import json, sys
d = {
    'version': 1,
    'created': '${TODAY}',
    'date': '${TODAY}',
    'note': 'Application queue. status: pending|building|built|error|skipped.',
    'items': []
}
print(json.dumps(d, indent=2))
" > "${QUEUE_JSON}"
  ok "Created empty applied/_queue/queue.json"
fi

# --- applied/applied-ledger.json ---
LEDGER_JSON="${ROOT}/applied/applied-ledger.json"
mkdir -p "${ROOT}/applied"
if [ -f "${LEDGER_JSON}" ]; then
  ok "applied/applied-ledger.json already exists — not modified."
else
  python3 -c "
import json
print(json.dumps({'version': 1, 'entries': []}, indent=2))
" > "${LEDGER_JSON}"
  ok "Created empty applied/applied-ledger.json"
fi

# --- cloud/found.json ---
FOUND_JSON="${ROOT}/cloud/found.json"
mkdir -p "${ROOT}/cloud"
if [ -f "${FOUND_JSON}" ]; then
  ok "cloud/found.json already exists — not modified."
else
  python3 -c "
import json
print(json.dumps({'version': 1, 'postings': []}, indent=2))
" > "${FOUND_JSON}"
  ok "Created empty cloud/found.json"
fi

# --- cloud/seen-jobs.json ---
SEEN_JSON="${ROOT}/cloud/seen-jobs.json"
if [ -f "${SEEN_JSON}" ]; then
  ok "cloud/seen-jobs.json already exists — not modified."
else
  python3 -c "print('{}')" > "${SEEN_JSON}"
  ok "Created empty cloud/seen-jobs.json"
fi

# --- keyword-bank/keyword-bank.json ---
KB_JSON="${ROOT}/keyword-bank/keyword-bank.json"
mkdir -p "${ROOT}/keyword-bank"
if [ -f "${KB_JSON}" ]; then
  ok "keyword-bank/keyword-bank.json already exists — not modified."
else
  TODAY="$(date +%Y-%m-%d)"
  python3 -c "
import json
d = {
    'version': 1,
    'updated': '${TODAY}',
    'keywords': []
}
print(json.dumps(d, indent=2))
" > "${KB_JSON}"
  ok "Created empty keyword-bank/keyword-bank.json"
fi

# ---------------------------------------------------------------------------
# Section 4 — NAME-SLUG SETUP
# ---------------------------------------------------------------------------
section "4 / 5  NAME SLUG — personalizing file names"

# Read fullName from private/applicant-profile.json
FULL_NAME="$(python3 -c "
import json, sys
try:
    with open('${ROOT}/private/applicant-profile.json') as f:
        d = json.load(f)
    name = d.get('identity', {}).get('fullName', '').strip()
    print(name if name else 'Applicant')
except Exception:
    print('Applicant')
" 2>/dev/null)"

# Compute slug: non-alphanumerics (except spaces) -> removed; spaces -> _
SLUG="$(python3 -c "
import re
name = '${FULL_NAME}'
# Keep letters, digits, spaces; replace everything else with space; then collapse spaces -> _
slug = re.sub(r'[^A-Za-z0-9 ]', ' ', name)
slug = '_'.join(slug.split())
print(slug)
" 2>/dev/null)"

if [ -z "${SLUG}" ] || [ "${SLUG}" = "Applicant" ]; then
  SLUG="Applicant"
  warn "Could not read fullName from applicant-profile.json — using slug 'Applicant'."
  info "Edit ${ROOT}/private/applicant-profile.json, then re-run setup.sh to fix the slug."
else
  ok "Name: ${FULL_NAME}  →  Slug: ${SLUG}"
fi

# --- Cover letter template: copy to slug-prefixed name ---
CL_TEMPLATE_GENERIC="${ROOT}/cover-letter-template/Cover_Letter_Template_TOKENS.docx"
CL_TEMPLATE_SLUG="${ROOT}/cover-letter-template/${SLUG}_Cover_Letter_Template_TOKENS.docx"

if [ -f "${CL_TEMPLATE_GENERIC}" ]; then
  if [ -f "${CL_TEMPLATE_SLUG}" ]; then
    ok "Slug-prefixed cover letter template already exists — not modified."
    info "  ${CL_TEMPLATE_SLUG}"
  else
    cp "${CL_TEMPLATE_GENERIC}" "${CL_TEMPLATE_SLUG}"
    ok "Created ${SLUG}_Cover_Letter_Template_TOKENS.docx in cover-letter-template/"
  fi
else
  warn "Generic cover letter template not found at ${CL_TEMPLATE_GENERIC}"
  info "Add your cover letter template there and re-run setup.sh to generate the slug-prefixed copy."
fi

# --- Remind about master resumes ---
echo
info "Master resumes must be named:"
info "  master-resumes/${SLUG}_Resume_PM_Master.docx      (PM / strategy / ops roles)"
info "  master-resumes/${SLUG}_Resume_Design_Master.docx  (Design / UX / product-design roles)"
echo

PM_MASTER="${ROOT}/master-resumes/${SLUG}_Resume_PM_Master.docx"
DESIGN_MASTER="${ROOT}/master-resumes/${SLUG}_Resume_Design_Master.docx"
if [ -f "${PM_MASTER}" ]; then
  ok "PM master resume found."
else
  warn "PM master resume NOT found: master-resumes/${SLUG}_Resume_PM_Master.docx"
fi
if [ -f "${DESIGN_MASTER}" ]; then
  ok "Design master resume found."
else
  warn "Design master resume NOT found: master-resumes/${SLUG}_Resume_Design_Master.docx"
fi

# ---------------------------------------------------------------------------
# Section 5 — RENDER LAUNCHD PLISTS (optional)
# ---------------------------------------------------------------------------
section "5 / 5  LAUNCHD PLISTS — background service agents (optional)"

# Collect all plist templates from scripts/ and bridge/
# while-read instead of mapfile: mapfile requires bash 4+; macOS ships bash 3.2.
PLIST_TEMPLATES=()
while IFS= read -r _plist_t; do
  PLIST_TEMPLATES+=("${_plist_t}")
done < <(find "${ROOT}/scripts" "${ROOT}/bridge" -name "*.plist.template" 2>/dev/null | sort)

if [ "${#PLIST_TEMPLATES[@]}" -eq 0 ]; then
  info "No .plist.template files found in scripts/ or bridge/ — skipping."
else
  info "Found ${#PLIST_TEMPLATES[@]} plist template(s):"
  for t in "${PLIST_TEMPLATES[@]}"; do
    info "  $(basename "${t}")"
  done
  echo
  read -rp "  Render and write plists to ~/Library/LaunchAgents/? [y/N] " RENDER_PLISTS
  RENDER_PLISTS="${RENDER_PLISTS:-N}"

  if [[ "${RENDER_PLISTS}" =~ ^[Yy]$ ]]; then
    mkdir -p "${HOME}/Library/LaunchAgents"
    NODE_PATH="$(command -v node 2>/dev/null || echo "/opt/homebrew/bin/node")"
    RENDERED_PLISTS=()

    for TEMPLATE in "${PLIST_TEMPLATES[@]}"; do
      # Derive output filename: strip .template suffix; use the Label value as filename
      BASENAME="$(basename "${TEMPLATE}" .template)"
      OUT="${HOME}/Library/LaunchAgents/${BASENAME}"

      sed \
        -e "s|__REPO__|${ROOT}|g" \
        -e "s|__HOME__|${HOME}|g" \
        -e "s|__NODE__|${NODE_PATH}|g" \
        "${TEMPLATE}" > "${OUT}"

      ok "Rendered: ~/Library/LaunchAgents/${BASENAME}"
      RENDERED_PLISTS+=("${OUT}")
    done

    echo
    info "Plists are written but NOT yet loaded. To activate background agents,"
    info "run these commands (or confirm below to run them now):"
    echo
    for p in "${RENDERED_PLISTS[@]}"; do
      echo "    launchctl load \"${p}\""
    done
    echo

    read -rp "  Load all agents now with launchctl? [y/N] " LOAD_PLISTS
    LOAD_PLISTS="${LOAD_PLISTS:-N}"

    if [[ "${LOAD_PLISTS}" =~ ^[Yy]$ ]]; then
      for p in "${RENDERED_PLISTS[@]}"; do
        LABEL="$(grep -o '<string>local\.jobpipeline\.[^<]*</string>' "${p}" 2>/dev/null | head -1 | sed 's/<[^>]*>//g' || true)"
        # Unload first if already loaded (idempotent)
        launchctl unload "${p}" 2>/dev/null || true
        if launchctl load "${p}" 2>/dev/null; then
          ok "Loaded: ${LABEL:-$(basename "${p}")}"
        else
          warn "Failed to load ${p} — check the file and try manually."
        fi
      done
    else
      info "Skipped launchctl load — run the commands above when ready."
    fi

  else
    info "Skipped plist rendering."
    info "You can render them later by re-running setup.sh, or manually:"
    for t in "${PLIST_TEMPLATES[@]}"; do
      BASENAME="$(basename "${t}" .template)"
      echo
      echo "    sed -e \"s|__REPO__|${ROOT}|g\" \\"
      echo "        -e \"s|__HOME__|${HOME}|g\" \\"
      echo "        -e \"s|__NODE__|$(command -v node 2>/dev/null || echo "/opt/homebrew/bin/node")|g\" \\"
      echo "        \"${t}\" \\"
      echo "        > \"${HOME}/Library/LaunchAgents/${BASENAME}\""
    done
  fi
fi

# ---------------------------------------------------------------------------
# NEXT STEPS
# ---------------------------------------------------------------------------
echo
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Setup complete! What to do next:${RESET}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════${RESET}"
echo
echo -e "  ${BOLD}1. Build your dossier${RESET}"
echo "     Open Claude Code in this repo and say:"
echo "       'help me build my dossier'"
echo "     This runs a guided intake to capture your background, projects,"
echo "     and evidence into the recruiter skill."
echo
echo -e "  ${BOLD}2. Add your two master resumes${RESET}"
echo "     Name them exactly:"
echo "       master-resumes/${SLUG}_Resume_PM_Master.docx"
echo "       master-resumes/${SLUG}_Resume_Design_Master.docx"
echo
echo -e "  ${BOLD}3. Edit your profile${RESET}"
echo "     Fill in your contact + EEO info (stays local, gitignored):"
echo "       ${ROOT}/private/applicant-profile.json"
echo
echo -e "  ${BOLD}4. Start the local services${RESET}"
echo "     Bridge UI (application engine):"
echo "       node ${ROOT}/bridge/server.js"
echo "       then open http://localhost:8787"
echo
echo "     Keyword review tool:"
echo "       python3 ${ROOT}/scripts/serve-review.py"
echo "       then open http://localhost:8765"
echo
echo -e "  ${BOLD}5. Remember:${RESET}"
echo "     Claude finalizes applications. YOU always click submit."
echo
