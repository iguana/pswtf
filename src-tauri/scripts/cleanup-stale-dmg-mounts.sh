#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-pswtf}"

if ! command -v hdiutil >/dev/null 2>&1; then
  exit 0
fi

# bundle_dmg.sh expects /Volumes/<APP_NAME> to be writable.
# If a previous DMG is mounted read-only (e.g. user previewed installer),
# bundling can fail with "Read-only file system".
hdiutil info | awk -v app="$APP_NAME" '
  $0 ~ ("/Volumes/" app "($| [0-9]+$)") { print $1 }
' | sed -E 's#^(/dev/disk[0-9]+)s[0-9]+$#\1#' | awk '!seen[$0]++' | while IFS= read -r dev; do
  if [[ -n "$dev" ]]; then
    hdiutil detach "$dev" >/dev/null 2>&1 || hdiutil detach -force "$dev" >/dev/null 2>&1 || true
  fi
done
