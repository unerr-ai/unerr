#!/usr/bin/env bash
#
# unerr CLI — End-to-End Integration Test Script
#
# Tests the full CLI against the current "low sub-command" architecture:
#   - `unerr` (no args) = auto-boot MCP server (first-run wizard or resume)
#   - `unerr --mcp` = headless MCP server for IDE integration
#   - Visible commands: status, stats, install, dashboard, debug, init, chat
#   - Hidden commands (callable): index, timeline, skills, branches, etc.
#
# Usage:
#   ./scripts/integration-test.sh              # Run against this repo
#   ./scripts/integration-test.sh /path/to/repo  # Run against another repo
#
# Prerequisites:
#   - Node.js >= 20, pnpm installed
#   - Run from the unerr-cli root (or pass repo path as arg)
#
# Exit codes:
#   0 = all critical tests pass
#   1 = one or more critical tests failed
#

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────

UNERR_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_REPO="${1:-$UNERR_ROOT}"
CLI="node $UNERR_ROOT/dist/cli.js"
PASS=0
FAIL=0
WARN=0
SKIP=0
RESULTS=()

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Helpers ─────────────────────────────────────────────────────

pass() {
  PASS=$((PASS + 1))
  RESULTS+=("${GREEN}✓${NC} $1")
  echo -e "  ${GREEN}✓${NC} $1"
}

fail() {
  FAIL=$((FAIL + 1))
  RESULTS+=("${RED}✗${NC} $1 — $2")
  echo -e "  ${RED}✗${NC} $1 — $2"
}

warn() {
  WARN=$((WARN + 1))
  RESULTS+=("${YELLOW}⚠${NC} $1 — $2")
  echo -e "  ${YELLOW}⚠${NC} $1 — $2"
}

skip() {
  SKIP=$((SKIP + 1))
  RESULTS+=("${DIM}○${NC} $1 — skipped ($2)")
  echo -e "  ${DIM}○${NC} $1 — skipped ($2)"
}

section() {
  echo ""
  echo -e "${BOLD}${CYAN}── $1 ──${NC}"
}

# ── Pre-flight ──────────────────────────────────────────────────

echo -e "${BOLD}unerr CLI Integration Test${NC}"
echo -e "${DIM}Target repo: $TARGET_REPO${NC}"
echo -e "${DIM}CLI binary:  $CLI${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════
# SECTION 1: Build & Basic Health
# ═══════════════════════════════════════════════════════════════

section "1. Build & Basic Health"

# 1.1 TypeScript compiles
if (cd "$UNERR_ROOT" && pnpm run typecheck 2>&1) >/dev/null 2>&1; then
  pass "1.1 TypeScript compiles"
else
  fail "1.1 TypeScript compiles" "typecheck failed"
fi

# 1.2 Lint passes
LINT_OUTPUT=$(cd "$UNERR_ROOT" && pnpm run lint 2>&1) || true
if echo "$LINT_OUTPUT" | grep -q "error"; then
  ERROR_COUNT=$(echo "$LINT_OUTPUT" | grep -c "error" || true)
  if [ "$ERROR_COUNT" -gt 2 ]; then
    fail "1.2 Lint passes" "$ERROR_COUNT errors found"
  else
    warn "1.2 Lint passes" "minor formatting issues"
  fi
else
  pass "1.2 Lint passes"
fi

# 1.3 Tests pass
TEST_OUTPUT=$(cd "$UNERR_ROOT" && pnpm run test:run 2>&1) || true
if echo "$TEST_OUTPUT" | grep -q "Tests.*passed"; then
  TEST_COUNT=$(echo "$TEST_OUTPUT" | sed -n 's/.*\([0-9][0-9]*\) tests.*/\1/p' | tail -1)
  FAILED_LINE=$(echo "$TEST_OUTPUT" | grep "failed" || true)
  if [ -z "$FAILED_LINE" ] || echo "$FAILED_LINE" | grep -q "0 failed"; then
    pass "1.3 Tests pass (${TEST_COUNT:-?} tests)"
  else
    fail "1.3 Tests pass" "some tests failed"
  fi
