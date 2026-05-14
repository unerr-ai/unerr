/**
 * unerr stats — Show weekly and all-time savings with mechanism breakdown.
 *
 * S8.8 + Layer 10 TF-C.6: Reads ~/.unerr/stats.json and displays formatted
 * report including per-mechanism token attribution.
 */

import type { Command } from "commander";
import {
  formatStatsReport,
  loadStats,
} from "../tracking/weekly-accumulator.js";

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description(
      "Show weekly and all-time token savings with mechanism breakdown",
    )
    .action(() => {
      const stats = loadStats();

      if (stats.allTime.totalSessions === 0) {
        process.stderr.write(
          "\n  No sessions recorded yet. Start using unerr to see stats.\n\n",
        );
        return;
      }

      process.stderr.write(formatStatsReport(stats));
    });
}
