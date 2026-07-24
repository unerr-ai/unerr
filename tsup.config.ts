import { defineConfig } from "tsup";

// Compile-time dead-code-elimination flag.
// Published npm builds run `UNERR_PROD_BUILD=1 pnpm run build` so that
// `if (__UNERR_DEV_BUILD__) { ... }` blocks are stripped by esbuild.
// format/target/dts/external are mirrored from the build:cli CLI flags in
// package.json so a standalone `tsup` invocation matches. entry, splitting, and
// noExternal live ONLY here (build:cli passes no --splitting flag — a CLI flag
// would override this config, which is exactly the bug that once pinned the
// hook fast-path shut: `--no-splitting` silently defeated the entry split).
const isProdBuild = process.env.UNERR_PROD_BUILD === "1";

export default defineConfig({
  // Object form (not an array) so output names are pinned at the dist root:
  // `dist/cli.js` is the `bin` target and cli-hook.js / cli-main.js / cozo-
  // worker.js sit beside it. An array would shift the common base to `src/` and
  // emit `dist/entrypoints/cli.js`, breaking the bin path and the sibling
  // resolution below.
  //
  // cli.ts is a thin argv router that dynamic-imports cli-hook.ts (the `unerr
  // hook <event>` fast-path) or cli-main.ts (the full Commander program). Making
  // those two their own entries + `splitting:true` lets esbuild emit each as a
  // chunk the router loads on demand — instead of inlining both into one file
  // and hoisting EVERY transitive external import (ink/react/react-reconciler/
  // yoga/gpt-tokenizer/…) to the top, where Node eval-loads them before any
  // dispatch runs. The heavy terminal-UI framework lives only under cli-main, so
  // a hook fire (or `unerr --version`) loads ~5 KB + the fired handler's chunks,
  // not the whole CLI. `./cli-hook.js` / `./cli-main.js` resolve as runtime
  // siblings of cli.js (same layout in the Bun binary — see
  // scripts/build-binary.ts). cozo-worker is the DB worker-thread entry —
  // `new URL("./cozo-worker.js", import.meta.url)` in cozo-worker-client.ts
  // resolves to it next to cli.js.
  entry: {
    cli: "src/entrypoints/cli.ts",
    "cli-hook": "src/entrypoints/cli-hook.ts",
    "cli-main": "src/entrypoints/cli-main.ts",
    "cozo-worker": "src/intelligence/cozo-worker.ts",
  },
  format: ["esm"],
  target: "node24",
  dts: true,
  splitting: true,
  external: ["cozo-node"],
  // `@unerr-ai/contracts` is `restricted` on GitHub Packages; the CLI ships to
  // PUBLIC npm, so end users could never fetch it as a runtime dep. It MUST be
  // inlined into dist. tsup auto-externalizes `dependencies` (e.g. zod stays
  // external — the CLI already ships it), so the vendored contract is force-
  // bundled here. zod / @orpc/contract stay external (CLI provides zod; the CLI
  // never imports the @orpc-bearing `/api` subpath).
  noExternal: ["@unerr-ai/contracts"],
  define: {
    __UNERR_DEV_BUILD__: isProdBuild ? "false" : "true",
    // The tsup/Node artifact is never a compiled Bun binary, so the native-embed
    // branches (embedded cozo addon / watcher addon / tree-sitter wasm) fold out
    // here and the package keeps loading cozo-node / @parcel/watcher normally.
    // `script/build-binary.ts` passes `--define __UNERR_BINARY__=true` instead.
    __UNERR_BINARY__: "false",
  },
  // Production only: enable esbuild's syntax-level dead-code pass so the
  // `if (false) { ... applyDevConfig ... }` branch is physically removed (not
  // just unreachable). minifySyntax folds dead branches and constants but does
  // NOT rename identifiers, so the published bundle stays debuggable by name.
  // Dev builds skip this and keep the readable, un-folded output.
  esbuildOptions(options) {
    if (isProdBuild) options.minifySyntax = true;
    // The vendored `@unerr-ai/contracts` declares `sideEffects: false` and emits
    // its 7 subpath entries with tsup code-splitting, so the entries share a
    // chunk via a bare `import '../chunk-*.js'`. Inlining the contract here
    // (`noExternal`) makes esbuild tree-shake that side-effect-free bare import
    // and warn `ignored-bare-import`. The drop is correct — every schema arrives
    // via a named import and the package runs no top-level code — so silence
    // just that one message instead of letting it clutter every build. Root
    // cause is esbuild#2922 (multi-entry + splitting → unneeded chunk imports);
    // the alternative root fix is `splitting:false` in the contract's tsup.
    options.logOverride = {
      ...options.logOverride,
      "ignored-bare-import": "silent",
    };
  },
});
