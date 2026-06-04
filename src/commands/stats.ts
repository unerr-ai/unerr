/**
 * unerr stats — Show weekly and all-time savings with mechanism breakdown.
 *
 * S8.8 + Layer 10 TF-C.6: Reads ~/.unerr/stats.json and displays formatted
 * report including per-mechanism token attribution.
 */

import type { Command } from "commander";
import {
  formatStatsReport,
  loadLiveSessions,
  loadStats,
  mergeLiveSessions,
} from "../tracking/weekly-accumulator.js";

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description(
      "Show weekly and all-time token savings with mechanism breakdown"
    )
    .action(() => {
      const persisted = loadStats();
      // Mid-session sidecars (regression 6f): sessions accumulate into
      // stats.json only at proxy shutdown, so a live session would
      // otherwise show nothing here.
      const live = loadLiveSessions();

      if (persisted.allTime.totalSessions === 0 && live.length === 0) {
        process.stderr.write(
          "\n  No sessions recorded yet. Start using unerr to see stats.\n\n"
        );
        return;
      }

      process.stderr.write(
        formatStatsReport(mergeLiveSessions(persisted, live))
      );
      if (live.length > 0) {
        process.stderr.write(
          `  Includes ${live.length} active session${live.length === 1 ? "" : "s"} (numbers finalize at session end).\n\n`
        );
      }
    });
}
