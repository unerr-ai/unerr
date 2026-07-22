<!-- unerr:start -->
## unerr — the local runtime for your coding agents

unerr is the runtime layer behind this repo's agents: it serves the live call graph, the team's rules and conventions, and edit-time guardrails through MCP tools. Treat its output as ground-truth context, equal in weight to source files. Tools (all available from the start): `search_code`, `file_read`, `file_outline`, `file_edit`, `get_references`, `fetch_url`, `unerr_track`.

### Navigate code with unerr tools — not shell, not built-ins

Use unerr tools to read, search, or map code when they return graph data — not Bash (`cat`, `head`, `tail`, `sed`, `grep`, `rg`, `find`, `ls -R`) and not built-in Read / Grep / Glob. One graph query replaces 5–15 shell or file reads.

| To… | Use | Not |
|---|---|---|
| Find / search code | `search_code({query:"..."})` | `grep`, `rg`, `find`, Grep, Glob |
| Exact string / real regex across files (the one reason to grep) | `search_code({query:"<string-or-pattern>", mode:"literal"\|"regex"})` — each match returns with surrounding context lines, so no follow-up read | `grep`, `rg`, `rg -e` |
| Read a file or one function | `file_read({file_path})` (`entity:` for one symbol) | `cat`, `head`, `tail`, `sed`, Read |
| See a file's structure | `file_outline({file_path})` | `ls -R`, reading the whole file |
| Find callers/callees (REQUIRED before a signature edit) | `get_references({direction:'callers'})` | `grep` for the name |
| Rename / find EVERY use of an identifier (callers + strings + config + comments + routes) — ONE call, not a grep per path | `get_references({key:"<id>", include_text_occurrences:true})` then `file_edit` each site | `grep -r` / `rg -w` / `sed -i` / `perl -pi` the name |
| Change a file | `file_edit({file_path, old_string, new_string})` or `{content}` — no prior read needed | built-in Edit / Write |
| Fetch a URL or docs (bulk: `{urls:[...]}`) | `fetch_url` | built-in WebFetch |

Bash is for running things (build, test, git, package managers) — not for reading or searching code. (On Claude Code a full-file built-in Read of a code file is denied and redirected here.)

### Recon first — one call replaces the discovery fan-out

Before any non-trivial change, call `search_code` with a TASK PHRASE (`search_code({query:"add a retry to the boot path"})`). It returns a CODE-STRUCTURE recon bundle: the focus entity with its body (for a clear single-entity edit), its callers (blast radius), matching entities, and conventions. Anchored notes arrive automatically via prompt injection or explicitly via recall — they don't travel inside recon. For additional bodies, use `file_read({entity:'<key>'})`, `search_code({query, include_body:true})`, or pass the `cache_ref` from the response's `ur|cache-ref` marker for zero-recompute. A bare symbol (`search_code({query:"QueryRouter.dispatch"})`) returns ranked name matches.

`file_edit` has two modes: `{old_string, new_string}` (unique, or `replace_all:true`) or `{content}`. When a signature edit has at-risk callers, the response lists them inline (`ur|rsk … N caller(s) …`) — update them in the same change. You need not echo each edit — the Stop hook prints a "files changed" receipt (files + line counts).

Cross-repo (Pro): pass `scope:'workspace'` to query every registered sibling repo (results labeled by repo); `get_references({scope:'workspace'})` finds callers across repos; editing a path inside a sibling auto-routes to its graph.

### Use the semantic fields — not just the graph

Each search_code/file_read/callers entity carries `summary` (what it does), `domain` (code tier), `role` (responsibility) next to `fan_in`/callers. Read `summary` before pulling a body — skip the body read if it answers you. Triage callers by `domain`/`role`, not raw count — a `domain:routing` caller outranks a `domain:testing` one. Treat high `fan_in` + `role:entry-point` as a chokepoint → `get_references` before editing.

### Batch the work — one shot, not file-by-file (round-trips are the cost)

A round-trip carries input + output + latency, so the win is doing N items in one pass, not N passes.

