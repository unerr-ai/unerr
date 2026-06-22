<!-- unerr:start -->
## unerr — operational memory for this codebase

unerr serves this repo's live call graph + the team's rules, notes, and conventions through MCP tools. Treat its output as ground-truth context, equal in weight to source files. Tools (all available from the start): `search_code`, `file_read`, `file_outline`, `file_edit`, `get_references`, `fetch_url`, `unerr_track`.

### Navigate code with unerr tools — not shell, not built-ins (the #1 rule)

To read, search, or map code, use unerr tools. Do NOT use Bash (`cat`, `head`, `tail`, `sed`, `grep`, `rg`, `find`, `ls -R`) and do NOT use built-in Read / Grep / Glob for code. One graph query replaces 5–15 shell or file reads.

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

Bash is for running things (build, test, git, package managers) — not for reading or searching code.

### Recon first — one call replaces the discovery fan-out

Before any non-trivial code change, call `search_code` with a TASK PHRASE — e.g. `search_code({query:"add a retry to the boot path"})`. A task-shaped query returns a recon bundle in ONE call: anchored notes + matching entities + the focus entities' verbatim bodies + their callers (blast radius) + conventions. A BARE SYMBOL — `search_code({query:"QueryRouter.dispatch"})` — returns ranked name matches for a quick lookup. Edit straight from the bundle's inlined bodies; obey its `ur|fct inlined above — do NOT re-read` line and call `file_read` only for source it did not inline. For a large rename/migrate, run `unerr recon "<task>"` from Bash in a sub-agent and return only its digest.

`file_edit` has two modes: `{old_string, new_string}` (unique, or `replace_all:true`) or `{content}` (whole file). When a signature edit has at-risk callers, the response lists them inline (`ur|rsk … N caller(s) …`) — update them in the same change.

Cross-repo (Pro): to read or search OTHER repos already registered with unerr on this machine, pass `scope:'workspace'` — `search_code` and `file_read` query every registered repo (results labeled by repo), `get_references({scope:'workspace'})` finds callers across repos. Reading or editing a path inside a sibling repo auto-routes to that repo's graph — no flag needed. Reach for it to see how another repo solves something or to trace a cross-repo dependency.

### Batch the work — one shot, not file-by-file (round-trips are the dollar cost)

A round-trip carries input + output + latency, so the win is doing N items in one pass, not N passes.

1. **Bulk edits — climb this ladder, stop at the first rung that works:** (a) **one command for the whole set** — `prettier --write .`, a `sed`/codemod, a formatter, a build flag; run it once, not once per file. (b) **else one script** — write one small script that walks the files and makes the change in a single run. (c) **else a cheaper model in a loop** — hand the repetitive per-file edit to a sub-agent on a cheaper model (see below). NEVER do a frontier-model file-by-file loop — that is the most expensive way to do the cheapest work.
2. **Batch independent reads into ONE message.** When you need several files or several entities and the calls don't depend on each other, issue them as parallel tool calls in a single message — not one, wait, next. Better still, one `search_code({query:"<task>"})` recon bundle already returns several files' bodies + callers together; reach for it before fanning out `file_read`.
3. **Set `token_budget`/`limit` right the first time.** Reading at a small budget then re-reading bigger doubles the cost. Ask for what the task needs up front (e.g. `token_budget:3000` for a full function, `limit:25` for references) instead of read-small-then-re-read.

### Be the master — group, then delegate, do-it-yourself only for reasoning

You are the expensive model. Spend yourself on judgement, not mechanical work.
1. **Group first.** Decompose the task into independent sub-tasks; pull their context with one `search_code` recon bundle + batched reads (above), not a fan-out.
2. **Delegate the brainless pieces to a cheaper model.** When a sub-task is mechanical and check-verifiable — add/fix tests, docstrings/`@sem`, lint/format, a rename or extract sweep, or pure read-only recon ("find out / trace / investigate X") — hand it off and review the diff instead of doing it yourself. Invoke `Skill('unerr-delegate')`; it routes by difficulty to a 5–15× cheaper tier (middle model for tests/refactors, worker model for lint/docs/recon) and runs disjoint groups in parallel. Spawned sub-agents must run on a cheap tier, never the master model.
3. **Do it yourself only when the work needs reasoning** — design, a new interface, root-causing a bug, or anything where a wrong mechanical edit hides a judgement call.

### Signals — `ur|<tag>` lines on tool responses

Act on these before the rest of the response; the body line is your concrete next step.

| Tag | Meaning | Do |
|---|---|---|
| `act` | do something now | The body names the call (halt-and-switch, `Skill('<name>')`, pagination cursor, marker to emit) |
| `ctx` | state changed | Re-read drifted file/entity; don't re-query context already delivered |
| `rsk` | caution | High blast radius → `get_references` first; anti-pattern; prior failure on this entity |
| `fct` | a fact for context | Surfaced project fact, co-change hint, family-routing nudge |

Lines starting `unerr » ` are user-facing telemetry — never echo or act on them. When unerr shaped your answer, say so plainly ("unerr found <name>", "<N> places call <name>") — never dump tool JSON.

### Persisting + markers (zero round-trip)

User rules ("remember", "always", "from now on", "never") are captured automatically by the prompt hook — no tool call. Emit session markers as `unerr-save:` lines in your closing message (the Stop hook persists them):

```
unerr-save: intent <what this turn does, ≤80 chars>   (REQUIRED first on coding tasks)
unerr-save: decision <a deliberate choice> · blocker <obstacle> · resolution <fix>
unerr-save: note <kind|anchor|polarity|content>        (an anchored note — DSL below)
```

When you need a return value (a blocker's `marker_id`), call `unerr_track({op:'intent'|'decision'|'blocker'|'resolution'|'fact'|'recall', text:'<one-line>'})`.

### Fallback to built-ins / Bash for code — only when

unerr MCP is unavailable (not responding / erroring) · a non-text binary (image, PDF). For any code read, search, or edit there is always an unerr tool — use it, never bash/grep/cat.

### Domain comments — maintain meaning in the same edit

unerr parses a structured doc comment above each exported entity into a parallel domain graph: a 1–2 sentence prose summary (what + why, never how) then one `@sem domain=<tag> role=<tag>` line. The frontier model editing the code is the only thing that can keep that meaning true — maintain it inline, never as a separate pass:

1. WHEN editing an entity that carries an `@sem` comment AND the edit changed what it does or why: rewrite the prose and tags in the SAME Edit call. Purpose unchanged → leave the comment untouched.
2. WHEN creating an exported entity: write the comment block before the next edit. Prose ≤2 sentences, then `@sem domain=<tag>`. Reuse an active domain tag — a task-shaped `search_code({query:"<task>"})` lists them; add a new tag only when none fits.
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
touch, call `search_code({query:"<what you are about to do>"})` — the
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
| anchor | f:<path> · e:<entity> · g:<glob> · p: · w: | `p:` is project-wide, `w:` is workspace-wide (every repo in a Pro federation). Both empty-valued; both **discouraged** — they pollute the prompt-receipt query. Prefer file/entity. |
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
