<h1 align="center">
  <a href="https://www.unerr.dev/"><img src="https://unerr.dev/icon-wordmark.svg" alt="unerr" width="320" /></a>
</h1>

<p align="center">
  <strong>Your AI agent has read your codebase. It still can't safely change it.</strong>
</p>

<p align="center">
  On a large, existing codebase your agent can't hold the whole thing in context — so it breaks callers it never read<br/>
  and rebuilds patterns your team already standardized, even with the rule written down. <strong>unerr is a guardrail<br/>
  your agent reaches over MCP</strong> that, the moment it edits, hands it the live call graph <em>plus the rule you pinned to that<br/>
  exact function</em> — a rule that re-anchors itself when the code moves instead of going stale. So it sees the 24 callers,<br/>
  and the standard it's about to violate, <em>before</em> it touches the function.
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
  <sub>Zero configuration. Install, restart your IDE, and the next prompt already knows your repo.</sub>
</p>

<p align="center">
  <sub><strong>It nets your context down, not up.</strong> Five separate MCP servers burn ~55K tokens of schemas just to announce themselves;<br/>
  unerr is one runtime whose tools load on demand, and each edit injects a single scoped line — the rule for the entity in front of it.<br/>
  Measured: the agent lands on the right code with <strong>86–90% fewer tokens</strong>, same corpus, same tokenizer, with a fidelity gate<br/>
  that discards any "saving" that lost the answer. <a href="./benchmarks/README.md">See the benchmarks →</a></sub>
</p>

---

<details>
<summary><strong>Contents</strong></summary>

