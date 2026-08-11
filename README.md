<h1 align="center">
  <a href="https://www.unerr.dev/"><img src="https://unerr.dev/icon-wordmark.svg" alt="unerr" width="320" /></a>
</h1>

<p align="center">
  <strong>The local runtime for your coding agents.</strong>
</p>

<p align="center">
  Node gives your code one predictable place to run. unerr gives your coding agents one<br/>
  predictable place to work — the live call graph, your team's rules, and edit-time guardrails,<br/>
  in the agent's loop, on your machine, the same across every agent and every repo.
</p>

<p align="center">
  <sub><strong>One install wires up every agent you run.</strong> No five-plugin toolchain to assemble and keep current — one local layer that finds the right code, keeps your rules in front of the agent, trims the noise out of reads, and catches a breaking change before the edit lands. It plugs into the agents you already use; it is <strong>not a new IDE and not a new model</strong>.</sub>
</p>

<p align="center">
  <strong>Cut what they cost</strong> · <strong>Measure what they produce</strong> · <strong>Keep them inside your rules</strong>
</p>

<p align="center">
  <sub>Running more than one agent? unerr is the one view across all of them — what they spend, catch, and change. The same view across a whole team is <a href="#you-today-your-team-soon">arriving soon</a>.</sub>
</p>

<p align="center">
  <sub><strong>Works with</strong> Cursor · Claude Code · Codex · Windsurf · Cline · Gemini CLI · Antigravity · GitHub Copilot CLI · and every MCP-compatible client.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@unerr-ai/unerr"><img src="https://img.shields.io/badge/install-npm_i_@unerr--ai/unerr-8B5CF6?style=flat-square&logo=npm" alt="Install" /></a>
  <a href="https://www.unerr.dev/"><img src="https://img.shields.io/badge/website-unerr.dev-8B5CF6?style=flat-square&logo=icloud&logoColor=white" alt="Website" /></a>
  <img src="https://img.shields.io/badge/runtime-Node.js_≥20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/protocol-MCP-7C3AED?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/local--first-runs_offline-22D3EE?style=flat-square" alt="Local-first" />
  <a href="./METRICS.md"><img src="https://img.shields.io/badge/metrics-CC_BY_4.0-34D399?style=flat-square" alt="Open metric definitions" /></a>
</p>

<p align="center">
  <code>curl -fsSL https://raw.githubusercontent.com/unerr-ai/unerr/main/install | bash</code>
  <br /><sub>or <code>brew install unerr-ai/tap/unerr</code> · <code>npm install -g @unerr-ai/unerr</code> · <a href="./INSTALL.md">all platforms →</a></sub>
  <br /><br />
  <sub>One self-contained binary — no Node to match, nothing to compile. Install, restart your IDE, and the next prompt already knows your repo. No config, no account, and your code never leaves your machine.</sub>
</p>

<p align="center">
  <a href="https://youtu.be/pL1izMwYZpI"><img src="https://unerr.dev/open-cli/video/unerr-cascade.gif" alt="unerr firing inside a live Claude Code session — 12 dependent call sites surfaced before a signature edit" width="760" /></a>
  <br/><sub><strong>Live, inside the agent</strong> · the agent tries to change <code>extractFilePath</code>; before the edit lands, unerr surfaces the <strong>12 places that depend on it across 4 files</strong> — so it fixes every one in the same turn instead of breaking them silently. ▶ <a href="https://youtu.be/pL1izMwYZpI">Watch the full demo</a>.</sub>
</p>

---

<details>
<summary><strong>Contents</strong></summary>

