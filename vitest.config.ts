import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    // Forks pool (child_process) is required: ~16 tests call process.chdir(),
    // which throws "process.chdir() is not supported in workers" under the
    // default `threads` pool (worker_threads). Forks also sidesteps the
    // Darwin SIGURG → exit 144 worker death we saw on the full suite.
    pool: "forks",
  },
})
