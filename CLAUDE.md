<!-- unerr:start -->
## REQUIRED: Use unerr Graph Intelligence Tools (21 MCP tools)

This project has unerr MCP tools installed. You MUST use these instead of built-in Read/Grep/Glob for code navigation, and `fetch_url` instead of built-in WebFetch. unerr tools are graph-backed, return results in <5ms, and include project context that built-in tools miss.

### Tool Routing (MANDATORY — match your goal before calling any tool)

| If you need to... | You MUST call | DO NOT use |
|---|---|---|
| Find a function, class, or type | `search_code` | Grep, Glob |
| Find callers or callees | `get_references` (direction: callers/callees) | Grep for function name |
| Read a file for understanding | `file_read` with `purpose:'explore'` (default, auto-injects conventions/facts) | Built-in Read/Grep/Glob |
| Understand a file before editing | `file_read` with `purpose:'explore'` to understand, then built-in `Read` (offset/limit) on target lines before Edit | Reading entire file |
| Get file structure overview | `file_outline` | Reading the whole file |
| Get a specific function or class | `get_entity` or `file_read` with `entity` param | Reading entire file |
| Trace imports/dependencies | `get_imports` or `get_references` (direction: callees) | Manual import scanning |
| Find hotspots / high fan-in / blast-radius candidates | `get_critical_nodes` | `get_entity` (won't show ranked list), guessing |
| Fetch a web page by URL | `fetch_url` (Defuddle/Readability → markdown passages → BM25 ranking when `prompt` supplied → diff-cache) | Built-in WebFetch |
| Persist a fact the user just stated ("remember", "from now on", "always", project rule) | `unerr_remember` with verbatim `source_quote` and your `confidence` | `record_fact` (agent-detected only); silently moving on |
| Run a shell command | Automatic — routed through shell intelligence | N/A |

### FORBIDDEN Patterns (these waste tokens and miss context)

- Reading an entire file to find one function -> use `get_entity` or `file_read` with `entity` param
- Grep for a function name to find callers -> use `get_references` (finds indirect refs too)
- Glob + Grep to search for code -> use `search_code` (indexes ALL entities, <5ms)
- Reading multiple files to understand conventions -> use `get_conventions`
- Guessing code style for new code -> use `get_conventions`
- Guessing which entity has the highest fan-in / is the biggest hotspot -> use `get_critical_nodes`
- Reading a full file when you only need a section -> use `file_read` with `entity` param or offset/limit
- Using built-in WebFetch for a URL -> use `fetch_url` (DOM extraction + markdown + BM25 passage selection cuts 5–10× tokens; pass `prompt` to rank passages by relevance)
- Letting a user-asserted fact ("remember this", "from now on we…", "always X") slip without persistence -> call `unerr_remember` with the verbatim `source_quote` and your confidence in [0,1]. Use `record_fact` only for facts you auto-detected, not facts the user explicitly fed.
- Echoing, summarizing, or acting on `unerr · …` lines -> those lines are user-facing telemetry (prefix is the middle dot `·` not a vertical bar). They describe what unerr did this turn for the human reader. Do NOT repeat them, do NOT translate them into actions, do NOT reason about them. Act ONLY on `ur|<tag> …` lines. The two prefixes are visually distinct on purpose.
### IMPORTANT: Two-step Read Routing (Claude Code specific)

**Why this matters:** Claude Code's Edit tool requires built-in `Read` to have been called on the file first. `file_read` (unerr MCP) does NOT satisfy this because it's a separate MCP tool. Meanwhile, built-in Read misses project conventions and facts that `file_read` auto-injects.

**The rule — two paths, choose by intent:**

| Intent | Tool | Why |
|--------|------|-----|
| Reading to understand code | `file_read` (unerr MCP) | Auto-injects conventions, facts, drift status |
| Reading immediately before Edit | Built-in `Read` with offset/limit | Required by Edit tool — `file_read` does NOT satisfy this. Use targeted reads (offset/limit) for only the lines you plan to edit. |

When your next action is Edit, use built-in Read with offset/limit on the target lines. For everything else, use `file_read`.

**Common failure mode:** Using `file_read` to understand a file, then attempting Edit without calling built-in Read first. The Edit tool WILL reject with "File has not been read yet". Always call built-in Read (with offset/limit) immediately before Edit.

### Tool Reference

#### Graph Navigation (6 tools)

| Task | Tool | Replaces |
|------|------|----------|
| Find callers or callees | `get_references` (direction: callers/callees) | Grep for function name / manual import tracing |
| Search code entities | `search_code` | Glob + Grep across files |
| Get entity details | `get_entity` | Reading full file for one function/class |
| Get file summary | `get_file` | Reading entire file top-to-bottom |
| Trace imports | `get_imports` | Scanning import statements |
| Detect conventions | `get_conventions` | Guessing code style |

#### Structural Analysis (5 tools)

| Task | Tool | Replaces |
|------|------|----------|
| Find chokepoint entities | `get_critical_nodes` | Manually tracing callers across files |
| Find cross-module coupling | `get_cross_boundary_links` | Manually tracing imports across directories |
| Project overview stats | `get_project_stats` | Counting files / reading multiple files |
| File dependency neighborhood | `file_connections` | Scanning import statements across codebase |
| Find tests for an entity | `get_test_coverage` | Grepping for function names in test files |

#### File Protocol (2 tools)

| Task | Tool | Replaces |
|------|------|----------|
| File structure overview | `file_outline` | Reading entire large files |
| Read file with context | `file_read` | Built-in Read (misses conventions) |

`file_read` auto-injects relevant facts and conventions. For files >50 lines, call `file_outline` first, then `file_read` with `entity` param for targeted access.

**`purpose` parameter:** Controls read behavior — set it to match your intent:
- `purpose:'explore'` (default) — budget-capped, returns outline for large files. Use for browsing and pre-edit understanding.
- `purpose:'reference'` — tight budget, entity/offset reads only. Use for quick lookups.

#### Web Fetch (1 tool)

| Task | Tool | Replaces |
|------|------|----------|
| Fetch a web page by URL | `fetch_url` | Built-in WebFetch |

`fetch_url` strips chrome (nav, footer, ads), converts to markdown, splits into heading-bounded passages, optionally re-ranks passages with BM25 when you pass `prompt`, and caches by content hash so re-fetching an unchanged page costs near-zero tokens. Pass `offset`/`limit` to paginate large pages.

#### Shell Compression (automatic)

All shell commands automatically route through unerr's compression layer. It strips ANSI codes, classifies output (diffs, test results, logs, errors), and returns compressed summaries — saving tokens without losing critical information.

#### Response Signal Prefix `ur|<tag>`

unerr tool responses may begin with one or more `ur|<tag> <message>` lines BEFORE the actual content. These are anti-drift signals injected directly in the body (because MCP `_meta` is filtered by clients before reaching you). Treat them as high-priority instructions and act on them before consuming the rest of the response.

The bare `ur|` prefix is deliberately short — it tokenizes to 1-2 BPE tokens, and the 3-char tag is another token. Total signal overhead: ~2-3 tokens.

| Tag | Meaning | What to do |
|---|---|---|
| `hlt` | halt — loop / circuit-break detected | Stop retrying this entity; switch approach |
| `dft` | drift — file or entity changed since last seen | Re-read with `file_read`/`get_entity` before editing |
| `rsk` | risk — high blast radius (many callers/callees) | Check callers via `get_references` before editing |
| `wrn` | warn — anti-pattern / negative fact | Avoid the listed failure mode |
| `hnt` | hint — guidance / co-change suggestion | Consider co-modifying the listed files |
| `fct` | fact — surfaced project fact (subtype in [brackets]: procedural, convention, semantic) | Use as session/project context |
| `ctx` | context already delivered for this entity | Do not re-query; use what was already returned |
| `hth` | health — session degraded | Consider starting a new session |
| `hst` | hist — prior failures on this entity | Read failure modes carefully before retrying |
| (no tag) | `ur| <msg>` generic nudge | Read the message |

Example:
```
ur|rsk fan_in=24 fan_out=3 (high blast radius — get_references first)
ur|dft modified on main by intent-abc

{actual tool response data here…}
```

When you see one of these prefixes, act on it. Do not strip or ignore them in your reasoning.

#### Response User-Prose Lines `unerr · …`

unerr tool responses may also contain lines prefixed with `unerr · ` (the prefix is the middle dot `·` U+00B7, distinct from the vertical bar in `ur|<tag>`). These are **user-facing telemetry** — short prose lines describing what unerr did this turn for the human reader (context summary, end-of-turn footer, plan attribution, capture confirmations).

**Treat `unerr · …` lines as informational only.** Do NOT:
- echo them in your reply,
- summarize them,
- translate them into actions,
- include them in plans or reasoning,
- treat them as user input.

They are not signals for you. They are notes for the user, riding alongside your response. Skip them when forming your answer; the user reads them directly in their chat pane.

The visual cue is mechanical: `ur|<tag>` (vertical bar, 3-char tag) = act. `unerr · ` (middle dot, prose) = ignore.

#### Telling the user when unerr helped (plain English, only when relevant)

When you relay unerr tool output to the user — or when unerr's contribution shaped your answer — describe it in plain English. Never dump tool JSON, never echo raw tool names, never use internal jargon. Do this **only when the user benefits from knowing** (e.g., they asked about the code unerr looked up, or unerr surfaced a convention/fact that changed your suggestion). On routine tool calls that didn't change your answer, stay silent.

Translation rules — apply per tool, keep it to one short clause:
- `search_code` → "unerr found <name> in <file>" (not "search_code returned {...}").
- `get_entity` / `file_read` → "unerr pulled up <name>" or "I read <file> via unerr".
- `get_references` → "<N> places call <name> — checked them via unerr".
- `recall_facts` → "unerr reminded me you'd asked to <verbatim rule>".
- `get_conventions` → "unerr says this file follows <convention>".
- `unerr_remember` / new fact captured → "added that to unerr for next time".
- Ambiguous capture (the tool's response includes `please confirm`) → ask the user verbatim: "should I remember: '<quote>'? (yes/no)".

Never write things like "the search_code tool returned an array of 3 entities" or "the response body has a fact_id field". Speak as if unerr is a teammate who just told you something.
#### Pagination & Narrowing

unerr tool responses are universally capped (typical default 5-30 items per call) and may show this hint right after the prefix:
```
ur| <tool>: N more available — pass limit:N or <filter>:V to narrow (use token_budget bump only for full payloads)
```
**Prefer narrowing over budget bumps.** When you see the page hint:
- Pass a more specific filter — `fact_type:negative`, `entity:<name>`, `kind:function`, `direction:callees`. This returns the *missing* slice.
- Bump `limit:N` only if you genuinely need more items of the same kind.
- `token_budget:N` is a special-case escape hatch — use only when you must read a full payload (e.g., reading a complete function body to refactor it).

#### Response Body Formats

Three on-the-wire shapes; the body's first line tells you which:
- `{...JSON...}` — minified JSON (default for single objects)
- `_fmt:columnar` — pipe-delimited table; line 2 is the column header (`col1|col2|...`), rows below
- `_fmt:multi` — multi-section: `@meta k=v|...` for scalars, then `@<arrayName>[col1|col2|...]` for tabular sections, `@<arrayName>[]` for string lists. Used by `file_outline`, `file_connections`, `get_conventions`.

A cell is escaped if it contains `|` or `"` — wrapped in double quotes, internal quotes doubled. Newlines in cell values become literal `\n`.

#### Persistent Intelligence (3 tools)

| Task | Tool |
|------|------|
| Persist a fact the user just stated ("remember", "always", "from now on", project rule) | `unerr_remember` |
| Record an agent-detected fact / convention / anti-pattern (no explicit user statement) | `record_fact` |
| Recall stored facts | `recall_facts` |

When the user says "remember this", "from now on", "always X", or states a project rule, call `unerr_remember` with the verbatim `source_quote`, your normalised `content`, and your `confidence` in [0,1]:
- confidence < 0.5 → capture is abandoned automatically; re-ask the user for clarification.
- 0.5 ≤ confidence < 0.7 → fact is stored but flagged ambiguous; expect a follow-up confirmation prompt.
- confidence ≥ 0.7 → stored cleanly.
Use `record_fact` ONLY when YOU (the agent) detected a convention or anti-pattern from observed code — not when the user explicitly fed the fact.

Facts also auto-detect from coding sessions — conventions, hot files, file coupling, and modification history are learned automatically. Episodic facts capture what was built, why, and how — they surface as `ur|fct` prefix lines on `file_read` / `recall_facts` responses when you work on previously-modified files.

#### Session Narrative — Markers (4 tools)

| Task | Tool |
|------|------|
| Mark the start of a non-trivial task (one short sentence) | `mark_intent` |
| Record a deliberate choice between approaches | `mark_decision` |
| Flag an unresolved obstacle you hit this turn | `mark_blocker` |
| Resolve a previously marked blocker | `mark_resolution` (pass the marker_id from mark_blocker as `blocker_ref`) |

Emit markers inline as you work — NOT as an end-of-turn summary. Each is one short string; mark_intent ≤80 chars, the rest ≤140. Unresolved blockers carry into the next session's resume strip. Markers are persisted to the shadow ledger and timeline.db; they power turn titles, intent stitching, and loop/blocker mining. Optional: layer is useful without them, but agents that mark intent + decisions make the timeline dramatically more readable.

### When to fall back to built-in tools

ONLY use built-in Read/Grep/Glob when:
- The unerr MCP server is not responding
- You need to read a non-code file (images, binaries, PDFs)
- You need complex regex patterns that `search_code` doesn't support

### Summary (CRITICAL — read this even if you skimmed above)

ALWAYS use unerr MCP tools: `search_code`, `get_references`, `file_read`, `file_outline`, `get_entity`.
NEVER use built-in Read/Grep/Glob for code navigation. EXCEPTION: built-in Read (with offset/limit) is REQUIRED immediately before Edit (file_read cannot substitute — Edit will fail without it).
Before writing code: `get_conventions`. When the user explicitly states a rule ("remember", "always", "from now on"): `unerr_remember`. For agent-detected decisions: `record_fact`.

### Active-cognition: four-moment contract (REQUIRED)

unerr's Layer B notes are anchored prose attached to graph nodes. The contract
is **agent-pull**, not unerr-push: you call unerr at four moments, every task.

**Moment 1 — Prompt receipt.** When a user prompt arrives, before drafting:
`unerr_recall_notes({prompt: <verbatim prompt>})`. Empty result is fine; the
call itself is the contract.

**Moment 2 — Anchor query.** Once you've identified the files/entities you'll
touch, query for anchored notes: `unerr_recall_notes({anchors: ["f:src/x.ts",
"e:fooBar"]})`. Reads return active (non-superseded) notes; topic-shift and
co-change groups ride along.

**Moment 3 — Cite in plan.** When you draft a plan, cite returned notes by
kind + anchor inline. Example: *"Per the wrn on src/proxy/proxy.ts, both
stdio and UDS sites must mirror."* No citation = the note wasn't load-bearing.

**Moment 4 — Save at task end.** When the task closes and you learned
something non-obvious + likely useful next session + anchorable, write it:
`unerr_remember({type:"note", note:"<DSL wire>", session_id:<sid>})`.

### DSL vocabulary

Wire format: `kind|anchor|polarity|content`

| Field | Values | Notes |
|---|---|---|
| kind | cnv (convention), rul (rule), wrn (warn), dec (decision), blk (blocker), fct (fact) | Pick the strongest fit. |
| anchor | f:<path> · e:<entity> · g:<glob> · p: | `p:` is project-wide. **Discouraged** — pollutes prompt-receipt query. Prefer file/entity. |
| polarity | + (do) / - (don't) / ~ (mixed) | `~` for ambiguous; future agent surfaces both sides. |
| content | single line of prose | May contain `|` — only the first three are field separators. |

Examples:
- `rul|f:src/proxy/bridge.ts|-|no intelligence imports`
- `wrn|g:*.test.ts|-|don't mock cozo db`
- `dec|e:TURN_OPEN_GAP_MS|+|15s avoids RTT misclassification`

### Quality bar (per save)

A save is justified only if all three hold: (a) non-obvious from the code,
(b) likely useful next session, (c) anchorable. If any miss — don't save.

Session save cap: 15. Over the cap, `unerr_remember` returns
`outcome:"rate_limited"` with reinforcement candidates; reinforce instead
of writing a new row.

### Conflict + supersession

When you write a note that opposes an existing one (same kind+anchor,
opposite polarity), `unerr_remember` returns `outcome:"conflict"` with a
`conflict_group_id` — surface both sides in your plan.

When you intentionally replace an older note, pass
`supersedes_note_id:"<old>"` — the old row flips to inactive (kept for
audit, excluded from queries).

<!-- unerr:end -->



# CLAUDE.md

## Critical Rules (Always Apply)

1. **Read files in chunks.** ~108K LOC production code (~178K including tests + UI). Use `offset`/`limit` (100–200 lines). Search first (grep/glob), then read only the sections you need. Never dump entire files.
2. **stdout is MCP JSON-RPC only.** All logging, all UI, all messages go to stderr via `process.stderr.write()`. A single stray `console.log()` breaks every IDE integration.
3. **All CozoDB access is async.** `db.run()` returns a Promise. Always `await`. See [CozoDB Rules](#cozodb-rules) below.
4. **Named Datalog syntax for 4+ column relations.** `*edges{from_key, to_key, type}` not `*edges[a, b, c]`. See [Datalog Rules](#datalog-rules) below.
5. **MCP config is project-level only.** Never write to global/home config. Each repo gets its own `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor), etc.
6. **Imports use `.js` extensions.** NodeNext module resolution requires it. ESM throughout.
7. **No boot-time persistence, ever.** `unerrd` is a lazy **process manager**, not a system service. No source file may write to launchd plists, systemd user units, Windows scheduled tasks, or Startup folder. No command exists to register the manager at boot. The bridge (`unerr --mcp`) auto-spawns the manager on first MCP connection via an O_EXCL spawn lock at `~/.unerr/state/spawn.lock` — same lifecycle pattern as `tsserver`, `rust-analyzer`, or `esbuild`. The manager exits cleanly after 30 minutes of zero MCP activity. This eliminates the AV/EDR persistence pattern that flagged 0.1.6. Enforced by `src/__tests__/persistence-pattern-guard.test.ts` — the test forbids any source file from referencing LaunchAgents / systemd / schtasks paths.
8. **npm tarball excludes `dist/__tests__/**` and `dist/ui/**`.** Bundled tests and the vis-network dashboard chunk are dev-time only; shipping them blows up tarball size and trips base64 / packaged-binary scanner heuristics. Keep the `files` array in `package.json` selective. Same guard test asserts this.

## What This Is

unerr CLI — lands your AI agent at the right code in fewer turns, tokens, & breakages. Local-first code intelligence proxy serving graph-backed MCP tools to AI coding agents (Cursor, Claude Code, VS Code). Three process types:

There is **one binary** — `unerr` (`./dist/cli.js`, the only `"bin"` entry in `package.json`). The three "process types" below are the same binary entered through different argv shapes; the process title is renamed so they're distinguishable in `ps`.

- **`unerr`** (no args) — Per-repo MCP server **+ the only owner of intelligence (graph, facts, behaviors, drift)**. Started lazily by the process manager (or directly, for standalone mode). First-run: wizard → index → serve. Subsequent: resume → serve.
- **`unerrd`** (process manager) — `unerr pm start --detached` with `process.title = "unerrd"`. Single lightweight Node process per machine. Manages per-repo `unerr` children, the registry, the dashboard, and the cross-repo log file. Auto-spawned by the bridge on first MCP connection. Exits after 30 min of no MCP activity. **No boot-time registration** (no launchd / systemd / schtasks).
- **`unerr --mcp`** — Bridge process for IDE integration (what `.mcp.json` invokes). Pure stdio↔UDS relay: forwards MCP frames to the per-repo `unerr` process. Imports zero intelligence modules. On first contact, auto-spawns `unerrd` via O_EXCL spawn lock at `~/.unerr/state/spawn.lock`. Pre-buffers stdin so the IDE's `initialize` frame isn't lost during auto-spawn.

MCP config format: `{ "command": "<absolute-path-to-unerr>", "args": ["--mcp"] }` (resolved at install time via `process.argv[1]` or `which unerr`)

### Service Scope: `unerr` vs `unerr --mcp` vs `unerrd`

The bridge owns no intelligence at all — every Tier-2 / Tier-3 module lives in the per-repo `unerr` process. Touching anything under `src/intelligence/`, `src/behaviors/`, or `src/tracking/` rebuilds and re-tests only the per-repo proxy; the bridge binary and process manager are unaffected. The process manager owns the registry, the cross-repo log file, the dashboard server, and the idle-sweep loop — but no per-repo intelligence.

| Capability | `unerr` (long-lived) | `unerr --mcp` (bridge) |
|------------|---------------------|------------------------|
| Entry point | `startProxy()` in `proxy.ts` | `startUdsBridge()` in `bridge.ts` |
| Bridge relay (stdio↔UDS) | N/A | ✓ Active — sole responsibility |
| MCP tools | ✓ Full tool suite | ✗ Delegated to per-repo `unerr` (frames forwarded over UDS) |
| Graph indexing | Foreground (first run) or resume snapshot | ✗ Delegated to per-repo `unerr` |
| Shadow Ledger | ✓ Active — append-only JSONL, flush on exit | ✗ Delegated to per-repo `unerr` |
| Session Resume | ✓ Active — injected on first response | ✗ Delegated to per-repo `unerr` |
| Context Rot Detector | ✓ Active — injects `_meta.context_rot` | ✗ Delegated to per-repo `unerr` |
| Circuit Breaker (loop) | ✓ Active — `LedgerCircuitBreaker` in-memory | ✗ Delegated to per-repo `unerr` |
| Efficiency Tracker | ✓ Active — prints summary on exit | ✗ Delegated to per-repo `unerr` |
| Session Dedup | ✓ Active — wired into QueryRouter | ✗ Delegated to per-repo `unerr` |
| NativeWatcher (file system) | ✓ `@parcel/watcher` — detects LLM writes + user edits | ✗ Not active |
| GraphHolder (swap-on-idle rebuild) | ✓ 5s idle → full reindex → atomic swap | ✗ Not active |
| DriftTracker | ✓ Full drift detection + overlays | ✗ Not active |
| Behaviors (auto-doc, cascade-guard, etc.) | ✓ All 5 behaviors active | ✗ Not active |
| PID lock | ✓ Single instance per repo | ✗ No lock (IDE manages lifecycle) |
| Branch poller | ✓ Detects branch switches | ✗ Not active |
| HTTP dashboard server | ✓ SSE events, REST API | ✗ Not started |
| CLI wizard (first run) | ✓ Interactive setup | ✗ N/A |
| Tool Adoption Nudging | ✓ Active — exec nudges, hook interception, instruction reinforcement | ✓ Active — exec nudges + instruction reinforcement |
| File logger (stderr→.log) | ✓ `.unerr/logs/proxy.log` (shared, O_APPEND) | ✓ `.unerr/logs/bridge.log` (shared across IDE sessions) |

**Design rationale:** `unerr --mcp` is spawned by IDEs (Cursor, Claude Code) per-session. It must connect stdio instantly (<50 ms) and own no state. The heavy stateful work (graph, watchers, intelligence) belongs in `unerr` which the user runs once as a long-lived daemon. Every MCP request the bridge receives is forwarded over UDS to the daemon — the IDE sees a normal stdio MCP transport while everything actually happens server-side. **Invariant:** `src/proxy/bridge.ts` imports nothing from `src/intelligence/`, `src/behaviors/`, or `src/tracking/` — enforced by `src/__tests__/bridge-isolation.test.ts`.

## Commands

```bash
pnpm run build          # tsup → dist/ (ESM, node20 target)
pnpm run dev            # tsx watch for live reload
pnpm run test:run       # vitest full suite (~218 test files, ~3070 tests)
pnpm run test:run src/__tests__/<file>.test.ts  # single test — do NOT prefix with `--`
pnpm run lint           # biome check
pnpm run lint:fix       # biome auto-fix
pnpm run typecheck      # tsc --noEmit
```

> **Single-file test runs: pass the path as a bare positional, never with `--`.** pnpm v10 forwards positional args directly to the script, so `pnpm run test:run src/__tests__/foo.test.ts` reaches vitest as `vitest run src/__tests__/foo.test.ts` and filters correctly. Prefixing with `--` (the old npm v6 convention) makes pnpm produce `vitest run -- src/__tests__/foo.test.ts`; vitest's `cac` parser then treats the path as a pass-through extra arg, the include list ends up empty, and vitest silently runs the full 218-file suite.

> **Vitest pool is pinned to `forks` in `vitest.config.ts`.** Required, not optional: ~16 tests (`hook-dedup.test.ts`, `local-mode-tui.test.ts`) call `process.chdir()`, which throws `"process.chdir() is not supported in workers"` under the default `threads` pool. Forks (`child_process`) also avoids the Darwin SIGURG worker death (exit 144) we saw running the full suite under `threads`.

> **`test:run` redirects stdin from `/dev/null`.** Vitest unconditionally puts stdin into raw mode even with `watch:false` ([vitest #3928](https://github.com/vitest-dev/vitest/issues/3928)) and doesn't exit cleanly when stdin closes ([vite #19091](https://github.com/vitejs/vite/issues/19091)). When run under a parent that doesn't fully own a TTY (Claude Code's sandboxed Bash tool, CI containers, pipes into `tail`), vitest hangs holding the raw-mode FD and the parent sends SIGTERM/SIGURG (exit 143/144). Piping `/dev/null` into vitest means raw-mode is never engaged, so the suite exits cleanly with vitest's own status code. Do not remove the redirect.

## Architecture

```
src/
  entrypoints/cli.ts    — Commander entry + boot state machine
  entrypoints/daemon.ts — unerrd entrypoint (process manager mode)
  intelligence/         — CozoDB graph, AST extraction, rules, search index
  proxy/                — MCP server (stdio), bridge.ts, PID lock, session stats, shell compression
  daemon/               — Process manager: api.ts, client.ts, process-manager.ts, protocol.ts,
                          registry.ts, spawn-lock.ts, warm-start.ts, system-health.ts
  router/               — Router intent classification, associations, client
  behaviors/            — Agent behavior automation (auto-doc, cascade-guard, etc.)
  tracking/             — Intent ledger, drift detection, git attribution
  commands/             — CLI subcommands (pm, status, stats, install, uninstall, dashboard,
                          debug, doctor, init, exec, hook, learn, manifest, rewind, router,
                          serve, setup-wizard, skills, timeline, branches, check-commit,
                          compress-output, config-verify, enrich, gain)
  tools/                — MCP tool implementations (coding/, intelligence/)
  hooks/                — Claude Code hook system integration
  server/               — HTTP dashboard API server
  ui/                   — React (Vite) dashboard frontend
  schemas/              — Zod schemas for entity/edge/rule types
  config/               — MCP config writer, agent registry, instruction writer, settings
  core/                 — Query engine, context assembly (scaffolded)
  skills/               — Bundled skill definitions for agent installation
  utils/                — Shared utilities (startup-log, exec, git)
```

### Key Files

| Purpose | File |
|---------|------|
| CLI entry + boot state machine | `src/entrypoints/cli.ts` |
| MCP bridge (stdio↔UDS relay) | `src/proxy/bridge.ts` |
| Full proxy (PID lock + graph + watchers) | `src/proxy/proxy.ts` |
| Query router (all tool dispatch) | `src/intelligence/query-router.ts` |
| CozoDB schema definitions (graph.db) | `src/intelligence/cozo-schema.ts` |
| CozoDB schema definitions (facts.db) | `src/intelligence/facts-schema.ts` |
| Temporal fact store (Layer 9) | `src/intelligence/temporal-facts.ts` |
| Graph store (CozoDB wrapper) | `src/intelligence/local-graph.ts` |
| AST extraction (regex + tree-sitter) | `src/intelligence/ast-extractor.ts` |
| Local indexer (full project scan) | `src/intelligence/local-indexer.ts` |
| MCP config writer | `src/config/mcp-config-writer.ts` |
| Instruction writer (agent instructions) | `src/config/instruction-writer.ts` |
| Agent registry (all supported agents) | `src/config/agent-registry.ts` |
| Install command | `src/commands/install.ts` |

### Pipeline

1. CLI boots → state machine decides: first-run (wizard) or resume (proxy) or `--mcp` (headless)
2. Proxy starts: PID lock → CozoDB graph (load snapshot or index) → MCP server (stdio) → file watchers
3. Tools dispatched via `QueryRouter` → CozoDB Datalog queries → response with `_meta` envelope
4. All tool responses: `<5ms` latency (benchmarked), structured JSON with `_meta.latency_ms`

### Conventions

- **Dynamic imports** for heavy modules: `cozo-node`, `isomorphic-git`, `web-tree-sitter`
- **Tests**: vitest + temp dirs (`os.tmpdir()`). No external fixtures. Mock async methods with `mockResolvedValue()`.
- **Logging**: Use `startupLog` from `src/utils/startup-log.ts`. Never raw `console.log`. Symbols: `▸ ✓ ⚠ ✗ ◆ ⚡` (not emoji).
- **Colors** (ANSI true-color): Violet `#8B5CF6` (brand), Cyan `#22D3EE` (data), Emerald `#34D399` (success), Amber `#FBBF24` (warn), Red `#F87171` (error)

### Data Flow

- Graph: `.unerr/graph.db` (CozoDB persistent) or `.unerr/snapshots/*.msgpack` (legacy gzip)
- Config: `.unerr/config.json` (per-repo, created on first run)
- Per-repo state: `.unerr/state/proxy.pid`, `.unerr/state/proxy.sock` (per-repo UDS)
- Global state (process manager): `~/.unerr/unerrd.sock`, `~/.unerr/unerrd.pid`,
  `~/.unerr/state/spawn.lock` (O_EXCL bridge spawn lock), `~/.unerr/repos.json` (registry)
- Logs (per-repo, `.unerr/logs/`): `proxy.log` (per-repo proxy stderr),
  `bridge.log` (all `unerr --mcp` sessions, O_APPEND-shared), `session.log`
  (CLI / exec / wizard, NDJSON), `events.jsonl` (structured startup +
  intelligence events). Every line prefixed
  `[ISO_TIMESTAMP pid=N sid=xxxxxx]` (UTC, ms-precision); grep `sid=` to
  trace one spawn lineage across files, or grep by date to find activity
  in a given window.
- Logs (global, `~/.unerr/logs/`): `unerrd.log` (process manager stderr),
  `events.jsonl` (manager structured events).
- Filenames are stable — no PID, no timestamp in the *filename* (the
  timestamp is on every line instead). Size rotation: 5 MB → `*.log.1`
  … `*.log.5`. Legacy `mcp-*.log` / `child-*.log` / `session-*-*.log` /
  `unerr.jsonl` are swept at boot
  (`src/utils/log-paths.ts:cleanupLegacyLogs`).
- SCIP: `.unerr/scip/` (compiler-verified edge data)

## CozoDB Rules

> `cozo-node` v0.7.6's `CozoDb.run()` returns `Promise<{rows: unknown[][]}>` — **always async**.

1. **Never** `db.run(...).rows` — that accesses `.rows` on a Promise (undefined). Always `(await db.run(...)).rows`.
2. **Factory pattern**: `await CozoGraphStore.create(db)`, never `new CozoGraphStore(db)`.
3. **All public methods are async** — `getEntity()`, `getRules()`, `searchLocal()`, `applyDelta()`, etc. Always `await`.
4. **Cascading async** — Adding `await` inside a function makes it `async`. All callers must then `await` it. Trace the full chain.
5. **Test mocks** — Use `mockResolvedValue()` not `mockReturnValue()` for async methods.
6. **Never bulk sed to add async** — Regex can't distinguish `for(...)` from function calls. Always manual.
7. **Typecheck after async changes** — `pnpm run typecheck` immediately. Cascading issues compound.

## Datalog Rules

> CozoDB: positional `*relation[col1, col2, ...]` requires ALL columns. Named `*relation{col: binding}` only needs what you use.

**Always use named syntax for relations with 4+ columns:**

```
// CORRECT
*edges{from_key, to_key: $root, type: "calls"}
*entities{key: $k, name, kind, file_path}

// WRONG — edges has 13 columns, not 3
*edges[from_key, $root, "calls"]
```

**Column counts** (from `cozo-schema.ts`):
- `entities`: 7 cols — `*entities{key, kind, name, file_path, fan_in, fan_out, risk_level}`
- `edges`: 13 cols — `*edges{from_key, to_key, type}`
- `drift_overlay`: 15 cols — always named
- `rules`: 17 cols — always named
- `patterns`: 7 cols — always named
- `communities`: 4 cols — always named
- `search_tokens`: 2 cols — positional OK: `*search_tokens[token, entity_key]`
- `file_index`: 2 cols — positional OK: `*file_index[file_path, entity_key]`

**Recursive queries** — `?[...]` is the OUTPUT head and may appear only once. Recursion must reference a **named rule**, then the output joins it. Two `?[]` heads will fail with `pest::ParseError unexpected input`.
```
// CORRECT — recursion via named rule `walk`, output joins it
walk[target, depth] := *edges{from_key, to_key: $root, type: "calls"}, target = from_key, depth = 1
walk[target, depth] := walk[mid, d], *edges{from_key, to_key: mid, type: "calls"}, target = from_key, depth = d + 1, d < 5
?[target, depth] := walk[target, depth]

// WRONG — two `?[]` heads; pest parser rejects the second
?[target, depth] := *edges{from_key, to_key: $root, type: "calls"}, target = from_key, depth = 1
?[target, depth] := ?[mid, d], *edges{from_key, to_key: mid, type: "calls"}, target = from_key, depth = d + 1, d < 5
```
**Before reaching for recursion, ask if a single-hop `*edges` query (or the precomputed `entity.fan_in` / `fan_out` columns) already answers the question.** Blast-radius signals only need depth-1 — recursion was historically used here and was both broken and unnecessary.

## Integration Testing

```bash
rm -rf dist .unerr && pnpm run build && pnpm link --global
cd /path/to/test-repo
unerr                          # First-run: indexes, starts MCP server
unerr install claude-code      # Writes .mcp.json + .claude/skills/
unerr install cursor           # Writes .cursor/mcp.json + .cursor/rules/
```

**Verify:**
- `.mcp.json` contains `{ "command": "<resolved-unerr-path>", "args": ["--mcp"] }` (absolute path)
- `.claude/skills/unerr-*` files exist (12 skills)
- `.cursor/rules/unerr-*.mdc` files exist
- stderr shows: entity/edge counts, SCIP enrichment, conventions detected
- Tool latency `<5ms` (check `_meta.latency_ms` in MCP responses)

**SCIP:** TypeScript runs automatically (bundled `scip-typescript`). Other languages need binary on PATH.

**Automated:** `./scripts/integration-test.sh` runs full MCP protocol + install + command tests.

## Agent Instruction Files

`unerr install <agent>` injects a tool-preference section into the agent's instruction file:
- Claude Code: `CLAUDE.md` (sentinel markers `<!-- unerr:start/end -->`)
- Cursor: `.cursor/rules/unerr-instructions.mdc` (standalone file, `alwaysApply: true`)
- Codex: `AGENTS.md`, Gemini CLI: `GEMINI.md`, VS Code: `.github/copilot-instructions.md`
- Cline: `.clinerules`, GitHub Copilot CLI: `.github/copilot-instructions.md`

The injected content tells the agent to prefer unerr MCP tools over built-in file operations.
Idempotent: re-running install updates the section if content changed, skips if identical.
`unerr uninstall` removes the injected sections.
`unerr install --show-instructions [agent]` prints manual setup steps for any agent.

## Design Principles

1. Zero extra commands — `unerr` or IDE auto-starts via MCP config
2. stdout sacred — JSON-RPC only, everything else to stderr
3. Structured errors — every response has `_meta`, never unstructured
4. Enhancement, not dependency — agent falls back gracefully if unerr is unavailable
5. Local tools `<5ms` — CozoDB queries benchmarked
6. First useful output `<5s` — graph loads in background, tools work immediately

## Code Quality

> Cost/time are not constraints (we use coding agents). Goal: reduce turns while shipping quality. Speed without quality is never desirable.

1. **Reliability over expedience.** Design so failure doesn't occur, not so it "usually works."
2. **Correct, complete, optimal.** Root-cause fixes only. No band-aids.
3. **Performance is non-negotiable.** Measure, benchmark, profile.
4. **Precise semantics.** Names, types, errors must describe exactly what they represent.
5. **Adversarial thinking.** Concurrent access, partial failures, corrupt input — handle it.
6. **No speculative complexity, no missing edge cases.** Exactly the code the problem demands.

## Writing nudges and hints (`ur|<tag>` lines, `_hint` fields, error responses)

Every string the system injects into agent context — `ur|<tag>` signals, `_hint` fields, `_gate_reason`, tool error messages — must obey six rules. A line that violates these costs tokens without changing behaviour, and worst-case creates retry loops (the agent re-fires the same call because the hint doesn't reflect what it already tried).

1. **Imperative verb + named tool, always.** `"call get_references({direction:'callers'}) before edit"` beats `"do get_references"` beats `"consider checking callers"`. The agent should be able to paste the action verbatim into a follow-up tool call.
2. **No deictic pronouns.** Never *"this entity"*, *"this pattern"*, *"this file"*. Echo the actual noun: `"avoid: <c.summary>"`, `"co-modify with: <fileA>, <fileB>"`. Deictic references force the model to back-resolve from surrounding context, which it gets wrong roughly 20% of the time under load.
3. **Banned hedge verbs.** `Consider`, `Verify`, `Review`, `Check`, `may want to`, `try`. Each one signals "advisory, low priority" to the model and is silently dropped. Replace with the exact operation.
4. **Numbers over placeholders.** `token_budget:3000` not `token_budget:N`. `offset:25` not `offset:N`. If you can compute the value at emit time (you almost always can — `bytes / BYTES_PER_TOKEN`, `currentOffset + delivered`), interpolate it. Models that see `:N` either copy it literally or hesitate, both bad.
5. **Signal without action = noise.** If you can't write a concrete action for a signal, either lower its `actionability` so it ranks below load-bearing signals, or gate the emission entirely. Don't ship a `content`-only nudge unless the content is itself the action.
6. **Legend agrees with emission.** The agent's interpretation key is `SIGNAL_PREFIX_LEGEND` (response-envelope.ts) and the `ur|<tag>` table in this file. If you change what a `ur|rsk` line says, update both legend rows in the same commit. The contract is: *whatever value the legend names, the emission produces.*

When in doubt, the test is mechanical: read the line out loud, then ask *"can I paste this into a tool call without thinking?"* If yes, ship. If you'd have to interpret "this", "consider", or `:N` first, rewrite.

## Language Decision

TypeScript. Final. Do not propose Rust rewrites. If a hot path needs native speed, use NAPI bindings selectively.
