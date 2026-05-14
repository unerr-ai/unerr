<p align="center">
  <a href="https://www.unerr.dev/"><img src="https://unerr.dev/icon-wordmark.svg" alt="unerr — local intelligence layer for AI coding agents" width="320" /></a>
</p>

<p align="center">
  <strong>Lands your AI agent at the right code in fewer turns, tokens, & breakages.</strong>
</p>

<p align="center">
  A local intelligence layer that sits between your AI agent and your codebase —<br/>
  indexes every call, remembers every decision, and gets sharper the longer you use it.
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

## The agent isn't stupid. It's flying blind.

Watch any AI coding session for ten minutes and you'll see the same loop:

- It **reads 30 files** to find one function — burning the context window before it writes a line.
- It **edits something with 40 callers** and never knows it just broke three services.
- It **re-derives the same conventions** you taught it yesterday, this morning, and an hour ago.
- It **forgets the entire session** the moment the window closes.

Every one of these is the same root cause: the agent has **no persistent memory of your code, your team's style, or its own past mistakes**. unerr is that memory. One process, fully local, indexed in seconds — and your agent picks it up automatically through MCP.

---

## What you actually see

Run `unerr` and open the dashboard. Four panes, all live:

| Pane | Answers the question | Powered by |
|---|---|---|
| **Token Optimization** | *How much context did unerr save my agent this session?* — saved vs. delivered, compounding multiplier, breakdown by mechanism (compression, graph hits, skipped re-reads). | Per-turn ledger of every tool call |
| **Reasoning Quality** | *Did the agent actually use what it remembered?* — 4-pillar score across exploration, planning, execution, persistent memory. | 5-turn outcome window per fact/convention |
| **Codebase Map + Code Intelligence** | *What's the call graph and where are the blast-radius landmines?* — entities, edges, fan-in/out chokepoints, cross-module surprise links. | CozoDB graph (in-process, <5ms) |
| **Project Memory + Activity** | *What did we already learn, and what was I doing last time?* — facts the agent recorded, sessions stitched into intents, open blockers. | Append-only fact store + timeline.db |

The agent reads from the same store through MCP — every claim on the dashboard is also a tool call it just made.

### See it in action

<table align="center">
  <tr>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/dashboard.png" alt="unerr dashboard — live overview" width="240" height="150" />
      <br/><sub><strong>Dashboard</strong><br/>Live overview — active sessions, recent tool calls, tokens saved this turn.</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/token-trace-main.png" alt="unerr token trace — global" width="240" height="150" />
      <br/><sub><strong>Token Trace · global</strong><br/>Aggregate savings across every session, broken down by mechanism (graph, file_read, shell, dedup, format).</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/token-session.png" alt="unerr token trace — session" width="240" height="150" />
      <br/><sub><strong>Token Trace · session</strong><br/>Single session: per-turn savings, mechanism mix, and the compounding multiplier.</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/token-turn.png" alt="unerr token trace — turn" width="240" height="150" />
      <br/><sub><strong>Token Trace · turn</strong><br/>Single turn: which tool calls fired, tokens each would have cost without unerr vs what was delivered.</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/reasoning-quality.png" alt="unerr reasoning quality — global" width="240" height="150" />
      <br/><sub><strong>Reasoning Quality · global</strong><br/>Four-pillar score across cleaner context, fewer wasted turns, fewer breakages, persistent memory.</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/reasoning-session.png" alt="unerr reasoning quality — session" width="240" height="150" />
      <br/><sub><strong>Reasoning Quality · session</strong><br/>Per-session: which facts and conventions were reinforced, acted on, ignored, or corrected.</sub>
    </td>
    <td align="center" width="240">
      <img src="https://unerr.dev/open-cli/screenshots/code-base-intelligence.png" alt="unerr code intelligence" width="240" height="150" />
      <br/><sub><strong>Code Intelligence</strong><br/>Call graph, fan-in/out chokepoints, cross-module surprise links, and a risk grade per file.</sub>
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

