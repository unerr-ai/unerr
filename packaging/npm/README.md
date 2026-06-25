# packaging/npm — native binary distribution layer

This directory stages the npm packages that let `npm install -g @unerr-ai/unerr`
install and exec the correct pre-compiled native binary, following the same
pattern used by esbuild and turbo.

## How it works

There are six npm packages in total:

| Package | Role |
|---|---|
| `@unerr-ai/unerr` | Thin JS wrapper (this is what users install) |
| `@unerr-ai/unerr-darwin-x64` | Native binary for macOS Intel |
| `@unerr-ai/unerr-darwin-arm64` | Native binary for macOS Apple Silicon |
| `@unerr-ai/unerr-linux-x64` | Native binary for Linux x64 |
| `@unerr-ai/unerr-linux-arm64` | Native binary for Linux ARM64 |
| `@unerr-ai/unerr-windows-x64` | Native binary for Windows x64 |

Each platform package declares `os` and `cpu` in its `package.json`. npm
uses these to skip installing packages that don't match the current system,
so only the one matching binary lands on disk.

The wrapper's `optionalDependencies` lists all five platform packages at the
same version. On install npm picks the matching one (or skips it silently if
the platform is unsupported — the shim then prints a useful error).

The wrapper's shim (`wrapper/bin/unerr.js`) resolves the platform package's
binary path at runtime via `require.resolve`, then hands off with
`child_process.spawnSync` (clean stdio passthrough + exact exit code).

## Directory layout

```
packaging/npm/
  wrapper/
    package.json          # @unerr-ai/unerr manifest (version = 0.0.0-PLACEHOLDER)
    bin/unerr.js          # JS shim — resolves + execs the platform binary
  platform-template/
    package.json          # Template for @unerr-ai/unerr-<os>-<arch> manifests
  build-npm-packages.mjs  # Release script — stages publishable dirs under dist/
  README.md               # This file
```

## CI assembly

After the release build populates `dist/bin/` with native binaries, run:

```bash
node packaging/npm/build-npm-packages.mjs <version>
# or: UNERR_VERSION=0.3.6 node packaging/npm/build-npm-packages.mjs
```

This creates `packaging/npm/dist/` with one ready-to-publish directory per
package, and prints the exact `npm publish` commands in the required order.

## Publish order

Platform packages must be published **before** the wrapper:

1. `npm publish packaging/npm/dist/@unerr-ai/unerr-darwin-x64 --access public`
2. `npm publish packaging/npm/dist/@unerr-ai/unerr-darwin-arm64 --access public`
3. `npm publish packaging/npm/dist/@unerr-ai/unerr-linux-x64 --access public`
4. `npm publish packaging/npm/dist/@unerr-ai/unerr-linux-arm64 --access public`
5. `npm publish packaging/npm/dist/@unerr-ai/unerr-windows-x64 --access public`
6. `npm publish packaging/npm/dist/@unerr-ai/unerr --access public`

All six packages must be published under the `@unerr-ai` scope on the public
npm registry with `--access public`.

## Open maintainer decision

The repo root `package.json` currently publishes `@unerr-ai/unerr` as a Node
package that ships `dist/cli.js` (the tsup-compiled JS bundle). The packages
in this directory would replace that with a thin wrapper pointing at native
binaries.

**These two models are mutually exclusive for the same package name and version.**

Options:

1. **Switch fully to native.** The root `package.json` is updated so its
   `bin` and `files` point at the shim from this directory, and the
   `optionalDependencies` are added. Node-only users lose the ability to run
   from source, but the install is self-contained and fast.

2. **Publish the wrapper under a different name** (e.g. `unerr` without the
   scoped name, or `@unerr-ai/unerr-native`) alongside the existing scoped
   package. Users opt in explicitly.

3. **Keep the Node package, add native as a side-channel** (Homebrew tap,
   install script, direct GitHub Releases download). No npm change.

Nothing in `packaging/npm/` touches the root `package.json` or `src/` — that
decision belongs to the maintainer.