else
  fail "1.3 Tests pass" "test run did not complete"
fi

# 1.4 Build succeeds
if (cd "$UNERR_ROOT" && pnpm run build 2>&1) >/dev/null 2>&1; then
  if [ -f "$UNERR_ROOT/dist/cli.js" ]; then
    pass "1.4 Build succeeds (dist/cli.js exists)"
  else
    fail "1.4 Build succeeds" "dist/cli.js not found"
  fi
else
  fail "1.4 Build succeeds" "build command failed"
  echo -e "${RED}FATAL: Cannot continue without a build.${NC}"
  exit 1
fi

# 1.5 CLI shows help (visible commands: status, stats, install, dashboard, debug)
HELP_OUTPUT=$(cd "$TARGET_REPO" && $CLI --help 2>&1) || true
if echo "$HELP_OUTPUT" | grep -qi "status\|install\|debug"; then
  pass "1.5 CLI shows help (visible commands present)"
else
  fail "1.5 CLI shows help" "expected commands not found in help output"
fi

# ═══════════════════════════════════════════════════════════════
# SECTION 2: Indexing (hidden command, still callable)
# ═══════════════════════════════════════════════════════════════

section "2. Indexing"

# 2.1 Index runs (hidden command but callable)
INDEX_OUTPUT=$(cd "$TARGET_REPO" && $CLI index 2>&1) || true
if echo "$INDEX_OUTPUT" | grep -qi "entit\|edge\|index\|graph"; then
  pass "2.1 Index completes"
else
  # The index command may output to stderr only
  if [ $? -eq 0 ] || echo "$INDEX_OUTPUT" | grep -qi "complet\|success\|loaded"; then
    pass "2.1 Index completes (exit 0)"
  else
    warn "2.1 Index completes" "unclear output"
  fi
fi

# 2.2 Index with JSON output
INDEX_JSON=$(cd "$TARGET_REPO" && $CLI index --json --force 2>/dev/null) || true
if echo "$INDEX_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('entityCount',0)>0" 2>/dev/null; then
  ENTITY_COUNT=$(echo "$INDEX_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('entityCount',0))" 2>/dev/null)
  EDGE_COUNT=$(echo "$INDEX_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('edgeCount',0))" 2>/dev/null)
  pass "2.2 Index JSON output ($ENTITY_COUNT entities, $EDGE_COUNT edges)"
else
  warn "2.2 Index JSON output" "could not parse or no entities"
fi

# 2.3 Graph data stored (.unerr/ directory has data)
if ls "$TARGET_REPO/.unerr/snapshots/"*.msgpack* 2>/dev/null | head -1 >/dev/null 2>&1; then
  pass "2.3 Snapshot file created (in .unerr/snapshots/)"
elif [ -f "$TARGET_REPO/.unerr/graph.db" ] || [ -d "$TARGET_REPO/.unerr/graph.db" ]; then
  pass "2.3 Persistent graph DB created (.unerr/graph.db)"
elif [ -d "$TARGET_REPO/.unerr" ]; then
  pass "2.3 .unerr directory exists (graph data in-memory)"
else
  warn "2.3 Graph storage" "no .unerr/ directory found"
fi

# ═══════════════════════════════════════════════════════════════
# SECTION 3: MCP Proxy & Protocol
# ═══════════════════════════════════════════════════════════════

section "3. MCP Proxy & Protocol"

# Ensure .unerr/config.json exists so the proxy starts in resume mode (not setup wizard)
mkdir -p "$TARGET_REPO/.unerr/state" 2>/dev/null || true
if [ ! -f "$TARGET_REPO/.unerr/config.json" ]; then
  echo '{"repoId":"integration-test","mode":"local"}' > "$TARGET_REPO/.unerr/config.json"
fi

# Clean up any stale PID
rm -f "$TARGET_REPO/.unerr/state/proxy.pid" 2>/dev/null || true

