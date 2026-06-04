import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
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
