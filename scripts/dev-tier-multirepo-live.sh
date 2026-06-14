#!/usr/bin/env bash
#
# dev-tier-multirepo-live — prove, through the REAL binary, that a paid plan
# lets more than one repo run at once while free caps at one.
#
# Why an isolated $HOME: the active-repo cap is decided by the daemon (unerrd)
# from its OWN process env. A dev-minted token is only trusted when the daemon
# carries UNERR_ENTITLEMENT_KID/PUBKEY. You CANNOT reliably restart the shared
# daemon with that env while an IDE/agent MCP session is connected — that
# session's env-less bridge auto-respawns an env-less daemon and wins the race.
# So this script runs a throwaway daemon under a temp $HOME (a separate socket
# no other bridge knows about), holds repo A active, then probes repo B.
#
# Expected: enterprise/pro → B ALLOWED (A still active); free → B -32003.
#
# Usage: bash scripts/dev-tier-multirepo-live.sh [repoA] [repoB]
# Defaults to two registered sibling repos. Pick repos NOT used by your live
# IDE session (the per-repo proxy lock at <repo>/.unerr/state is path-keyed).
set -u

REALHOME="$HOME"
HERE="$(cd "$(dirname "$0")" && pwd)"
UNERR="$(command -v unerr || echo "$REALHOME/Library/pnpm/unerr")"
DEVENT="$HERE/dev-entitlement.mjs"
PROBE="$HERE/dev-mcp-probe.mjs"
REPO_A="${1:-$REALHOME/IdeaProjects/unerr-gov-agent}"
REPO_B="${2:-$REALHOME/IdeaProjects/unerr-web-service}"
FAKE="/tmp/unerr-tiertest-home.$$"

run_case() {
  local plan="$1"
  rm -rf "$FAKE"; mkdir -p "$FAKE/.unerr"
  export HOME="$FAKE"

  node "$DEVENT" mint "$plan" >/dev/null 2>&1
  local PUB
  PUB=$(node -e 'process.stdout.write(require(process.env.HOME+"/.unerr/dev/entitlement-key.json").publicKey)')
  export UNERR_ENTITLEMENT_KID=k-dev-local
  export UNERR_ENTITLEMENT_PUBKEY="$PUB"

  "$UNERR" pm start --detached >/dev/null 2>&1
  perl -e 'select(undef,undef,undef,2)'

  node "$PROBE" "$REPO_A" "$UNERR" 28000 >"/tmp/holderA.$plan.$$.log" 2>&1 &
  local HOLDER=$!
  perl -e 'select(undef,undef,undef,5)'   # let A register + activate

  echo "===== plan=$plan ====="
  echo "A held active: $REPO_A"
  echo "probing B:     $REPO_B"
  node "$PROBE" "$REPO_B" "$UNERR" 16000 2>&1 | grep -E 'verdict|message'
  echo

  kill "$HOLDER" 2>/dev/null
  "$UNERR" pm stop >/dev/null 2>&1
  unset UNERR_ENTITLEMENT_KID UNERR_ENTITLEMENT_PUBKEY
  export HOME="$REALHOME"
  rm -f "/tmp/holderA.$plan.$$.log"
}

run_case enterprise
run_case free
rm -rf "$FAKE"
echo "done. (your real ~/.unerr and daemon are untouched — this ran under $FAKE)"
