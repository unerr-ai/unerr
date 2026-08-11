<h1 align="center">
  <a href="https://www.unerr.dev/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/unerr-ai/unerr/main/public/unerr-lockup-paper.svg" />
      <img src="https://raw.githubusercontent.com/unerr-ai/unerr/main/public/unerr-lockup.svg" alt="unerr" width="300" />
    </picture>
  </a>
</h1>

<p align="center">
  <strong>The local runtime for your coding agents.</strong>
</p>

<p align="center">
  Your agent has read the code. It still breaks callers it never saw.<br/>
  unerr hands it the live call graph and your rules at the moment it edits.
</p>

<p align="center">
  <strong>Cut what they cost</strong> · <strong>Measure what they produce</strong> · <strong>Keep them inside your rules</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@unerr-ai/unerr"><img src="https://img.shields.io/badge/install-npm_i_@unerr--ai/unerr-8B5CF6?style=flat-square&logo=npm" alt="Install" /></a>
  <a href="https://www.unerr.dev/"><img src="https://img.shields.io/badge/website-unerr.dev-8B5CF6?style=flat-square&logo=icloud&logoColor=white" alt="Website" /></a>
  <img src="https://img.shields.io/badge/protocol-MCP-7C3AED?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/local--first-runs_offline-22D3EE?style=flat-square" alt="Local-first" />
  <a href="./METRICS.md"><img src="https://img.shields.io/badge/metrics-CC_BY_4.0-34D399?style=flat-square" alt="Open metric definitions" /></a>
</p>

<p align="center">
  <code>curl -fsSL https://raw.githubusercontent.com/unerr-ai/unerr/main/install | bash</code>
  <br /><sub><code>brew install unerr-ai/tap/unerr</code> · <code>npm install -g @unerr-ai/unerr</code> · <a href="./INSTALL.md">all platforms →</a></sub>
</p>

<p align="center">
  <sub>One self-contained binary. No Node to match, nothing to compile, no account.<br/>
  <strong>Works with</strong> Cursor · Claude Code · Codex · Windsurf · Cline · Gemini CLI · Antigravity · GitHub Copilot CLI · any MCP client.</sub>
</p>

<p align="center">
  <a href="https://youtu.be/pL1izMwYZpI"><img src="https://raw.githubusercontent.com/unerr-ai/unerr/main/public/screenshots/end-of-turn-receipt.png" alt="unerr end-of-turn receipt" width="420" /></a>
  <br/><sub>Every turn closes with what unerr caught and saved. ▶ <a href="https://youtu.be/pL1izMwYZpI">Watch it catch a breaking change live</a></sub>
</p>

---

## What it is

Every coding agent on your machine speaks the same protocol, MCP. unerr sits in
that one path, locally, and works while the agent works instead of waiting to be
asked:

- hands it the 50 lines that matter, not 3,000;
- brings up your rule for the code it is touching, at the edit;
- trims long command output and file reads to the slice it needs;
- stops a change that would break callers it never read.

One install covers every agent and every repo. It is not a new IDE and not a new
model.