- [Agents read your code. They can't safely change it.](#agents-read-your-code-they-cant-safely-change-it)
- [The pains this fixes](#the-pains-this-fixes)
- [What changes when you install it](#what-changes-when-you-install-it)
- [See it in action](#see-it-in-action)
- [Quick Start](#quick-start)
- [Who it's for](#who-its-for)
- [Why one runtime, not five separate tools](#why-one-runtime-not-five-separate-tools)
- [How the runtime works](#how-the-runtime-works)
- [License](#license)

</details>

---

## Agents read your code. They can't safely change it.

On a small or greenfield project the agent holds the whole repo in its head and grepping the live code is enough — you don't need us. The wall is the *large, existing, multi-contributor* codebase, and it's the same wall every time: the agent can't fit the whole thing in context, so it acts on the slice it can see and never reads the rest.

So it ships damage that looks locally correct. It changes a signature and breaks the 24 callers it never read. It writes a fourth copy of a registry pattern your team standardized months ago — even with the rule spelled out in `.cursorrules`. Neither shows up as an error. They show up as a senior engineer's afternoon.

The knowledge that would have stopped it — who calls this function, which pattern is load-bearing — exists. It's just nowhere the agent can reach *at the moment it edits*: in a call graph it doesn't build, and conventions it was never told.

**unerr is the guardrail that closes that gap.** One local runtime your agent reaches over MCP, that hands it the call graph and the rules you anchored to each entity the moment it edits — and re-anchors those rules when the code moves, so they never go silently stale. A change that would break 7 call sites is caught before it lands; a standard you set once is enforced every time the agent touches that scope.

| The old way | With unerr |
|---|---|
| The agent changes a function without reading its 24 callers — 7 sites break silently. | **Cascade guard** reads the call graph *before* the edit; every caller is on screen first. |
| The agent ships a fourth copy of a pattern your team standardized — the rule in `.cursorrules` was never honored. | **Anchored rules** surface the standard the moment the agent touches that scope, and re-anchor when the code moves instead of going silently stale. |
| Five single-purpose MCP servers — memory, graph, compressor — that can't reach across each other. | **One runtime** — cascade guard, convention drift, and a loop breaker (*stops the agent re-trying a fix that already failed twice*) fire on joins no point tool can make. |

---

## The pains this fixes

If you're maintaining a large, existing codebase, you've hit these — and they get *worse* as the repo grows, not better:

- The agent is sharp for 20 minutes, then writes a second implementation of something you already have, because it never saw the first.
- You don't trust it to change anything load-bearing. It treats your codebase as a flat string of text — locally correct, globally wrong.
- It reads a 2,000-line file to find a 5-line function, then still doesn't know that function has 24 callers in six other files.
- The rule you wrote in `.cursorrules` gets acknowledged, then ignored a few turns later once the context fills up.

These aren't four problems. They're one: **your agent acts on a codebase it can't hold in context, with no idea what each change will break or which rule it's about to violate.**

---

## What changes when you install it

| You feel | What unerr does |
|---|---|
| **Trust returns.** The agent runs for an hour without you watching. | Every edit is preceded by a graph lookup. All 24 callers are visible *before* it touches the function. Refactors stop rippling silently. |
| **Your rules finally get honored.** The standard you set is enforced at the edit, not acknowledged and forgotten once context fills up. | unerr anchors each rule and decision to the file or entity it governs and surfaces it the instant the agent touches that scope — then re-anchors it when the code moves, so it never goes silently stale. Keep your `.cursorrules` and specs; unerr makes sure they're applied. |
| **The agent stays sharp at turn 50.** | `file_read({entity})` returns 200 lines instead of 3,000. Shell output is compressed 93% on average. The context window stays uncluttered, so the model isn't fighting "lost in the middle." |
| **Tool sprawl dies.** | One graph, one set of tools, project-aware routing. Five MCP servers no longer compete for the agent's attention. |

**What it looks like in your chat** — before the Edit tool runs, unerr injects this into the agent's context:

> ⚡ unerr · cascade guard: editing `src/payments/gateway.ts` changes a signature with callers that must be updated in the same change — `processPayment`: **24 callers at risk across 6 files** (19 source, 5 test). Call `get_references({key:'processPayment', direction:'callers'})` and update every caller before finishing.

The outcome you get is **agents that behave like senior engineers** — checking dependencies before editing, remembering project history, refusing to thrash on a function they've already failed on three times.

---

## See it in action

**Watch it run** — a real Claude Code session in this repo. The agent attempts a signature change to `extractFilePath`; *before* the edit lands, unerr surfaces **12 callers at risk across 4 files**, so the agent updates every one of them in the same turn instead of breaking them silently.

<p align="center">
  <a href="https://youtu.be/pL1izMwYZpI"><img src="https://unerr.dev/open-cli/video/unerr-cascade.gif" alt="unerr cascade guard firing inside a live Claude Code session — 12 callers surfaced before a signature edit" width="760" /></a>
  <br/><sub><strong>Cascade guard, live</strong> · unerr catches the 12 callers of <code>extractFilePath</code> before the edit ripples. ▶ <a href="https://youtu.be/pL1izMwYZpI">Watch the full demo on YouTube</a>.</sub>
</p>

Two places unerr shows up so you know it's working — inside the chat, and in a browser.

**Inside the chat.** Every coding turn opens with one line naming what unerr loaded ("loaded a convention you wrote yesterday for `src/payments/gateway.ts`…") and closes with one line totalling what it saved you ("this turn: 2 catches · ≈ 4.2k tokens saved · +5 turns of headroom this session"). Catches are *named, countable events*, not a ratio.

**In a browser.** A live dashboard at `http://localhost:9847` reads from the same store the agent reads from over MCP — the graph it navigates, the facts it remembers, the tokens it didn't have to chew through, and the score showing which of those facts actually shaped the next answer.

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/end-of-turn-receipt.png" alt="unerr end-of-turn receipt — tokens saved and headroom kept open this turn" width="380" />
  <img src="https://unerr.dev/open-cli/screenshots/end-of-turn-receipt-2.png" alt="unerr end-of-turn receipt — named, countable catches totalled at the close of a turn" width="380" />
  <br/><sub><strong>End-of-turn receipt</strong> · every coding turn closes with one line totalling what unerr saved you — named, countable catches, not a ratio.</sub>
</p>

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/dashboard.png" alt="unerr dashboard — live overview" width="300" />
  <br/><sub><strong>Dashboard</strong> · live overview — active sessions, recent tool calls, tokens the agent skipped this turn.</sub>
</p>

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/token-trace-main.png" alt="unerr token trace" width="300" />
  <br/><sub><strong>Token Trace</strong> · context kept out of the window, broken down by mechanism — graph hits, skipped re-reads, compressed shell output, deduped fetches.</sub>
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

> **Dashboard:** <http://localhost:9847> — open any time to watch unerr's operational intelligence at work in real time.

> Need manual setup or any other MCP client? `unerr install --show-instructions <agent>` prints copy-pasteable steps.

---

## Who it's for

- **Engineers on large, existing codebases.** The dependency graph, the load-bearing patterns, and the prior incidents a senior engineer carries in their head — handed to the agent before every edit, so it stops breaking callers it never read.
- **Teams with conventions worth enforcing.** The standard you agreed on once, applied every time the agent touches that scope — no `.cursorrules` file to hand-maintain, re-paste, or merge-conflict over.
- **Solo builders shipping into a codebase that's already grown.** The continuous thread across tools — switch from Claude Code in the terminal to Cursor in the IDE and the graph, rules, and history come with you, instead of relearning the repo every session.

---

## Why one runtime, not five separate tools

**unerr is the layer your agents share — sitting *behind* every MCP they already speak.** Every coding agent on your machine — Claude Code, Cursor, Windsurf, Antigravity — speaks MCP. MCP carries tool calls; it does not carry context. Without unerr, every agent rebuilds your codebase's dependency graph, conventions, and prior decisions from scratch — every session, by reading files blindly. With unerr, all of them read the same per-repo runtime over MCP, so your project's graph, memory, and guardrails carry across sessions *and* across IDEs.

The adjacent space already has strong point tools. unerr's job is not to out-feature any of them in their lane — it's to be the single per-repo runtime that joins them.

| Layer | Where point tools live | What unerr adds |
|---|---|---|
| Memory across sessions | dedicated memory tools | Memory tied to the *current* state of the code — facts get drift signals when the file they're about moves. |
| Code-graph navigation | dedicated code-graph tools | The graph is read *before every file read* — surgical context instead of 3,000-line dumps. |
| Output compression | dedicated compression tools | Compression is fed through the same MCP runtime as the graph and memory, not a separate tool the agent has to remember to invoke. |
| Convention enforcement | `.cursorrules`, CLAUDE.md hand-maintained | Conventions auto-detected from ≥70% adherence in the code. No file to maintain. |

We deliberately don't ship a feature-by-feature checkmark matrix against the depth leaders on each lane — that's the trap. A dedicated memory tool will out-memory us on memory depth; a dedicated code-graph tool will out-graph us on graph aesthetics; a dedicated compressor will out-compress us on shell compression simplicity. The runtime is the join across all four lanes — not the depth on any one.

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

Full module map and source-tree breakdown: **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)**.

**Design principles** — zero network calls; stdout is sacred (MCP JSON-RPC only, everything else to stderr); <5 ms query responses; first useful output <5 s (shallow index first, deep enrichment in background); graceful degradation (the agent still works if unerr is down, you just lose the operational intelligence layer).

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

### MCP tools (22)

Grouped by what the agent gets, not by file:

- **Graph intelligence (8)** — `get_entity`, `get_file`, `get_references`, `get_imports`, `search_code`, `get_conventions`, `get_critical_nodes`, `get_cross_boundary_links`.
- **Structural analysis (3)** — `get_project_stats`, `file_connections`, `get_test_coverage`.
- **File protocol (2)** — `file_read` (context-aware, auto-injects conventions and facts), `file_outline` (structure without body).
- **Persistent memory (3)** — `unerr_remember` (user-stated facts with verbatim quote + confidence), `record_fact` (agent-detected conventions / decisions / anti-patterns), `recall_facts` (hierarchical scope + decay-adjusted confidence).
- **Session markers (4)** — `mark_intent`, `mark_decision`, `mark_blocker`, `mark_resolution`. Inline as the agent works; powers turn titles and the cross-session resume strip.
- **Web fetch (1)** — `fetch_url` (DOM-extracted markdown, BM25 re-ranking, content-hash cache). Replaces built-in WebFetch.
- **Code review (1)** — `review_changes` (graph-evidenced review of a diff — flags breaking callers, contract drift, duplicate logic).

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

unerr removes **86–90% of the tokens** an agent would otherwise spend navigating and reading code — measured, not estimated, across the same questions and the same tokenizer, with a fidelity gate that discards any "saving" that lost the answer. Methodology, reproduction commands, and per-repo results: [benchmarks/README.md](./benchmarks/README.md).

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
