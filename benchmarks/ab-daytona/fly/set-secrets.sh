#!/usr/bin/env bash
# Push the live keys from unerr-terminal-bench/.env.local onto a Fly app as
# app-level secrets (injected into every machine the app creates). Values are
# never echoed — only key NAMES are printed.
#
#   ./set-secrets.sh <app-name>
set -euo pipefail

APP="${1:?usage: set-secrets.sh <app>}"
BENCH_DIR="${BENCH_DIR:-$HOME/IdeaProjects/unerr-terminal-bench}"
ENVF="${ENVF:-$BENCH_DIR/.env.local}"
[ -f "$ENVF" ] || { echo "FATAL: env file not found: $ENVF" >&2; exit 1; }

# Load the file into THIS shell only (never printed, never committed).
set -a
# shellcheck disable=SC1090
. "$ENVF"
set +a

# Only the keys the orchestrator + upload actually need. MODAL_* is not used for
# the daytona sandbox, so it's intentionally omitted.
KEYS=(ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN DAYTONA_API_KEY DAYTONA_TARGET HARBOR_API_KEY)

args=()
present=()
for k in "${KEYS[@]}"; do
  v="${!k:-}"
  if [ -n "$v" ]; then args+=("$k=$v"); present+=("$k"); else echo "  (skip $k — absent in $ENVF)"; fi
done
[ ${#args[@]} -gt 0 ] || { echo "FATAL: no secrets found in $ENVF" >&2; exit 1; }

echo "==> setting ${#args[@]} secrets on $APP (values hidden): ${present[*]}"
# --stage stores them without triggering a deploy (the app has no machines yet);
# the one-shot machine deploy-arm.sh launches next inherits them.
flyctl secrets set "${args[@]}" -a "$APP" --stage
echo "==> staged on $APP: ${present[*]}"
