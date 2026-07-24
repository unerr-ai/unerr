#!/usr/bin/env bash
# A/B arm runner — one Harbor run of MinimalUnerrAgent (ab_agent.py).
#   ARM=unerr    ./run_arm.sh   -> full unerr install + unerr MCP + minimal prompt
#   ARM=baseline ./run_arm.sh   -> bare claude-code, same prompt (AB_BASELINE=1)
# Task/model are fixed to the opus A/B config; override via TASK / MODEL env.
set -euo pipefail

ARM="${ARM:-unerr}"
TASK="${TASK:-terminal-bench/build-pmars}"
DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-claude-opus-4-8}"

AB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="${BENCH_DIR:-$HOME/IdeaProjects/unerr-terminal-bench}"

# Live secrets — sourced, never printed.
set -a; source "$BENCH_DIR/.env.local"; set +a
export PYTHONPATH="$BENCH_DIR/src:$AB_DIR"

if [ "$ARM" = "baseline" ]; then
  export AB_BASELINE=1; OUT="out/ab-baseline"
else
  unset AB_BASELINE || true; OUT="out/ab-unerr"
  # Fresh DEV build + pack -> vendor, then point the agent at THAT tgz (never
  # the stale vendored copy in unerr-terminal-bench). SKIP_REFRESH=1 reuses the
  # last vendor/ tgz. See README.md.
  if [ "${SKIP_REFRESH:-0}" != "1" ]; then "$AB_DIR/refresh-unerr-tgz.sh"; fi
  export UNERR_CONTEXT_DIR="$AB_DIR/vendor"
fi

echo "[run_arm] arm=$ARM task=$TASK model=$MODEL out=$OUT ctx=${UNERR_CONTEXT_DIR:-<none>}"
cd "$AB_DIR"
exec harbor run \
  -d "$DATASET" \
  -a ab_agent:MinimalUnerrAgent \
  -m "$MODEL" --ak "unerr_main_model=$MODEL" \
  -e daytona \
  -i "$TASK" \
  -n 1 \
  -o "$OUT"
