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

## Uninstall

```bash
unerr uninstall                       # remove unerr from the current repo
unerr uninstall --strip-annotations   # also strip the @sem comments unerr added
```

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
the macOS binaries, uploads them to the PUBLIC `unerr-ai/unerr` Releases
(unerr-cli is private, so its own Release assets aren't anonymously
downloadable), and syncs `install` / `install.ps1` to that repo's `main` so the
raw URL resolves. All channels above point at those public artifacts. Design
notes: `.internal/roadmap/NATIVE_BINARY_DISTRIBUTION.md`.
