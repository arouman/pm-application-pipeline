#!/usr/bin/env bash
# open-links.sh — dumb fallback: open every applyUrl from field-map.json files
# under a date directory (or a single CLICK-LIST.md style file) in the default
# browser, 1 second apart. No Chrome CDP, no autofill — just opens the tabs.
#
# Usage:
#   bash scripts/open-links.sh /abs/path/to/applied/YYYY-MM-DD
#   bash scripts/open-links.sh /abs/path/to/applied/YYYY-MM-DD/CLICK-LIST.md
#
# The CLICK-LIST.md path extracts raw URLs (lines containing https://), which
# covers the click-list format written by the pipeline.

TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  echo "Usage: bash scripts/open-links.sh <applied/YYYY-MM-DD>"
  echo "       bash scripts/open-links.sh <applied/YYYY-MM-DD/CLICK-LIST.md>"
  exit 1
fi

if [ ! -e "$TARGET" ]; then
  echo "Error: not found: $TARGET"
  exit 1
fi

urls=()

if [ -f "$TARGET" ]; then
  # Treat as a text file (CLICK-LIST.md or similar) — extract bare https:// URLs.
  while IFS= read -r line; do
    # Extract the first URL on each line.
    url=$(echo "$line" | grep -oE 'https://[^ )>]+')
    if [ -n "$url" ]; then
      urls+=("$url")
    fi
  done < "$TARGET"

elif [ -d "$TARGET" ]; then
  # Extract applyUrl from every field-map.json under the directory.
  while IFS= read -r fm; do
    url=$(node -e "
      try {
        const fm = JSON.parse(require('fs').readFileSync('$fm', 'utf8'));
        process.stdout.write(fm.applyUrl || '');
      } catch(e) {}
    " 2>/dev/null)
    if [ -n "$url" ]; then
      urls+=("$url")
    fi
  done < <(find "$TARGET" -name "field-map.json" | sort)

else
  echo "Error: $TARGET is neither a file nor a directory."
  exit 1
fi

if [ "${#urls[@]}" -eq 0 ]; then
  echo "No URLs found under $TARGET"
  exit 0
fi

echo "Opening ${#urls[@]} URL(s) — 1 second apart..."
for url in "${urls[@]}"; do
  echo "  $url"
  open "$url"
  sleep 1
done
echo "Done."