### 1. Install globally

```bash
npm install -g @unerr-ai/unerr
```

### 2. Choose your mode

<table>
<tr>
<th width="50%">Standalone (single repo, simple)</th>
<th width="50%">Daemon Mode (multi-repo, recommended)</th>
</tr>
<tr>
<td>

```bash
cd ~/project
unerr install cursor   # install MCP config + skills
unerr                  # start per-repo process
```

One `unerr` process per repo. You start it manually. Good for single-project workflows.

</td>
<td>

```bash
unerr daemon initialize       # one-time: register at boot + start
cd ~/project
unerr install cursor          # install config + register repo
# done — IDE auto-connects via unerrd
```

A single `unerrd` supervisor manages all repos. Starts at login, spawns per-repo processes on demand, idles unused ones, unified dashboard at `localhost:9847`.

</td>
</tr>
</table>

> **Important:** After running `unerr install`, restart your coding AI session (close and reopen the IDE or start a new chat) for unerr to take effect. The agent needs to pick up the newly installed MCP config, skills, and instructions.

### What each command does (no hidden behaviors)

| Command | What it does | What it does NOT do |
|---------|------|------|
| `unerr daemon initialize` | Registers unerrd at boot (launchd/systemd/schtasks) + starts it | - |
| `unerr install <agent>` | MCP config + skills + hooks + instructions + gitignore. If unerrd running: registers the repo | Start unerrd, start per-repo process |
| `unerr --mcp` | Bridges to running process (standalone or daemon-managed) | Spawn unerrd, register repos, start processes |
| `unerr` (no args) | Starts a standalone per-repo proxy | Touch the daemon |

### Supported agents

```bash
unerr install claude-code        # → .mcp.json + CLAUDE.md + .claude/skills/ + hooks
unerr install cursor             # → .cursor/mcp.json + .cursor/rules/ + hooks
unerr install antigravity        # → .antigravity/mcp_config.json + .agents/rules/ + .agents/skills/
unerr install windsurf           # → ~/.codeium/windsurf/mcp_config.json + .windsurf/rules/ + .windsurf/skills/
unerr install gemini-cli         # → .gemini/settings.json + GEMINI.md + .gemini/skills/
unerr install github-copilot-cli # → .copilot/mcp-config.json + .github/copilot-instructions.md + .github/skills/
```

You can install multiple agents in the same repo — each writes its own config, the repo is registered once:

