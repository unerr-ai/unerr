/**
 * unerr serve — DEPRECATED. Now delegates to the unified proxy.
 *
 * Kept as hidden alias to preserve backward compatibility.
 * The proxy (proxy.ts) handles all MCP server and graph loading duties.
 */

import type { Command } from "commander";

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start local MCP server (deprecated — use 'unerr')")
    .option("--repo <repoId>", "Specific repo to serve")
    .option("--prefetch", "Enable predictive context pre-fetching")
    .option("--no-prefetch", "Disable predictive context pre-fetching")
    .action(async (opts: { repo?: string; prefetch?: boolean }) => {
      process.stderr.write(
        "Note: 'unerr serve' is now handled by 'unerr'. Starting proxy...\n"
      );
      const { startProxy } = await import("../proxy/proxy.js");
      await startProxy({ repoId: opts.repo, prefetch: opts.prefetch });
    });
}
