# Contributing to unerr

Contributions are welcome. For anything bigger than a small fix, please open
an issue first so we can agree on the shape before you put time into it.

## Known limitation: the contracts submodule is private

This repo depends on a git submodule, `vendor/contracts`, which today points
at a **private** repository (`unerr-ai/unerr-contracts`). CI clones it using
a scoped GitHub App token that only this repo's own workflow has access to.

**Practical effect: a pull request from a fork cannot build, typecheck,
lint, or test locally until that submodule is public**, because your clone
has no credentials to fetch it. If you hit a permission error cloning
`vendor/contracts`, this is why — it isn't something wrong with your setup.
We're tracking making the contracts repo public; until then, say so in your
PR description if you couldn't run the full check suite locally, and CI will
still run the real checks on our side.

## Development setup

```bash
git clone --recurse-submodules https://github.com/unerr-ai/unerr.git
cd unerr
# If you cloned without --recurse-submodules:
#   git submodule update --init --recursive

pnpm install
pnpm run build:contracts   # builds vendor/contracts/dist — required before
                            # lint/typecheck/test; also gitignored, so a
                            # fresh checkout always needs this once
pnpm run build              # tsup → dist/ (ESM, node24 target)
pnpm link --global          # make local `unerr` available globally
```

Node `>=24` is required (`package.json` `engines.node`). We use pnpm; enable
it with `corepack enable` or install it globally.

## Day-to-day commands

```bash
pnpm run dev             # tsx watch — live reload
pnpm run test:run        # full vitest suite (~425 test files)
pnpm run lint             # biome check
pnpm run lint:fix         # biome auto-fix
pnpm run typecheck        # tsc --noEmit
```

### Running a single test file

```bash
pnpm run test:run src/__tests__/<file>.test.ts
```

Pass the path as a **bare positional** — never with a `--` prefix. pnpm v10
forwards positional args straight to the underlying script, so the command
above reaches vitest as `vitest run src/__tests__/<file>.test.ts` and only
runs that file. Adding `--` (the old npm v6 convention) turns it into
`vitest run -- src/__tests__/<file>.test.ts`; vitest's argument parser then
treats the path as a pass-through extra arg instead of a filter, the include
list ends up empty, and vitest silently runs the entire suite instead of
just your file.

## Before submitting a PR

```bash
pnpm run typecheck && pnpm run lint && pnpm run test:run
```

All three must pass. The full test suite is the source of truth for
cross-cutting changes — `pnpm test` is watch-mode and doesn't count as a
check.

## What CI runs

- **Every pull request and every push to `main`:** lint, typecheck, the full
  test suite, and a build. This is the `build-and-test` job in
  `.github/workflows/ci.yml`.
- **Release jobs (npm publish, binary builds, GitHub Release, Homebrew,
  Scoop) run only on a `v*` tag push.** They do not run on pull requests.
- **CodeQL** (`.github/workflows/codeql.yml`) scans on pull requests, pushes
  to `main`, and weekly, independent of the main CI workflow.

## Code conventions

A few rules that will save us both a review round:

- **`stdout` is sacred.** MCP JSON-RPC only on stdout. All logging, all UI,
  all messages go to `stderr` via `process.stderr.write()`. A single stray
  `console.log()` breaks every IDE integration.
- **All CozoDB calls are async.** `db.run()` returns a Promise. Always
  `await`. Public methods on `CozoGraphStore` are async — `await
  CozoGraphStore.create(db)`, never `new CozoGraphStore(db)`.
- **Imports use `.js` extensions.** NodeNext module resolution requires it.
  ESM throughout.
- **Named Datalog syntax for relations with 4+ columns.**
  `*edges{from_key, to_key, type}` not `*edges[a, b, c]`.
- **No boot-time persistence.** `unerrd` is a lazy process manager. No
  source file may register launchd / systemd / Windows scheduled tasks.
  Enforced by `src/__tests__/persistence-pattern-guard.test.ts`.
- **MCP config is project-level only.** Never write to global/home config.
  Each repo gets its own `.mcp.json` / `.cursor/mcp.json` / etc.

See [CLAUDE.md](./CLAUDE.md) for the full operational guide — architecture,
CozoDB query patterns, and conventions in more depth.

## What to work on

- Look at open issues tagged `good-first-issue` for entry points.
- For larger changes (new MCP tool, new behavior module, new language
  tier-1 support), open an issue first so we can align on the shape before
  you invest time.
- For architecture-level changes (proxy lifecycle, bridge isolation, daemon
  model), open an issue to talk through the design before sending a PR.

## Communication

- [Discord](https://discord.gg/JfZ4pYgb) for async questions and design
  discussion.
- GitHub Issues for bugs and feature requests.
- `unerr doctor` and `unerr status` output is the most useful context to
  include in a bug report.
