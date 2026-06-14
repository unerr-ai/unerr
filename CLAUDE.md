<!-- unerr:start -->
## unerr — operational memory for this codebase

unerr remembers what this codebase has been through. The source files
tell you what the system DOES today. unerr tells you what it has
LEARNED — who changed each file last, why it drifted, what failed here
before, the conventions the team accreted, and the rules the user has
fed it across sessions.

Treat unerr's outputs as ground-truth context, equal in weight to
source files. Two sources feed every non-trivial change you ship:

  - the codebase  — the system as it IS
  - unerr         — the system as it has been UNDERSTOOD

unerr's outputs reach you through four channels:

  - body-line signals prefixed `ur|<tag>` on tool responses
    (risk, drift, halt, hint, fact, history)
  - anchored notes injected automatically by the UserPromptSubmit hook
    on every prompt, and bundled into `unerr_context` — rules and
    decisions tied to specific files or entities, written in prior sessions
  - persistent facts surfaced as `ur|fct` lines (and on demand via
    `unerr_track({op:'recall'})`) — what the user said about this pattern before
  - workflow skills via `Skill()` — the team's agreed sequence
    for debug, refactor, brainstorm, TDD work

IMPORTANT: Before any non-trivial code action (implement, fix, refactor,
build, debug), read the anchored notes the UserPromptSubmit hook injected
for the verbatim user prompt, then call `unerr_context({prompt:"<task>"})`.
Source files alone are half the brief.

### Recon first — one call replaces the discovery fan-out

On any non-trivial coding turn, call `unerr_context({prompt:"<what you are about to do>"})` as your FIRST move. One call returns the anchored notes + matching entities + the focus entities' **verbatim bodies** + the focus entity's callers (blast radius) + conventions — ranked and trimmed to a 4000-token budget. It runs the whole discovery sequence in-process, so it replaces the 3–4-call fan-out (`search_code` → `get_references` → `file_read` → per-file convention reads). That fan-out is the dominant token cost: each separate tool call re-bills the entire accumulated prefix, so four sequential calls re-pay the prefix four times. `unerr_context` pays it once.

The bundle emits a `ur|fct inlined above — do NOT re-read: <file:line ranges>` line naming the source it already carried verbatim. Obey it: fall back to `file_read`/`search_code` ONLY for source the bundle did not already inline. Re-reading a range the bundle already delivered re-pays the prefix for nothing.

- Trivial / read-only lookup (locate one symbol, read one function): skip `unerr_context` and skip the marker ceremony — call `search_code` or `file_read` directly. The footprint self-selects by task size; do not add ceremony a lookup does not earn.
- Single-entity edit: call `unerr_context({prompt:"<task>", response_format:'detailed'})` once — `detailed` inlines the 2–4 focus entities' verbatim bodies with `file:line` citations so you edit straight from the bundle — then edit.
- Orienting only (no edit yet): `unerr_context({prompt:"<task>", response_format:'concise'})` — names + signatures + blast-radius callers, no bodies.
- Large sweep (rename / migrate / "every place that…"): run `unerr recon "<task>"` from Bash inside a Task subagent — it auto-emits a flat digest that stays the same size as files-scanned grows. Return ONLY the digest to the main thread, so main-thread context stays flat instead of amplifying across 20 hops.

