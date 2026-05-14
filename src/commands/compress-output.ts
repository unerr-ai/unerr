/**
 * `unerr compress-output` — stdin→stdout compression for CLI hooks.
 *
 * S6.4: Reads text from stdin, compresses with the output compressor,
 * writes compressed output to stdout. When graph is available, passes
 * entity risk map for graph-aware prioritization.
 *
 * Usage (in hooks): echo "$OUTPUT" | unerr compress-output
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  type EntityRiskInfo,
  compressOutput,
} from "../proxy/output-compressor.js";

/**
 * Load entity risk map from the local graph state if available.
 * Returns empty map if graph is not initialized.
 */
function loadEntityRiskMap(cwd: string): Map<string, EntityRiskInfo> {
  const riskMap = new Map<string, EntityRiskInfo>();

  try {
    const unerrDir = join(cwd, ".unerr");
    const configPath = join(unerrDir, "config.json");
    if (!existsSync(configPath)) return riskMap;

    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      repoId?: string;
    };
    if (!config.repoId) return riskMap;

    const riskCachePath = join(unerrDir, "state", "entity_risk_cache.json");
    if (!existsSync(riskCachePath)) return riskMap;

    const data = JSON.parse(readFileSync(riskCachePath, "utf-8")) as Record<
      string,
      EntityRiskInfo
    >;
    for (const [key, info] of Object.entries(data)) {
      riskMap.set(key, info);
    }
  } catch {
    // Risk map loading is best-effort — compression works without it
  }

  return riskMap;
}

export function registerCompressOutputCommand(program: Command): void {
  program
    .command("compress-output")
    .description(
      "Compress text from stdin using graph-aware compression (for hooks)",
    )
    .option("--budget <tokens>", "Token budget", "2000")
    .option("--no-graph", "Skip loading graph risk map")
    .action(async (opts: { budget: string; graph?: boolean }) => {
      const budget = Number.parseInt(opts.budget, 10) || 2000;

      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
      }

      if (input.length === 0) {
        process.exit(0);
        return;
      }

      // S6.4: Load entity risk map from graph when available
      const entityRiskMap =
        opts.graph !== false ? loadEntityRiskMap(process.cwd()) : undefined;

      const result = compressOutput(input, {
        tokenBudget: budget,
        entityRiskMap:
          entityRiskMap && entityRiskMap.size > 0 ? entityRiskMap : undefined,
      });
      process.stdout.write(result.output);
    });
}
