#!/usr/bin/env bash
# Benchmark arm runner — one Harbor run of MinimalUnerrAgent (bench_agent.py).
#   ARM=unerr    ./run_arm.sh   -> full unerr install + unerr MCP + minimal prompt
#   ARM=baseline ./run_arm.sh   -> bare claude-code, same prompt (BASELINE_ARM=1)
# Task/model are fixed to the opus benchmark config; override via TASK / MODEL env.
set -euo pipefail

ARM="${ARM:-unerr}"
TASK="${TASK:-terminal-bench/build-pmars}"
# TASKS = space-separated task ids -> one -i per id (harbor's -i is repeatable).
# Set it to run a subset; leave empty to fall back to the single TASK above.
TASKS="${TASKS:-}"
DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
MODEL="${MODEL:-claude-opus-4-8}"
# FULL=1 drops the -i single-task filter and runs the whole dataset.
# N = concurrent trials, K = attempts per task, UPLOAD=private|public|0.
FULL="${FULL:-0}"
N="${N:-1}"
K="${K:-1}"
UPLOAD="${UPLOAD:-0}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="${BENCH_DIR:-$HOME/IdeaProjects/unerr-terminal-bench}"

# Live secrets — sourced, never printed.
set -a; source "$BENCH_DIR/.env.local"; set +a
export PYTHONPATH="$BENCH_DIR/src:$SELF_DIR"

if [ "$ARM" = "baseline" ]; then
  export BASELINE_ARM=1; OUT="out/baseline"
else
  unset BASELINE_ARM || true; OUT="out/unerr"
  # Fresh DEV build + pack -> vendor, then point the agent at THAT tgz (never
  # the stale vendored copy in unerr-terminal-bench). SKIP_REFRESH=1 reuses the
  # last vendor/ tgz. See README.md.
  if [ "${SKIP_REFRESH:-0}" != "1" ]; then "$SELF_DIR/refresh-unerr-tgz.sh"; fi
  export UNERR_CONTEXT_DIR="$SELF_DIR/vendor"
fi

ARGS=(-d "$DATASET" -a bench_agent:MinimalUnerrAgent
      -m "$MODEL" --ak "unerr_main_model=$MODEL"
      -e daytona -n "$N" -k "$K" -o "$OUT")
if [ "$FULL" != "1" ]; then
  if [ -n "$TASKS" ]; then
    for t in $TASKS; do ARGS+=(-i "$t"); done
  else
    ARGS+=(-i "$TASK")
  fi
fi
case "$UPLOAD" in
  private) ARGS+=(--upload --private) ;;
  public)  ARGS+=(--upload --public) ;;
esac

echo "[run_arm] arm=$ARM model=$MODEL n=$N k=$K upload=$UPLOAD out=$OUT ctx=${UNERR_CONTEXT_DIR:-<none>}"
echo "[run_arm] scope=$([ "$FULL" = "1" ] && echo "FULL $DATASET" || echo "${TASKS:-$TASK}")"
cd "$SELF_DIR"
exec harbor run "${ARGS[@]}"
