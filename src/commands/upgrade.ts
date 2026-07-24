/**
 * `unerr upgrade` — the manual, end-to-end upgrade command.
 *
 * A thin CLI shell over {@link performUpgrade} (src/update/upgrade-flow.ts), the
 * single consolidated flow that auto-apply also reuses: download the latest
 * binary → reinstall every registered repo under the new binary → restart
 * unerrd, the per-repo `unerr` proxies, and the IDE-owned `unerr --mcp` bridges.
 * All logic lives in upgrade-flow.ts so there is ONE upgrade implementation.
 *
 */

import type { Command } from "commander";
import {
  type UpgradeFlowOptions,
  performUpgrade,
} from "../update/upgrade-flow.js";

const write = (msg: string) => process.stderr.write(`${msg}\n`);

/** Run the consolidated upgrade flow; set a non-zero exit code on failure. */
export async function runUpgrade(opts: UpgradeFlowOptions = {}): Promise<void> {
  const result = await performUpgrade({ ...opts, log: opts.log ?? write });
  if (!result.ok) process.exitCode = 1;
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description(
      "Download the latest unerr, reinstall every registered repo, and restart unerrd + bridges"
    )
    .option(
      "--version <version>",
      "Pin a specific version (default: the channel's latest)"
    )
    .option(
      "--channel <channel>",
      "Release channel: stable (default) or beta",
      (v: string) => {
        if (v !== "stable" && v !== "beta") {
          throw new Error(`--channel must be 'stable' or 'beta', got: ${v}`);
        }
        return v;
      }
    )
    .option(
      "--no-restart",
      "Install + reinstall repos without restarting the runtime"
    )
    .action(
      async (opts: {
        version?: string;
        channel?: "stable" | "beta";
        restart?: boolean;
      }) => {
        await runUpgrade({
          version: opts.version,
          channel: opts.channel,
          restart: opts.restart,
        });
      }
    );
}
