<p align="center">
  <a href="https://www.unerr.dev/"><img src="https://unerr.dev/icon-wordmark.svg" alt="unerr — operational memory for your codebase" width="320" /></a>
</p>

<p align="center">
  <strong>Stop babysitting your AI.</strong>
</p>

<p align="center">
  <strong>unerr is operational memory for your codebase</strong> — one local runtime that sits <em>behind</em> every MCP<br/>
  your coding agent already speaks, carrying a shared code graph, persistent memory,<br/>
  drift detection, and the guardrails the protocol itself doesn't.
</p>

<p align="center">
  <sub><strong>Works with</strong> Cursor · Claude Code · Windsurf · Gemini CLI · Antigravity · GitHub Copilot CLI · and every MCP-compatible client.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@unerr-ai/unerr"><img src="https://img.shields.io/badge/install-npm_i_@unerr--ai/unerr-8B5CF6?style=flat-square&logo=npm" alt="Install" /></a>
  <a href="https://www.unerr.dev/"><img src="https://img.shields.io/badge/website-unerr.dev-8B5CF6?style=flat-square&logo=icloud&logoColor=white" alt="Website" /></a>
  <img src="https://img.shields.io/badge/runtime-Node.js_≥20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/protocol-MCP-7C3AED?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/local--first-no_cloud-22D3EE?style=flat-square" alt="Local-first" />
  <img src="https://img.shields.io/badge/license-ELv2-A1A1AA?style=flat-square" alt="License" />
</p>

<p align="center">
  <code>npm install -g @unerr-ai/unerr</code>
  <br /><br />
  <sub>Zero configuration. Install, restart your IDE, and the next prompt is smarter.</sub>
</p>

<p align="center">
  <sub>Measured, not estimated: removes <strong>86–90%</strong> of the tokens an agent spends navigating code —<br/>
  and wins head-to-head against other code-intelligence tools on the same corpus. <a href="./benchmarks/README.md">See the benchmarks →</a></sub>
</p>

---

## The pains this fixes

You've felt all four of these in the last 48 hours:

- Claude is brilliant for 20 minutes, then hallucinates a duplicate component and forgets the styling rules you set five turns ago.
- More time spent writing `MEMORY.md`, updating `.cursorrules`, and pasting session summaries than writing code.
- The agent reads a 2,000-line file to find a 5-line function, then still doesn't know that function has 24 callers across three services.
- You don't trust the agent to refactor anything important. It treats your codebase like a flat string of text — locally correct, globally wrong.

These aren't four problems. They're one: today's agents are incredibly smart but structurally blind and severely amnesiac. They grep when a senior engineer would check the call graph. They forget on Tuesday what they learned on Monday.

---

## What changes when you install it

| You feel | What unerr does |
|---|---|
| **Trust returns.** The agent runs for an hour without you watching. | Every edit is preceded by a graph lookup. All 24 callers are visible *before* it touches the function. Refactors stop rippling silently. |
| **The babysitter tax disappears.** You delete `MEMORY.md` and `.cursorrules`. | A local fact store remembers what you decided, what failed, and the conventions the team accreted — with decay-adjusted confidence. Open the laptop on Tuesday and the agent already knows what you decided on Monday. |
| **The agent stays sharp at turn 50.** | `file_read({entity})` returns 200 lines instead of 3,000. Shell output is compressed 93% on average. The context window stays uncluttered, so the model isn't fighting "lost in the middle." |
| **Tool sprawl dies.** | One graph, one set of tools, project-aware routing. Five MCP servers no longer compete for the agent's attention. |

**What it looks like in your chat:**

> ⚡ unerr · cascade guard: `PaymentGateway` has 8 callers across 3 services. Call `get_references({direction:'callers'})` before the edit — refactor it locally and 7 sites break silently.

The outcome you get is **agents that behave like senior engineers** — checking dependencies before editing, remembering project history, refusing to thrash on a function they've already failed on three times.

---

## See it in action

Two places unerr shows up so you know it's working — inside the chat, and in a browser.

**Inside the chat.** Every coding turn opens with one line naming what unerr loaded ("loaded a convention you wrote yesterday for `src/proxy/proxy.ts`…") and closes with one line totalling what it saved you ("this turn: 2 catches · ≈ 4.2k tokens saved · +5 turns of headroom this session"). Catches are *named, countable events*, not a ratio.