- [What it actually is](#what-it-actually-is)
- [Why one runtime instead of five plugins](#why-one-runtime-instead-of-five-plugins)
- [What it gives you](#what-it-gives-you)
- [Quick Start](#quick-start)
- [See it in action](#see-it-in-action)
- [You today, your team soon](#you-today-your-team-soon)
- [Account](#account)
- [Metrics](./METRICS.md) · [Your data](./docs/DATA.md) · [Privacy](./PRIVACY.md)
- [Who it's for](#who-its-for)
- [What it does under the hood](#what-it-does-under-the-hood)
- [About the fewer tokens](#about-the-fewer-tokens)

</details>

---

## What it actually is

**unerr is not a new IDE and not a new model.** Runtime is the *role* it borrows, not the mechanism — the way Node or Docker gives code one predictable place to run, unerr gives every coding agent on your machine one predictable layer to work through. Its safety comes from a live code graph, rules tied to the code, and checks that run in the agent's loop; it plugs into the agents you already use instead of replacing them. Here's the literal version in one breath.

Every coding agent on your machine — Cursor, Claude Code, Copilot, Windsurf — speaks the same protocol, MCP. unerr sits in that one path, on your machine, and does four jobs *while the agent works* instead of waiting to be asked:

- finds the right code and hands the agent the 50 lines that matter, not 3,000;
- keeps your rules pinned to the code they're about and brings them up at the edit;
- trims long command output and file reads down to the slice the agent needs;
- catches a change that would break callers it never read — before the edit lands.

One install does all four, for every agent you run, on every repo. No rules file to hand-maintain, no five-plugin toolchain to keep current, nothing the agent has to remember to call. That's the whole product. Everything below is detail.

It runs entirely on your machine — **the one runtime behind every agent you run**, here today. The same runtime extends to a shared view across your whole team, [arriving soon](#you-today-your-team-soon) — and your individual setup carries straight over.

---

## Why one runtime instead of five plugins

To make an agent behave on real code, the usual answer is to bolt on separate tools — one to search code, one for memory, one to trim output, your rules, a reviewer. Five point tools to wire up, keep current, and hope the agent calls. Two things go wrong with that, every time.

**MCP only carries requests the agent *chooses* to make.** A memory plugin, a code-search plugin, a context trimmer — they all just sit there waiting to be called, and a busy agent low on room skips the one it has to remember to call. Optional advice is optional.

**Every tool you add costs the agent attention before it does any work.** GitHub's own MCP server spends [~42,000 tokens just defining its tools](https://eclipsesource.com/blogs/2026/01/22/mcp-context-overload/) before the first request; a handful of servers together can eat the majority of the context window. The more you add, the worse each one performs.

unerr doesn't sit and wait. It steps in at the moments that matter — when the agent reads a file, when it's about to make a change — and puts the one relevant thing in front of it on its own. You can't forget to call something that isn't waiting to be called.

And the useful behaviors only exist when the pieces live together, because each needs information no single plugin has alone:

| To do this… | …it needs, at the same instant |
|---|---|
| Catch a breaking change | what the agent is about to edit **and** everything that depends on it |
| Know a saved rule has gone stale | that rule tied to real code, so it notices the moment the code moves |
| Spot a convention slipping | the patterns your codebase already uses **and** the new code being written |
| Stop a retry-loop | the full history of what the agent already tried this session |

You can't buy those as five separate tools and bolt them together. That's why unerr is one local runtime, not a fifth plugin in the list — and why one thing instead of five also means the agent isn't burning attention deciding which plugin to call.

> This isn't an MCP gateway that bundles your existing servers behind one address — those still hand the agent every tool up front. unerr replaces what those add-ons *do*, so there's nothing left to bundle.

---

## What it gives you

Three jobs, one install — across every agent and every repo on your machine, with no dashboard-per-tool to keep checking. (Running a team? The same three roll up into one shared view — [arriving soon](#you-today-your-team-soon).)

### ⚡ Cut what the agents cost to run

Because unerr only ever hands the agent the one relevant thing — the rule for the function in front of it, 50 lines instead of 3,000 — it spends far fewer tokens getting there. In head-to-head benchmarks against grep-and-read, unerr removes **86–90% of the tokens an agent spends reading and navigating code** — same questions, same tokenizer, with a fidelity gate that throws out any "saving" that lost the answer.

That number is the read/navigate slice, not a promise about your whole bill. It's measured, not estimated, and you can [reproduce it on your own repo](https://github.com/unerr-ai/unerr-benchmarks).

### 📊 Measure what they produce

Usage dashboards tell you tokens went out. They don't tell you whether the spending produced anything that lasted. unerr computes both halves on your machine, from your own git history and session records:

| Metric | What it answers |
|---|---|
| [Code survival](./METRICS.md#code-survival) | Of the lines added in the last 30 or 90 days, how many are still here — agent-written versus human-written. |
| [Durability score](./METRICS.md#durability-score) | Which functions an agent keeps rewriting, measured by whether its change was still untouched a day later. |
| [Cache hit rate](./METRICS.md#cache-hit-rate) | How much of a session's input was reused rather than paid for again. |
| [Re-read amplification](./METRICS.md#re-read-amplification) | How many times the average cached token got billed back — the number that makes context expensive. |
| [Self-correction patterns](./METRICS.md#self-correction-patterns) | Which parts of your codebase agents get wrong on the first try and immediately come back to. |

Every definition, including what each metric deliberately ignores, is in [METRICS.md](./METRICS.md) under CC BY 4.0. Today this is a mirror for your own work, not a scorecard. Shared team views stay aggregate when they land — **never per-developer ranking.**

### 📐 Keep them inside your rules

A rules file is something an agent can acknowledge and then skip three turns later. unerr ties each rule to the part of the code it's about, brings it up the moment the agent touches that part, and keeps it pinned there even after the code moves. Conventions it detects on its own once a pattern holds across the codebase become rules without you writing them down. One standard, applied the same way across every agent you run and every session — Cursor today, Claude Code tomorrow, same rule.

Today those rules are enforced on your machine, for your work. Making them enforceable across a whole team is the paid part, [described below](#you-today-your-team-soon).

### Your data

Everything above is computed from files inside your own repository, in a documented and versioned format. It stays there unless you log in on a paid plan. [What's in it and how to read it →](./docs/DATA.md)

---

## Quick Start

Three steps. Step 1 is once per machine; steps 2–3 are per repo.

### 1. Install the CLI

unerr ships as a single self-contained binary — the runtime, the graph engine, the watcher, and the parsers are all baked in, so there's no Node version to match and nothing to compile. Pick the line for your platform:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/unerr-ai/unerr/main/install | bash

# macOS (Homebrew)
brew install unerr-ai/tap/unerr

# Windows (PowerShell)
irm https://raw.githubusercontent.com/unerr-ai/unerr/main/install.ps1 | iex

# Windows (Scoop)
scoop bucket add unerr https://github.com/unerr-ai/scoop-bucket && scoop install unerr

# Node users / CI (installs the same binary via a thin wrapper; needs Node ≥18)
npm install -g @unerr-ai/unerr
```

Any of these puts the `unerr` binary on your PATH. If your shell can't find it afterward, run `unerr doctor` once — it patches your shell config and won't need to run again. Full per-platform notes (supported architectures, version pinning, uninstall) are in [INSTALL.md](./INSTALL.md).

### 2. Set it up for your agent (per repo)

```bash
cd ~/your-project
unerr install cursor
```

That writes the MCP config, skills, hooks, and instructions for that agent in the current repo. Swap `cursor` for any supported agent:

```bash
unerr install claude-code
unerr install cursor
unerr install antigravity
unerr install windsurf
unerr install gemini-cli
unerr install github-copilot-cli
```

You can install more than one agent in the same repo — each writes its own config. Re-running updates the setup if anything changed and skips it if nothing did. Remove it with `unerr uninstall`.

**Claude Cowork and ChatGPT Work work differently.** They handle documents, not code, so there is no repo to set up — you install a plugin into the app instead, and nothing lands in your project. [How to install it](./INSTALL.md#work-agents--install-a-plugin).

### 3. Restart your IDE

Close and reopen your IDE, or start a new chat session. Your agent picks up unerr through MCP and everything is available from the next prompt — the context and catches show up inline in the chat, no dashboard to open.

> Using a different MCP client, or setting it up by hand? `unerr install --show-instructions <agent>` prints copy-pasteable steps.

---

## See it in action

The demo at the top is one moment, caught live. Day to day, you watch it working in the chat, on every turn.

Before an edit runs, unerr drops a line into the agent's context on its own:

> ⚡ unerr · editing `src/payments/gateway.ts` changes a function that **24 other places depend on, across 6 files**. Update every one of them in this same change before finishing.

Every turn opens with one line naming what unerr brought in and closes with one line totalling what it caught and saved — named, countable catches, not a vague percentage.

<p align="center">
  <img src="https://unerr.dev/open-cli/screenshots/end-of-turn-receipt.png" alt="unerr end-of-turn receipt — what it caught and saved this turn" width="380" />
  <img src="https://unerr.dev/open-cli/screenshots/end-of-turn-receipt-2.png" alt="unerr end-of-turn receipt — named, countable catches at the close of a turn" width="380" />
  <br/><sub><strong>End-of-turn receipt</strong> · every turn closes with one line totalling what unerr caught and saved you — named, countable, not a ratio.</sub>
</p>

---

## You today, your team soon

Today unerr is the local runtime behind the agents **you** run: the code map, the five MCP tools, and all the in-loop behaviors — local, no account needed, across your tools and your repos.

The same runtime extends to your whole team — one shared view across every engineer's agents — and that's **arriving soon.** Your individual setup carries straight over; there's nothing to redo when it lands. The same local data that answers these questions for you answers them for a team: what your AI-assisted work costs, and what it produces that lasts.

| | You, today | Your team, soon |
|---|---|---|
| **Cut what they cost** | | |
| Code map, the 5 MCP tools, all in-loop behaviors | ✓ | ✓ |
| Output trimming + savings receipts, hooks, skills, every agent | ✓ | ✓ |
| **Measure what they produce** | | |
| Every metric in [METRICS.md](./METRICS.md), computed locally | ✓ | ✓ |
| One continuous thread across the agents and repos you run | ✓ | ✓ |
| One rolled-up view of what the whole team's agents spend and catch | | ✓ soon |
| **Keep them inside your rules** | | |
| Conventions detected and applied for your own work | ✓ | ✓ |
| Conventions **shared** across the team | | ✓ soon |
| Edit-time behaviors **enforceable** org-wide (block / approve) | | ✓ soon |

**The line between the two columns is simple, and it does not move.** Everything that runs on your machine is free, forever, on unlimited repos — no account required, and it keeps working with no network at all. The right-hand column needs our servers to hold the shared state and roll it up, so it is part of the paid plan. Nothing in the left-hand column will ever move to the right.

Follow [unerr.dev](https://www.unerr.dev/) for the team rollout.

---

## Account

Logging in is optional. Everything above this section — the code map, search, edits, blast-radius checks, convention detection, every metric, and unlimited repos — runs fully on your machine with no account, forever.

**The rule, stated once:** if it runs on your machine, it is free and always will be. If it needs our hosted service to hold shared state across people and machines, it is part of the paid plan — because it runs on our servers and stores your history there. The client code that talks to that service is in this repository under Apache-2.0, so you can read exactly what it sends.

| Works with no account | Needs a paid plan |
|---|---|
| Code map, search, file edits, blast-radius checks | Usage synced to a team dashboard |
| Convention detection, applied to your own work | Shared team conventions, pulled from the server |
| Every metric, computed and stored locally | Fleet inventory — which machines run which repos |
| Unlimited repos, cross-repo search on this machine | Org-wide enforcement, when it ships |

```bash
unerr login      # connect this machine — opens your browser to approve
unerr whoami     # show the account this machine is connected to
unerr logout     # disconnect and delete the local credentials
```

**What gets sent — and what never does.** Logged out, or logged in on the free plan, nothing but two account-less checks (a version check, a one-time parser download for some languages) ever leaves your machine. Once you're on a paid, logged-in plan, background sync adds four things: machine facts, this repo's inventory row, usage events (which tool ran, how long, session/branch/commit), and a stripped summary of agent transcripts. Never source code, file contents, diffs, raw prompts, raw transcript text, or credentials. Full detail in [PRIVACY.md](./PRIVACY.md).

**Where credentials live.** The token for this machine goes into your OS keychain (Keychain Access on macOS, Secret Service on Linux, Credential Manager on Windows). If no keychain is available, it falls back to `~/.unerr/credentials.json` (readable only by you) and warns you once.

**Revoking access.** `unerr logout` disconnects this machine. You can also revoke any machine from the web app under **Settings → Machines** — the token stops working right away, even if the laptop is lost.

**Offline behavior.** The CLI caches your plan locally and keeps working without a connection. If it can't reach the service for about a week, it falls back to the free plan until it reconnects — but everything local needs no plan and never stops working.

---

## Who it's for

- **Engineers in large, existing codebases.** What a senior engineer keeps in their head — what depends on what, which patterns are load-bearing, what broke here before — handed to the agent before every edit, so it stops breaking code it never read. Your review goes back to being about the *change*, not a hunt for the callers the agent never saw.
- **Anyone running more than one agent.** One continuous thread across your tools — move from Claude Code in the terminal to Cursor in the editor and what unerr knows about your repo comes with you, instead of relearning it every session.
- **Developers with conventions worth keeping.** The standard you settled on once, applied every time your agent touches that part of the code — no rules file to hand-maintain, re-paste, or fight merge conflicts over, and no hoping the agent remembers to look.
- **Solo builders and vibe coders shipping into a codebase that's already grown.** The guardrails of a careful senior engineer, on a project you're moving through fast and can't hold in your head.

Your team's shared view is arriving soon, and this same individual setup carries straight over to it.

---

## What it does under the hood

One local process per repo. You don't have to think about any of this to use it — but if you want to know what's running, here it is.

| The piece | What's in it | What it gives the agent |
|---|---|---|
| **A live map of your code** | CozoDB · tree-sitter · SCIP-verified call data · 18+ languages · sub-5ms lookups | Before any file read, the agent gets the 50 lines that matter and the list of what depends on them — not 3,000 lines and a guess. |
| **Conventions detected from source** | auto-detected once a pattern holds across ≥70% of matching code | Conventions re-derive from source on every reindex, so they can't drift out of date — no rules file to hand-maintain. |
| **The right slice, delivered automatically** | shell-output trimming (645+ command types) · web pages fetched at 5–10× less bulk · function-targeted file reads | The relevant piece shows up the moment the agent reads — it never has to remember which tool to reach for. |
| **The behaviors that catch problems** | breaking-change guard · convention-slip guard · retry-loop breaker · session continuity · auto-doc · change narrative · architecture guard | Each fires on a combination of the three above, *at the moment of the edit* — not as a tool the agent picked, not as a review after the fact. |

<details>
<summary><strong>Architecture, CLI commands, MCP tools, manual config</strong></summary>

### Architecture

```
AI Agent (Claude Code / Cursor / Windsurf / any MCP client)
    │
    └── stdio MCP ──→ unerr --mcp (bridge, per IDE session)
                            │
                            └── UDS ──→ unerrd (one lightweight Node process
                                               per machine, auto-spawned,
                                               exits after 30 min idle)
                                           │
                                           └── per-repo unerr process(es)
                                                  ├── CozoDB graph      (in-process, <5ms)
                                                  ├── Shadow ledger     (every tool call, append-only)
                                                  ├── File watcher      (incremental reindex)
                                                  ├── Convention engine
                                                  ├── Compression engine
                                                  └── Behavior modules
```

One local DB per repo. No API keys. Your code never leaves the machine. Nothing on the query path touches the network — the only calls that ever go out are a daily version check, a one-time parser download for some languages, and, if you log in on a paid plan, background sync. All three are itemised in [PRIVACY.md](./PRIVACY.md).

**Design principles** — no network call on the query path; stdout is sacred (MCP JSON-RPC only, everything else to stderr); sub-5ms query responses; first useful output in under 5s (shallow index first, deep enrichment in the background); graceful degradation (the agent still works if unerr is down — you just lose the extra layer).

**Tech stack** — TypeScript (ESM) · CozoDB (Rust/NAPI) · web-tree-sitter (WASM) · MCP SDK · Ink (React CLI) · tsup · Vitest

### CLI commands

```bash
unerr install <agent>   # MCP config + skills + hooks + instructions for one agent
unerr uninstall         # Remove unerr from this repo
unerr doctor            # Check PATH + environment, auto-fix if unerr isn't on all shells
unerr status            # Process health, entity count, graph age
unerr --mcp             # Stdio bridge — what your IDE invokes via .mcp.json

unerr login             # Connect this machine to your account (optional)
unerr whoami            # Show the connected account and machine
unerr logout            # Disconnect and delete the local credentials
unerr dashboard         # Open the cloud dashboard (requires login)

unerr pm status         # Process manager: PID, uptime, repos, memory, idle countdown
unerr pm logs           # Tail ~/.unerr/logs/unerrd.log
```

`unerrd` is a lightweight Node process that supervises every registered repo. Your IDE invocation auto-spawns it; it exits cleanly after 30 minutes of no activity. `unerr pm --help` lists the rest.

### MCP tools (5 advertised)

- `search_code` — find code by name or task phrase; a task phrase returns a recon bundle (focus body + callers + conventions in one call); `detail:true` resolves one entity (signature, callers, callees, imports).
- `file_read` — read a file as numbered lines, a line range, an entity's body, or a structural outline.
- `file_edit` — change a file (exact replacement or full overwrite); no prior built-in read needed.
- `get_references` — every caller or callee of an entity, including indirect refs grep misses.
- `fetch_url` — fetch one page or many, DOM-extracted markdown, BM25-ranked — replaces built-in WebFetch.

Persistence costs zero tool calls: a UserPromptSubmit hook fires when the user states a durable rule ("remember this", "always X") — the agent writes it straight into the instruction file, unerr itself stores nothing. On Claude Code the rest of the always-on ceremony runs automatically: a PostToolUse hook injects detected conventions on the first file read, and the Stop hook prints the turn close-out — all at zero extra round-trip.

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

unerr removes **86–90% of the tokens** an agent would otherwise spend navigating and reading code — measured, not estimated, across the same questions and the same tokenizer, with a fidelity gate that discards any "saving" that lost the answer. Methodology, reproduction commands, and per-repo results live in the separate [unerr-benchmarks](https://github.com/unerr-ai/unerr-benchmarks) repo.

### Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, day-to-day commands, code conventions, and the pre-PR checklist.

</details>

---

## About the fewer tokens

Token savings is a receipt, not the reason — a dozen tools now claim some version of the same number, so it isn't where the product lives. But it's real, and you get it as a side effect of only ever handing the agent the one relevant thing:

- **86–90%** of an agent's code-navigation tokens removed in head-to-head benchmarks against grep-and-read — real tokenizer, fidelity-gated, reproducible on any repo. [See the benchmarks →](https://github.com/unerr-ai/unerr-benchmarks)
- An agent's turn is dominated by what its tools hand back, and managing that instead of letting it pile up **cuts cost by more than half** ([JetBrains Research, NeurIPS 2025 workshop](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)). unerr steps in at the read, so the window doesn't fill up with noise in the first place.
- **0** AI calls per query in the core — the lookups, facts, and warnings are computed directly. No API keys and no per-turn inference cost. No telemetry while you are logged out or on the free plan; [PRIVACY.md](./PRIVACY.md) lists the exact fields paid sync sends.

The reason this matters more than it looks: a token you let into a conversation is not paid for once. It gets re-read on every later turn, and unerr measures that multiplier directly — see [re-read amplification](./METRICS.md#re-read-amplification). Keeping a token out is worth many times more than compressing it after the fact.

The point was never the number. The point is that the agent lands on the right code, sees the thing that would have stopped the break, and you stop paying — in money *and* in afternoons — for work it would otherwise have had to undo.

---

<p align="center">
  <code>curl -fsSL https://raw.githubusercontent.com/unerr-ai/unerr/main/install | bash</code>
  <br /><br />
  <a href="https://www.unerr.dev/"><sub>unerr.dev</sub></a> · <a href="https://www.npmjs.com/package/@unerr-ai/unerr"><sub>npm registry</sub></a> · <a href="https://discord.gg/2BjRftz8kG"><sub>Discord</sub></a> · <a href="https://x.com/unerr_ai"><sub>X</sub></a> · <a href="https://www.linkedin.com/company/unerr"><sub>LinkedIn</sub></a> · <sub>Runs locally. No account needed, ever.</sub>
</p>
