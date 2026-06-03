<h1 align="center">
  <a href="https://www.unerr.dev/"><img src="https://unerr.dev/icon-wordmark.svg" alt="unerr" width="320" /></a>
</h1>

<p align="center">
  <strong>To make a coding agent work well on real code, you end up bolting a bunch of separate things onto it —<br/>
  one to find the right code, one to stop it forgetting, one to trim the clutter, your rules, a few checks to catch<br/>
  mistakes. You set them all up, you keep them running, and it still ignores half of them — because each one is<br/>
  only advice it can skip, and they all pull at its attention at once.</strong>
</p>

<p align="center">
  unerr puts all of that into one piece, built into the way the agent already works — so it's not one more thing the<br/>
  agent can choose to ignore. As the agent goes, it finds the right code, keeps your rules in front of it, trims the<br/>
  clutter, and catches a break before it lands — all together, with nothing for you to set up. The agent wastes less<br/>
  time, money, and attention redoing work, and you waste less of yours setting tools up and cleaning up after it.
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
  <img src="https://img.shields.io/badge/license-Apache--2.0-A1A1AA?style=flat-square" alt="License" />
</p>

<p align="center">
  <code>npm install -g @unerr-ai/unerr</code>
  <br /><br />
  <sub>Install, restart your IDE, and the next prompt already knows your repo. No config, no account, nothing leaves your machine.</sub>
</p>

<p align="center">
  <a href="https://youtu.be/pL1izMwYZpI"><img src="https://unerr.dev/open-cli/video/unerr-cascade.gif" alt="unerr firing inside a live Claude Code session — 12 dependent call sites surfaced before a signature edit" width="760" /></a>
  <br/><sub><strong>Live, inside the agent</strong> · the agent tries to change <code>extractFilePath</code>; before the edit lands, unerr surfaces the <strong>12 places that depend on it across 4 files</strong> — so it fixes every one in the same turn instead of breaking them silently. ▶ <a href="https://youtu.be/pL1izMwYZpI">Watch the full demo</a>.</sub>
</p>

---

<details>
<summary><strong>Contents</strong></summary>

