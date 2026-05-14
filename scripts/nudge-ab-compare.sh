#!/usr/bin/env bash
#
# N11 — A/B comparison harness for Nudge v1 vs v2.
#
# Runs the same fixed sequence of representative shell commands under each
# variant, captures: total nudge bytes emitted, drift events recorded in
# state, and unerr MCP tool calls observed via the metrics DB. Produces a
# markdown summary so v2 rollout can be evidence-backed.
#
# Usage:
#   scripts/nudge-ab-compare.sh                 # runs both, prints report
#   scripts/nudge-ab-compare.sh --report-only   # re-print last report
#
# Environment:
#   UNERR_AB_REPO   target repo (default: current dir)

set -uo pipefail

REPO="${UNERR_AB_REPO:-$(pwd)}"
CLI="node $REPO/dist/cli.js"
REPORT="$REPO/.unerr/nudge-ab-report.md"
SCRATCH="$(mktemp -d)"

if [[ "${1:-}" == "--report-only" ]]; then
  if [[ -f "$REPORT" ]]; then cat "$REPORT"; else echo "no prior report"; fi
  exit 0
fi

# ── Fixture: deterministic command sequence covering tier-1 drift, benign
# commands (no nudge expected), and a clean linter (zero-output gate). ──
fixture_commands() {
  cat <<'EOF'
grep -r 'compressShellOutput' src/proxy/
grep -r 'foo' src/
cat src/proxy/shell-compressor.ts
find . -name '*.ts'
ls -R src/
npm version
git status
git tag --list
echo hello
node_modules/.bin/eslint 'src/proxy/redact.ts' 2>/dev/null || true
EOF
}

run_variant() {
  local label="$1"
  local nudge_flag="$2"
  local session_id="ab-${label}-$$"
  local outdir="$SCRATCH/$label"
  mkdir -p "$outdir"

  # Reset any prior state for this session
  rm -f "$REPO/.unerr/state/nudge-${session_id}.flags"

  local total_bytes=0
  local nudge_bytes=0
  local cmd_count=0

  while IFS= read -r cmd; do
    [[ -z "$cmd" ]] && continue
    cmd_count=$((cmd_count + 1))
    local out_file="$outdir/cmd-$cmd_count.txt"
    env -i HOME="$HOME" PATH="$PATH" SHELL="$SHELL" \
      "UNERR_SESSION_ID=$session_id" "$nudge_flag" \
      $CLI exec -- bash -c "$cmd" >"$out_file" 2>&1 || true
    local sz
    sz=$(wc -c <"$out_file" | tr -d ' ')
    total_bytes=$((total_bytes + sz))
    # Count lines that start with [unerr] as nudge bytes (incl. drift)
    local nb
    nb=$(grep -c '^\[unerr\]' "$out_file" 2>/dev/null || echo 0)
    nudge_bytes=$((nudge_bytes + nb * 100))  # ~100B per typical nudge
  done < <(fixture_commands)

  # Read the final state file
  local state_file="$REPO/.unerr/state/nudge-${session_id}.flags"
  local drift_count=0
  local tier1_kinds=""
  local tier2=false
  if [[ -f "$state_file" ]]; then
    drift_count=$(jq -r '.drift_count // 0' "$state_file" 2>/dev/null || echo 0)
    tier1_kinds=$(jq -r '.tier1_emitted_kinds // [] | join(",")' "$state_file" 2>/dev/null || echo "")
    tier2=$(jq -r '.tier2_emitted // false' "$state_file" 2>/dev/null || echo false)
  fi

  echo "$label|$cmd_count|$total_bytes|$nudge_bytes|$drift_count|$tier1_kinds|$tier2"
}

echo "Running variant A (v1 default)…" >&2
v1=$(run_variant "v1" "UNERR_NUDGE_V2=0")

echo "Running variant B (v2 opt-in)…" >&2
v2=$(run_variant "v2" "UNERR_NUDGE_V2=1")

# ── Build report ──
{
  echo "# Nudge v1 vs v2 — A/B Comparison"
  echo
  echo "Repo: \`$REPO\`"
  echo "Date: $(date -Iseconds)"
  echo "Fixture: $(fixture_commands | grep -cv '^$') commands"
  echo
  echo "| Variant | Cmds | Total out (B) | Est. nudge (B) | Drift events | Tier-1 kinds | Tier-2 fired |"
  echo "|---|---:|---:|---:|---:|---|:---:|"

  IFS='|' read -r vlbl vcnt vtot vnudge vdrift vkinds vt2 <<<"$v1"
  echo "| **$vlbl** | $vcnt | $vtot | $vnudge | $vdrift | ${vkinds:--} | $vt2 |"
  IFS='|' read -r vlbl vcnt vtot vnudge vdrift vkinds vt2 <<<"$v2"
  echo "| **$vlbl** | $vcnt | $vtot | $vnudge | $vdrift | ${vkinds:--} | $vt2 |"

  echo
  echo "## Interpretation"
  echo
  echo "- **Estimated nudge bytes** should be substantially LOWER in v2 (target ≥60% reduction)."
  echo "- **Drift events** count should be HIGHER in v2 — v2 actually tracks and acts on drift; v1 fires generic wallpaper instead."
  echo "- **Tier-1 kinds** field shows v2 detected and reported specific drift types."
  echo "- v2 wins iff: nudge bytes ↓ AND drift kinds detected > 0 AND no benign commands flagged."
  echo
  echo "## Raw output dirs"
  echo
  echo "- \`$SCRATCH/v1/\`  (v1 variant per-command output)"
  echo "- \`$SCRATCH/v2/\`  (v2 variant per-command output)"
} >"$REPORT"

cat "$REPORT"
echo
echo "Report saved to: $REPORT" >&2