**Why one thing instead of five plugins.** MCP only carries requests the agent
*chooses* to make, and a busy agent skips the plugin it has to remember to call.
Every tool you add also costs attention before any work happens: GitHub's MCP
server alone spends [~42,000 tokens defining its
tools](https://eclipsesource.com/blogs/2026/01/22/mcp-context-overload/). unerr
steps in on its own, so there is nothing to forget. The useful behaviors also
need information no single plugin has: catching a breaking change needs the edit
*and* everything depending on it, in the same instant.

---

## What it gives you

### Cut what the agents cost

Handing the agent only the relevant thing means far fewer tokens spent getting
there. Against grep-and-read, unerr removes **86–90% of the tokens an agent
spends navigating code**, with a fidelity gate that throws out any "saving" that
lost the answer. That is the read/navigate slice, not your whole bill, and it is
[reproducible on your own repo](https://github.com/unerr-ai/unerr-benchmarks).

The reason it compounds: a token you let into a conversation is not paid for
once. It is re-read on every later turn. unerr measures that multiplier as
[re-read amplification](./METRICS.md#re-read-amplification).

### Measure what they produce

Usage dashboards tell you tokens went out. They cannot tell you whether anything
lasted. unerr computes both halves locally, from your own git history and
session records.

| Metric | What it answers |
|---|---|
| [Code survival](./METRICS.md#code-survival) | Of lines added in the last 30 or 90 days, how many are still here, agent-written versus human-written. |
| [Durability score](./METRICS.md#durability-score) | Which functions an agent keeps rewriting. |
| [Cache hit rate](./METRICS.md#cache-hit-rate) | How much of a session's input was reused rather than paid for again. |
| [Re-read amplification](./METRICS.md#re-read-amplification) | How many times the average cached token got billed back. |
| [Self-correction patterns](./METRICS.md#self-correction-patterns) | Where agents get it wrong on the first try. |

Definitions, and what each metric deliberately ignores, are in
[METRICS.md](./METRICS.md) under CC BY 4.0. This is a mirror for your own work.
Team views stay aggregate when they land: **never per-developer ranking.**

### Keep them inside your rules

A rules file is something an agent can acknowledge and skip three turns later.
unerr ties each rule to the code it is about, raises it when the agent touches
that code, and keeps it pinned after the code moves. Patterns that hold across
your codebase become rules without you writing them down. Same standard across
every agent and every session.

### Your data

All of the above is computed from files in your own repository, in a documented
and versioned format. It stays there unless you log in on a paid plan.
[What's in it, and how to read it →](./docs/DATA.md)

---

## Quick start

```bash
# 1. Install (once per machine)
curl -fsSL https://raw.githubusercontent.com/unerr-ai/unerr/main/install | bash

# 2. Set up your agent (per repo)
cd ~/your-project
unerr install claude-code     # or cursor, codex, windsurf, cline,
                              # gemini-cli, antigravity, github-copilot-cli

# 3. Restart your IDE, or start a new chat
```

That writes the MCP config, skills, hooks, and instructions for that agent in
that repo. Install more than one; re-running updates only what changed. Remove
with `unerr uninstall`.

If your shell cannot find `unerr` afterwards, run `unerr doctor` once. Full
per-platform notes are in [INSTALL.md](./INSTALL.md).

**Claude Cowork and ChatGPT Work are different.** They handle documents, not
code, so you install a plugin into the app and nothing lands in your project.
[How →](./INSTALL.md)

Using another MCP client? `unerr install --show-instructions <agent>` prints
copy-pasteable steps.

---

## You today, your team soon

Today unerr is the local runtime behind the agents **you** run. The same runtime
extends to a shared view across a whole team, arriving soon, and your setup
carries straight over.

| | You, today | Your team, soon |
|---|---|---|
| Code map, the 5 MCP tools, all in-loop behaviors | ✓ | ✓ |
| Output trimming, savings receipts, hooks, skills | ✓ | ✓ |
| Every metric in [METRICS.md](./METRICS.md), computed locally | ✓ | ✓ |
| Conventions detected and applied to your own work | ✓ | ✓ |
| One thread across the agents and repos you run | ✓ | ✓ |
| Conventions **shared** across the team | | ✓ soon |
| Edit-time behaviors **enforceable** org-wide | | ✓ soon |
| One rolled-up view of what the team's agents spend and catch | | ✓ soon |

**The line between the columns does not move.** Everything that runs on your
machine is free, forever, on unlimited repos, and it keeps working with no
network. The right column needs our servers to hold shared state, so it is part
of the paid plan. Nothing on the left will ever move right.

---

## Account

Logging in is optional. The code map, search, edits, blast-radius checks,
convention detection, every metric, and unlimited repos all run on your machine
with no account, forever.

```bash
unerr login      # connect this machine
unerr whoami     # show the connected account
unerr logout     # disconnect and delete local credentials
```

**What gets sent.** Logged out or on the free plan, nothing but two
account-less checks leave your machine: a version check and a one-time parser
download for some languages. On a paid, logged-in plan, background sync adds
machine facts, this repo's inventory row, usage events, and a stripped
transcript summary. Never source code, file contents, diffs, raw prompts, or
credentials. Field-by-field detail and three ways to switch it off are in
[PRIVACY.md](./PRIVACY.md).

**Credentials** go in your OS keychain, falling back to `~/.unerr/credentials.json`
with a warning. `unerr logout` disconnects this machine; you can also revoke any
machine from **Settings → Machines** in the web app.

**Offline.** The CLI caches your plan and keeps working without a connection.
After about a week unreachable it falls back to the free plan, but nothing local
ever stops.

---

## Under the hood

One local process per repo. Nothing on the query path touches the network. Your
code never leaves the machine.

| The piece | What it gives the agent |
|---|---|
| **Live code map** — CozoDB, tree-sitter, SCIP-verified calls, 18+ languages, sub-5ms lookups | The 50 lines that matter and the list of what depends on them. |
| **Conventions from source** — detected once a pattern holds across ≥70% of matching code | Re-derived on every reindex, so they cannot drift stale. |
| **The right slice, automatically** — shell-output trimming (645+ command types), web pages at 5–10× less bulk, function-targeted reads | Shows up at the read; nothing to remember to call. |
| **Behaviors that catch problems** — breaking-change guard, convention-slip guard, retry-loop breaker, session continuity | Fires at the moment of the edit, not as a review afterwards. |

<details>
<summary><strong>Architecture, CLI commands, MCP tools, manual config</strong></summary>

### Architecture

```
AI Agent (any MCP client)
    └── stdio MCP ──→ unerr --mcp (bridge, per IDE session)
                          └── UDS ──→ unerrd (one process per machine,
                                              auto-spawned, 30 min idle exit)
                                         └── per-repo unerr process(es)
                                                ├── CozoDB graph   (<5ms)
                                                ├── Shadow ledger  (append-only)
                                                ├── File watcher   (incremental reindex)
                                                ├── Convention engine
                                                ├── Compression engine
                                                └── Behavior modules
```

**Design principles** — no network call on the query path; stdout carries MCP
JSON-RPC only, everything else to stderr; sub-5ms queries; first useful output
under 5s; the agent still works if unerr is down.

**Stack** — TypeScript (ESM) · CozoDB (Rust/NAPI) · web-tree-sitter (WASM) ·
MCP SDK · Ink · tsup · Vitest

### CLI commands

```bash
unerr install <agent>   # MCP config + skills + hooks + instructions
unerr uninstall         # remove unerr from this repo
unerr doctor            # check PATH + environment, auto-fix
unerr status            # process health, entity count, graph age
unerr --mcp             # stdio bridge — what your IDE invokes

unerr login / whoami / logout / dashboard

unerr pm status         # process manager: PID, uptime, repos, memory
unerr pm logs           # tail ~/.unerr/logs/unerrd.log
```

### MCP tools (5 advertised)

- `search_code` — find code by name or task phrase; a phrase returns a recon
  bundle (body, callers, conventions) in one call.
- `file_read` — a file as numbered lines, a range, an entity's body, or an outline.
- `file_edit` — exact replacement or full overwrite, no prior read needed.
- `get_references` — every caller or callee, including indirect refs grep misses.
- `fetch_url` — one page or many, DOM-extracted markdown, BM25-ranked.

On Claude Code the always-on ceremony runs through hooks at zero extra
round-trip: conventions injected on the first file read, durable rules written
straight to the instruction file, turn close-out on stop. Responses carry inline
`ur|<tag>` signals so the agent acts on drift and breaking-change warnings
without burning a turn.

### Manual MCP config

```json
{
  "mcpServers": {
    "unerr": { "command": "npx", "args": ["@unerr-ai/unerr", "--mcp"] }
  }
}
```

### Benchmarks

Methodology, reproduction commands, and per-repo results are in the separate
[unerr-benchmarks](https://github.com/unerr-ai/unerr-benchmarks) repo.

### Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

</details>

---

<p align="center">
  <a href="https://www.unerr.dev/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/unerr-ai/unerr/main/public/unerr-mark-paper.svg" />
      <img src="https://raw.githubusercontent.com/unerr-ai/unerr/main/public/unerr-mark.svg" alt="unerr" width="28" />
    </picture>
  </a>
  <br/>
  <a href="https://www.unerr.dev/"><sub>unerr.dev</sub></a> · <a href="./METRICS.md"><sub>Metrics</sub></a> · <a href="./docs/DATA.md"><sub>Your data</sub></a> · <a href="./PRIVACY.md"><sub>Privacy</sub></a> · <a href="https://discord.gg/2BjRftz8kG"><sub>Discord</sub></a> · <a href="https://x.com/unerr_ai"><sub>X</sub></a>
  <br/><sub>Apache-2.0 · Runs locally · No account needed, ever</sub>
</p>