**In a browser.** A live dashboard at `http://localhost:9847` reads from the same store the agent reads from over MCP — the graph it navigates, the facts it remembers, the tokens it didn't have to chew through, and the score showing which of those facts actually shaped the next answer.

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/dashboard.png" alt="unerr dashboard — live overview" width="300" />
  <br/><sub><strong>Dashboard</strong> · live overview — active sessions, recent tool calls, tokens the agent skipped this turn.</sub>
</p>

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/activity.png" alt="unerr activity — session timeline" width="300" />
  <br/><sub><strong>Activity</strong> · session timeline — every tool call, marker, and catch in order, replayable across sessions.</sub>
</p>

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/token-trace-main.png" alt="unerr token trace" width="300" />
  <br/><sub><strong>Token Trace</strong> · context kept out of the window, broken down by mechanism — graph hits, skipped re-reads, compressed shell output, deduped fetches.</sub>
</p>

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/prompt-trace.png" alt="unerr prompt trace" width="300" />
  <br/><sub><strong>Prompt Trace</strong> · every prompt and the context unerr fed it — what was recalled, and what shaped the response.</sub>
</p>

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/reasoning-quality.png" alt="unerr reasoning quality" width="300" />
  <br/><sub><strong>Reasoning Quality</strong> · which remembered facts actually shaped the next answer — scored, so memory earns its place in context.</sub>
</p>

<p align="center"><sub>More views in the <a href="https://www.unerr.dev/">full dashboard tour</a>.</sub></p>

---

## Quick Start

Three steps. Step 1 is once per machine; steps 2–3 are per repo.

### 1. Install the CLI

```bash
npm install -g @unerr-ai/unerr
```

Puts the `unerr` binary on your PATH. If your shell can't find it (common with nvm, fnm, volta, pnpm), run `unerr doctor` once — it patches your shell config and won't need to run again.

### 2. Install for your agent (per repo)

```bash
cd ~/your-project
unerr install cursor
```

Writes the MCP config, skills, hooks, and instructions for that agent in the current repo. Swap `cursor` for any of the supported agents:

```bash
unerr install claude-code
unerr install cursor
unerr install antigravity
unerr install windsurf
unerr install gemini-cli
unerr install github-copilot-cli
```

Install multiple agents in the same repo — each writes its own config. Idempotent: re-running updates if content changed, skips if identical. Remove with `unerr uninstall`.

### 3. Restart your IDE

Close and reopen your IDE (or start a new chat session). Your agent picks up unerr through MCP — graph-backed tools, persistent memory, shell compression all available immediately.

> **Dashboard:** <http://localhost:9847> — open any time to watch unerr's operational memory at work in real time.

> Need manual setup or any other MCP client? `unerr install --show-instructions <agent>` prints copy-pasteable steps.

---

## Who it's for

- **Vibe coders.** The thing that stops your app from breaking on turn 30 when the AI gets confused.
- **Solo builders.** The continuous thread. Switch from Claude Code in the terminal to Cursor in the IDE — your project memory comes with you.
- **Senior / staff engineers.** The dependency graph, prior incidents, and team conventions a human engineer would already carry in their head — fed to AI on every edit.

---

## Why one runtime, not five separate tools

**unerr is the layer your agents share — sitting *behind* every MCP they already speak.** Every coding agent on your machine — Claude Code, Cursor, Windsurf, Antigravity — speaks MCP. MCP carries tool calls; it does not carry context. Without unerr, every agent rebuilds your codebase's dependency graph, conventions, and prior decisions from scratch — every session, by reading files blindly. With unerr, all of them read the same per-repo runtime over MCP, so your project's graph, memory, and guardrails carry across sessions *and* across IDEs.

The adjacent space already has strong point tools. unerr's job is not to out-feature any of them in their lane — it's to be the single per-repo runtime that joins them.

| Layer | Where point tools live | What unerr adds |
|---|---|---|
| Memory across sessions | claude-mem, Mem0, Zep, Letta | Memory tied to the *current* state of the code — facts get drift signals when the file they're about moves. |
| Code-graph navigation | Graphify, CodeGraphContext, Serena | The graph is read *before every file read* — surgical context instead of 3,000-line dumps. |
| Output compression | RTK, Repomix | Compression is fed through the same MCP runtime as the graph and memory, not a separate tool the agent has to remember to invoke. |
| Convention enforcement | `.cursorrules`, CLAUDE.md hand-maintained | Conventions auto-detected from ≥70% adherence in the code. No file to maintain. |

