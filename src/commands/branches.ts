import * as fs from "node:fs";
import * as path from "node:path";
/**
 * unerr branches — Show local git branches with drift overlay info.
 */
import type { Command } from "commander";
import { gitQuery } from "../utils/exec.js";

interface LocalBranchInfo {
  name: string;
  isCurrent: boolean;
  lastCommit: string;
  tracking: string;
  driftEntityCount: number;
}

export async function listLocalBranches(
  cwd: string
): Promise<LocalBranchInfo[]> {
  const raw = await gitQuery(
    [
      "branch",
      "-a",
      "--format=%(HEAD)|%(refname:short)|%(upstream:track)|%(committerdate:relative)",
    ],
    cwd
  );

  if (!raw) return [];

  const driftCounts = loadBranchDriftCounts(cwd);

  const branches: LocalBranchInfo[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split("|");
    const isCurrent = parts[0] === "*";
    const name = parts[1] ?? "";
    const tracking = parts[2] ?? "";
    const lastCommit = parts[3] ?? "";

    if (!name) continue;

    branches.push({
      name,
      isCurrent,
      lastCommit,
      tracking,
      driftEntityCount: driftCounts.get(name) ?? 0,
    });
  }

  return branches;
}

function loadBranchDriftCounts(cwd: string): Map<string, number> {
  const counts = new Map<string, number>();
  const branchDir = path.join(cwd, ".unerr", "state", "branch-overlays");
  if (!fs.existsSync(branchDir)) return counts;

  try {
    const entries = fs.readdirSync(branchDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const overlayPath = path.join(
        branchDir,
        entry.name,
        "overlay_snapshot.json"
      );
      if (!fs.existsSync(overlayPath)) continue;

      try {
        const raw = fs.readFileSync(overlayPath, "utf-8");
        const snapshot = JSON.parse(raw) as {
          branch: string;
          entities?: unknown[];
        };
        if (snapshot.branch && snapshot.entities) {
          counts.set(snapshot.branch, snapshot.entities.length);
        }
      } catch {
        // Skip corrupt snapshots
      }
    }
  } catch {
    // Non-blocking
  }

  return counts;
}

export function registerBranchesCommand(program: Command): void {
  program
    .command("branches")
    .description("Show branches for this repository")
    .action(async () => {
      try {
        const cwd = process.cwd();
        const branches = await listLocalBranches(cwd);

        if (branches.length === 0) {
          process.stderr.write("[unerr] No branches found.\n");
          return;
        }

        let withDrift = 0;
        process.stderr.write("\n");
        for (const branch of branches) {
          const marker = branch.isCurrent ? "* " : "  ";
          const trackingSuffix = branch.tracking ? ` ${branch.tracking}` : "";
          let driftSuffix = "";
          if (branch.driftEntityCount > 0) {
            driftSuffix = ` (${branch.driftEntityCount} drift entities)`;
            withDrift++;
          }
          process.stderr.write(
            `${marker}${branch.name.padEnd(30)} ${branch.lastCommit}${trackingSuffix}${driftSuffix}\n`
          );
        }

        process.stderr.write(
          `\n  ${branches.length} branches · ${withDrift} with drift overlays\n\n`
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
