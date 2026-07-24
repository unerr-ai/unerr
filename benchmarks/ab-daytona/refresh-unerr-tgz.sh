#!/usr/bin/env bash
# Build the CURRENT unerr-cli checkout as a DEV binary and pack it into a fresh
# npm tarball under ./vendor, which the A/B agent (ab_agent.py) picks up via
# UNERR_CONTEXT_DIR. Run before EVERY benchmark run so a run never ships a stale
# binary. This is the ONLY tgz the benchmark uses — never the stale vendored
# copy in ../../../unerr-terminal-bench/src (that repo is inspiration, not the
# source of truth).
#
# The build is a DEV build (UNERR_PROD_BUILD=0) on purpose: it keeps the
# file-based dev-mode code (the dev.json tier override) compiled in. A prod
# build (=1) strips it and dev.json would not mint Pro.
#
# Adapted from (inspiration only)
# ../../../unerr-terminal-bench/scripts/refresh-unerr-tgz.sh — that one is
# pack-only because its owner controls the build; here we own it, so we build.
#
# Usage:
#   ./refresh-unerr-tgz.sh               # rm -rf dist; dev build; pack -> vendor/
#   SKIP_BUILD=1 ./refresh-unerr-tgz.sh  # pack an already-built dist (staleness-gated)
#   UNERR_CLI_DIR=/path ./refresh-unerr-tgz.sh
set -euo pipefail

AB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "${UNERR_CLI_DIR:-$AB_DIR/../..}" && pwd)"
VENDOR_DIR="${VENDOR_DIR:-$AB_DIR/vendor}"
DIST_CLI="$CLI_DIR/dist/cli.js"

if [ "${SKIP_BUILD:-0}" = "1" ]; then
  # Pack-only: refuse if dist is missing or any src/*.ts is newer than it.
  [ -f "$DIST_CLI" ] || { echo "FATAL: $DIST_CLI missing — drop SKIP_BUILD, or 'pnpm run build' in $CLI_DIR" >&2; exit 1; }
  STALE_SRC="$(find "$CLI_DIR/src" -name '*.ts' -newer "$DIST_CLI" -print -quit)"
  [ -z "$STALE_SRC" ] || { echo "FATAL: $DIST_CLI is older than $STALE_SRC — rebuild" >&2; exit 1; }
else
  echo "[refresh] DEV build:  rm -rf dist && UNERR_PROD_BUILD=0 pnpm run build   (in $CLI_DIR)"
  ( cd "$CLI_DIR" && rm -rf dist && UNERR_PROD_BUILD=0 pnpm run build )
  [ -f "$DIST_CLI" ] || { echo "FATAL: build did not produce $DIST_CLI" >&2; exit 1; }
fi

mkdir -p "$VENDOR_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# --ignore-scripts: tar the package.json `files` globs (dist/**) only; no
# prepack rebuild, no lifecycle surprises.
PACKED_NAME="$(cd "$CLI_DIR" && npm pack --ignore-scripts --pack-destination "$TMP_DIR" 2>/dev/null)"
PACKED_PATH="$TMP_DIR/$PACKED_NAME"
[ -f "$PACKED_PATH" ] || { echo "FATAL: npm pack produced nothing in $TMP_DIR" >&2; exit 1; }

VERSION="$(tar -xzf "$PACKED_PATH" -O package/package.json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
GITSHA="$(cd "$CLI_DIR" && git rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIST_BUILT="$(date -r "$DIST_CLI" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')"

# One tgz only — drop older ones so the glob in _find_unerr_tgz is unambiguous.
rm -f "$VENDOR_DIR"/unerr-ai-unerr-*.tgz
cp "$PACKED_PATH" "$VENDOR_DIR/$PACKED_NAME"
BYTES="$(wc -c < "$VENDOR_DIR/$PACKED_NAME" | tr -d ' ')"

echo "refreshed: $VENDOR_DIR/$PACKED_NAME"
echo "  ${BYTES} bytes | version ${VERSION} | git ${GITSHA} | dist built ${DIST_BUILT}"
echo "  agent picks it up via:  UNERR_CONTEXT_DIR=$VENDOR_DIR"
