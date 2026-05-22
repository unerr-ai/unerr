<p align="center">
  <a href="https://www.unerr.dev/"><img src="https://unerr.dev/icon-wordmark.svg" alt="unerr — stateful cognitive guardrail for AI coding agents" width="320" /></a>
</p>

<p align="center">
  <strong>Stop babysitting your AI.</strong>
</p>

<p align="center">
  A stateful cognitive guardrail that sits beneath Claude Code, Cursor, and every other coding agent —<br/>
  forces them to respect your architecture, remember your decisions, and stay sharp 50+ turns into a session.
</p>

<p align="center">
  <a href="https://www.unerr.dev/"><img src="https://img.shields.io/badge/website-unerr.dev-8B5CF6?style=flat-square&logo=icloud&logoColor=white" alt="Website" /></a>
  <a href="https://www.npmjs.com/package/@unerr-ai/unerr"><img src="https://img.shields.io/badge/install-npm_i_@unerr--ai/unerr-8B5CF6?style=flat-square&logo=npm" alt="Install" /></a>
  <a href="https://discord.gg/JfZ4pYgb"><img src="https://img.shields.io/badge/community-Discord-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://x.com/unerr_ai"><img src="https://img.shields.io/badge/follow-@unerr__ai-000000?style=flat-square&logo=x&logoColor=white" alt="X / Twitter" /></a>
  <a href="https://www.linkedin.com/company/unerr"><img src="https://img.shields.io/badge/linkedin-unerr-0A66C2?style=flat-square&logo=linkedin&logoColor=white" alt="LinkedIn" /></a>
  <img src="https://img.shields.io/badge/runtime-Node.js_≥20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/protocol-MCP-7C3AED?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/local--first-no_cloud-22D3EE?style=flat-square" alt="Local-first" />
  <img src="https://img.shields.io/badge/license-ELv2-A1A1AA?style=flat-square" alt="License" />
</p>

<p align="center">
  <code>npm install -g @unerr-ai/unerr</code>
</p>

---

## How you'll know it's working — the four surfaces

unerr is not a silent background daemon you hope is doing something. It shows up at the four moments of the day when you're already paying attention:

1. **Start-of-turn preface** — the first response of every turn opens with `unerr · context: 3 stored facts loaded, 1 file cached`. You always know what the agent walked into the turn with.
2. **End-of-turn footer** — the final response closes with `unerr · this turn: 2 catches · ≈ 4.2k tokens saved · +5 turns of headroom this session`. Catches are *named, countable events*, not a ratio.
3. **Multi-day archive dashboard** — `http://localhost:9847/` hosts a Logbook page that reads as a story for today / this week / since install, a Token Trace page that headlines turns of headroom (compounded) alongside the raw tokens-saved trail, and a Sidekick Memory page that shows every fact you fed it — verbatim, editable, replayable.
4. **Named-sidekick persistence** — say *"from now on, always X"* and the agent calls `unerr_remember` with your verbatim quote. Next session — even from a different IDE — the next-turn preface includes the fact, and any file edit covered by your `applies_to` list pulls a `ur|fct …` enforcement line into the agent's prompt.