- [Why I built this](#why-i-built-this)
- [What's actually going wrong](#whats-actually-going-wrong)
- [What changes when you use it](#what-changes-when-you-use-it)
- [See it in action](#see-it-in-action)
- [Quick Start](#quick-start)
- [Who it's for](#who-its-for)
- [Why it's one thing and not five plugins](#why-its-one-thing-and-not-five-plugins)
- [What it does under the hood](#what-it-does-under-the-hood)
- [About the fewer tokens](#about-the-fewer-tokens)
- [License](#license)

</details>

---

## Why I built this

I built unerr because I got tired of cleaning up after my own coding agent.

I was running coding agents on real work — not toy projects — and to stop them from messing things up I kept bolting on extra stuff. A memory file here, some rules there, something to keep the agent from forgetting what it was doing, a few guardrails. And two things drove me crazy.

One: setting all that up is its own job, and every one of those things is really just a *suggestion* to the agent. A rule it can acknowledge and then ignore once it gets busy. A memory it has to remember to check. A reviewer that only speaks up after the break is already written. They don't work together — they compete for the agent's attention, and half of them get dropped exactly when you need them.

Two: while all that's going on, the agent is burning time and money redoing work and breaking things it shouldn't have touched — and I'm sitting there babysitting it, because the one time I look away is the time it quietly breaks something that matters.

unerr is the thing I wanted to exist: one piece that does all of that itself, right while the agent is working — so you don't have to assemble a toolchain, or write a flawless prompt every time, or sit through the back-and-forth just to trust what it ships. The agent wastes less of its own time and a lot less of your money, and you spend far less effort watching over it.

It's free, open source, and runs entirely on your machine.

---

## What's actually going wrong

On any codebase big enough to matter, the agent can't hold the whole thing in its head. So it works from the slice it can see and never looks at the rest. It changes a function and breaks the other places that call it — places it never read. It writes a fourth copy of a pattern your team already settled on, even with the rule sitting right there in your `.cursorrules`. Neither of those shows up as an error. They show up later, as your afternoon.

The usual fixes both leak:

- **Things that *tell* the agent stuff** — memory stores, rule files, context tools — only help when the agent remembers to use them. Optional advice is optional, and a busy agent skips it.
- **Things that *check* the agent afterward** — reviewers, linters, CI — only speak up after the code is already written. By then it's a pull-request comment and a second round of work, not a break that never happened.

And every one of these is a separate thing you have to install, configure, and keep current. The more you add, the more they pull against each other for the agent's limited attention, and the more of your time goes into maintaining the setup instead of shipping.

unerr closes that gap by doing the work at the moment it matters — when the agent reads and when it edits — instead of waiting to be asked or waiting to complain after the fact. The agent doesn't have to remember anything. The thing that would have stopped the break is already in front of it, before the change lands.

---

## What changes when you use it

| What you feel | What's happening |
|---|---|
| **You stop babysitting.** The agent runs for an hour and you're not bracing for a silent break. | Before it changes a function, unerr shows it every other place that depends on that function — on its own, without the agent asking. |
| **Your rules finally stick.** The standard you set gets applied at the edit, not acknowledged and forgotten three turns later. | unerr ties each rule to the part of the code it's about and brings it up the moment the agent touches that part — and keeps it pinned there even after the code moves. |
| **It stops going in circles.** No more watching it try the same broken fix three times. | unerr notices when the agent is re-trying something that already failed and stops it before it burns another turn. |
| **It stays sharp deep into a long session.** | unerr hands the agent the small, relevant slice of a file or a command's output instead of dumping thousands of lines into the window, so the model isn't drowning in noise by turn 50. |

Here's what it actually looks like in your chat. Before the edit runs, unerr drops a line like this into the agent's context, on its own:

> ⚡ unerr · editing `src/payments/gateway.ts` changes a function that **24 other places depend on, across 6 files**. Update every one of them in this same change before finishing.

The result is an agent that behaves a lot more like a careful senior engineer: it checks what a change affects before making it, honors the standards you set, and doesn't keep retrying something that already failed.

---

## See it in action

The demo above is one moment, caught live. Day to day, there are two places you watch it working — in the chat, and in a browser.

**In the chat.** Every coding turn opens with one line naming what unerr brought in ("brought in a convention you wrote yesterday for `src/payments/gateway.ts`…") and closes with one line totalling what it caught and saved you. The catches are named, countable events — not a vague percentage.

**In a browser.** A live dashboard at `http://localhost:9847` reads from the same place the agent reads from — what it remembers, what it caught, and which of those things actually shaped the next answer.

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/end-of-turn-receipt.png" alt="unerr end-of-turn receipt — what it caught and saved this turn" width="380" />
  <img src="https://unerr.dev/open-cli/screenshots/end-of-turn-receipt-2.png" alt="unerr end-of-turn receipt — named, countable catches at the close of a turn" width="380" />
  <br/><sub><strong>End-of-turn receipt</strong> · every turn closes with one line totalling what unerr caught and saved you — named, countable, not a ratio.</sub>
</p>

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/token-trace-main.png" alt="unerr token trace — where the agent's tokens went, per turn and per task" width="400" />
  <img src="https://unerr.dev/open-cli/screenshots/reasoning-quality.png" alt="unerr reasoning quality — answer quality held steady while the token count dropped" width="400" />
  <br/><sub><strong>Token trace & reasoning quality</strong> · where the agent's tokens actually went — and that the answer quality held while the count came down. Cost-per-useful-action, not cost-per-token.</sub>
</p>

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/project-memory.png" alt="unerr project memory — anchored notes and facts unerr kept for this repo across sessions" width="400" />
  <img src="https://unerr.dev/open-cli/screenshots/activity.png" alt="unerr activity feed — what unerr caught and surfaced live as the agent worked" width="400" />
  <br/><sub><strong>Memory & activity</strong> · what unerr remembered for this repo across sessions, and a live feed of what it caught and surfaced as the agent worked.</sub>
</p>

---

## Quick Start

Three steps. Step 1 is once per machine; steps 2–3 are per repo.

### 1. Install the CLI

```bash
npm install -g @unerr-ai/unerr
```

Puts the `unerr` binary on your PATH. If your shell can't find it afterward (this happens with nvm, fnm, volta, and pnpm), run `unerr doctor` once — it patches your shell config and won't need to run again.

### 2. Set it up for your agent (per repo)

```bash
cd ~/your-project
unerr install cursor
```

That writes the MCP config, skills, hooks, and instructions for that agent in the current repo. Swap `cursor` for any of the supported agents:

```bash
unerr install claude-code
unerr install cursor
unerr install antigravity
unerr install windsurf
unerr install gemini-cli
unerr install github-copilot-cli
```

You can install more than one agent in the same repo — each writes its own config. Re-running updates the setup if anything changed and skips it if nothing did. Remove it with `unerr uninstall`.

### 3. Restart your IDE

Close and reopen your IDE, or start a new chat session. Your agent picks up unerr through MCP and everything is available from the next prompt.

> **Dashboard:** <http://localhost:9847> — open it any time to watch unerr work.

> Using a different MCP client, or setting it up by hand? `unerr install --show-instructions <agent>` prints copy-pasteable steps.

---

## Who it's for

- **Engineers working in large, existing codebases.** The things a senior engineer keeps in their head — what depends on what, which patterns are load-bearing, what broke here before — handed to the agent before every edit, so it stops breaking code it never read.
- **Teams with conventions worth keeping.** The standard you agreed on once, applied every time the agent touches that part of the code — no rules file to hand-maintain, re-paste, or fight merge conflicts over, and no hoping the agent remembers to look.
- **Solo builders and vibe coders shipping into a codebase that's already grown.** One continuous thread across your tools — move from Claude Code in the terminal to Cursor in the IDE and what unerr knows about your repo comes with you, instead of relearning it every session.

---

## Why it's one thing and not five plugins

This is the part that took me a while to get right, so it's worth saying plainly.

Every coding agent on your machine speaks the same protocol, MCP. MCP carries requests the agent *chooses* to make — it doesn't hand the agent context on its own, and it doesn't fire anything by itself. So a memory plugin, a code-search plugin, and a context trimmer all just sit there waiting to be called. And an agent that's busy or low on room skips the thing it has to remember to call. That's the whole leak.

unerr doesn't sit and wait. It steps in at the moments that matter — when the agent reads a file, when it's about to make a change — and puts the one relevant thing in front of it automatically. You can't forget to call something that isn't waiting to be called.

The catch is that this only works if the pieces live together, because the useful ones each need information no single plugin has on its own:

- Catching a breaking change needs to know both *what the agent is about to edit* and *what depends on it* — at the same instant.
- Knowing a saved rule has gone stale needs that rule tied to the actual code, so it notices the moment the code moves.
- Spotting a convention slipping needs both the patterns your codebase already uses and the new code being written, side by side.
- Stopping a retry-loop needs the full history of what the agent already tried this session.

You can't buy those as five separate tools and bolt them together — they only exist when everything lives in one place. That's why unerr is one local thing, not a fifth plugin in your agent's list. And one thing instead of five means the agent isn't spending its attention deciding which plugin to call — a real cost once that list gets long. Researchers have measured a routine set of these add-ons eating [more than 20% of an agent's context window before it does any actual work](https://eclipsesource.com/blogs/2026/01/22/mcp-context-overload/).

(This isn't an MCP gateway that bundles your existing servers behind one address — those still hand the agent every tool up front. unerr replaces what those add-ons *do*, so there's nothing left to bundle.)

---

## What it does under the hood

One local process per repo. You don't have to think about any of this to use it — but if you want to know what's actually running, here it is.

| The piece | What's in it | What it gives the agent |
|---|---|---|
| **A live map of your code** | CozoDB · tree-sitter · SCIP-verified call data · 18+ languages · sub-5ms lookups | Before any file read, the agent gets the 50 lines that matter and the list of what depends on them — not 3,000 lines and a guess. |
| **Memory tied to the code** | typed facts · conventions auto-detected once a pattern holds ≥70% of the time · confidence that decays over time | Every saved fact is pinned to a real file or function. When that code moves, the fact flags itself instead of quietly going wrong. |
| **The right slice, delivered automatically** | shell-output trimming (645+ command types) · web pages fetched at 5–10× less bulk · function-targeted file reads | The relevant piece shows up at the moment the agent reads — it never has to remember which tool to reach for. |
| **The behaviors that catch problems** | breaking-change guard · convention-slip guard · retry-loop breaker · session continuity · auto-doc · change narrative · architecture guard | Each one fires on a combination of the three above, *at the moment of the edit* — not as a tool the agent picked, not as a review after the fact. |

<details>
<summary><strong>Architecture, CLI commands, MCP tools, manual config, dev setup</strong></summary>

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

**Design principles** — zero network calls; stdout is sacred (MCP JSON-RPC only, everything else to stderr); sub-5ms query responses; first useful output in under 5s (shallow index first, deep enrichment in the background); graceful degradation (the agent still works if unerr is down — you just lose the extra layer).

**Tech stack** — TypeScript (ESM) · CozoDB (Rust/NAPI) · web-tree-sitter (WASM) · MCP SDK · Ink (React CLI) · React + Vite (dashboard) · tsup · Vitest

### CLI commands

```bash
unerr install <agent>   # MCP config + skills + hooks + instructions for one agent
unerr uninstall         # Remove unerr from this repo
unerr doctor            # Check PATH + environment, auto-fix if unerr isn't on all shells
unerr status            # Process health, entity count, graph age
unerr stats             # Session statistics (tokens, tool calls, compression)
unerr --mcp             # Stdio bridge — what your IDE invokes via .mcp.json

unerr pm status         # Process manager: PID, uptime, repos, memory, idle countdown
unerr pm logs           # Tail ~/.unerr/logs/unerrd.log
unerr pm dashboard      # Open http://localhost:9847
```

`unerrd` is a lightweight Node process that supervises every registered repo. Your IDE invocation auto-spawns it; it exits cleanly after 30 minutes of no activity. `unerr pm --help` lists the rest.

### MCP tools (16 advertised)

Grouped by what the agent gets, not by file:

- **Reads (11)** — `search_code`, `file_outline` (structure without body), `file_read` (context-aware, auto-injects conventions, facts, and drift), `get_entity` (signature plus callers / callees / imports in one call), `get_references` (callers or callees — catches indirect refs grep misses), `get_conventions`, `get_critical_nodes`, `get_test_coverage`, `get_project_stats`, `fetch_url` (DOM-extracted markdown, BM25 re-ranking, content-hash cache — replaces built-in WebFetch), and `unerr_context` (one call that folds anchored notes + search + references + conventions for what you're about to edit).
- **Memory & session (5)** — `unerr_remember` (user-stated facts and anchored notes with verbatim quote + confidence), `unerr_recall_notes` (anchored notes for the current prompt), `unerr_track` (one op-union call for intent / decision / blocker / resolution / fact / recall — powers turn titles and the cross-session resume strip), plus the per-turn `unerr_surface2_line` and `unerr_turn_summary` economy lines.

On Claude Code the always-on ceremony runs for free: a UserPromptSubmit hook injects recalled notes, a PostToolUse hook injects detected conventions on the first file read, and a Stop hook prints the turn close-out — all at zero extra round-trip, so the agent never spends a call on them. Eleven more tools stay dispatchable as a fallback for agents without hooks (and as an explicit high-fidelity escape): the six session writes (`mark_intent`, `mark_decision`, `mark_blocker`, `mark_resolution`, `record_fact`, `recall_facts`) fold into `unerr_track`; `get_file`, `get_imports`, `file_connections`, and `get_cross_boundary_links` collapse into `file_outline`, `get_entity`, and `get_references`; and `review_changes` runs from the `unerr review` CLI.

Every response carries inline `ur|<tag>` signals for high-priority guidance — drift, breaking-change warnings, loop-breaker halts — so the agent acts on what it just learned without burning a turn.

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

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, day-to-day commands, code conventions, and the pre-PR checklist.

</details>

---

## About the fewer tokens

I didn't build unerr to save tokens — I built it to stop bad changes. But a tool that only ever hands the agent the one relevant thing — the rule for the function in front of it, 50 lines instead of 3,000 — ends up spending far fewer tokens almost by accident. So you get that too:

- **86–90%** of an agent's code-navigation tokens removed in head-to-head benchmarks against grep-and-read — real tokenizer, fidelity-gated, reproducible on any repo. [See the benchmarks →](./benchmarks/README.md)
- Roughly **84%** of an agent's tokens are tool output, mostly file reads ([JetBrains, NeurIPS 2025](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)). unerr steps in at the read, so the window doesn't fill up with noise.
- **0** AI calls per query in the core — the lookups, facts, and warnings are all computed directly. No API keys, no per-turn inference cost, no telemetry.

But the token number was never the point. The point is that the agent lands on the right code, sees the thing that would have stopped the break, and you stop paying — in money *and* in afternoons — for work it would otherwise have had to undo.

---

## License

[Apache License 2.0](./LICENSE) — free to use, modify, and distribute, including commercially. Includes an explicit patent grant.

---

<p align="center">
  <code>npm install -g @unerr-ai/unerr</code>
  <br /><br />
  <a href="https://www.unerr.dev/"><sub>unerr.dev</sub></a> · <a href="https://www.npmjs.com/package/@unerr-ai/unerr"><sub>npm registry</sub></a> · <a href="https://discord.gg/2BjRftz8kG"><sub>Discord</sub></a> · <a href="https://x.com/unerr_ai"><sub>X</sub></a> · <a href="https://www.linkedin.com/company/unerr"><sub>LinkedIn</sub></a> · <sub>Fully local. No account. No cloud. Free.</sub>
</p>
