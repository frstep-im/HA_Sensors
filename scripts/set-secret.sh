#!/bin/sh
set -eu
SECRET_ID="${1:?secret ID required}"
LABEL="${2:-secret value}"
PROJECT="soter-updater-59ead"
GCLOUD_CONFIG="${SOTER_GCLOUD_CONFIG:-/Users/fraser/Soter/.config-codex/gcloud}"
GCLOUD="${SOTER_GCLOUD_BIN:-/Users/fraser/Soter/google-cloud-sdk/bin/gcloud}"
[ -x "$GCLOUD" ] || GCLOUD="$(command -v gcloud || true)"
[ -n "$GCLOUD" ] || { echo "gcloud not found" >&2; exit 1; }
printf "Enter %s: " "$LABEL" >&2
stty -echo; IFS= read -r VALUE; stty echo; printf "\n" >&2
[ -n "$VALUE" ] || { echo "Empty secret; nothing changed." >&2; exit 1; }
if ! CLOUDSDK_CONFIG="$GCLOUD_CONFIG" "$GCLOUD" secrets describe "$SECRET_ID" --project "$PROJECT" >/dev/null 2>&1; then
  CLOUDSDK_CONFIG="$GCLOUD_CONFIG" "$GCLOUD" secrets create "$SECRET_ID" --project "$PROJECT" --replication-policy automatic >/dev/null
fi
printf %s "$VALUE" | CLOUDSDK_CONFIG="$GCLOUD_CONFIG" "$GCLOUD" secrets versions add "$SECRET_ID" --project "$PROJECT" --data-file=- >/dev/null
unset VALUE
echo "Stored a new $SECRET_ID version in $PROJECT."