The proof of presence is the channel. The `unerr · ` prefix (middle-dot, human-facing) is text inside `content[].text` — every supported IDE preserves it. The `ur|<tag>` prefix (pipe, model-facing) is the same channel but addressed to the agent. For the one-page overview and the full sprint plan, see [docs/open-cli/PERCEPTION_TO_PRESENCE.md](https://github.com/unerr-ai/unerr-web-landing/blob/main/docs/open-cli/PERCEPTION_TO_PRESENCE.md#overview--the-four-surface-presence-model-at-a-glance).

---

## The slop isn't your agent's fault. It's flying blind and forgetting everything.

You've felt all four of these in the last 48 hours:

- **The Slop Threshold.** Claude is brilliant for 20 minutes, then hallucinates a duplicate component and forgets the styling rules you set five turns ago. Turn 30 isn't worse because the model got dumber — it's worse because the context window is now polluted with 15k tokens of file dumps and the agent has lost the plot.
- **The Babysitter Tax.** More time writing `MEMORY.md`, updating `.cursorrules`, and pasting session summaries than writing code. You've become a middle manager for a junior dev with amnesia.
- **The Blind Grep.** The agent reads a 2,000-line file to find a 5-line function. Its context window is now full of garbage and it still doesn't know that function has 24 callers across three services.
- **The Silent Blast Radius.** You don't trust the agent to refactor anything important. It treats your codebase like a flat string of text — locally correct, globally wrong.

These aren't four problems. They're one: **Agentic Entropy** — the inevitable decay of AI logic and architectural integrity in long-running sessions. Today's agents are incredibly smart but structurally blind and severely amnesiac. They grep when a senior engineer would check the call graph. They forget on Tuesday what they learned on Monday.

`unerr` is the substrate that fixes that. One local process, picked up automatically through MCP, that gives every agent on your machine a shared brain — a dependency graph it can see and a memory that survives the next session.

---

## What changes (mapped to what you actually feel)

| You feel | The mechanism | What it changes |
|---|---|---|
| **Trust returns.** You let the agent run for an hour without watching. | Every edit is preceded by a graph lookup. The agent sees all 24 callers *before* it touches the function. | Cascade guard fires on wide blast radius. `get_references` is one tool call away. Refactors stop rippling silently. |
| **The babysitter tax disappears.** You delete `MEMORY.md` and `.cursorrules`. | Local fact store + timeline that survives sessions. Decisions, conventions, and anti-patterns persist with decay-adjusted confidence; auto-detected from coding sessions. | Open the laptop on Tuesday and the agent already knows what you decided on Monday — and why. |
| **The agent stays sharp at turn 50.** Slop doesn't set in. | Surgical context. `file_read({entity})` returns 200 lines + relevant conventions instead of a 3,000-line dump. Shell output compressed 93% on average. Context window stays uncluttered. | The model isn't fighting "lost in the middle." It's fed exactly what it needs, when it needs it. |
| **Tool sprawl dies.** No more "which search tool should I use?" | One graph, one set of tools, project-aware routing. Tool-adoption nudging keeps agents on the graph instead of reverting to grep within 3–5 turns. | Five MCP servers no longer compete for the agent's attention. |

What you're really getting is **agents that behave like senior engineers** — checking dependencies before editing, remembering project history, refusing to thrash on a function they've already failed on three times.

---

## See it in action

<p align="center">
  <img src="https://unerr.dev/open-cli/video/unerr_short.gif" alt="unerr in action" width="720" />
</p>

The dashboard is the evidence. Every claim above is something the agent is actively doing — and every panel reads from the same store the agent reads from over MCP.

| Pane | What it shows |
|---|---|
| **Token Optimization** | How much context the agent *didn't* have to chew through this session — saved vs. delivered, by mechanism (graph hits, skipped re-reads, compressed shell output, deduped fetches). The compounding multiplier is the real number. |
| **Reasoning Quality** | Did the agent actually act on what it remembered? A 4-pillar score with a 5-turn outcome window per fact and convention. Reinforced / acted-on / ignored / corrected — the load-bearing rate is what matters. |
| **Codebase Map + Code Intelligence** | The graph the agent reads from. Fan-in chokepoints, cross-module surprise links, risk grade per file. This is what stops the silent blast radius. |
| **Project Memory + Activity** | The facts that survived. Conventions auto-detected, decisions recorded, blockers still open. Sessions stitched into intents — your continuous thread across Cursor, Claude Code, and whatever you open tomorrow. |

<table align="center">
  <tr>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/dashboard.png" alt="unerr dashboard — live overview" width="240" height="150" />
      <br/><sub><strong>Dashboard</strong><br/>Live overview — active sessions, recent tool calls, tokens the agent skipped this turn.</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/token-trace-main.png" alt="unerr token trace — global" width="240" height="150" />
      <br/><sub><strong>Token Trace · global</strong><br/>Aggregate context kept out of the window, broken down by mechanism (graph, file_read, fetch_url, shell, dedup, format).</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/token-session.png" alt="unerr token trace — session" width="240" height="150" />
      <br/><sub><strong>Token Trace · session</strong><br/>Single session: per-turn impact, mechanism mix, and the compounding multiplier.</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/token-turn.png" alt="unerr token trace — turn" width="240" height="150" />
      <br/><sub><strong>Token Trace · turn</strong><br/>Single turn: which tool calls fired, what each would have dumped into context without unerr vs what was delivered.</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/reasoning-quality.png" alt="unerr reasoning quality — global" width="240" height="150" />
      <br/><sub><strong>Reasoning Quality · global</strong><br/>Four-pillar score: cleaner context, fewer wasted turns, fewer breakages, persistent memory.</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/reasoning-session.png" alt="unerr reasoning quality — session" width="240" height="150" />
      <br/><sub><strong>Reasoning Quality · session</strong><br/>Per-session: which facts and conventions were reinforced, acted on, ignored, or corrected.</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/code-base-intelligence.png" alt="unerr code intelligence" width="240" height="150" />
      <br/><sub><strong>Code Intelligence</strong><br/>Call graph, fan-in/out chokepoints, cross-module surprise links, risk grade per file.</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/project-memory.png" alt="unerr project memory — facts" width="240" height="150" />
      <br/><sub><strong>Project Memory</strong><br/>Conventions, anti-patterns, decisions — with decay-adjusted confidence and reinforcement counts.</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="240" colspan="4">
      <img src="https://unerr.dev/open-cli/screenshots/activity.png" alt="unerr activity — timeline + heatmap" width="240" height="150" />
      <br/><sub><strong>Activity</strong><br/>Turn-grouped timeline with a 30-day heatmap — each row is one burst of agent work (intent → tools → outcome).</sub>
    </td>
  </tr>
</table>

---

## Quick Start

Three steps. Step 1 is once per machine; steps 2–3 are per repo.

### 1. Install the CLI

```bash
npm install -g @unerr-ai/unerr
```

Puts the `unerr` binary on your PATH. If the global `npm` directory isn't already in your shell's PATH (common with nvm, fnm, volta, pnpm), run `unerr doctor` once — it patches your shell config and won't need to run again.

### 2. Install for your agent (per repo)

```bash
cd ~/your-project
unerr install cursor
```

Writes the MCP config, skills, hooks, and instructions for that agent in the current repo. Swap `cursor` for any of the [supported agents](#supported-agents): `claude-code`, `windsurf`, `gemini-cli`, `antigravity`, `github-copilot-cli`.

### 3. Restart your IDE

Close and reopen your IDE (or start a new chat session). Your agent picks up unerr through MCP — graph-backed tools, persistent memory, shell compression all available immediately.

> **Dashboard:** <http://localhost:9847> — open any time to watch the guardrail at work in real time.

### Supported agents

```bash
unerr install claude-code        # → .mcp.json + CLAUDE.md + .claude/skills/ + hooks
unerr install cursor             # → .cursor/mcp.json + .cursor/rules/ + hooks
unerr install antigravity        # → .antigravity/mcp_config.json + .agents/rules/ + .agents/skills/
unerr install windsurf           # → ~/.codeium/windsurf/mcp_config.json + .windsurf/rules/ + .windsurf/skills/
unerr install gemini-cli         # → .gemini/settings.json + GEMINI.md + .gemini/skills/
unerr install github-copilot-cli # → .copilot/mcp-config.json + .github/copilot-instructions.md + .github/skills/
```

Install multiple agents in the same repo — each writes its own config:

```bash
unerr install cursor
unerr install claude-code
```

> Need manual setup? `unerr install --show-instructions <agent>` prints copy-pasteable steps.

<details>
<summary>Manual MCP config (any MCP-compatible client)</summary>

```json
{
  "mcpServers": {
    "unerr": {
      "command": "npx",
      "args": ["@unerr-ai/unerr", "--mcp"]
    }
  }
}
```

</details>

<details>
<summary>What <code>unerr install</code> writes</summary>

| Item | File(s) |
|------|------|
| MCP config pointing to `unerr --mcp` | `.mcp.json`, `.cursor/mcp.json`, … |
| Skills — 12 definitions teaching the agent when to use each tool | `.claude/skills/`, `.cursor/rules/`, … |
| Instructions — tool-routing table injected into the agent's instruction file | `CLAUDE.md`, `.cursor/rules/unerr-instructions.mdc` |
| Hooks — shell compression + tool-adoption nudging | `.claude/settings.json`, `.cursor/hooks.json` |
| Gitignore — keeps `.unerr/` out of commits | `.gitignore` |
| Force tools (Claude Code only) — denies built-in Read/Grep/Glob so the agent uses graph tools. Opt out with `--no-force-tools`. | `.claude/settings.json` |

Idempotent — re-running updates if content changed, skips if identical. Remove with `unerr uninstall`.

</details>

---

## Who it's for

- **Vibe coders.** The thing that stops your app from breaking on turn 30 when the AI gets confused. Slop never sets in.
- **Solo builders.** The continuous thread. Switch from Claude Code in the terminal to Cursor in the IDE — your project memory comes with you.
- **Senior / staff engineers.** A cognitive guardrail. Forces AI to respect dependency graphs and architectural boundaries the way a human engineer would.

---

## What happens the moment you connect

### Day 1 — instant relief

- **Architecturally aware navigation** — `get_entity`, `get_references`, `get_imports`, `search_code`. The agent stops reading 30 files to find one function.
- **Blast-radius checks before every edit** — `get_references` returns every caller. No more confident wrong changes that ripple across services.
- **Surgical file reads** — `file_read({entity: "fnName"})` returns just the function + relevant conventions, not 2,000 lines of attention-dilution.
- **Shell compression** — 11 strategies, 645+ command classifiers. Diffs, errors, logs, test runs, YAML — each compressed differently. **93% average compression** across real-world benchmarks (2 MB → 138 KB). Raw output kept on disk; the agent can recover it on demand.
- **Web fetches that don't bloat the context** — `fetch_url` strips chrome via Defuddle/Readability, converts to markdown, splits into heading-bounded passages, optionally re-ranks with BM25 when a `prompt` is supplied, and caches by content hash. **5–10× fewer tokens** than built-in WebFetch.
- **Conventions detected automatically** — naming, structure, import direction. No `.cursorrules` to maintain.
- **Tool adoption that sticks** — five reinforcement layers (exec nudges, hook interception, instruction injection, skill reminders, default-deny of built-ins on Claude Code) stop the agent from reverting to grep within 3–5 turns.

### Day 2 onward — the compounding starts

- **Memory that survives** — what the agent learned today is available tomorrow. The continuous thread across Cursor, Claude Code, and any other MCP client on your machine.
- **Decay-adjusted facts** — `record_fact` and `recall_facts` with per-type decay and contradiction handling. Facts also auto-detect from coding sessions.
- **Episodic narratives** — reopen a file and the agent sees what was modified, when, and why.
- **Loop prevention** — a circuit breaker fires after repeated failed attempts on the same entity. No more silent thrashing.
- **Memory-effectiveness scoring** — every fact opens a 5-turn observation window. The Reasoning Quality pane shows the **load-bearing rate** — not how much the agent remembered, how much actually mattered.

### Running quietly in the background

These activate automatically — no extra commands:

- **Cascade guard** — warns before an edit ripples wide.
- **Architecture guard** — flags structural violations before they ship.
- **Convention drift** — catches new code diverging from established patterns.
- **Auto-doc** — generates docs for undocumented entities.
- **Change narrative** — tracks the story behind multi-step refactors.
- **Loop breaker** — intervenes when the agent is stuck retrying.
- **Session continuity** — preserves state across restarts.

### Shell compression benchmarks

| Strategy | What it compresses | Avg compression |
|----------|-------------------|:-:|
| **diff** | `git diff`, patch output | **99%** |
| **structured** | JSON APIs, `docker inspect` | **97%** |
| **progress** | `npm install`, `pip install` | **95%** |
| **log_text** | Build logs, server logs, `make`, `cargo build` | **89%** |
| **test_results** | `vitest`, `pytest`, `cargo test`, `playwright` | **80%** |
| **tabular** | `ps aux`, `docker ps`, `kubectl get` | **77%** |
| **error_diagnostic** | `tsc`, `eslint`, `rustc`, `shellcheck` | **72%** |
| **key_value** | `env`, `kubectl describe`, `systemctl status` | **48%** |
| **tree_paths** | `find`, `tree`, `ls -R` | **42%** |
| **yaml** | YAML configs, `kubectl get -o yaml`, Helm output | adaptive |
| **omni** | Fallback for unrecognized output | adaptive |

**Overall: 93% compression** (2 MB → 138 KB across 40 real-world test cases). This is the mechanism behind "agent stays sharp at turn 50" — not a token-cost play.

### Language support

| Language | Tier | Entities | Edges | Tree-sitter | SCIP |
|----------|:---:|:-:|:-:|:-:|:-:|
| TypeScript / JavaScript / Python / Go / Java / Kotlin / Scala / Rust / Ruby / C / C++ / C# | 1 | ✓ | ✓ | ✓ | ✓ |
| PHP / Swift / Lua / Dart / Elixir / Zig | 2 | ✓ | ✓ | ✓ | — |

**Tier 1** (12 languages): full tree-sitter AST + dedicated extraction + SCIP compiler-verified call graphs where the toolchain is on PATH.
**Tier 2** (6 languages): tree-sitter AST + generic extraction. Regex fallback for the rest.

**Tier 3 (search-discoverable):** Markdown, IaC (`.tf`, `.yaml`, `.toml`), schemas (`.proto`, `.graphql`, `.prisma`), SQL, shell, templates, build files, CI configs — indexed for `search_code` only, no entity extraction.

---

## How unerr compares

Adjacent tools each own one layer — graph navigation, persistent memory, or output compression. `unerr` integrates all three plus the drift prevention that keeps the graph tools in active rotation. Peer strengths are real; the table credits them where they win.

| Capability | unerr | Graphify (~47K) | Serena (~23K) | claude-mem (~75K) | RTK (~40K) |
|---|:---:|:---:|:---:|:---:|:---:|
| **Code intelligence** | | | | | |
| Pre-hoc file-read intercept — resolves entity via graph, returns ~200 lines + conventions + blast radius instead of a 3,000-line file | ✓ | ✗ | Partial | ✗ | ✗ |
| Convention auto-detection — naming, structure, import direction from ≥70% adherence; no manual rules file | ✓ | ✗ | ✗ | ✗ | ✗ |
| Drift / staleness signals — `ur\|dft` fires when code moves under stored memory | ✓ | ✗ | ✗ | ✗ | ✗ |
| **Memory & continuity** | | | | | |
| Persistent across sessions — typed facts with per-type decay, contradiction handling | ✓ | ✗ | ✗ | ✓ | ✗ |
| Per-repo isolation — all state in `.unerr/` inside the repo, no cross-project leakage | ✓ | ✓ | ✓ | ✗ | — |
| **Runtime** | | | | | |
| Zero LLM in core — no API keys, no per-turn inference cost | ✓ | ✓ | ✓ | ✗ | ✓ |
| Keeps MCP tools in active rotation — without enforcement, agents revert to built-in Read/Grep/Glob within 3–5 turns | ✓ | ✗ | ✗ | ✗ | ✗ |

Three numbers behind the table:

- **~84%** of an AI coding agent's tokens are tool output, mostly file reads (JetBrains, NeurIPS 2025 DL4Code Workshop) — `unerr` intercepts before the read so attention isn't diluted.
- **0** LLM calls per query in the core — facts, conventions, and drift signals are algorithmic.
- **3–5** turns is how long agents take to revert to built-in Read/Grep/Glob without drift prevention. The agent's mental model decays without active reinforcement.

Honest acknowledgements: `unerr` is the new entrant with fewer stars than every peer; the install is heavier than `brew install` (Node + index step); TypeScript is deepest, other languages run on tree-sitter; no semantic vector retrieval and no narrative session resume in the core.

---

## How it works

```
AI Agent (Claude Code / Cursor / Windsurf / any MCP client)
    │
    ├── stdio MCP ──→ unerr --mcp (bridge, per IDE session)
    │                       │
    │                       └── UDS ──→ unerrd (lightweight Node process,
    │                                           one per machine, auto-spawned)
    │                                       │
    │                                       └── per-repo unerr process(es)
    │                                              │
    │                                              ├── CozoDB graph     (in-process, <5ms)
    │                                              ├── Fact store       (cross-session memory)
    │                                              ├── Timeline + ledger (every tool call)
    │                                              ├── File watcher     (incremental reindex)
    │                                              ├── Convention engine
    │                                              ├── Compression engine (11 strategies, 645+ classifiers)
    │                                              └── Behavior modules (cascade-guard, loop-breaker, auto-doc…)
    │
    └── Dashboard ──→ http://localhost:9847 (SSE-streamed live)
```

One local DB per repo. Zero network calls. No API keys. No cloud. Your code never leaves the machine.

---

## MCP Tools (20)

### Graph Intelligence (8)

| Tool | What the agent gets |
|------|-----|
| `get_entity` | Any code entity — signature, body, callers, callees, risk |
| `get_file` | All entities in a file with risk summary |
| `get_references` | Callers (blast radius) or callees (dependencies) |
| `get_imports` | Import graph for a file |
| `search_code` | Graph-ranked full-text search across all entities |
| `get_conventions` | Detected naming/structure/import patterns + adherence rates |
| `get_critical_nodes` | High fan-in/fan-out chokepoints |
| `get_cross_boundary_links` | Unexpected cross-module dependencies, scored by surprise |

### Structural Analysis (3)

| Tool | What the agent gets |
|------|-----|
| `get_project_stats` | Entity counts, risk distribution, health grade |
| `file_connections` | Imports + co-change correlations for a file |
| `get_test_coverage` | Direct + transitive tests for any entity |

### File Protocol (2)

| Tool | What the agent gets |
|------|-----|
| `file_read` | Context-aware read — auto-injects conventions and facts |
| `file_outline` | File structure (entities, exports) without reading the body |

### Persistent Memory (3)

| Tool | What the agent gets |
|------|-----|
| `unerr_remember` | Persist a fact the **user** just stated ("remember", "always", "from now on", project rule). Carries the verbatim `source_quote` and the agent's `confidence`; <0.5 abandoned, 0.5–<0.7 flagged ambiguous, ≥0.7 stored cleanly. |
| `record_fact` | Persist an **agent-detected** convention, decision, or anti-pattern (no explicit user statement) |
| `recall_facts` | Retrieve facts with hierarchical scope + decay-adjusted confidence |

### Session Narrative — Markers (4)

Inline markers the agent emits as it works. Persisted to the shadow ledger and `.unerr/timeline.db` — powers turn titles, cross-session intent stitching, the resume strip, and loop/blocker miners.

| Tool | What it does |
|------|-----|
| `mark_intent` | One-sentence task start (≤80 chars). Becomes the turn title |
| `mark_decision` | Records a chosen approach + up to 5 alternatives (≤140 chars) |
| `mark_blocker` | Flags an unresolved obstacle. Carries into the next session's resume strip |
| `mark_resolution` | Resolves a prior blocker by `marker_id` |

### Web Fetch (1)

| Tool | What the agent gets |
|------|-----|
| `fetch_url` | DOM-extracted markdown of a web page (Defuddle/Readability), split into heading-bounded passages, optionally re-ranked by BM25 against a `prompt`, cached by content hash. Replaces built-in WebFetch — 5–10× fewer tokens. Optional Playwright SPA fallback. |

Every response carries inline `ur|<tag>` signals for high-priority guidance — drift, blast-radius warnings, circuit-breaker halts — so the agent acts on what it just learned without burning a turn.

---

<details>
<summary><strong>CLI commands</strong></summary>

```bash
unerr install <agent> # MCP config + skills + hooks + instructions for one agent
unerr uninstall       # Remove unerr integration from this repo
unerr doctor          # Check PATH + environment, auto-fix if unerr isn't on all shells
unerr status          # Proxy health, entity count, graph age
unerr stats           # Session statistics (tokens, tool calls, compression)

unerr --mcp           # Stdio bridge — what your IDE invokes via .mcp.json
unerr                 # Start a standalone per-repo proxy (rare — IDE invocation covers this)
```

`unerr pm …` manages the cross-repo `unerrd` process — see the [reference](#process-manager-command-reference) below.

</details>

<details>
<summary><strong>Architecture</strong></summary>

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
  skills/        12 bundled skill definitions
  server/ + ui/  HTTP API + React (Vite) dashboard
  config/        Agent registry, MCP config writer, instruction injector
  schemas/       Zod schemas
```

**Design principles**

- Zero network calls — fully local, no API keys.
- stdout is sacred — MCP JSON-RPC only; everything else to stderr.
- <5 ms query responses — CozoDB runs in-process (Rust via NAPI).
- First useful output <5 s — shallow index first, deep enrichment in background.
- Graceful degradation — the agent still works if unerr is down, you just lose the guardrail.

**Tech stack** TypeScript (ESM) · CozoDB (Rust/NAPI) · web-tree-sitter (WASM) · MCP SDK · Ink (React CLI) · React + Vite (dashboard) · tsup · Vitest

</details>

<details>
<summary><strong>Development</strong></summary>

```bash
pnpm install
pnpm run build          # tsup → dist/ (ESM, node20)
pnpm run dev            # tsx watch
pnpm run test:run       # full suite
pnpm run lint           # biome check
pnpm run typecheck      # tsc --noEmit

pnpm link --global      # make local `unerr` available globally
```

</details>

<details>
<summary><strong>Contributing</strong></summary>

Contributions welcome — please open an issue first.

**Before submitting a PR:**
- `pnpm run typecheck && pnpm run lint && pnpm run test:run`
- All output to stderr — never stdout (MCP JSON-RPC channel)
- All CozoDB interactions are async — always `await`
- Use `.js` extensions in imports (NodeNext resolution)

See [CLAUDE.md](./CLAUDE.md) for full conventions.

</details>

---

## Process Manager Command Reference

`unerrd` is a lightweight Node process that supervises every registered repo. Your IDE invocation auto-spawns it; it exits cleanly after 30 minutes of no MCP activity. You rarely run these commands directly, but they're here when you want a look under the hood.

```bash
unerr pm status                       # PID, uptime, repos, memory, idle countdown
unerr pm start                        # Start manually (auto-spawn usually covers this)
unerr pm stop                         # Graceful shutdown — stops children, flushes state

unerr pm add <path>                   # Register a repo (auto-registered on first MCP call)
unerr pm remove <path>                # Unregister a repo
unerr pm config <path> <key>=<value>  # Per-repo settings (idleTimeout, javaBuildTool, …)

unerr pm logs                         # Tail ~/.unerr/logs/unerrd.log
unerr pm logs --repo <path>           # Tail a specific repo's log
unerr pm logs --bridge --follow       # Stream bridge session logs continuously
unerr pm logs --boot                  # Most recent spawn sequence only

unerr pm dashboard                    # Open http://localhost:9847 in your browser
```

**Dashboard** shows the global overview (registered repos, health, active sessions), a repo switcher into each repo's full intelligence dashboard, and process-manager info (uptime, memory, idle countdown).

**Updates** — `npm i -g @unerr-ai/unerr` and restart the IDE. The next bridge invocation re-spawns the manager on the new version.

---

## The truth this is built on

Today's agents are incredibly smart — and structurally blind and severely amnesiac. They treat complex software like a flat text document. They grep when a senior engineer would check the call graph. They forget on Tuesday what they learned on Monday.

`unerr` forces them to act like senior engineers instead — checking dependencies, respecting boundaries, remembering project history. The invisible substrate that turns a brilliant-but-flaky junior into something you can actually trust to run for an hour without watching.

---

## License

[Elastic License 2.0 (ELv2)](./LICENSE) — free to use, modify, and distribute. Cannot be offered as a hosted service.

---

<p align="center">
  <code>npm install -g @unerr-ai/unerr</code>
  <br /><br />
  <a href="https://www.unerr.dev/"><sub>unerr.dev</sub></a> · <a href="https://www.npmjs.com/package/@unerr-ai/unerr"><sub>npm registry</sub></a> · <a href="https://discord.gg/2BjRftz8kG"><sub>Discord</sub></a> · <a href="https://x.com/unerr_ai"><sub>X</sub></a> · <a href="https://www.linkedin.com/company/unerr"><sub>LinkedIn</sub></a> · <sub>Fully local. No account. No cloud. Free.</sub>
</p>
