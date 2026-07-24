# ab-daytona — unerr A/B token benchmark

Measures what unerr does to a plain `claude -p` run: token cost and the "unerr
tax". Two arms, identical except for unerr itself, run on Daytona sandboxes via
Harbor with a minimal custom agent (`ab_agent.py`).

| Arm | What runs |
|---|---|
| `unerr` | claude-code + full unerr install + unerr MCP server + minimal prompt |
| `baseline` | bare claude-code, same minimal prompt (no unerr) |

## The one rule: always run the CURRENT build, never a vendored tgz

The benchmark must test *this checkout's* code. It builds a fresh DEV binary and
packs it into `vendor/`, and the agent loads that via `UNERR_CONTEXT_DIR`. It
must NEVER use the stale `unerr-ai-unerr-*.tgz` vendored in
`../../../unerr-terminal-bench/src` — that repo is inspiration, not the source of
truth.

### Build command (dev build — mandatory)

```bash
rm -rf dist && export UNERR_PROD_BUILD=0 && pnpm run build   # in the unerr-cli repo root
```

`UNERR_PROD_BUILD=0` is load-bearing: it keeps the file-based **dev-mode** code
compiled in (`~/.unerr/dev.json` → Pro tier). A prod build (`=1`) strips it, and
`dev.json` would not mint Pro — so login/tier behavior would be wrong.

`refresh-unerr-tgz.sh` runs exactly this command for you, then `npm pack`s the
result into `vendor/unerr-ai-unerr-<version>.tgz` (one tgz, older ones removed).

## Run

```bash
# unerr arm — auto-builds fresh, packs to vendor/, points the agent at it:
ARM=unerr ./run_arm.sh

# baseline arm (no unerr, no build needed):
ARM=baseline ./run_arm.sh
```

`run_arm.sh` calls `refresh-unerr-tgz.sh` for the `unerr` arm and exports
`UNERR_CONTEXT_DIR=vendor`. Overrides:

| Env | Default | Effect |
|---|---|---|
| `MODEL` | `claude-opus-4-8` | model under test (`claude-sonnet-5` for a cheap correctness probe) |
| `TASK` | `terminal-bench/build-pmars` | task id |
| `SKIP_REFRESH=1` | off | reuse the last `vendor/` tgz (skip the rebuild) |
| `SKIP_BUILD=1` | off | (on `refresh-unerr-tgz.sh`) pack an already-built dist, staleness-gated |

Standalone refresh, without a run:

```bash
./refresh-unerr-tgz.sh                # rm -rf dist; dev build; pack -> vendor/
SKIP_BUILD=1 ./refresh-unerr-tgz.sh   # pack an existing dist only
```

## How unerr runs logged-in offline (no `unerr login`)

Two independent gates, both cleared without a browser login:

1. **Tier** — `ab_agent.py` writes `~/.unerr/dev.json = {"tier":"pro"}`.
   `applyDevConfig` mints a local Pro entitlement in every `unerr <cmd>` process
   (needs the dev build above).
2. **Login wall** — `UNERR_TOKEN` is forwarded into the `claude -p` container via
   an `EnvVar` in `MinimalUnerrAgent.ENV_VARS`, so `claude` and every child it
   spawns (hooks, the `unerr --mcp` bridge) inherit it. `loginBlocked()` returns
   false the instant `UNERR_TOKEN` is non-blank — it is never validated locally,
   and wire calls with it fail gracefully off the tool path.

## Output

Results land in `out/ab-<arm>/<timestamp>/…`. The per-turn token usage and tool
calls are in the Claude session log:
`…/agent/sessions/projects/-app/*.jsonl` (parse `message.usage` +
`tool_use`/`tool_result`).

## Files

| File | Purpose |
|---|---|
| `ab_agent.py` | the minimal Harbor agent (both arms) |
| `run_arm.sh` | one arm run (build → pack → harbor run) |
| `refresh-unerr-tgz.sh` | dev-build + pack this checkout into `vendor/` |
| `verify_devmode.py` | standalone Daytona probe of file-based dev mode (no model spend) |
| `vendor/` | the fresh packed tgz (gitignored) |
| `out/` | run outputs (gitignored) |