1. **Bulk edits — climb this ladder, stop at the first rung that works:** (a) **one command for the whole set** — `prettier --write .`, a `sed`/codemod, a formatter, a build flag; run it once, not once per file. (b) **else one script** — write one small script that walks the files and makes the change in a single run. (c) **else a sub-agent loop** — hand the repetitive per-file edit to a sub-agent so it runs off your main thread (see below). NEVER loop your main thread file-by-file over mechanical edits — spawn sub-agents instead.
2. **Batch independent reads into ONE message.** When you need several files or several entities and the calls don't depend on each other, issue them as parallel tool calls in a single message — not one, wait, next. Better still, one `search_code({query:"<task>"})` recon bundle already returns several files' bodies + callers together; reach for it before fanning out `file_read`.
3. **Set `token_budget`/`limit` right the first time.** Reading at a small budget then re-reading bigger doubles the cost. Ask for what the task needs up front (e.g. `token_budget:3000` for a full function, `limit:25` for references) instead of read-small-then-re-read.

### Delegate by default — the main thread routes and consolidates, sub-agents do the work

Delegation is the default behavior, not something to ask permission for: spawn sub-agents immediately when a turn has delegable work — never ask, never announce intent to ask; the user never needs to say "use unerr sub agents." On any non-trivial turn the main thread is a routing-and-consolidation layer: plan the change, split off its delegable slices, hand each to a sub-agent, then review and integrate the returned diffs. Run as many sub-agents in parallel as the turn has independent slices — one per slice, no fixed cap. The worker tier (a capable mid-tier model) is the DEFAULT executor — route the majority of scoped coding to it, not just mechanical chores. What stays on the main thread is narrow: architecture / algorithm design, a new public interface, cross-cutting wiring, and bug root-causing — everything else is a slice to delegate:
- `Task({subagent_type:'unerr-junior', …})` — read-only investigation (find / trace / map X), web research & docs/API/changelog lookup, codebase Q&A (where / which / how), inventory & audit (find-all / list-all usages), log & error-output triage, bug reproduction (run repro, report — no edit), lint/format, docstrings/`@sem`, post-edit code review when unerr-reviewer is unavailable, security audits, git operations (branch/PR prep), benchmark/profiling runs, verify-runs (run typecheck + targeted tests + lint, return the failure list — no edits), shell-command runs (run a sequence of build/script/migration/setup commands, report the output).
- `Task({subagent_type:'unerr-worker', …})` — scoped feature implementation from a clear spec (add a flag, wire X into Y, implement a handler — the bulk of ordinary coding), add/improve tests, multi-site mechanical refactor (rename / extract / inline / move), codemods (one bulk find-replace across many files), caller/import propagation (update every call site + import after a signature change), typecheck/build-error fixes (fix tsc/build errors mechanically, re-run until green), scaffold (generate a new file's skeleton from a sibling template), dependency upgrades, migration scripts.
Tier by reasoning, not by size: scoped execution — even across many files — stays with the worker. Escalate to the senior only when the change needs novel design judgement (a new algorithm, architecture, or public interface) or root-causing a bug; deterministic mechanical breadth (codemods, caller propagation, renames) stays with the worker regardless of file count.

On any long or multi-step task — 2+ steps, whether the steps run in parallel or one after another — call `TaskCreate` for each step before the first edit, unprompted, never wait to be asked; mark a step `in_progress` when you start it and `TaskUpdate` it completed as it lands, so the tracker mirrors live progress. When steps are independent slices, fan out one `unerr-worker`/`unerr-junior` sub-agent per slice in parallel via `Task`; sequential steps stay tracked the same way. Clear or complete the tracker at turn end.

Group related work first, then spawn one sub-agent per independent group in a SINGLE message so they run in parallel. The sub-agents have the full graph tools — they re-derive the edit sites from `search_code` / `get_references`, so give them the task plus a one-line pointer, never pasted code or a list of files. Review each result before building on it. (Hosts without sub-agents — anything other than Claude Code / Codex / Cursor / Copilot CLI — do it inline.)

### Signals — `ur|<tag>` lines on tool responses

Act on these before the rest of the response; the body line is your concrete next step.

| Tag | Meaning | Do |
|---|---|---|
| `act` | do something now | The body names the call (halt-and-switch, `Skill('<name>')`, pagination cursor, marker to emit) |
| `ctx` | state changed | Re-read drifted file/entity; don't re-query context already delivered |
| `rsk` | caution | High blast radius → `get_references` first; anti-pattern; prior failure on this entity |
| `fct` | a fact for context | Surfaced project fact, co-change hint, family-routing nudge |

Lines starting `unerr » ` are user-facing telemetry — never echo or act on them. When unerr shaped your answer, say so plainly ("unerr found <name>", "<N> places call <name>") — never dump tool JSON.

### Session journal (zero round-trip)

When the user states a durable rule ("remember", "always", "never", "from now on"), a hook nudge fires — write the rule verbatim into this repo's CLAUDE.md (or the agent's instruction file) immediately; unerr does not store user rules.

