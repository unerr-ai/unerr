import { defineConfig } from "tsup";

// Compile-time dead-code-elimination flag.
// Published npm builds run `UNERR_PROD_BUILD=1 pnpm run build` so that
// `if (__UNERR_DEV_BUILD__) { ... }` blocks are stripped by esbuild.
// Entry/format/target/dts/external are supplied by the build:cli CLI flags
// in package.json and merged with this config; we mirror them here so the
// two stay consistent if either is invoked alone.
const isProdBuild = process.env.UNERR_PROD_BUILD === "1";

export default defineConfig({
  entry: ["src/entrypoints/cli.ts"],
  format: ["esm"],
  target: "node24",
  dts: true,
  splitting: false,
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