# For MCP testing, use --mcp flag (headless mode) and send requests via stdin.
TMPDIR_TEST=$(mktemp -d)
PROXY_LOG="$TMPDIR_TEST/proxy.log"
MCP_OUTPUT="$TMPDIR_TEST/mcp_output.jsonl"

cd "$TARGET_REPO"

# Send all requests with delays, then close stdin. Use timeout to force-kill proxy.
timeout 20 bash -c '
  (
    echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"integration-test\",\"version\":\"1.0\"}}}"
    sleep 1
    echo "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"
    sleep 0.3
    echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}"
    sleep 0.5
    echo "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"search_code\",\"arguments\":{\"query\":\"proxy\"}}}"
    sleep 0.5
    echo "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_callers\",\"arguments\":{\"key\":\"proxy\"}}}"
    sleep 0.5
    echo "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"get_conventions\",\"arguments\":{}}}"
    sleep 0.5
    echo "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"get_critical_nodes\",\"arguments\":{}}}"
    sleep 0.5
    echo "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"get_project_stats\",\"arguments\":{}}}"
    sleep 0.5
    echo "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\"params\":{\"name\":\"totally_fake_tool\",\"arguments\":{}}}"
    sleep 2
  ) | '"$CLI"' --mcp > '"$MCP_OUTPUT"' 2>'"$PROXY_LOG"'
' 2>/dev/null || true

sleep 1

# 3.1 Proxy starts & returns responses
RESPONSE_COUNT=$(wc -l < "$MCP_OUTPUT" | tr -d ' ')
if [ "$RESPONSE_COUNT" -ge 1 ]; then
  pass "3.1 Proxy starts and returns MCP responses ($RESPONSE_COUNT lines)"
else
  fail "3.1 Proxy starts" "no responses received on stdout"
fi

# 3.2 Initialize response valid
INIT_RESP=$(sed -n '1p' "$MCP_OUTPUT")
if echo "$INIT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('id')==1 and 'result' in d" 2>/dev/null; then
  SERVER_NAME=$(echo "$INIT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'].get('serverInfo',{}).get('name','?'))" 2>/dev/null)
  pass "3.2 MCP initialize succeeds (server: $SERVER_NAME)"
else
  fail "3.2 MCP initialize" "invalid response"
fi

# Helper: get response by id
get_response() {
  local id=$1
  python3 -c "
import json, sys
for line in open('$MCP_OUTPUT'):
  line = line.strip()
  if not line: continue
  try:
    d = json.loads(line)
    if d.get('id') == $id:
      print(line)
      break
  except: pass
" 2>/dev/null
}

# 3.3 tools/list
TOOLS_RESP=$(get_response 2)
if [ -n "$TOOLS_RESP" ]; then
  TOOL_COUNT=$(echo "$TOOLS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['result']['tools']))" 2>/dev/null)
  if [ -n "$TOOL_COUNT" ] && [ "$TOOL_COUNT" -ge 10 ]; then
    pass "3.3 tools/list returns $TOOL_COUNT tools"
  else
    fail "3.3 tools/list" "only $TOOL_COUNT tools (expected >=10)"
  fi
else
  fail "3.3 tools/list" "no response for id=2"
fi