```bash
unerr install cursor        # registers repo (if daemon running), writes cursor config
unerr install claude-code   # skips registration (already done), writes claude-code config
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
<summary>What <code>unerr install</code> does (detailed)</summary>

| Step | What | File(s) written |
|------|------|------|
| MCP config | Agent-specific config pointing to `unerr --mcp` | `.mcp.json`, `.cursor/mcp.json`, etc. |
| Skills | 12 skill definitions teaching the agent when to use each tool | `.claude/skills/`, `.cursor/rules/`, etc. |
| Instructions | Tool-routing table injected into agent instruction file | `CLAUDE.md`, `.cursor/rules/unerr-instructions.mdc` |
| Hooks | Shell compression + tool-adoption nudging | `.claude/settings.json`, `.cursor/hooks.json` |
| Repo registration | If unerrd is running: registers repo with supervisor | Only when daemon is active |
| Gitignore | Ensures `.unerr/` isn't committed | `.gitignore` |
| Force tools | Claude Code only: denies built-in Read/Grep/Glob (opt out: `--no-force-tools`) | `.claude/settings.json` |

Idempotent — re-running updates if content changed, skips if identical. Remove with `unerr uninstall`.

</details>

---

## What changes the moment you connect

### First session — instant value

- **Graph navigation in <5ms** — `get_entity`, `get_references`, `get_imports`, `search_code`. The agent stops reading 30 files to find one function.
- **Blast radius before edits** — `get_references` returns every caller. No more confident wrong changes that ripple across services.
- **Targeted file reads** — `file_read({entity: "fnName"})` returns just that function + relevant conventions/facts, not 2000 lines.
- **Shell compression** — 11 strategies, 645+ command classifiers. Diffs, errors, logs, test runs, YAML — each compressed differently. **93% average compression** across real-world benchmarks (2 MB → 138 KB). Raw output is kept on disk; the agent can recover it on demand.
- **Convention awareness** — naming, structure, import patterns auto-detected and injected into the agent's context.
- **Tool adoption nudging** — five reinforcement layers (exec nudges, hook interception, instruction injection, skill reminders, default-deny of built-ins on Claude Code) push the agent to use the graph instead of grep.

### Session 2+ — it starts compounding

- **Session persistence** — what the agent learned today is available tomorrow. No more starting from zero.
- **Fact memory** — `record_fact` persists conventions, decisions, and anti-patterns; `recall_facts` retrieves them with decay-adjusted confidence. Facts also auto-detect from coding sessions.
- **Episodic narratives** — when you reopen a file, the agent sees what was modified there, when, and why.
- **Loop prevention** — a circuit breaker fires after repeated failed attempts on the same entity, surfacing the failure mode instead of letting the agent thrash.
- **Memory-effectiveness scoring** — every fact and convention opens a 5-turn observation window and resolves to a verdict (reinforced / acted_on / caught / ignored / corrected). The Reasoning Quality pane shows the **load-bearing rate** — not just how much the agent remembered, but how much of it actually mattered.

### Daemon mode — automated behaviors

When `unerr` is running long-lived, these activate in the background:

- **Architecture guard** — flags structural violations before they ship.
- **Cascade guard** — warns when an edit has wide blast radius.
- **Convention drift** — detects when new code diverges from established patterns.
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

**Overall: 93% compression** (2 MB → 138 KB across 40 real-world test cases).

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

Adjacent tools each own one layer — graph navigation, persistent memory, or output compression. unerr integrates all three, plus the drift prevention that keeps the graph tools in active rotation. Peer strengths are real; the table credits them where they win.

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

- **~84%** of an AI coding agent's tokens are tool output, mostly file reads (JetBrains, NeurIPS 2025 DL4Code Workshop) — unerr intercepts before the read.
- **0** LLM calls per query in the Free tier — facts, conventions, and drift signals are algorithmic.
- **3–5** turns is how long agents take to revert to built-in Read/Grep/Glob without drift prevention.

Honest acknowledgements: unerr is the new entrant with fewer stars than every peer; the install is heavier than `brew install` (Node + index step); TypeScript is deepest, other languages run on tree-sitter; no semantic vector retrieval and no narrative session resume in the Free tier.

---

## How it works

```
AI Agent (Claude Code / Cursor / Windsurf / any MCP client)
    │
    ├── stdio MCP ──→ unerr --mcp (bridge, per IDE session)
    │                       │
    │                       └── UDS ──→ unerr (long-lived daemon, owns everything)
    │                                       │
    │                                       ├── CozoDB graph     (in-process, <5ms)
    │                                       ├── Fact store       (cross-session memory)
    │                                       ├── Timeline + ledger (every tool call)
    │                                       ├── File watcher     (incremental reindex)
    │                                       ├── Convention engine
    │                                       ├── Compression engine (11 strategies, 645+ classifiers)
    │                                       └── Behavior modules (cascade-guard, loop-breaker, auto-doc…)
    │
    └── Dashboard ──→ http://localhost:<port> (SSE-streamed live)
