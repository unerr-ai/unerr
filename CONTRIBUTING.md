# Contributing to unerr

Contributions are welcome — please open an issue first to discuss what you'd like to change.

## Development setup

```bash
git clone https://github.com/unerr-ai/unerr.git
cd unerr
pnpm install
pnpm run build          # tsup → dist/ (ESM, node20)
pnpm link --global      # make local `unerr` available globally
```

## Day-to-day commands

```bash
pnpm run dev            # tsx watch — live reload
pnpm run test:run       # full vitest suite
pnpm run test:run src/__tests__/<file>.test.ts  # single test file (bare positional, never with --)
pnpm run lint           # biome check
pnpm run lint:fix       # biome auto-fix
pnpm run typecheck      # tsc --noEmit
```

## Before submitting a PR

```bash
pnpm run typecheck && pnpm run lint && pnpm run test:run
```

All three must pass. The full test suite is the source of truth for cross-cutting changes — `pnpm test` is watch-mode and doesn't count.

## Code conventions

A few rules that will save us both a review round:

- **`stdout` is sacred.** MCP JSON-RPC only on stdout. All logging, all UI, all messages go to `stderr` via `process.stderr.write()`. A single stray `console.log()` breaks every IDE integration.
- **All CozoDB calls are async.** `db.run()` returns a Promise. Always `await`. Public methods on `CozoGraphStore` are async — `await CozoGraphStore.create(db)`, never `new CozoGraphStore(db)`.
- **Imports use `.js` extensions.** NodeNext module resolution requires it. ESM throughout.
- **Named Datalog syntax for relations with 4+ columns.** `*edges{from_key, to_key, type}` not `*edges[a, b, c]`.
- **No boot-time persistence.** `unerrd` is a lazy process manager. No source file may register launchd / systemd / Windows scheduled tasks. Enforced by `src/__tests__/persistence-pattern-guard.test.ts`.
- **MCP config is project-level only.** Never write to global/home config. Each repo gets its own `.mcp.json` / `.cursor/mcp.json` / etc.

See [CLAUDE.md](./CLAUDE.md) for the full operational guide — architecture diagrams, CozoDB query patterns, signal-prefix legend, and the active-cognition four-moment contract.

## What to work on

- Look at open issues tagged `good-first-issue` for entry points.
- For larger changes (new MCP tool, new behavior module, new language tier-1 support), please open an issue first so we can align on the shape before you invest time.
- Architecture-level changes (proxy lifecycle, bridge isolation, daemon model) — open a discussion before a PR.

## Communication

- [Discord](https://discord.gg/JfZ4pYgb) for async questions and design discussion.
- GitHub Issues for bugs and feature requests.
- `unerr doctor` and `unerr status` outputs are the most useful debugging context to include in bug reports.