We deliberately don't ship a feature-by-feature checkmark matrix against the depth leaders on each lane — that's the trap. Mem0 will out-memory us on memory depth; Graphify will out-graph us on graph aesthetics; RTK will out-compress us on shell compression simplicity. The runtime is the join across all four lanes — not the depth on any one.

Three numbers behind the runtime:

- **~84%** of an AI coding agent's tokens are tool output, mostly file reads ([JetBrains, NeurIPS 2025](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)) — unerr intercepts at the read layer, so attention isn't diluted.
- **Tool-selection accuracy collapses 58% → 26% as MCP tools go from 9 to 51** ([LangChain ReAct benchmark](https://blog.langchain.com/react-agent-benchmarking/)) — unerr is one MCP runtime instead of five, freeing the agent's tool-selection budget. Anthropic itself acknowledged this in Jan 2026 by shipping [MCP Tool Search](https://www.anthropic.com/engineering/code-execution-with-mcp) to hide tool definitions until queried.
- **0** LLM calls per query in the core — facts, conventions, drift signals, and graph lookups are all algorithmic. No API keys, no per-turn inference cost, no telemetry.
- **86–90%** of an agent's code-navigation tokens removed in head-to-head benchmarks vs grep+read — real tokenizer, fidelity-gated, reproducible on any repo ([benchmarks](./benchmarks/README.md)).

---

## How the runtime works

One local process per repo. Four slices, joined deterministically — *the joins are the product, not the slices.* Point tools own one slice each. None of them can ship the joins without becoming a per-repo runtime themselves.

| Slice | What's inside | What the join enables |
|---|---|---|
| **Live code graph** | CozoDB · tree-sitter ASTs · SCIP-verified call graphs · 18+ languages · <5ms queries | Read *before every file read*. The agent opens 50 targeted lines and a caller list — not 3,000 lines and a guess. |
| **Anchored memory** | Typed facts · conventions auto-detected at ≥70% adherence · decay-adjusted confidence | Every fact is pinned to a file or entity in the graph. When the code moves, the fact gets a **drift signal** — never silent staleness. |
| **Context delivery** | Shell output compression (93% overall, 645+ command classifiers) · Web fetches (5–10× via Defuddle + BM25) · Entity-targeted file reads | Compression, graph, and memory share one process — the agent doesn't have to remember which tool to invoke for which kind of content. |
| **Behaviour modules** | cascade guard · convention drift · loop breaker · session continuity · auto-doc · change narrative · architecture guard | Each guardrail fires on a *join* — cascade-guard reads the graph before the edit, convention-drift compares new code against memory, loop-breaker watches the timeline. None of these are reachable from a single point tool. |

**The unifying point.** Drift detection requires memory anchored to a live graph. Cascade-guard requires the graph and the edit-intent ledger on the same process. Convention-drift requires the auto-detected pattern store and the new-code stream in the same memory space. These aren't "features" you can buy individually — they're *emergent properties of the runtime*, only available when all four slices live in one per-repo process.

Five disconnected MCP servers — one for memory, one for graph, one for compression, one for tracing, one for skills — burn ~55K tokens of schemas just to *announce themselves* (Anthropic's own engineering example). They can't reach across each other to fire any of these guardrails. That's the difference between a stack and a runtime.

---

<details>
<summary><strong>Under the hood — architecture, CLI commands, MCP tools, dev setup</strong></summary>

### Architecture

```
AI Agent (Claude Code / Cursor / Windsurf / any MCP client)
    │
    ├── stdio MCP ──→ unerr --mcp (bridge, per IDE session)
    │                       │
    │                       └── UDS ──→ unerrd (one lightweight Node process
    │                                           per machine, auto-spawned,
    │                                           exits after 30 min idle)
    │                                       │
    │                                       └── per-repo unerr process(es)
    │                                              ├── CozoDB graph     (in-process, <5ms)
    │                                              ├── Fact store       (cross-session memory)
    │                                              ├── Timeline + ledger (every tool call)
    │                                              ├── File watcher     (incremental reindex)
    │                                              ├── Convention engine
    │                                              ├── Compression engine
    │                                              └── Behavior modules
    │
    └── Dashboard ──→ http://localhost:9847 (SSE-streamed live)
```

One local DB per repo. Zero network calls. No API keys. No cloud. Your code never leaves the machine.

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
```

**Design principles** — zero network calls; stdout is sacred (MCP JSON-RPC only, everything else to stderr); <5 ms query responses; first useful output <5 s (shallow index first, deep enrichment in background); graceful degradation (the agent still works if unerr is down, you just lose the operational memory).

**Tech stack** TypeScript (ESM) · CozoDB (Rust/NAPI) · web-tree-sitter (WASM) · MCP SDK · Ink (React CLI) · React + Vite (dashboard) · tsup · Vitest

### CLI commands

```bash
unerr install <agent>   # MCP config + skills + hooks + instructions for one agent
unerr uninstall         # Remove unerr integration from this repo
unerr doctor            # Check PATH + environment, auto-fix if unerr isn't on all shells
unerr status            # Proxy health, entity count, graph age
unerr stats             # Session statistics (tokens, tool calls, compression)
unerr --mcp             # Stdio bridge — what your IDE invokes via .mcp.json

unerr pm status         # Process manager: PID, uptime, repos, memory, idle countdown
unerr pm logs           # Tail ~/.unerr/logs/unerrd.log
unerr pm dashboard      # Open http://localhost:9847
```

`unerrd` is a lightweight Node process that supervises every registered repo. Your IDE invocation auto-spawns it; it exits cleanly after 30 minutes of no MCP activity. `unerr pm --help` lists the rest.

### MCP tools (20)

Grouped by what the agent gets, not by file:

- **Graph intelligence (8)** — `get_entity`, `get_file`, `get_references`, `get_imports`, `search_code`, `get_conventions`, `get_critical_nodes`, `get_cross_boundary_links`.
- **Structural analysis (3)** — `get_project_stats`, `file_connections`, `get_test_coverage`.
- **File protocol (2)** — `file_read` (context-aware, auto-injects conventions and facts), `file_outline` (structure without body).
- **Persistent memory (3)** — `unerr_remember` (user-stated facts with verbatim quote + confidence), `record_fact` (agent-detected conventions / decisions / anti-patterns), `recall_facts` (hierarchical scope + decay-adjusted confidence).
- **Session markers (4)** — `mark_intent`, `mark_decision`, `mark_blocker`, `mark_resolution`. Inline as the agent works; powers turn titles and the cross-session resume strip.
- **Web fetch (1)** — `fetch_url` (DOM-extracted markdown, BM25 re-ranking, content-hash cache). Replaces built-in WebFetch.

Every response carries inline `ur|<tag>` signals for high-priority guidance — drift, blast-radius warnings, circuit-breaker halts — so the agent acts on what it just learned without burning a turn.

### Manual MCP config (any MCP-compatible client)

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

### Benchmarks

unerr removes **86–90% of the tokens** an agent would otherwise spend navigating and reading code — measured, not estimated, with head-to-head runs against other code-intelligence tools on the same questions, same tokenizer, and a fidelity gate that discards any "saving" that lost the answer. Methodology, reproduction commands, and per-repo results: [benchmarks/README.md](./benchmarks/README.md).

### Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, day-to-day commands, code conventions, and pre-PR checklist.

</details>

---

## License

[Elastic License 2.0 (ELv2)](./LICENSE) — free to use, modify, and distribute. Cannot be offered as a hosted service.

---

<p align="center">
  <code>npm install -g @unerr-ai/unerr</code>
  <br /><br />
  <a href="https://www.unerr.dev/"><sub>unerr.dev</sub></a> · <a href="https://www.npmjs.com/package/@unerr-ai/unerr"><sub>npm registry</sub></a> · <a href="https://discord.gg/2BjRftz8kG"><sub>Discord</sub></a> · <a href="https://x.com/unerr_ai"><sub>X</sub></a> · <a href="https://www.linkedin.com/company/unerr"><sub>LinkedIn</sub></a> · <sub>Fully local. No account. No cloud. Free.</sub>
</p>