```

Two processes, one local DB. Zero network calls. No API keys. No cloud. Your code never leaves the machine.

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

### Persistent Memory (2)

| Tool | What the agent gets |
|------|-----|
| `record_fact` | Persist a convention, decision, or anti-pattern |
| `recall_facts` | Retrieve facts with hierarchical scope + decay-adjusted confidence |

### Session Narrative — Markers (4)

Inline markers the agent emits as it works. Persisted to the shadow ledger and `.unerr/timeline.db` — powers turn titles, cross-session intent stitching, the resume strip, and loop/blocker miners.

| Tool | What it does |
|------|-----|
| `mark_intent` | One-sentence task start (≤80 chars). Becomes the turn title |
| `mark_decision` | Records a chosen approach + up to 5 alternatives (≤140 chars) |
| `mark_blocker` | Flags an unresolved obstacle. Carries into the next session's resume strip |
| `mark_resolution` | Resolves a prior blocker by `marker_id` |

Every response includes `_meta` (latency, risk level, drift status) and inline `ur|<tag>` signals for high-priority guidance (drift, blast-radius warnings, circuit-breaker halts).

---

<details>
<summary><strong>CLI commands</strong></summary>

```bash
unerr                 # Start per-repo daemon (or resume; auto-spawned by IDE if missing)
unerr --mcp           # Stdio bridge — what your IDE invokes via .mcp.json
unerr install <agent> # Install MCP config + skills + instructions for one agent
unerr uninstall       # Remove unerr integration from agents in this repo
unerr status          # Show proxy health, entity count, graph age
unerr stats           # Session statistics (tokens, tool calls, compression)
```

**Daemon supervisor** (multi-repo management):

```bash
unerr daemon start              # Start the unerrd supervisor
unerr daemon stop               # Gracefully stop unerrd + all managed repos
unerr daemon status             # Show all managed repos, PIDs, memory, idle time
unerr daemon add <path>         # Register a repo (indexes on next access)
unerr daemon remove <path>      # Unregister a repo
unerr daemon config <path> <k=v> # Set per-repo settings (idleTimeout, javaBuildTool, etc.)
unerr daemon autostart on|off|status  # Manage start-at-login (launchd/systemd/schtasks)
unerr daemon logs [--repo <path>] [--follow]  # Tail daemon/repo logs
unerr daemon dashboard          # Open the unified dashboard in browser
unerr daemon update             # Check for updates, install, restart
```

See the [full command reference](#daemon-command-reference) below.

</details>

<details>
<summary><strong>Architecture</strong></summary>

```
src/
  entrypoints/   CLI entry + boot state machine
  proxy/         MCP server (daemon), stdio↔UDS bridge, session stats, shell compression
  intelligence/  CozoDB graph, AST extraction, conventions, rules, search, semantic
  tracking/      Prompt ledger, drift detection, git attribution
  behaviors/     Cascade guard, loop breaker, auto-doc, change narrative…
  commands/      CLI commands (install, status, stats, timeline, learn, debug, …)
  tools/         MCP tool implementations (intelligence + coding)
  hooks/         Claude Code hook system integration
  skills/        11 bundled skill definitions
  server/ + ui/  HTTP API + React (Vite) dashboard
  config/        Agent registry (16 agents), MCP config writer, instruction injector
  schemas/       Zod schemas
```

**Design principles**

- Zero network calls — fully local, no API keys.
- stdout is sacred — MCP JSON-RPC only; everything else to stderr.
- <5 ms query responses — CozoDB runs in-process (Rust via NAPI).
- First useful output <5 s — shallow index first, deep enrichment in background.
- Graceful degradation — the agent still works if unerr is down, you just lose the intelligence layer.

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

## Daemon Command Reference

The `unerrd` supervisor is a single lightweight process that manages all your registered repositories. It replaces the need to run `unerr` separately in each repo.

### Lifecycle

```bash
unerr daemon start              # Start supervisor (PID-locked, one instance per machine)
unerr daemon stop               # Graceful shutdown — stops all child processes, flushes state
unerr daemon status             # Overview: all repos, their state (running/stopped/idle), PIDs,
                                #   memory usage, connection count, idle time, update notices
```

### Repository Management

```bash
unerr daemon add <path>         # Register a repo with the supervisor
                                #   - Auto-derives a unique label from the directory name
                                #   - Mirrors settings to <repo>/.unerr/config.json
                                #   - Detects parent/child directory conflicts
                                #   - Installs platform auto-start on first add

