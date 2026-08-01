# unerr token benchmark

Measures what unerr does to a plain `claude -p` run: token cost and the "unerr
tax". Two arms, identical except for unerr itself, run in a remote sandbox via
Harbor with a minimal custom agent (`bench_agent.py`).

| Arm | What runs |
|---|---|
| `unerr` | claude-code + full unerr install + unerr MCP server + minimal prompt |
| `baseline` | bare claude-code, same minimal prompt (no unerr) |

## Prerequisite: the `unerr-terminal-bench` repo

The scripts here need a sibling checkout at `~/IdeaProjects/unerr-terminal-bench`
(override with `BENCH_DIR`). It supplies two things `run_arm.sh` reads directly:

- `.env.local` — live secrets (sandbox API key, Anthropic key), sourced and
  never printed.
- `src/harbor_agents.py` — the full leaderboard agent (`ClaudeUnerrAgent`) that
  `bench_agent.py` imports from and strips down for this benchmark.

## The one rule: always run the CURRENT build, never a vendored tgz

The benchmark must test *this checkout's* code. `refresh-unerr-tgz.sh` builds a
fresh DEV binary and packs it into `vendor/`, and the agent loads that via
`UNERR_CONTEXT_DIR`. Never use the stale `unerr-ai-unerr-*.tgz` vendored in
`../unerr-terminal-bench/src` — that repo is inspiration, not the source of
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

All commands run from `benchmarks/`.

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

1. **Tier** — `bench_agent.py` writes `~/.unerr/dev.json = {"tier":"pro"}`.
   `applyDevConfig` mints a local Pro entitlement in every `unerr <cmd>` process
   (needs the dev build above).
2. **Login wall** — `UNERR_TOKEN` is forwarded into the `claude -p` container via
   an `EnvVar` in `MinimalUnerrAgent.ENV_VARS`, so `claude` and every child it
   spawns (hooks, the `unerr --mcp` bridge) inherit it. `loginBlocked()` returns
   false the instant `UNERR_TOKEN` is non-blank — it is never validated locally,
   and wire calls with it fail gracefully off the tool path.

## Output and analysis

Results land in `out/<arm>/<timestamp>/…`. The per-turn token usage and tool
calls are in the Claude session log:
`…/agent/sessions/projects/-app/*.jsonl` (parse `message.usage` +
`tool_use`/`tool_result`).

```bash
python3 status.py out/unerr [TOTAL_TASKS]        # progress, cost, resolved rate for one job
python3 status.py out/unerr --line               # one compact line, for a periodic monitor
python3 trajectory.py out/unerr out/baseline      # paired route + prefix + landed-token comparison
python3 trajectory.py out/unerr out/baseline --steps TASK_ID  # per-step tool trace for one task
```

`verify_devmode.py` is a standalone sandbox probe of file-based dev mode (no
model spend): it boots a sandbox, installs the vendored tgz, and confirms
`tools/list` / `tools/call` work with no login env set. Run:

```bash
set -a; source ~/IdeaProjects/unerr-terminal-bench/.env.local; set +a
python3 verify_devmode.py
```

## Leaderboard run (one public Harbor job)

Different from the two-arm benchmark above. The leaderboard is **one Harbor
job**: 89 tasks × ≥5 trials, a single job UUID, one config, uploaded public. It
runs the **full** agent (`harbor_agents:ClaudeUnerrAgent`), not the minimal
benchmark agent. Per-trial cloud sandboxes (`-e daytona`/`e2b`/`modal`) give
the resource isolation the heavy tail needs while letting you raise
concurrency safely.

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \          # dataset (all 89 tasks)
  -a harbor_agents:ClaudeUnerrAgent \             # full unerr agent (not the minimal benchmark one)
  -m claude-opus-4-8 \                            # model under test
  --ak reasoning_effort=<none|low|medium|high> \  # agent kwarg (repeatable)
  -e daytona \                                    # per-trial cloud sandbox
  -k 5 \                                          # trials (attempts) per task — ≥5 REQUIRED
  -n 10 \                                         # concurrency (concurrent trials)
  --upload --public                               # push to Harbor Hub, world-viewable
```

Flag reference (from `harbor run --help`):

| Flag | Meaning |
|---|---|
| `-d` | dataset id |
| `-a` | agent (`module:Class`) |
| `-m` | model |
| `-i` | filter to ONE task id (the two-arm benchmark uses this, e.g. `terminal-bench/torch-tensor-parallelism`) |
| `--ak` / `--agent-kwarg` | extra agent kwarg, repeatable (e.g. `reasoning_effort=high`, `unerr_main_model=claude-opus-4-8`) |
| `-e` | environment / sandbox: `daytona`, `e2b`, `modal`, `local` |
| `-k` / `--n-attempts` | **trials (attempts) per task** — ≥5 for the leaderboard (drives pass@k). Default 1 |
| `-n` / `--n-concurrent` | **concurrency** — number of concurrent trials |
| `-o` | jobs output dir |

`run_arm.sh` here is deliberately `-k` unset (1 trial) and `-n 1` — a
single-trial isolation test, NOT a leaderboard-valid run.

## Upload / share results (Harbor Hub — external)

Uploads the whole job dir (trajectories, session logs, token usage, config) to
Harbor Hub. New uploads default to **private**.

```bash
# upload an existing run:
harbor upload <JOB_DIR> --public                 # world-viewable link
harbor upload <JOB_DIR> --share-user <github>    # keep private, share with one GitHub user
harbor upload <JOB_DIR> --share-org <org> --yes  # share with an org (-y confirms non-member orgs)

# or auto-upload when a run finishes:
harbor run ... --upload --public                 # --public/--share-* require --upload
```

`--public`/`--private` set visibility; `--share-org` / `--share-user` are
repeatable. **Before any `--public` upload, scan the job dir for a leaked
`UNERR_TOKEN` / Anthropic / sandbox API key or an `env` dump** — the run env
carries live secrets, and public upload is world-readable and may be cached.

## Files

| File | Purpose |
|---|---|
| `bench_agent.py` | the minimal Harbor agent (both arms) |
| `run_arm.sh` | one arm run (build → pack → harbor run) |
| `refresh-unerr-tgz.sh` | dev-build + pack this checkout into `vendor/` |
| `status.py` | progress/cost/resolved-rate summary for one job dir |
| `trajectory.py` | paired route + prefix + landed-token comparison across two job dirs |
| `verify_devmode.py` | standalone sandbox probe of file-based dev mode (no model spend) |
| `vendor/` | the fresh packed tgz (gitignored) |
| `out/` | run outputs (gitignored) |