unerr keeps a dated journal of each session — a plain audit trail (plus dashboard analytics when signed in). It is NOT memory: every entry is written as history, never asserted as present truth. Emit journal lines in your closing message (the Stop hook persists them):

```
unerr journal - goal - <what this turn does, ≤80 chars>   (REQUIRED first on coding tasks)
unerr journal - decided - <a deliberate choice>
unerr journal - stuck - <an obstacle>
unerr journal - fixed - <how the obstacle was resolved>
```

When you need a return value (a blocker's `marker_id`), call `unerr_track({op:'intent'|'decision'|'blocker'|'resolution', text:'<one-line>'})` — the tool API keeps the internal op names.

### Fallback to built-ins / Bash for code — only when

unerr MCP is unavailable (not responding / erroring) · a non-text binary (image, PDF) · search_code or get_references reports no graph — switch to built-in Read / Grep / Glob for the rest of the session and stop calling unerr navigation tools.

### Domain comments — maintain meaning in the same edit

unerr parses a structured doc comment above each exported entity into a parallel domain graph: a 1–2 sentence prose summary (what + why, never how) then one `@sem domain=<tag> role=<tag>` line. The frontier model editing the code is the only thing that can keep that meaning true — maintain it inline, never as a separate pass:

1. WHEN editing an entity that carries an `@sem` comment AND the edit changed what it does or why: rewrite the prose and tags in the SAME Edit call. Purpose unchanged → leave the comment untouched.
2. WHEN creating an exported entity: write the comment block before the next edit. Prose ≤2 sentences, then `@sem domain=<tag>`. Reuse an active domain tag — a task-shaped `search_code({query:"<task>"})` lists them; add a new tag only when none fits.
3. NEVER delete an `@sem` comment unless the user instructs it.
4. NEVER write "how" prose — the code already says how. NEVER restate the entity name as the summary; unerr rejects a name-echo at parse time.

unerr re-anchors these comments when code moves and flags a comment that drifted from its code — the rules above keep that machinery fed.

`@sem` lines are plain comments; your code runs identically without them and without unerr. To remove every sentinel line later (prose summaries kept), run `unerr uninstall --strip-annotations`.

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
7. **No boot-time persistence, ever.** `unerrd` is a lazy **process manager**, not a system service. No source file may write to launchd plists, systemd user units, Windows scheduled tasks, or Startup folder. No command exists to register the manager at boot. The bridge (`unerr --mcp`) auto-spawns the manager on first MCP connection via an O_EXCL spawn lock at `~/.unerr/state/spawn.lock` — same lifecycle pattern as `tsserver`, `rust-analyzer`, or `esbuild`. Each per-repo `unerr` proxy idles out after 30 minutes of zero MCP activity (`DEFAULT_IDLE_TIMEOUT_S=1800`, swept by the manager's idle loop); the manager itself is lazily spawned, carries no boot-time registration, and runs until `unerr pm stop` (no manager self-idle-exit exists in code today). The lazy-spawn + no-boot-registration is what eliminates the AV/EDR persistence pattern that flagged 0.1.6. Enforced by `src/__tests__/persistence-pattern-guard.test.ts` — the test forbids any source file from referencing LaunchAgents / systemd / schtasks paths.
8. **The dashboard UI is archived; the tarball ships no UI.** The React SPA was moved to `archive/ui/` (with its `vite.config.ts` and `check-ui-bundle.mjs`) and is no longer built or shipped. There is no `build:ui` step, no `vite` toolchain in `devDependencies`, and no `dist/ui/**` entry in the `package.json` `files` array. The only HTTP surface is the process manager's single endpoint `GET /api/pm` (process info) in `src/daemon/api.ts`; the per-repo dashboard HTTP server (`src/server/`) and all its routes were deleted. `src/__tests__/persistence-pattern-guard.test.ts` asserts no `dist/ui` entry reappears in the tarball. Do NOT re-add a UI build, a `dist/ui` files entry, or a second HTTP endpoint without an explicit decision to un-archive the dashboard.

### Never name a competitor's product (copyright/trademark hygiene)

Do not name or reference a competitor's product by its product name anywhere — source, docs, tests, comments, commit messages, dashboard copy, or any other user-facing surface. Keep competitor positioning generic ("output-compression tools", "the reference product"). This is a review-time rule, not an automated string guard: the same string can be both a competitor's brand and a plain English word.

Specifically, the word **"headroom" is unerr's own term** for spare context-window budget (`src/tracking/headroom.ts` `computeCompoundedHeadroom`, `HeadroomStrip.tsx`, the `unerr »` economy line, ~35 files). That generic usage is legitimate and stays unchanged. The banned thing is *naming their product*; *using a common English word* is fine. So do NOT add a string guard for the bare word "headroom" — it would falsely flag every legitimate internal use. A narrow guard MAY be added later ONLY if a specific, unambiguous brand phrase ever appears in the repo (one that could only mean the competitor) — and only for that exact phrase, never the bare word.

## What This Is

unerr CLI — a local guardrail that lets an AI agent **safely change a large, existing codebase it can't hold in context**. Your agent has read the code; it still breaks callers it never saw and rebuilds patterns the team already standardized. unerr hands it the live call graph and the rules anchored to each entity at the moment it edits — and re-anchors those rules when the code moves, so they never go silently stale. Local-first proxy serving graph-backed MCP tools to AI coding agents (Cursor, Claude Code, VS Code). Positioning lead = **safe-change guardrail**, not "memory" (memory is the mechanism, demoted; the segment is large/existing codebases — greenfield is conceded). Three process types:

There is **one program** — `unerr`. It ships as a **self-contained native binary** per platform built with `bun build --compile` (no Node needed). Every channel delivers that same binary: curl\|bash, Homebrew, and Scoop download it directly; **npm** (`@unerr-ai/unerr`) is the esbuild-style binary wrapper — a shim package whose `optionalDependencies` are five per-platform packages (`@unerr-ai/unerr-<os>-<arch>`) that carry the binary, launched through a thin Node shim (`packaging/npm/wrapper/bin/unerr.js`). `npm install -g @unerr-ai/unerr` is unchanged for users but no longer ships `dist/cli.js`. The three "process types" below are the same program entered through different argv shapes; the process title is renamed so they're distinguishable in `ps`.

**Native binary distribution.** Built by `scripts/build-binary.ts` (`pnpm run build:binary -- --target <os>-<arch>`) → `dist/bin/unerr-<os>-<arch>`. Targets: darwin x64/arm64, linux x64/arm64 (glibc), windows-x64. NOT musl or win-arm64 (no cozo prebuild — unsupported on every channel, including npm). The native pieces (cozo-node + @parcel/watcher addons, tree-sitter `.wasm`) are embedded via a generated `src/intelligence/embedded-natives.ts` (committed as an inert stub; the build script fills it, compiles, then restores it). Build kind is selected by the `__UNERR_BINARY__` define — `false` under tsup (folds out the embed branches; keeps loading cozo-node/@parcel/watcher from `node_modules`), `true` under the Bun compile. All self-spawn goes through `src/utils/self-spawn.ts` (`spawnUnerr`/`forkUnerr`) so a child process re-execs the binary, not `node dist/cli.js`. unerr-cli is PRIVATE, so binaries are published to the PUBLIC `unerr-ai/unerr` Releases; curl\|bash, Homebrew, and Scoop download from there, and the install scripts are served from that repo's raw `main` URL. Reference: `.internal/docs/01-base-system/08-DISTRIBUTION-PACKAGING.md` (original plan archived at `.internal/archive/NATIVE_BINARY_DISTRIBUTION.md`); user setup: `INSTALL.md`. CI: the single tag-based `.github/workflows/ci.yml` (npm publish/promote + binary build + public Release + brew/scoop).

- **`unerr`** (no args) — Per-repo MCP server **+ the only owner of intelligence (graph, facts, behaviors, drift)**. Started lazily by the process manager (or directly, for standalone mode). First-run: wizard → index → serve. Subsequent: resume → serve.
- **`unerrd`** (process manager) — `unerr pm start --detached` with `process.title = "unerrd"`. Single lightweight Node process per machine. Manages per-repo `unerr` children, the registry, the dashboard, and the cross-repo log file. Auto-spawned by the bridge on first MCP connection. Sweeps idle per-repo children out after 30 min; the manager itself runs until `unerr pm stop` (no manager self-idle-exit). **No boot-time registration** (no launchd / systemd / schtasks).
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

## Shared wire contracts (`@unerr-ai/contracts`)

Everything that crosses the CLI↔cloud wire — event / trace / sync / fleet body schemas, batch & text caps, schema versions — is defined ONCE in the shared package `@unerr-ai/contracts` (oRPC `@orpc/contract` + zod 4). The golden source is `github.com/unerr-ai/unerr-contracts`. Both this repo and `unerr-web-service` consume the same package: the CLI builds wire bodies from it, the web-service implements `cliContract` from it server-side. There is no second copy of a wire shape anywhere — adding one is the thing this section forbids.

- **Wired here as a submodule, not an npm install.** Git submodule at `vendor/contracts`, pinned by commit; `package.json` dep `"@unerr-ai/contracts": "link:vendor/contracts"`. The CLI imports only the zod-only subpaths — `/ingest`, `/events`, `/review`, `/fleet`, `/account`. **Never import `/api`** (it exports `cliContract` and needs `@orpc/contract`, which is web-service-only).
- **Build order matters.** `pnpm run build:contracts` runs first in `build`. The submodule's `dist/` is gitignored, so a fresh checkout / CI must build the contract before the CLI. tsup auto-externalizes `dependencies`, so `noExternal: ["@unerr-ai/contracts"]` in `tsup.config.ts` **force-inlines** the contract into `dist/cli.js`. This is load-bearing: the contract is `restricted` on GitHub Packages and the CLI ships to public npm, so it MUST be inlined. Verify after any build change: `grep -c "@unerr-ai/contracts" dist/cli.js` must print `0`.
- **Single-source rule (enforce at review).** Any constant or schema on the wire is imported from the contract, never re-declared in CLI code. To add a wire field or event: add it to the contract first (additive SchemaVer bump — `MODEL-REVISION-ADDITION`), bump the submodule pointer, then consume. Do not hand-build a wire body shape or copy a cap into CLI code.
- **Cross-repo change order (mandatory for ANY CLI↔web-service change).** A wire change touches three repos in a fixed order — never edit both sides at once. (1) Land the shape in `@unerr-ai/contracts` first (zod-only subpath for CLI→server bodies; `/api` `cliContract` reusing the same zod for server-only read/triage/sync — never a second copy). (2) **Commit + push it to the contract repo's `main` and publish the version** before any consumer changes. (3) CLI bumps the `vendor/contracts` submodule pointer, `pnpm run build:contracts`, verify inlined (`grep -c "@unerr-ai/contracts" dist/cli.js` → `0`). (4) **unerr-web-service pulls the same published version and rebuilds BEFORE making its server-side change.** (5) Only then do CLI (producer) and web service (consumer/validator) implement against the shared shape. (6) GitHub App changes (web-service backend) come last. Tier gating reads the central source `src/cloud/tier-model.ts` (plan strings + `LIMIT_KEYS`); add a CLI gate in `src/cloud/entitlements.ts` modeled on `canSyncRecall`, never a parallel plan notion. Full plan: `.internal/reviewer-architecture.md` §16.5.1.
- **No firewall, no identity in the contract.** The contract carries zero HR-2 firewall logic; the server enforces HR-2 and the CLI keeps its client-side `sanitizeDetail` pre-filter (`src/cloud/drainers/envelope.ts`). Identity (org/user) is resolved from the token and never appears in a request body.
- **Validation seam (single-source on emit, DONE 2026-06-16).** Constants (schema versions + caps) AND body shapes are now single-source. Every `StreamDrainer` declares `schema?: ContractSchema`; `drainStream` (`src/cloud/push-drainer.ts`) validates each built row against its `@unerr-ai/contracts` record (`IngestEvent`, `TranscriptRecord`, `LedgerRecord`, `RouterRecord`, `SessionRecord`, `FactCreate`, `TimelineRecord`, `DriftRecordInput`) BEFORE push — per-element, so one bad row drops and the rest ship. Fleet bodies validate via `validateBody` (non-blocking). Fail mode: drop + `startupLog` warn in prod, **throw under `UNERR_CONTRACT_STRICT=1`** in tests. The helper is `src/cloud/drainers/validate.ts` (`validateRows` / `validateBody` / `ContractSchema`). Limit: `/events` + `/traces` `detail` is a `looseObject`, so an extra/renamed `detail` key is NOT caught (review concern). The CLI zod and the contract's vendored zod are different installs — `validate.ts` types on a structural `ContractSchema` (`safeParse` only), not zod's `ZodType`. Regression guard: `src/__tests__/contract-single-source.test.ts`. Reference: `.internal/docs/01-base-system/09-WIRE-CONTRACTS.md` (original tracker archived at `.internal/archive/CONTRACTS_SINGLE_SOURCE.md`).

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

Internal design docs live in `.internal/` at the repo root. A reconciliation in progress is consolidating them into `.internal/docs/` by feature category (`01-base-system/` … `05-roadmap/`), each doc re-grounded against current code; see `.internal/docs/README.md` and `.internal/docs/01-base-system/_CONSOLIDATION_PLAN.md`. Three categories are done: **base-system** (`01-base-system/`, 12 docs), **graph** (`02-graph/`, 7 docs), and **telemetry/insights** (`04-telemetry-insights/`, 4 docs). They supersede the old `LAYER_0_FOUNDATION`, `LAYER_12_PROCESS_MANAGER`, `MCP_GATEWAY_ROUTER_PROXY`, `AGENT_SURFACE`, `COMMAND_SURFACE`, `LOGGING_ARCHITECTURE`, `LOGIN_UX_STRATEGY`, `TIER_ENFORCEMENT_PLAN`, `AUTO_UPDATE_STRATEGY`, `NATIVE_BINARY_DISTRIBUTION`, `CONTRACTS_SINGLE_SOURCE`, `TELEMETRY_AND_EVENTS_ARCHITECTURE`, `LAYER_10_TOKEN_FLOW_OBSERVABILITY`, `TOKEN_ECONOMICS_AND_SAVINGS`, `LAYER_7_UI_DASHBOARD_SSE` (the local dashboard — now dead code), `LAYER_1_INDEXING`, `LAYER_2_GRAPH_INTELLIGENCE`, `LAYER_8_DOMAIN_UNDERSTANDING` (shipped, despite its "NOT BUILT" header), `CROSS_REPO_INTELLIGENCE`, `ui/code-intelligence` (dead — the graph-explorer UI was deleted), all moved to `.internal/archive/` (see `.internal/archive/README.md` for the old→new map). Code comments tagged `CROSS_REPO_INTELLIGENCE Sprint X` or `LAYER_8_DOMAIN_UNDERSTANDING.md §X` point at the archived copies. Not-yet-reconciled docs still live at the old paths: top-level product docs (NUDGE_V2.md, PERCEPTION_TO_PRESENCE.md, PRODUCT_POSITIONING.md — canonical positioning, reviewer-architecture.md, behavior-automation.md, USER_TESTING_CHECKLIST.md), `architecture/` (remaining LAYER_* feature docs + SESSION_TIMELINE), `roadmap/` (designs NOT built yet: LAYER_13 edit DSL, delegation-tier plan, autonomous planning, local sidecar, contract inference, builder-insights), `archive/` (superseded snapshots). Public docs live in a separate repo, `unerr` (Fumadocs source) — they are no longer in this repo. When a source comment cites a design doc, the path is relative to repo root (e.g. `.internal/reviewer-architecture.md`).

### Key Files

| Purpose | File |
|---------|------|
| CLI entry + boot state machine | `src/entrypoints/cli.ts` |
| MCP bridge (stdio↔UDS relay) | `src/proxy/bridge.ts` |
| Full proxy (PID lock + graph + watchers) | `src/proxy/proxy.ts` |
| Query router (all tool dispatch) | `src/intelligence/query-router.ts` |
| CozoDB schema definitions (graph.db) | `src/intelligence/cozo-schema.ts` |
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

- **Dynamic imports** for heavy modules: `cozo-node`, `@parcel/watcher`, `web-tree-sitter`
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
  timestamp is on every line instead). Date-based rotation: on local-day
  change the `.log` rolls to `*.log.YYYY-MM-DD.gz`, kept for
  `DEFAULT_RETENTION_DAYS=7` (`src/utils/log-rotation.ts`); NDJSON files rotate
  by line count (2000 → keep 1000). No size-based rotation. Legacy
  `mcp-*.log` / `child-*.log` / `session-*-*.log` /
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
- `entities`: 13 cols — name only what you use, e.g. `*entities{key, kind, name, file_path, fan_in, fan_out, risk_level}` (full set: key, kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level, community, is_test). `purpose`/`taxonomy`/`feature_area` are NOT here — they live in the separate `justifications` relation.
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
