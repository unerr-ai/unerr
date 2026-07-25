# fly/ — run an A/B arm on Fly instead of your laptop

Each arm becomes its own Fly app running the **harbor orchestrator** on a small
machine. The agent itself still runs in a remote **Daytona** sandbox (`-e
daytona`) — Fly is just the orchestrator host, so your laptop stays free. One
image serves every arm; `ARM` / `MODEL` / `TASKS` / `N` / `K` are read from env
at machine-launch time.

```
laptop:  refresh tgz -> assemble context -> flyctl deploy (remote build) -> flyctl machine run
fly app: entrypoint.sh -> harbor run -e daytona -> summarize.py -> (optional) harbor upload
daytona: the actual `claude -p` run for each trial
```

## Prereqs (on the laptop)

- `flyctl` installed and `flyctl auth login` done.
- `unerr-terminal-bench/.env.local` present (live keys — pushed to the app as
  secrets by `set-secrets.sh`, values never printed).
- This checkout builds; `refresh-unerr-tgz.sh` produces the fresh dev tgz.

## Run one arm

```bash
ARM=unerr    MODEL=claude-sonnet-5 \
TASKS="terminal-bench/build-pmars terminal-bench/torch-tensor-parallelism" \
N=4 K=1 UPLOAD=public ./deploy-arm.sh
```

| Env | Default | Effect |
|---|---|---|
| `ARM` | `unerr` | `unerr` or `baseline` |
| `MODEL` | `claude-opus-4-8` | model under test |
| `TASKS` | `terminal-bench/build-pmars` | space-separated task ids (one `-i` each) |
| `N` | `4` | concurrency |
| `K` | `1` | trials per task |
| `UPLOAD` | `public` | `public` \| `private` \| `none` |
| `APP` | `ab-<arm>-<opus\|sonnet>` | Fly app name |
| `SKIP_REFRESH` | off | reuse the last `vendor/` tgz |
| `SKIP_SECRETS` | off | don't re-push secrets |

`N`/`K` are yours to change per run (defaults `-n 4 -k 1`).

## Smoke test (what to run first)

`./smoke-test.sh` runs exactly one arm — **unerr + sonnet** — on the two tasks
already run (`build-pmars`, `torch-tensor-parallelism`), `UPLOAD=none`. It proves
the pipeline works and prints the token/cost table to the Fly logs without
publishing anything.

```bash
./smoke-test.sh
flyctl logs -a ab-smoke-unerr-sonnet     # watch the run; token/cost summary at the end
```

The machine exits when done and stays `stopped` (logs remain queryable). Remove
it with `flyctl machine destroy <id> -a <app> --force`, or the app with
`flyctl apps destroy <app>`.

## Public-upload safety

`UPLOAD=public|private` publishes the whole job dir. Before any upload the
entrypoint scans the job dir for a leaked secret VALUE (Anthropic / Daytona /
Harbor key or `sk-ant-` pattern) and **aborts the upload** if one is found — the
run env carries live keys and a public link is world-readable. The smoke test
uses `UPLOAD=none`, so it never publishes.

## Files

| File | Purpose |
|---|---|
| `Dockerfile.ab` | orchestrator image (python + harbor + daytona SDK + A/B agent + tgz) |
| `entrypoint.sh` | run one arm → cost summary → secret-scan → optional upload |
| `summarize.py` | sum token usage from the job dir and price it (stdlib only) |
| `fly.ab.toml` | minimal per-arm app config (build-only) |
| `set-secrets.sh` | push `.env.local` keys onto an app (values hidden) |
| `deploy-arm.sh` | laptop driver: tgz → context → build → secrets → machine |
| `smoke-test.sh` | the one-arm sonnet/unerr smoke run on the two known tasks |
| `context/` | assembled build context (gitignored) |
