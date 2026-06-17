import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/__tests__/**/*.test.ts",
      // Benchmark harnesses live outside src/ (excluded from the src-only
      // tsconfig rootDir), so their pure-logic tests are colocated here.
      "benchmarks/**/*.test.ts",
    ],
    exclude: [
      ...configDefaults.exclude,
      // Track4 A/B clones the target OSS repo into each run's out/worktrees/
      // (e.g. track4-single-repo-ab/hono-run/out/...). Those are the TARGET
      // repo's own tests (deno/bun/fastly globals that can't collect here),
      // not unerr tests — the benchmarks/** include glob would otherwise sweep
      // them into the suite as ~200 failing-to-collect foreign suites.
      "benchmarks/**/out/**",
    ],
    // Forks pool (child_process) is required: ~16 tests call process.chdir(),
    // which throws "process.chdir() is not supported in workers" under the
    // default `threads` pool (worker_threads). Forks also sidesteps the
    // Darwin SIGURG → exit 144 worker death we saw on the full suite.
    pool: "forks",
    // Jest-compatible JSON artifact alongside normal terminal output.
    // `unerr exec` reads .unerr/test-results.json back to render a first-turn
    // verdict when a teardown-time SIGTERM (exit 143) eats the terminal
    // output — the artifact is written when the run finishes, so its presence
    // proves the suite completed. See src/proxy/test-artifact.ts.
    reporters: ["default", "json"],
    outputFile: { json: ".unerr/test-results.json" },
  },
});