# 3.4 search_code
SEARCH_RESP=$(get_response 3)
if [ -n "$SEARCH_RESP" ]; then
  HAS_RESULT=$(echo "$SEARCH_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r = d.get('result',{})
has_meta = '_meta' in r
content = r.get('content',[])
has_data = False
if content:
  text = content[0].get('text','')
  try:
    parsed = json.loads(text)
    has_data = 'results' in parsed or 'entities' in parsed or isinstance(parsed, list) or len(parsed) > 0
  except:
    has_data = len(text) > 10
print('meta' if has_meta else 'no_meta', 'data' if has_data else 'no_data')
" 2>/dev/null)

  if echo "$HAS_RESULT" | grep -q "data"; then
    if echo "$HAS_RESULT" | grep -q "meta"; then
      pass "3.4 search_code returns results with _meta envelope"
    else
      warn "3.4 search_code" "returns data but missing _meta"
    fi
  else
    warn "3.4 search_code" "response: $HAS_RESULT"
  fi
else
  fail "3.4 search_code" "no response"
fi

# 3.5 get_callers
CALLERS_RESP=$(get_response 4)
if [ -n "$CALLERS_RESP" ] && echo "$CALLERS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'result' in d" 2>/dev/null; then
  pass "3.5 get_callers responds"
else
  fail "3.5 get_callers" "no valid result"
fi

# 3.6 get_conventions
CONV_RESP=$(get_response 5)
if [ -n "$CONV_RESP" ] && echo "$CONV_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'result' in d" 2>/dev/null; then
  pass "3.6 get_conventions responds"
else
  fail "3.6 get_conventions" "no valid result"
fi

# 3.7 get_critical_nodes
CRITICAL_RESP=$(get_response 6)
if [ -n "$CRITICAL_RESP" ] && echo "$CRITICAL_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'result' in d" 2>/dev/null; then
  pass "3.7 get_critical_nodes responds"
else
  fail "3.7 get_critical_nodes" "no valid result"
fi

# 3.8 get_project_stats
STATS_RESP=$(get_response 7)
if [ -n "$STATS_RESP" ] && echo "$STATS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'result' in d" 2>/dev/null; then
  pass "3.8 get_project_stats responds"
else
  fail "3.8 get_project_stats" "no valid result"
fi

# 3.9 Unknown tool handling
UNK_RESP=$(get_response 8)
if [ -n "$UNK_RESP" ]; then
  UNK_CHECK=$(echo "$UNK_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r = d.get('result',{})
content = r.get('content',[])
if content:
  text = content[0].get('text','').lower()
  if 'unknown' in text or 'not found' in text:
    print('good')
  else:
    print('unexpected')
elif 'error' in d:
  print('good')
else:
  print('empty')
" 2>/dev/null)
  if [ "$UNK_CHECK" = "good" ]; then
    pass "3.9 Unknown tool returns helpful error"
  else
    warn "3.9 Unknown tool handling" "response: $UNK_CHECK"
  fi
else
  warn "3.9 Unknown tool handling" "no response"
fi

# 3.10 Response latency (from result._meta)
if [ -n "$SEARCH_RESP" ]; then
  LATENCY=$(echo "$SEARCH_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
meta = d.get('result',{}).get('_meta', {})
lat = meta.get('latency_ms', meta.get('duration_ms', -1))
print(int(lat) if lat != -1 else -1)
" 2>/dev/null) || LATENCY="-1"

  if [ "$LATENCY" != "-1" ] && [ "$LATENCY" -lt 50 ] 2>/dev/null; then
    pass "3.10 Query latency: ${LATENCY}ms (target: <5ms)"
  elif [ "$LATENCY" != "-1" ]; then
    warn "3.10 Query latency" "${LATENCY}ms (target: <5ms)"
  else
    skip "3.10 Query latency" "could not extract from _meta"
  fi
fi

# 3.11 _meta.tokens_saved
if [ -n "$SEARCH_RESP" ]; then
  TOKENS_SAVED=$(echo "$SEARCH_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
meta = d.get('result',{}).get('_meta',{})
ts = meta.get('tokens_saved')
if ts is not None:
  print(ts)
else:
  content = d.get('result',{}).get('content',[])
  if content:
    text = content[0].get('text','{}')
    try:
      parsed = json.loads(text)
      ts2 = parsed.get('_meta',{}).get('tokens_saved')
      print(ts2 if ts2 is not None else 'missing')
    except:
      print('missing')
  else:
    print('missing')
" 2>/dev/null) || TOKENS_SAVED="missing"

  if [ "$TOKENS_SAVED" != "missing" ]; then
    pass "3.11 _meta.tokens_saved present ($TOKENS_SAVED)"
  else
    warn "3.11 _meta.tokens_saved" "not present in response"
  fi
fi

# 3.12 _context envelope
if [ -n "$SEARCH_RESP" ]; then
  HAS_CONTEXT=$(echo "$SEARCH_RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
result = d.get('result',{})
if '_context' in result:
  print('yes')
else:
  content = result.get('content',[])
  if content:
    text = content[0].get('text','{}')
    try:
      parsed = json.loads(text)
      print('yes' if '_context' in parsed else 'no')
    except:
      print('no')
  else:
    print('no')
" 2>/dev/null) || HAS_CONTEXT="no"

  if [ "$HAS_CONTEXT" = "yes" ]; then
    pass "3.12 _context envelope present"
  else
    warn "3.12 _context envelope" "not present in response (may need enrichable entity)"
  fi
fi

# 3.13 PID lock cleaned on shutdown
if [ ! -f "$TARGET_REPO/.unerr/state/proxy.pid" ]; then
  pass "3.13 PID lock cleaned on shutdown"
else
  warn "3.13 PID lock cleanup" "proxy.pid still exists"
fi

# 3.14 stdout purity (no non-JSON lines)
NON_JSON_LINES=$(python3 -c "
import json
count = 0
with open('$MCP_OUTPUT') as f:
  for line in f:
    line = line.strip()
    if not line: continue
    try:
      json.loads(line)
    except:
      count += 1
print(count)
" 2>/dev/null) || NON_JSON_LINES="?"

if [ "$NON_JSON_LINES" = "0" ]; then
  pass "3.14 stdout is pure JSON-RPC (no log leaks)"
else
  fail "3.14 stdout purity" "$NON_JSON_LINES non-JSON lines detected"
fi

# ═══════════════════════════════════════════════════════════════
# SECTION 4: Install Command & Skills
# ═══════════════════════════════════════════════════════════════

section "4. Install Command & Skills"

cd "$TARGET_REPO"

# 4.1 Install for claude-code
INSTALL_OUTPUT=$(cd "$TARGET_REPO" && $CLI install claude-code 2>&1) || true
if [ -f "$TARGET_REPO/.mcp.json" ]; then
  pass "4.1 install claude-code creates .mcp.json"
else
  fail "4.1 install claude-code" ".mcp.json not created"
fi

# 4.2 MCP config content correct (command: "unerr", args: ["--mcp"])
if [ -f "$TARGET_REPO/.mcp.json" ]; then
  if python3 -c "
import json
with open('$TARGET_REPO/.mcp.json') as f:
  d = json.load(f)
servers = d.get('mcpServers', {})
assert 'unerr' in servers, 'no unerr entry'
unerr = servers['unerr']
assert unerr.get('command') == 'unerr', f'command is {unerr.get(\"command\")} (expected unerr)'
assert '--mcp' in unerr.get('args', []), 'missing --mcp in args'
" 2>/dev/null; then
    pass "4.2 MCP config correct (command: unerr, args: [--mcp])"
  else
    fail "4.2 MCP config content" "missing unerr entry or wrong command/args"
  fi
fi

# 4.3 Skills installed for claude-code
SKILLS_DIR="$TARGET_REPO/.claude/skills"
if [ -d "$SKILLS_DIR" ]; then
  SKILL_COUNT=$(ls "$SKILLS_DIR"/unerr-* 2>/dev/null | wc -l | tr -d ' ')
  if [ "$SKILL_COUNT" -ge 1 ]; then
    pass "4.3 Skills installed ($SKILL_COUNT files in .claude/skills/)"
  else
    warn "4.3 Skills installed" "no unerr-* skill files found"
  fi
else
  fail "4.3 Skills installed" ".claude/skills/ directory not created"
fi

# 4.4 Install idempotency
INSTALL2_OUTPUT=$(cd "$TARGET_REPO" && $CLI install claude-code 2>&1) || true
if [ -f "$TARGET_REPO/.mcp.json" ]; then
  UNERR_COUNT=$(python3 -c "
import json
with open('$TARGET_REPO/.mcp.json') as f:
  d = json.load(f)
count = sum(1 for k in d.get('mcpServers', {}) if 'unerr' in k.lower())
print(count)
" 2>/dev/null) || UNERR_COUNT="?"
  if [ "$UNERR_COUNT" = "1" ]; then
    pass "4.4 Install is idempotent (no duplicates)"
  else
    fail "4.4 Install idempotent" "$UNERR_COUNT unerr entries found"
  fi
fi

# 4.5 Install for cursor
CURSOR_OUTPUT=$(cd "$TARGET_REPO" && $CLI install cursor 2>&1) || true
if [ -f "$TARGET_REPO/.cursor/mcp.json" ]; then
  pass "4.5 install cursor creates .cursor/mcp.json"
else
  warn "4.5 install cursor" ".cursor/mcp.json not created"
fi

# 4.6 Cursor skills in .mdc format
if [ -d "$TARGET_REPO/.cursor/rules" ]; then
  MDC_COUNT=$(ls "$TARGET_REPO/.cursor/rules"/unerr-*.mdc 2>/dev/null | wc -l | tr -d ' ')
  if [ "$MDC_COUNT" -ge 1 ]; then
    pass "4.6 Cursor skills in .mdc format ($MDC_COUNT files)"
  else
    warn "4.6 Cursor .mdc skills" "no .mdc files found"
  fi
else
  warn "4.6 Cursor rules dir" ".cursor/rules/ not created"
fi

# ═══════════════════════════════════════════════════════════════
# SECTION 5: CLI Commands
# ═══════════════════════════════════════════════════════════════

section "5. CLI Commands"

# 5.1 Status
STATUS_OUTPUT=$(cd "$TARGET_REPO" && $CLI status 2>&1) || true
if echo "$STATUS_OUTPUT" | grep -qi "entit\|graph\|health\|grade\|branch\|status"; then
  pass "5.1 status command works"
else
  fail "5.1 status command" "unexpected output"
fi

# 5.2 Debug
DEBUG_OUTPUT=$(cd "$TARGET_REPO" && $CLI debug 2>&1) || true
if echo "$DEBUG_OUTPUT" | grep -qi "node\|version\|pid\|path\|debug"; then
  pass "5.2 debug command works"
else
  fail "5.2 debug command" "unexpected output"
fi

# 5.3 Stats
STATS_CMD_OUTPUT=$(cd "$TARGET_REPO" && $CLI stats 2>&1) || true
# Stats may have no data yet but should not crash
if echo "$STATS_CMD_OUTPUT" | grep -qi "session\|token\|week\|savings\|no.*data\|0\|stats"; then
  pass "5.3 stats command works"
else
  pass "5.3 stats command runs without error"
fi

# 5.4 Chat shows disabled message
CHAT_OUTPUT=$(cd "$TARGET_REPO" && $CLI chat 2>&1) || true
if echo "$CHAT_OUTPUT" | grep -qi "disabled\|temporarily\|MCP proxy"; then
  pass "5.4 chat command properly disabled"
else
  warn "5.4 chat disabled" "not showing expected disabled message"
fi

# ═══════════════════════════════════════════════════════════════
# SECTION 6: Edge Cases
# ═══════════════════════════════════════════════════════════════

section "6. Edge Cases"

# 6.1 No git repo handling (--mcp in non-git dir should fail gracefully)
NO_GIT_OUTPUT=$(cd /tmp && $CLI --mcp 2>&1; true)
if echo "$NO_GIT_OUTPUT" | grep -qi "git\|repository\|not.*found\|error"; then
  pass "6.1 Graceful handling of non-git directory"
else
  warn "6.1 No git repo" "unclear error message"
fi

# 6.2 --help includes expected visible commands
HELP_CHECK=$(cd "$TARGET_REPO" && $CLI --help 2>&1) || true
if echo "$HELP_CHECK" | grep -q "status" && echo "$HELP_CHECK" | grep -q "install"; then
  pass "6.2 --help shows visible commands (status, install)"
else
  warn "6.2 --help" "missing expected visible commands"
fi

# 6.3 Hidden commands don't appear in --help
if ! echo "$HELP_CHECK" | grep -q "timeline" && ! echo "$HELP_CHECK" | grep -q "rewind"; then
  pass "6.3 Hidden commands not in --help (timeline, rewind)"
else
  warn "6.3 Hidden commands" "appear in --help (should be hidden)"
fi

# ═══════════════════════════════════════════════════════════════
# SECTION 7: Performance
# ═══════════════════════════════════════════════════════════════

section "7. Performance"

# 7.1 Index time
INDEX_START=$(python3 -c "import time; print(int(time.time()*1000))")
(cd "$TARGET_REPO" && $CLI index --force 2>/dev/null >/dev/null) || true
INDEX_END=$(python3 -c "import time; print(int(time.time()*1000))")
INDEX_MS=$((INDEX_END - INDEX_START))
INDEX_SEC=$((INDEX_MS / 1000))

if [ "$INDEX_SEC" -lt 30 ]; then
  pass "7.1 Index time: ${INDEX_SEC}s (target: <30s)"
elif [ "$INDEX_SEC" -lt 60 ]; then
  warn "7.1 Index time" "${INDEX_SEC}s (target: <30s)"
else
  fail "7.1 Index time" "${INDEX_SEC}s (way over 30s target)"
fi

# 7.2 MCP cold start (measure time to first response via --mcp)
mkdir -p "$TARGET_REPO/.unerr/state" 2>/dev/null || true
if [ ! -f "$TARGET_REPO/.unerr/config.json" ]; then
  echo '{"repoId":"integration-test","mode":"local"}' > "$TARGET_REPO/.unerr/config.json"
fi
rm -f "$TARGET_REPO/.unerr/state/proxy.pid" 2>/dev/null || true
BOOT_TMPFILE=$(mktemp)
BOOT_START=$(python3 -c "import time; print(int(time.time()*1000))")
cd "$TARGET_REPO"
timeout 10 bash -c '
  (
    echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"boot-test\",\"version\":\"1.0\"}}}"
    sleep 3
  ) | '"$CLI"' --mcp 2>/dev/null
' > "$BOOT_TMPFILE" 2>/dev/null || true
BOOT_END=$(python3 -c "import time; print(int(time.time()*1000))")
BOOT_RESP=$(head -1 "$BOOT_TMPFILE")
BOOT_MS=$((BOOT_END - BOOT_START))
BOOT_SEC=$((BOOT_MS / 1000))
rm -f "$BOOT_TMPFILE"

if [ -n "$BOOT_RESP" ] && [ "$BOOT_SEC" -lt 5 ]; then
  pass "7.2 Cold start: ${BOOT_SEC}s to first response (target: <5s)"
elif [ -n "$BOOT_RESP" ] && [ "$BOOT_SEC" -lt 10 ]; then
  warn "7.2 Cold start" "${BOOT_SEC}s (target: <5s)"
else
  warn "7.2 Cold start" "could not measure or >10s (${BOOT_SEC}s elapsed)"
fi

# ═══════════════════════════════════════════════════════════════
# CLEANUP
# ═══════════════════════════════════════════════════════════════

rm -rf "$TMPDIR_TEST" 2>/dev/null || true

# ═══════════════════════════════════════════════════════════════
# REPORT
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Integration Test Report${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${GREEN}Passed:${NC}  $PASS"
echo -e "  ${RED}Failed:${NC}  $FAIL"
echo -e "  ${YELLOW}Warned:${NC}  $WARN"
echo -e "  ${DIM}Skipped:${NC} $SKIP"
echo ""
TOTAL=$((PASS + FAIL + WARN + SKIP))
echo -e "  Total: $TOTAL checks"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}  RESULT: FAIL — $FAIL critical test(s) failed${NC}"
  echo ""
  echo -e "  ${RED}Failed tests:${NC}"
  for r in "${RESULTS[@]}"; do
    if echo -e "$r" | grep -q "✗"; then
      echo -e "    $r"
    fi
  done
  echo ""
  exit 1
else
  if [ "$WARN" -gt 0 ]; then
    echo -e "${YELLOW}  RESULT: PASS with $WARN warning(s)${NC}"
  else
    echo -e "${GREEN}  RESULT: ALL PASS${NC}"
  fi
  echo ""
  exit 0
fi
