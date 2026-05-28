# Architecture

unerr runs as **one local process per repo**, supervised by a single lightweight
machine-wide process manager (`unerrd`). The high-level runtime topology —
IDE → stdio bridge → process manager → per-repo process → dashboard — is
summarized in the "Under the hood" section of the
[README](../README.md#how-the-runtime-works). This document is the source-tree
map and module breakdown.

## Source tree

```
src/
  entrypoints/   CLI entry + boot state machine
  proxy/         Per-repo MCP server, stdio↔UDS bridge, session stats, shell compression
  daemon/        Process manager (unerrd) — registry, supervisor, spawn lock, HTTP API
  intelligence/  CozoDB graph, AST extraction, conventions, rules, search, semantic
  tracking/      Prompt ledger, drift detection, git attribution
  behaviors/     Cascade guard, loop breaker, auto-doc, change narrative…
  commands/      CLI commands (install, status, stats, pm, debug, …)
  tools/         MCP tool implementations (intelligence + coding)
  hooks/         Claude Code hook system integration
  skills/        8 bundled skill definitions
  server/ + ui/  HTTP API + React (Vite) dashboard
```

For day-to-day commands, code conventions, and the pre-PR checklist, see
[CONTRIBUTING.md](../CONTRIBUTING.md).
