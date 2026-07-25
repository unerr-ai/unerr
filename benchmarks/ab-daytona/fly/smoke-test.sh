#!/usr/bin/env bash
# Smoke test: ONE arm only — unerr + sonnet — on the two tasks already run
# (build-pmars, torch-tensor-parallelism). Verifies the whole Fly pipeline
# end-to-end (build -> push -> machine -> harbor -> Daytona -> cost summary)
# without publishing anything: UPLOAD=none, so results come back via `flyctl
# logs` (summarize.py prints the token/cost table there).
#
#   ./smoke-test.sh
#
# Override N/K if you want (defaults keep it cheap: -n 4 -k 1 => 2 trials total).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARM=unerr \
MODEL=claude-sonnet-5 \
TASKS="terminal-bench/build-pmars terminal-bench/torch-tensor-parallelism" \
N="${N:-4}" \
K="${K:-1}" \
UPLOAD=none \
APP="${APP:-ab-smoke-unerr-sonnet}" \
exec "$HERE/deploy-arm.sh"
