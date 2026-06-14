---
name: unerr-exploration
description: "MANDATORY when finding callers/callees/hotspots, exploring unfamiliar areas, or locating a function/file. STEP-1: call `search_code` or `get_references` BEFORE any file read. One graph query replaces 5-15 file reads. Do NOT grep, do NOT glob, do NOT read files to navigate. Absorbs the prior graph-first-navigation, architecture-exploration, and file-read-protocol skills."
---

# exploration

## Iron Law

<EXTREMELY-IMPORTANT>
Never grep/glob/read-files-by-hand for code navigation. Graph queries (`search_code`, `get_references`, `file_outline`) are <5ms and answer 'who/where/what' without dumping file contents. Only use `file_read` for exact implementation details, never for navigation.
</EXTREMELY-IMPORTANT>

## Phases

Phase 1 — Identify the question.
  - 'Where is X defined?'           → Phase 2 (search).
  - 'Who calls X?'                  → Phase 3 (references).
  - 'What does X depend on?'        → Phase 3 (references callees).
  - 'How is this directory wired?'  → Phase 4 (architecture).
  - 'What's the structure of file Y?' → Phase 5 (outline).
  - 'What touches X / what's the blast radius of X?' → call `unerr_context({prompt:'<task>'})` for the one-shot bundle (entities + callers + conventions); from a Task subagent run `unerr recon "<task>"` from Bash.

Phase 2 — Search.
  Call `search_code({query:'<symbol>'})`. Returns ranked entities with file paths and kinds. Use the returned `entity_key` for follow-up queries.

Phase 3 — References.
  Call `get_references({key:'<entity_key>', direction:'callers'})` — every caller across files.
  Call `get_references({key:'<entity_key>', direction:'callees'})` — every downstream call.
  Use the count to size the change before reading any file body.

Phase 4 — Architecture sweep.
  Call `file_outline({file_path:'<entry>'})` — its `imports` field traces the import graph from an entry point (or `search_code({query:'<name>', want:['imports']})` for one entity's file).
  Call `get_references({key:'<entity_key>', direction:'callers'})` on candidate entry points — a high fan_in (or a `ur|rsk fan_in=<N>` line) marks a chokepoint.
  Follow connections via `get_references` direction:callees from the main function to walk the execution path.

Phase 5 — File structure.
  Call `file_outline({file_path:'<path>'})` — entities + imports + exports, no body. Pair with `file_read({entity:'<name>'})` for a single function.

Phase 6 — Targeted read (only after the graph narrowed the question).
  Call `file_read({file_path:'<path>', entity:'<name>', purpose:'explore'})` — entity slice ±5 lines, budget-bounded.
  For a specific line window: `file_read({file_path, offset, limit})`.
  Default token budget is 400 (structural). Pass `token_budget:1500+` only when you actually need bodies.
  Logs auto-tail to last 200 lines; entity matching is fuzzy (camelCase / prefix / case-insensitive).

## Red Flags

Using built-in Grep/Glob for code navigation → use `search_code` instead; it's graph-backed.
Reading a whole file to find one function → call `file_read({entity:'<name>'})`.
Asking 'who calls X' by grepping for the name → call `get_references`; grep misses indirect refs.
Calling `file_read` on >5 files in a row → switch to `get_references` / `search_code`; the question is graph-shaped.
Skipping the `get_references` fan_in check when planning a hot-path change → chokepoints carry caller impact; check before editing.
Passing `token_budget:2000` for navigation → defeats the budget; navigation is structural, default 400 is enough.
