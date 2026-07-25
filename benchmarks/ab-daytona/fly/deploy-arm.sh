#!/usr/bin/env bash
# Deploy ONE A/B arm as its own Fly app and launch a one-shot machine that runs
# the harbor orchestrator (over Daytona) to completion — no load on your laptop.
# The laptop only: builds the fresh unerr tgz, assembles a small build context,
# kicks a remote-builder image build, sets secrets, and launches the machine.
#
#   ARM=unerr    MODEL=claude-sonnet-5 TASKS="terminal-bench/build-pmars terminal-bench/torch-tensor-parallelism" ./deploy-arm.sh
#   ARM=baseline MODEL=claude-opus-4-8 TASKS="terminal-bench/build-pmars" ./deploy-arm.sh
#
# Env (all optional except the arm/model/task shape):
#   ARM     unerr | baseline                 (default unerr)
#   MODEL   claude-opus-4-8 | claude-sonnet-5 (default claude-opus-4-8)
#   TASKS   space-separated task ids          (default terminal-bench/build-pmars)
#   N       concurrency  (default 4)          K   trials/task (default 1)
#   UPLOAD  public | private | none           (default public)
#   APP     override app name (default ab-<arm>-<opus|sonnet>)
#   REGION  fly region   (default iad)        FLY_ORG (default personal)
#   VM_SIZE (default shared-cpu-2x)           VM_MEMORY MB (default 4096)
#   SKIP_REFRESH=1  reuse the last vendor tgz (no rebuild)
#   SKIP_SECRETS=1  don't re-push secrets (already staged)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AB_DIR="$(cd "$HERE/.." && pwd)"
BENCH_DIR="${BENCH_DIR:-$HOME/IdeaProjects/unerr-terminal-bench}"

ARM="${ARM:-unerr}"
MODEL="${MODEL:-claude-opus-4-8}"
TASKS="${TASKS:-terminal-bench/build-pmars}"
DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
N="${N:-4}"
K="${K:-1}"
UPLOAD="${UPLOAD:-public}"
FULL="${FULL:-0}"                 # 1 => whole dataset, no -i (all tasks)
RUN_NAME="${RUN_NAME:-}"          # free-text label echoed in the arm logs
REGION="${REGION:-iad}"
FLY_ORG="${FLY_ORG:-personal}"
VM_SIZE="${VM_SIZE:-shared-cpu-2x}"
VM_MEMORY="${VM_MEMORY:-4096}"

case "$MODEL" in *opus*) MS=opus ;; *sonnet*) MS=sonnet ;; *) MS=model ;; esac
APP="${APP:-ab-${ARM}-${MS}}"
if [ "$FULL" = "1" ]; then SCOPE="FULL($DATASET)"; else SCOPE="tasks='$TASKS'"; fi

echo "==> arm=$ARM model=$MODEL $SCOPE -k $K -n $N  app=$APP  org=$FLY_ORG  upload=$UPLOAD"
command -v flyctl >/dev/null || { echo "FATAL: flyctl not on PATH — install + 'flyctl auth login'" >&2; exit 1; }

# 1. Latest DEV tgz, built on THIS laptop (decision 4). Skippable to reuse.
if [ "${SKIP_REFRESH:-0}" != "1" ]; then
  echo "==> building latest unerr dev tgz…"
  "$AB_DIR/refresh-unerr-tgz.sh"
fi
TGZ="$(ls -t "$AB_DIR"/vendor/unerr-ai-unerr-*.tgz 2>/dev/null | head -1 || true)"
[ -n "$TGZ" ] || { echo "FATAL: no vendor tgz under $AB_DIR/vendor" >&2; exit 1; }
echo "==> tgz: $(basename "$TGZ")"

# 2. Assemble a small, self-contained build context.
CTX="$HERE/context"
rm -rf "$CTX"
mkdir -p "$CTX/ab-daytona/vendor" "$CTX/bench-src"
cp "$AB_DIR/ab_agent.py"              "$CTX/ab-daytona/ab_agent.py"
cp "$TGZ"                             "$CTX/ab-daytona/vendor/"
cp "$BENCH_DIR/src/harbor_agents.py"  "$CTX/bench-src/harbor_agents.py"
cp "$HERE/entrypoint.sh"             "$CTX/entrypoint.sh"
cp "$HERE/summarize.py"              "$CTX/summarize.py"

# 3. Ensure the app exists (idempotent).
flyctl apps create "$APP" --org "$FLY_ORG" 2>/dev/null || true

# 4. Secrets from .env.local (idempotent; staged onto the app).
if [ "${SKIP_SECRETS:-0}" != "1" ]; then
  "$HERE/set-secrets.sh" "$APP"
fi

# 5. Build + push the image on Fly's remote builder (no local Docker, no machine
#    started). Explicit --config + --dockerfile with a positional CONTEXT: on a
#    fresh machine-less app flyctl otherwise tries to rebuild config from
#    machines and fails.
LABEL="ab-$(date +%s)"
BUILD_LOG="$HERE/build.log"
echo "==> building + pushing image to $APP (label $LABEL)…"
flyctl deploy "$CTX" \
  --config "$HERE/fly.ab.toml" \
  --dockerfile "$HERE/Dockerfile.ab" \
  --image-label "$LABEL" \
  --build-only --remote-only --push \
  -a "$APP" 2>&1 | tee "$BUILD_LOG"
IMG="$(grep -oE 'registry\.fly\.io/[^ ]+' "$BUILD_LOG" | tail -1)"
[ -n "$IMG" ] || { echo "FATAL: could not determine built image ref from $BUILD_LOG" >&2; exit 1; }
echo "==> image: $IMG"

# 6. Launch ONE ephemeral machine that runs the arm and exits (--restart no).
#    Retry the create on the usual just-pushed transients (MANIFEST_UNKNOWN/429).
run_machine() {
  local tries=0 max="${RUN_RETRIES:-6}" log="$HERE/machine-run.log"
  while [ "$tries" -lt "$max" ]; do
    tries=$((tries + 1))
    if flyctl machine run "$@" >"$log" 2>&1; then cat "$log"; return 0; fi
    cat "$log"
    if grep -qiE 'MANIFEST_UNKNOWN|429|rate limit|capacity|please try again' "$log"; then
      echo "  transient machine-create error (try $tries/$max) — retry in $((tries * 5))s"
      sleep $((tries * 5)); continue
    fi
    echo "  machine run FAILED (non-transient) — see above"; return 1
  done
  echo "  gave up after $tries tries"; return 1
}

echo "==> launching one-shot machine…"
run_machine "$IMG" \
  --app "$APP" --region "$REGION" \
  --vm-size "$VM_SIZE" --vm-memory "$VM_MEMORY" \
  --restart no \
  --entrypoint /work/entrypoint.sh \
  --metadata "fleet=ab-$ARM-$MS" \
  -e ARM="$ARM" -e MODEL="$MODEL" -e TASKS="$TASKS" \
  -e DATASET="$DATASET" -e N="$N" -e K="$K" -e UPLOAD="$UPLOAD" \
  -e FULL="$FULL" -e RUN_NAME="$RUN_NAME" \
  || { echo "FATAL: machine launch failed"; exit 1; }

echo
echo "==> launched on $APP. Follow the run:"
echo "     flyctl logs -a $APP"
echo "    The machine runs the arm, prints a token/cost summary, then exits (stays 'stopped')."
echo "    Cost/token numbers appear in the logs even when UPLOAD=none."
