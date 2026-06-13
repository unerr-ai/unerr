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
  target: "node20",
  dts: true,
  splitting: false,
  external: ["cozo-node", "better-sqlite3"],
  define: {
    __UNERR_DEV_BUILD__: isProdBuild ? "false" : "true",
  },
  // Production only: enable esbuild's syntax-level dead-code pass so the
  // `if (false) { ... applyDevConfig ... }` branch is physically removed (not
  // just unreachable). minifySyntax folds dead branches and constants but does
  // NOT rename identifiers, so the published bundle stays debuggable by name.
  // Dev builds skip this and keep the readable, un-folded output.
  esbuildOptions(options) {
    if (isProdBuild) options.minifySyntax = true;
  },
});