unerr daemon remove <path>      # Unregister — stops the child process if running, removes entry

unerr daemon config <path> <key>=<value>  # Set per-repo settings:
                                #   idleTimeout=600       seconds before idle sweep stops the repo
                                #   javaBuildTool=gradle  skip detection heuristic
                                #   autostart=false       exclude from warm-start at boot
```

### Auto-Start (Start at Login)

```bash
unerr daemon autostart on       # Install platform service:
                                #   macOS: ~/Library/LaunchAgents/dev.unerr.daemon.plist
                                #   Linux: ~/.config/systemd/user/unerr-daemon.service
                                #   Windows: schtasks /create ... (or Startup folder .cmd)

unerr daemon autostart off      # Remove the platform service
unerr daemon autostart status   # Show whether auto-start is installed and running
```

Auto-start is also installed automatically on your first `unerr install` or `daemon add` — no manual step needed. Skipped in CI/container environments.

### Warm Start

After boot, the supervisor pre-spawns your Most Recently Used repos at low priority:

```bash
unerr daemon set --warm-start-budget 3      # Max repos to warm-start (default: 3)
unerr daemon set --warm-start-idle-days 7   # Skip repos inactive for >N days
unerr daemon set --warm-start-delay-ms 5000 # Delay before warm-start begins
```

Warm-start aborts if the system is on battery or under high load.

### Logs

```bash
unerr daemon logs                     # Tail the supervisor log (~/.unerr/logs/unerrd.log)
unerr daemon logs --repo <path>       # Tail a specific repo's log
unerr daemon logs --bridge            # Tail bridge session logs
unerr daemon logs --follow            # Stream continuously (like tail -f)
unerr daemon logs -n 50              # Last N lines
unerr daemon logs --boot              # Show only the most recent boot sequence
```

### Dashboard

```bash
unerr daemon dashboard          # Opens http://localhost:9847 in your default browser
```

The unified dashboard shows:
- **Global overview** — all registered repos, their health, active sessions
- **Repo switcher** — click into any repo for its full intelligence dashboard
- **Supervisor info** — uptime, memory, warm-start events, version status

### Updates

```bash
unerr daemon update             # Check npm registry → confirm → stop → install → restart → verify
unerr daemon dismiss-update <version>  # Suppress notification for a specific version
```

Update notifications appear as:
- A CLI banner on `unerr daemon status` and `unerr` startup
- A dashboard banner with version diff and changelog link
- An `_meta["dev.unerr/update_available"]` field in MCP responses (when >2 minor versions behind)

Updates are never auto-applied — the agent and supervisor remain stable mid-session.

### How auto-spawn works

When your IDE opens and spawns `unerr --mcp`:

1. Bridge checks for a per-repo UDS socket (`.unerr/state/proxy.sock`)
2. If not found, queries the supervisor's UDS socket (`~/.unerr/state/unerrd.sock`)
3. If supervisor isn't running, auto-spawns it as a detached background process
4. Supervisor ensures the repo is registered and its child process is running
5. Bridge connects — MCP requests flow through

Total cold-start latency (supervisor not running → first MCP response): **<2 seconds**.

---

## License

[Elastic License 2.0 (ELv2)](./LICENSE) — free to use, modify, and distribute. Cannot be offered as a hosted service.

---

<p align="center">
  <code>npm install -g @unerr-ai/unerr</code>
  <br /><br />
  <a href="https://www.unerr.dev/"><sub>unerr.dev</sub></a> · <a href="https://www.npmjs.com/package/@unerr-ai/unerr"><sub>npm registry</sub></a> · <a href="https://discord.gg/2BjRftz8kG"><sub>Discord</sub></a> · <a href="https://x.com/unerr_ai"><sub>X</sub></a> · <a href="https://www.linkedin.com/company/unerr"><sub>LinkedIn</sub></a> · <sub>Fully local. No account. No cloud. Free.</sub>
</p>
