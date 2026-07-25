#!/usr/bin/env bash
# One A/B arm, run to completion on this Fly machine, then (optionally) uploaded.
#
# Reads from env (set at `flyctl machine run` time):
#   ARM      unerr | baseline                       (required)
#   MODEL    claude-opus-4-8 | claude-sonnet-5       (required)
#   TASKS    space-separated task ids               (required; or TASK for one)
#   DATASET  dataset id            (default terminal-bench/terminal-bench-2-1)
#   N        concurrency           (default 4)
#   K        trials per task       (default 1)
#   UPLOAD   public | private | none               (default public)
#
# Flow: harbor run -> cost/token summary to stdout (Fly logs) -> secret-scan the
# job dir -> harbor upload (only if UPLOAD != none AND the scan is clean).
set -euo pipefail

ARM="${ARM:?set ARM=unerr|baseline}"
MODEL="${MODEL:?set MODEL=claude-opus-4-8|claude-sonnet-5}"
DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
N="${N:-4}"
K="${K:-1}"
UPLOAD="${UPLOAD:-public}"
FULL="${FULL:-0}"                 # 1 => whole dataset, no -i filter (all tasks)
RUN_NAME="${RUN_NAME:-}"          # free-text label, echoed for identification

cd /work/ab-daytona
export PYTHONPATH="/work/bench-src:/work/ab-daytona"
export UNERR_CONTEXT_DIR="/work/ab-daytona/vendor"

# Arm selector: MinimalUnerrAgent switches to the no-unerr baseline on AB_BASELINE=1.
if [ "$ARM" = "baseline" ]; then
  export AB_BASELINE=1
  OUT="/work/out/ab-baseline"
else
  unset AB_BASELINE || true
  OUT="/work/out/ab-unerr"
fi

# FULL=1 => no -i, harbor runs every task in the dataset. Otherwise one -i per
# task id in TASKS (dataset filtered to just those tasks).
I_ARGS=()
if [ "$FULL" = "1" ]; then
  SCOPE="FULL (all tasks in $DATASET)"
else
  TASKS="${TASKS:-terminal-bench/build-pmars}"
  for t in $TASKS; do I_ARGS+=(-i "$t"); done
  SCOPE="tasks='$TASKS'"
fi

echo "[fly-arm] ${RUN_NAME:+run='$RUN_NAME' }arm=$ARM model=$MODEL dataset=$DATASET $SCOPE -k $K -n $N upload=$UPLOAD"

# Ensure the dataset is present (no-op if baked at build time; covers overrides).
harbor dataset download "$DATASET" || true

harbor run \
  -d "$DATASET" \
  -a ab_agent:MinimalUnerrAgent \
  -m "$MODEL" --ak "unerr_main_model=$MODEL" \
  -e daytona \
  "${I_ARGS[@]}" \
  -k "$K" -n "$N" \
  -o "$OUT"

JOB="$(ls -td "$OUT"/*/ 2>/dev/null | head -1 || true)"
if [ -z "$JOB" ]; then
  echo "[fly-arm] no job dir produced under $OUT — nothing to summarize/upload"
  exit 2
fi
JOB="${JOB%/}"
echo "[fly-arm] job dir: $JOB"

# Cost/token summary straight to Fly logs — this is the smoke-test signal even
# when nothing is uploaded.
python /work/summarize.py "$JOB" "$MODEL" || echo "[fly-arm] (summary failed — non-fatal)"

# ── upload gate ───────────────────────────────────────────────────────────────
case "$UPLOAD" in
  none|no|0|off) echo "[fly-arm] UPLOAD=$UPLOAD — skipping upload."; echo "[fly-arm] done."; exit 0 ;;
  private) VIS="--private" ;;
  public|*) VIS="--public" ;;
esac

# The run env carries LIVE keys. A public/shared upload publishes the whole job
# dir, so scan it for any leaked secret VALUE first and abort if one is present.
echo "[fly-arm] secret scan before $VIS upload…"
leak=0
for v in "${ANTHROPIC_API_KEY:-}" "${CLAUDE_CODE_OAUTH_TOKEN:-}" \
         "${DAYTONA_API_KEY:-}" "${DAYTONA_TARGET:-}" "${HARBOR_API_KEY:-}"; do
  [ -n "$v" ] && grep -rIqF -- "$v" "$JOB" && { echo "[fly-arm] LEAK: a secret VALUE appears in $JOB"; leak=1; }
done
# Belt-and-braces: catch an Anthropic key even if it differs from this env's copy.
grep -rIqE -- 'sk-ant-[A-Za-z0-9_-]{20,}' "$JOB" && { echo "[fly-arm] LEAK: sk-ant- key pattern in $JOB"; leak=1; }

if [ "$leak" = "1" ]; then
  echo "[fly-arm] ABORT upload — secrets present in the job dir. Machine will exit; nothing published."
  exit 3
fi

echo "[fly-arm] scan clean -> harbor upload $VIS"
UP_LOG="/work/out/.upload.log"
harbor upload "$JOB" $VIS --yes 2>&1 | tee "$UP_LOG"
URL="$(grep -aoE 'https?://[^ ]+' "$UP_LOG" | tail -1 || true)"
[ -n "$URL" ] && echo "[fly-arm] PUBLIC URL: $URL"
echo "[fly-arm] done."