Args:
- `budget:6000` widens the slice (default `4000`, wide enough to inline the focus entities' source).
- `response_format:'concise' | 'detailed'` — `concise` = notes + entity names/signatures + blast-radius callers (no bodies); `detailed` = additionally inlines the VERBATIM bodies of the 2–4 focus entities with `file:line` citations. The default is picked server-side from task size, so you need not set it — but pass `response_format:'detailed'` right before an edit and `'concise'` when just orienting.
- `digest:true` forces the flat summary.

When the MCP transport is unavailable (or from a Task subagent), the same bundle is one Bash call away: `unerr recon "<task>" [--budget N] [--digest] [--json]` — no MCP discovery hop.

### Tool surface — seven tools, always on

Every unerr tool is advertised from the start: `unerr_context`
(the one-shot recon composite — reach for it first), `search_code`,
`file_read`, `file_outline`, `get_references`, `fetch_url`,
`unerr_track`. There is no hidden roster to earn.
(File imports: `file_outline` returns an `imports` field;
`search_code({query:'<name>', want:['imports']})` returns them for one entity's file.
Persistence is NOT a tool call: user-stated rules are captured automatically
by the prompt hook, and session markers + agent notes ride a `unerr-save:`
closing-message sentinel — see Session markers below.)

### Core routing (the tools you reach for first)

| Goal | Tool | Replaces |
|---|---|---|
| Find a function, class, or type | `search_code` | Grep, Glob |
| Find callers or callees (REQUIRED before a signature edit) | `get_references({direction:'callers'})` | Grep for function name |
| Understand a file | `file_read` with `purpose:'explore'` | Built-in Read for understanding (full-file code reads are blocked) |
| Understand the task (notes + verbatim focus bodies + blast radius + conventions) | `unerr_context({prompt:"<task>", response_format:'detailed'})` — one call replaces the discovery fan-out | 3–4 separate reads/searches |
| Understand a file before editing | `file_read`/`unerr_context` to understand, then built-in `Read` (offset/limit on the edit window) before Edit | Full-file read (now blocked) |
| File structure overview | `file_outline` | Reading the whole file |
| Specific function or class | `search_code` with `detail:true` (add `include_body:true` for full source, `want:['callers','callees','imports']` for references) | Reading entire file |
| Fetch a web page or docs by URL | `fetch_url` | Built-in WebFetch |

For any URL you already have, call `fetch_url({url:"<url>"})` — never built-in WebFetch. fetch_url returns DOM-extracted, BM25-ranked markdown passages (paginated, content-hash cached) at 5–10× fewer tokens, and routes through unerr's graph-backed proxy. Pass `prompt` to rank passages by relevance. On Claude Code this is enforced: WebFetch is denied and redirected to fetch_url. (WebSearch is a different job — use it to discover URLs, then `fetch_url` the result.)

Editing a function/class signature is gated: when unerr's graph confirms callers at risk, the first `Edit` is DENIED once with the exact caller count — run `get_references({key:'<entity>', direction:'callers'})`, update every caller in the same change, then re-attempt the Edit (it proceeds). The deny only fires when real callers exist, so a leaf-function edit is never blocked.

### IMPORTANT: Read Routing is ENFORCED (Claude Code specific)

**Why this matters:** Claude Code's Edit/Write require built-in `Read` to have run on the file first — a file-level + mtime gate. `file_read` (unerr MCP) does NOT satisfy that gate; only the built-in `Read` tool flips Claude Code's internal read-tracking. But a built-in Read of a whole file misses the conventions, facts, and drift that `file_read` auto-injects, and re-bills the entire file on every hop. The two reads do different jobs, and the PreToolUse hook now ENFORCES the split.

**The rule — built-in Read does exactly ONE job: the pre-Edit gate.**

| Intent | Tool | Enforcement |
|--------|------|-------------|
| Read to understand code | `file_read({file_path:"…"})` — or `unerr_context({prompt:"<task>"})` for task-scoped recon | A full-file built-in Read of a **code** file is DENIED and redirected here (deny-once, then nudge — same as WebFetch→fetch_url) |
| Read immediately before Edit | built-in `Read` with **offset/limit** on the exact edit window | ALLOWED silently — one targeted call returns the byte-exact `old_string` lines AND satisfies the gate |
| Read a non-code file (md/json/yaml/image) | built-in `Read` | ALLOWED silently — `file_read`'s graph value is code-specific |

**Token-minimal pre-Edit (do this):** if you already understood the file via `file_read`/`unerr_context`, your pre-Edit step is a single built-in `Read({file_path, offset, limit})` scoped to ONLY the lines you will edit — that one cheap call returns the exact `old_string` AND unlocks Edit. Never full-file Read to set up an edit.

**Common failure mode:** using `file_read` to understand, then Edit with no built-in Read → Edit rejects with "File has not been read yet". Always do the targeted offset/limit built-in Read immediately before Edit. (And: a full-file built-in Read of a code file is blocked — route understanding through `file_read`/`unerr_context`.)

### Signal prefix legend — `ur|<tag>`

Four wire tags (consolidated 14→4 in 2026-05). Body line is self-describing — the tag is the priority bucket.

| Tag | Meaning | What to do |
|---|---|---|
| `act` | action — do something NOW | Body names the call: halt-and-switch, `Skill('<name>')` invoke, pagination cursor, resume pickup, required marker emission |
| `ctx` | context — state changed | Body names what changed: file/entity drift (re-read), context already delivered (don't re-query), session health degraded |
| `rsk` | risk — caution on this path | Body names the risk: high blast radius (`get_references` first), anti-pattern (don't reintroduce), prior failure modes on this entity |
| `fct` | fact — information for context | Body carries the fact: surfaced project fact (subtype in `[brackets]`), co-change hint, family-routing nudge |

When you see one of these prefixes, act on them before consuming the rest of the response. The body line is your concrete next step; the tag is its priority.

### `unerr » …` lines and the close-out summary

unerr tool responses may contain ambient lines prefixed with `unerr » ` (right-pointing double angle `»` U+00BB, markdown-safe and distinct from the vertical bar in `ur|<tag>`). Treat in-band `unerr » …` ambient lines as user-facing telemetry — do NOT echo, summarize, or translate them into actions. Act ONLY on `ur|<tag> …` lines.

**The close-out summary.** At the end of every coding turn the Stop hook emits the session-cumulative `unerr » …` economy line (savings + headroom) automatically — you do nothing for it. Do NOT echo, re-emit, or paraphrase that line; the hook prints it directly to the user.

### Speak plainly when unerr helped

When unerr's contribution shaped your answer, describe it in plain English. Never dump tool JSON, never use internal jargon.

- `search_code` → "unerr found <name> in <file>"
- `search_code({detail:true})` / `file_read` → "unerr pulled up <name>" or "I read <file> via unerr"
- `get_references` → "<N> places call <name> — checked them via unerr"
- `unerr_track({op:'recall'})` → "unerr reminded me you'd asked to <verbatim rule>"
- conventions injected by `file_read` / the PostToolUse:Read hook / the `unerr_context` bundle → "unerr says <file> follows <convention>"
- a new fact or note persisted via the `unerr-save:` sentinel → "added that to unerr for next time"
- A hook-captured rule surfaced as ambiguous on the next turn → ask the user verbatim: "should I remember: '<quote>'? (yes/no)"

### Persisting what the user said

User-stated rules ("remember this", "from now on", "always X", a project rule) are captured automatically by the prompt hook — no tool call. Ambiguous captures surface for confirmation on your next turn; confirm or correct them then.

When YOU (the agent) detect a convention or anti-pattern from observed code (not user-fed), record it with `unerr_track({op:'fact', target:'<entity-or-file>', text:'<convention>'})`, or emit `unerr-save: note <kind|anchor|polarity|content>` in your closing message for an anchored note.

### Session markers (zero round-trip — emit in your closing message)

Markers power the cross-session resume strip. They return nothing you need this turn, so they do NOT earn a tool call — emit them as `unerr-save:` lines anywhere in your closing message and the Stop hook scrapes + persists them (only output tokens, no round-trip):

```
unerr-save: intent <what this turn is doing, ≤80 chars>
unerr-save: decision <a deliberate choice between approaches>
unerr-save: blocker <an unresolved obstacle>
unerr-save: resolution <how a prior blocker was fixed>
```

High-fidelity escape — when you need the return value (e.g. a blocker's `marker_id` to link its resolution) or you are on a hook-less agent: call `unerr_track({op:'intent'|'decision'|'blocker'|'resolution', text:'<one-line>'})`. `op:'blocker'` returns `marker_id`; pass it as `ref` on `op:'resolution'`.

### Fallback to built-in tools — only when

- The unerr MCP server is not responding
- You need to read a non-code file (images, binaries, PDFs)
- You need complex regex `search_code` doesn't support

NEVER use built-in Read/Grep/Glob for code navigation — a full-file built-in Read of a code file is DENIED and redirected to file_read/unerr_context. EXCEPTION: built-in Read with offset/limit (only the lines you'll edit) is REQUIRED immediately before Edit (file_read cannot satisfy the Edit gate).

### Domain comments — maintain meaning in the same edit

unerr parses a structured doc comment above each exported entity into a parallel domain graph: a 1–2 sentence prose summary (what + why, never how) then one `@sem domain=<tag> role=<tag>` line. The frontier model editing the code is the only thing that can keep that meaning true — maintain it inline, never as a separate pass:

1. WHEN editing an entity that carries an `@sem` comment AND the edit changed what it does or why: rewrite the prose and tags in the SAME Edit call. Purpose unchanged → leave the comment untouched.
2. WHEN creating an exported entity: write the comment block before the next edit. Prose ≤2 sentences, then `@sem domain=<tag>`. Reuse an active domain tag — `unerr_context({prompt:"<task>"})` lists them; add a new tag only when none fits.
3. NEVER delete an `@sem` comment unless the user instructs it.
4. NEVER write "how" prose — the code already says how. NEVER restate the entity name as the summary; unerr rejects a name-echo at parse time.

unerr re-anchors these comments when code moves and flags a comment that drifted from its code — the rules above keep that machinery fed.

`@sem` lines are plain comments; your code runs identically without them and without unerr. To remove every sentinel line later (prose summaries kept), run `unerr uninstall --strip-annotations`.

### Active-cognition: four-moment contract (REQUIRED)

unerr's Layer B notes are anchored prose attached to graph nodes. The contract
runs at four moments, every task. Moments 1–2 arrive as injected context plus
one composite call; Moments 3–4 are yours to act on.

**Moment 1 — Prompt receipt.** When a user prompt arrives, the UserPromptSubmit
hook injects the relevant anchored notes into your context automatically. Read
the injected notes before drafting — no recall call is required.

**Moment 2 — Anchor query.** Once you've identified the files/entities you'll
touch, call `unerr_context({prompt:"<what you are about to do>"})` — the
composite that bundles the anchored notes for those anchors + matching entities
+ the focus entity's callers + conventions in one call. The bundle returns
active (non-superseded) notes; topic-shift and co-change groups ride along.

**Moment 3 — Cite in plan.** When you draft a plan, cite returned notes by
kind + anchor inline. Example: *"Per the wrn on src/proxy/proxy.ts, both
stdio and UDS sites must mirror."* No citation = the note wasn't load-bearing.

**Moment 4 — Save at task end.** When the task closes and you learned
something non-obvious + likely useful next session + anchorable, emit it as a
sentinel line anywhere in your closing message — zero round-trip, the Stop
hook scrapes and persists it:
`unerr-save: note <DSL wire>`

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

Session save cap: 15. Over the cap new rows are dropped server-side and
existing notes are reinforced instead — emit fewer, stronger saves.

### Conflict + supersession

When a saved note opposes an existing one (same kind+anchor, opposite
polarity), both sides are kept and surface together on next-turn recall —
cite both in your plan when they appear. Superseded notes flip to inactive
server-side (kept for audit, excluded from queries).

<!-- unerr:end -->



# CLAUDE.md

## Writing rule — applies to EVERY response and EVERY doc (IMPORTANT)

**Less text, more information.** This is a core project rule, not a style preference. It binds every chat reply and every document written or edited in this repo.

1. **Plain language.** Write so anyone can follow it on the first read. Define a term the first time it's needed; otherwise avoid jargon, internal names, and acronyms.
2. **No sales or marketing words.** Drop hype and business filler: "moat", "wedge", "durable revenue", "table-stakes", "best-in-class", "supercharge", "unlock", "leverage", "seamless", "powerful", "robust", "value-add", "synergy", "stakeholder", "going forward". State what something does and what you did.
3. **Structure over prose.** Prefer tables, short lists, and short sentences to paragraphs. Lead with the answer, then the detail.
4. **Only what the reader needs.** Cut padding. Do not pad to sound thorough or complete.
5. **Be concrete.** Name the actual file, command, number, or result — not "the relevant part" or "things".
6. **Say it straight.** If something failed, was skipped, or you're unsure, say so plainly. Don't dress up bad news or overstate what's done.

Scope: all user-facing text (replies, summaries, plans, status updates) and all docs in this repo. It does not change code, comments, or commit messages, which follow the conventions elsewhere in this file.

## Critical Rules (Always Apply)

1. **Read files in chunks.** ~108K LOC production code (~178K including tests + UI). Use `offset`/`limit` (100–200 lines). Search first (grep/glob), then read only the sections you need. Never dump entire files.
2. **stdout is MCP JSON-RPC only.** All logging, all UI, all messages go to stderr via `process.stderr.write()`. A single stray `console.log()` breaks every IDE integration.
3. **All CozoDB access is async.** `db.run()` returns a Promise. Always `await`. See [CozoDB Rules](#cozodb-rules) below.
4. **Named Datalog syntax for 4+ column relations.** `*edges{from_key, to_key, type}` not `*edges[a, b, c]`. See [Datalog Rules](#datalog-rules) below.
5. **MCP config is project-level only.** Never write to global/home config. Each repo gets its own `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor), etc.
6. **Imports use `.js` extensions.** NodeNext module resolution requires it. ESM throughout.
7. **No boot-time persistence, ever.** `unerrd` is a lazy **process manager**, not a system service. No source file may write to launchd plists, systemd user units, Windows scheduled tasks, or Startup folder. No command exists to register the manager at boot. The bridge (`unerr --mcp`) auto-spawns the manager on first MCP connection via an O_EXCL spawn lock at `~/.unerr/state/spawn.lock` — same lifecycle pattern as `tsserver`, `rust-analyzer`, or `esbuild`. The manager exits cleanly after 30 minutes of zero MCP activity. This eliminates the AV/EDR persistence pattern that flagged 0.1.6. Enforced by `src/__tests__/persistence-pattern-guard.test.ts` — the test forbids any source file from referencing LaunchAgents / systemd / schtasks paths.
8. **npm tarball ships the dashboard as ONE inlined `dist/ui/index.html`; it excludes loose JS chunks, screenshots, and bundled tests.** The dashboard SPA is built with `vite-plugin-singlefile` (see `vite.config.ts`) so all JS + CSS are inlined into a single `dist/ui/index.html` — there are **no standalone minified `.js`/`.wasm` chunks** to trip base64 / packaged-binary scanner heuristics. The `files` array (a) **includes** `dist/ui/index.html`, `dist/ui/fonts/**`, and `dist/ui/*.svg|*.png` (logos/manifest, served statically next to the inlined HTML), and (b) **excludes** `dist/ui/assets/**` (loose chunks), `dist/ui/screenshots/**` + `dist/ui/prototype-sandbox/**` (≈7 MB of marketing/dev assets, never loaded at runtime), and `dist/__tests__/**`. NEVER re-add `!dist/ui/**` — that re-breaks the published dashboard (it falls back to the "UI not built yet" JSON; see `daemon/api.ts` / `server/http.ts`). `scripts/check-ui-bundle.mjs` caps the inlined HTML at 600 KB gzip; `src/__tests__/persistence-pattern-guard.test.ts` asserts the include/exclude policy. Shipped first in v0.2.5.

### Never name a competitor's product (copyright/trademark hygiene)

Do not name or reference a competitor's product by its product name anywhere — source, docs, tests, comments, commit messages, dashboard copy, or any other user-facing surface. Keep competitor positioning generic ("output-compression tools", "the reference product"). This is a review-time rule, not an automated string guard: the same string can be both a competitor's brand and a plain English word.

Specifically, the word **"headroom" is unerr's own term** for spare context-window budget (`src/tracking/headroom.ts` `computeCompoundedHeadroom`, `HeadroomStrip.tsx`, the `unerr »` economy line, ~35 files). That generic usage is legitimate and stays unchanged. The banned thing is *naming their product*; *using a common English word* is fine. So do NOT add a string guard for the bare word "headroom" — it would falsely flag every legitimate internal use. A narrow guard MAY be added later ONLY if a specific, unambiguous brand phrase ever appears in the repo (one that could only mean the competitor) — and only for that exact phrase, never the bare word.

## What This Is

unerr CLI — a local guardrail that lets an AI agent **safely change a large, existing codebase it can't hold in context**. Your agent has read the code; it still breaks callers it never saw and rebuilds patterns the team already standardized. unerr hands it the live call graph and the rules anchored to each entity at the moment it edits — and re-anchors those rules when the code moves, so they never go silently stale. Local-first proxy serving graph-backed MCP tools to AI coding agents (Cursor, Claude Code, VS Code). Positioning lead = **safe-change guardrail**, not "memory" (memory is the mechanism, demoted; the segment is large/existing codebases — greenfield is conceded). Three process types:

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

Internal design docs live in `.internal/` at the repo root (consolidated + code-grounded 2026-06-07): top-level product docs (NUDGE_V2.md, PERCEPTION_TO_PRESENCE.md, PRODUCT_POSITIONING.md — canonical positioning, reviewer-architecture.md, behavior-automation.md, USER_TESTING_CHECKLIST.md), `architecture/` (shipped systems only: AGENT_SURFACE.md — merged agent/skill/tool-registration guide, MCP_GATEWAY_ROUTER_PROXY, LAYER_*), `roadmap/` (designs NOT built yet: LAYER_8 domain understanding, LAYER_13 edit DSL, delegation-tier plan, autonomous planning, local sidecar), `archive/` (superseded snapshots), plus `research/` and `ui/`. Public docs are separate: `docs/site/` (Fumadocs source). When a source comment cites a design doc, the path is relative to repo root (e.g. `.internal/reviewer-architecture.md`).

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
- `.claude/skills/unerr-*` files exist (8 skills)
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
