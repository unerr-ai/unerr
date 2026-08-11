# Installing unerr

unerr ships as a single self-contained binary — the JavaScript runtime, the
graph engine (cozo), the file watcher, and the tree-sitter parsers are all baked
into one file. There is no Node version to match and nothing to compile.

Pick the line for your platform, run it, then restart your IDE.

| You're on… | Run this |
|---|---|
| macOS / Linux | `curl -fsSL https://raw.githubusercontent.com/unerr-ai/unerr/main/install \| bash` |
| macOS (Homebrew) | `brew install unerr-ai/tap/unerr` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/unerr-ai/unerr/main/install.ps1 \| iex` |
| Windows (Scoop) | `scoop bucket add unerr https://github.com/unerr-ai/scoop-bucket; scoop install unerr` |
| Any platform with Node ≥18 | `npm install -g @unerr-ai/unerr` |

After it's on your PATH:

```bash
cd ~/your-project
unerr install claude-code     # or: cursor, windsurf, gemini-cli, antigravity, github-copilot-cli
```

Then restart your IDE (or start a new chat). The next prompt already knows your repo.

Using **Claude Cowork** or **ChatGPT Work**? Those work on documents, not code.
They install a plugin into the app itself and put nothing in your project — see
[Work agents](#work-agents--install-a-plugin).

---

## Supported platforms

| OS | x64 | arm64 |
|---|---|---|
| macOS | ✓ | ✓ (Apple Silicon) |
| Linux (glibc) | ✓ | ✓ |
| Windows | ✓ | — not supported |

**Alpine / musl Linux** and **Windows on ARM** are not supported on any channel
— there's no prebuilt graph engine (cozo) for them, so the binary, Homebrew,
Scoop, and `npm install -g @unerr-ai/unerr` all have no build to give you. The
npm wrapper will install but `unerr` exits with a "platform not supported"
message on those systems.

---

## The install channels in detail

### curl \| bash (macOS + Linux) — the default

```bash
curl -fsSL https://raw.githubusercontent.com/unerr-ai/unerr/main/install | bash
```

What it does: detects your OS, CPU, and libc; downloads the matching binary from
[GitHub Releases](https://github.com/unerr-ai/unerr/releases); verifies its
SHA-256 against the release's `SHA256SUMS`; drops `unerr` into your install dir;
and adds that dir to your PATH if it isn't already.

Knobs (environment variables):

| Variable | Default | Effect |
|---|---|---|
| `UNERR_INSTALL_DIR` | `$XDG_BIN_HOME`, else `$HOME/.unerr/bin` | Where the binary lands |
| `VERSION` | latest release | Pin a specific version, e.g. `VERSION=0.3.5` |

```bash
# Pin a version and a location
VERSION=0.3.5 UNERR_INSTALL_DIR="$HOME/.local/bin" \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/unerr-ai/unerr/main/install)"
```

If `unerr` isn't found after install, open a new shell, or run `unerr doctor`
(it patches your shell config and won't need to run twice).

### Homebrew (macOS + Linux)

```bash
brew install unerr-ai/tap/unerr
```

This is our own tap (`unerr-ai/homebrew-tap`), so it tracks every release the
moment it ships — there's no waiting on homebrew-core review. Upgrade with
`brew upgrade unerr`; remove with `brew uninstall unerr`.

### Windows — PowerShell

```powershell
irm https://raw.githubusercontent.com/unerr-ai/unerr/main/install.ps1 | iex
```

Downloads the Windows x64 build, verifies its hash, expands it to
`%USERPROFILE%\.unerr\bin`, and adds that to your user PATH. Open a new terminal
afterward.

Works on Windows PowerShell 5.1 (what ships with Windows 10 and 11) and on
PowerShell 7+. Nothing else is needed — no Node, no admin rights, no execution
policy change, since piping into `iex` doesn't run a script file.

Same knobs as the macOS/Linux script:

| Variable | Default | Effect |
|---|---|---|
| `$env:UNERR_INSTALL_DIR` | `%USERPROFILE%\.unerr\bin` | Where the binary lands |
| `$env:VERSION` | latest release | Pin a specific version, e.g. `0.3.5` |

```powershell
# Pin a version and a location
$env:VERSION="0.3.5"; $env:UNERR_INSTALL_DIR="C:\tools\unerr"
irm https://raw.githubusercontent.com/unerr-ai/unerr/main/install.ps1 | iex
```

### Windows — Scoop

```powershell
scoop bucket add unerr https://github.com/unerr-ai/scoop-bucket
scoop install unerr
```

Scoop keeps it updated via the bucket's manifest. Upgrade with `scoop update unerr`.

### npm — for Node users and CI

```bash
npm install -g @unerr-ai/unerr
```

This channel uses your own Node (≥18) to launch the binary. It installs a tiny
wrapper package (`@unerr-ai/unerr`) plus exactly one platform package for your
OS/CPU (the [esbuild pattern](https://github.com/evanw/esbuild) —
`optionalDependencies` gated by `os`/`cpu`), so you get the same compiled binary
the other channels ship, launched through a thin Node shim. Use it when you'd
rather manage unerr with npm or pin it in CI. It covers the same five platforms
as the binary — there's no npm build for Alpine/musl or Windows-on-ARM either.

---

## Verify the install

```bash
unerr --version      # prints the version baked into the binary
unerr doctor         # checks PATH across your shells, auto-fixes if needed
unerr status         # in a repo: shows graph + proxy state
```

---

## Connect unerr to your agent

There are two kinds of agent, and they are set up in completely different ways.

| Your agent works on… | What you do | Takes |
|---|---|---|
| **Code** — Claude Code, Cursor, Codex, Windsurf, Gemini CLI, Copilot, VS Code | Run `unerr install <agent>` in the repo. Done. | one command |
| **Documents** — Claude Cowork, ChatGPT Work | Install a plugin into the app itself. Nothing is installed into your project. | a few clicks |

---

## Code agents — one command

Run it inside the repository you want the agent to understand.

```bash
cd ~/your-project
unerr install claude-code     # or: cursor, codex, windsurf, gemini-cli,
                              #     antigravity, github-copilot-cli, vscode
```

That is the whole setup. It writes two things, both inside that project:

- the agent's MCP config, pointing at your `unerr` binary
- a short block in the agent's instruction file, telling it to prefer unerr's tools

Never a global or home-directory config. Restart your IDE, or start a new chat,
and the next prompt already knows the repo.

Run `unerr install` with no argument to see every supported agent and which ones
you already have set up.

---

## Work agents — install a plugin

Claude Cowork and ChatGPT Work have no codebase to index, so there is no graph
and no repo to set up. unerr ships them a **plugin** instead, carrying what still
pays off without a graph: compressed command output, ranked web fetching, and
five sub-agents that take work off the main thread.

**Nothing is written into your project.** These commands do not touch the folder
you run them from.

### Claude Cowork

Two ways in. The first is better — it keeps itself up to date.

#### Option A — add the marketplace (recommended)

1. Open **Customize** in the Cowork sidebar, then **Plugins**.
2. Under **Personal plugins**, click **+**, then **Add marketplace**.
3. Enter `unerr-ai/unerr`.
4. Install **unerr for work** from it.

Nothing to download and nothing to run. To pick up new versions later, press
**Update** on that marketplace. A marketplace you add yourself does not refresh
silently — that is Anthropic's default for third-party sources, not an unerr
choice.

#### Option B — upload the file

Use this when you want a fixed version, or you are offline.

```bash
unerr install cowork
```

This writes the plugin and a matching `.zip` to a folder in your home
directory. Then in Cowork: **Customize → Plugins → upload**, and pick the `.zip`.

An uploaded copy never updates itself. Re-run the command and upload again to
move to a new version.

#### Where the files land

One copy per computer, shared by every project. Never inside a project folder.

| Your system | Folder |
|---|---|
| macOS | `~/Claude/Plugins/` |
| Windows | `C:\Users\<you>\Claude\Plugins\` |
| Linux | `~/Claude/Plugins/` |

Inside it:

```
Claude/Plugins/
├── unerr-work/         the plugin itself
└── unerr-work.zip      the file you upload to Cowork  (~8 KB)
```

It sits next to `Claude/Projects/`, the folder Cowork already keeps your work in,
so it is easy to find in the upload dialog. Set `UNERR_WORK_PLUGIN_HOME` to put
it somewhere else.

**Why Cowork gets no MCP server.** Cowork runs every session inside an isolated
virtual machine that cannot reach a program on your computer. An MCP entry there
would advertise tools that could never connect, so the Cowork plugin deliberately
ships none. Its value is the sub-agents and skills.

### ChatGPT Work, Codex, Cursor, Copilot, Kiro, VS Code

```bash
unerr install chatgpt-work
```

This writes an [Agent Plugins](https://github.com/agentplugins/agent-plugins-spec)
v1.0.0 package to the same folder — `Claude/Plugins/unerr/`. Point your host's
plugin install at it. These hosts do run on your machine, and the standard lets a
plugin launch its own binary, so this package **does** carry an MCP server.

### What web access looks like in work mode

Pages are fetched through unerr's `fetch_url`. You get back ranked passages
rather than the whole document — that is the point of the mode.

## Uninstall

```bash
unerr uninstall              # a code agent: clean this repo
unerr uninstall cowork       # a work agent: delete the shared plugin folder
```

For a work agent, also remove it inside the app: in Cowork, **Customize →
Plugins**, then remove the plugin and the `unerr-ai/unerr` marketplace. Deleting
the folder on disk does not remove what Cowork already installed.

Then remove the binary itself:

| Installed with | Remove with |
|---|---|
| curl \| bash | `rm "$(command -v unerr)"` (and the line it added to your shell rc) |
| Homebrew | `brew uninstall unerr` |
| Scoop | `scoop uninstall unerr` |
| npm | `npm uninstall -g @unerr-ai/unerr` |

---

## How the binary is built (for maintainers)

`unerr` is compiled with [Bun's `--compile`](https://bun.com/docs/bundler/executables).
The build is driven by `scripts/build-binary.ts`:

```bash
pnpm run build:contracts                 # the wire-contract submodule must be built first
pnpm run build:binary -- --target darwin-arm64
# → dist/bin/unerr-darwin-arm64
```

Targets: `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `windows-x64`.
The script stages each target's prebuilt cozo / watcher `.node` addon and the
tree-sitter `.wasm` grammars, then embeds them into the binary (cozo-node's
node-pre-gyp loader is bypassed — the addon is `require`d directly so Bun bundles
it). The `release` job in `.github/workflows/ci.yml` builds all targets, signs
the macOS binaries, uploads them to this repo's own `unerr-ai/unerr` Releases
(public), and updates `install` / `install.ps1` on `main` so the raw URL
resolves. All channels above point at those artifacts. Design notes:
`.internal/docs/01-base-system/08-DISTRIBUTION-PACKAGING.md`.
