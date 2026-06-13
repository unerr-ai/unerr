/**
 * Track 4 orchestrator CLI: loads a task manifest, sets up one worktree per arm,
 * and for each (task, arm) applies the break, times the `claude -p` run, runs the
 * gate test, reads the unerr metrics window, and records a RunRecord. At the end
 * it scores all runs and writes a markdown report. Run with `--dry-run` to validate
 * the manifest and arm wiring without spending any agent budget.
 *
 * @sem domain=benchmark role=orchestrator
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildClaudeArgs,
  type DriverOptions,
  runClaude,
} from "./claude-driver.js";
import { readPlatformEvents } from "./metrics-reader.js";
import {
  type ArmWorkspace,
  applyBreak,
  resetWorktree,
  runOracle,
  setupArmWorkspace,
  wipeUnerrMemory,
  writeEmptyMcpConfig,
} from "./repo-harness.js";
import { buildReport, renderReport } from "./score.js";
import {
  ALL_ARMS,
  type ArmId,
  armKeepsMemory,
  armUsesUnerr,
  emptyPlatform,
  type RunRecord,
  type TaskManifest,
} from "./types.js";

/** Parsed CLI flags. */
interface CliOpts {
  manifestPath: string;
  reps: number;
  arms: ArmId[];
  dryRun: boolean;
  scoreOnly: boolean;
  outDir: string;
  permissionMode: string;
  model?: string;
  maxTurns?: number;
}

function parseArgs(argv: string[]): CliOpts {
  const [manifestPath] = argv;
  if (!manifestPath) {
    throw new Error(
      "usage: tsx run.ts <tasks.json> [--reps N] [--arms a,b] [--dry-run] [--score-only] [--out DIR] [--permission-mode MODE] [--model M] [--max-turns N]"
    );
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const armsRaw = flag("arms");
  const arms = armsRaw
    ? (armsRaw.split(",").map((s) => s.trim()) as ArmId[])
    : ALL_ARMS;
  for (const a of arms) {
    if (!ALL_ARMS.includes(a)) {
      throw new Error(`unknown arm "${a}" — valid: ${ALL_ARMS.join(", ")}`);
    }
  }

  return {
    manifestPath: resolve(manifestPath),
    reps: Number(flag("reps") ?? 1),
    arms,
    dryRun: has("dry-run"),
    scoreOnly: has("score-only"),
    outDir: resolve(flag("out") ?? join(dirname(resolve(manifestPath)), "out")),
    permissionMode: flag("permission-mode") ?? "acceptEdits",
    model: flag("model"),
    maxTurns: flag("max-turns") ? Number(flag("max-turns")) : undefined,
  };
}

function loadManifest(path: string): TaskManifest {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as TaskManifest;
  if (!raw.repo || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error(`manifest ${path} needs a "repo" and a non-empty "tasks"`);
  }
  return raw;
}

/** Coarse epoch-ms clock for run windows. */
function now(): number {
  return Number(execSync("date +%s%3N", { encoding: "utf-8" }).trim());
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(opts.manifestPath);
  const arms = manifest.arms ?? opts.arms;
  mkdirSync(opts.outDir, { recursive: true });

  const runsPath = join(opts.outDir, "runs.jsonl");

  // --score-only: re-score an existing runs.jsonl without touching the agent.
  if (opts.scoreOnly) {
    const runs = readFileSync(runsPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunRecord);
    writeReport(runs, opts.outDir);
    return;
  }

  const emptyMcp = writeEmptyMcpConfig(join(opts.outDir, "empty-mcp.json"));
  const driverOpts: DriverOptions = {
    permissionMode: opts.permissionMode,
    model: opts.model,
    emptyMcpConfigPath: emptyMcp,
    maxTurns: opts.maxTurns,
  };

  const repoDir = resolve(manifest.repo);
  const workRoot = join(opts.outDir, "worktrees");

  // Install unerr into a worktree by writing its project-level .mcp.json. The
  // unerr binary is expected on PATH (the dev links it globally during testing).
  const installUnerr = (worktreeDir: string): void => {
    if (opts.dryRun) return;
    execSync("unerr install claude-code", {
      cwd: worktreeDir,
      stdio: "inherit",
    });
  };

  const records: RunRecord[] = [];
  const recordLines: string[] = [];

  for (const arm of arms) {
    const ws: ArmWorkspace = setupArmWorkspace(
      repoDir,
      workRoot,
      arm,
      manifest.baseCommit,
      installUnerr
    );
    if (manifest.setupCommand && !opts.dryRun) {
      execSync(manifest.setupCommand, { cwd: ws.worktreeDir, stdio: "inherit" });
    }

    for (let rep = 0; rep < opts.reps; rep++) {
      for (const task of manifest.tasks) {
        applyBreak(task, ws.worktreeDir);

        const startTs = now();
        let record: RunRecord;

        if (opts.dryRun) {
          // Validate arg wiring without spending budget.
          const args = buildClaudeArgs(task.prompt, arm, driverOpts);
          process.stderr.write(
            `[dry-run] ${arm} :: ${task.id} :: claude ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`
          );
          record = {
            instanceId: `${task.id}#${rep}`,
            taskId: task.id,
            arm,
            dependsOn: task.dependsOn ?? [],
            resolved: false,
            inputTokens: 0,
            outputTokens: 0,
            turns: 0,
            wallMs: 0,
            costUsd: 0,
            breakages: 0,
            platform: emptyPlatform(),
          };
        } else {
          let breakages = 0;
          let driver = {
            inputTokens: 0,
            outputTokens: 0,
            turns: 0,
            costUsd: 0,
            isError: false,
          };
          try {
            driver = runClaude(task.prompt, arm, ws.worktreeDir, driverOpts);
            if (driver.isError) breakages = 1;
          } catch (err) {
            // A CLI crash is a breakage, not a thrown run — record and continue.
            process.stderr.write(
              `[error] ${arm} :: ${task.id} :: ${(err as Error).message}\n`
            );
            breakages = 1;
          }
          const oracle = runOracle(task, ws.worktreeDir);
          const endTs = now();
          const platform = armUsesUnerr(arm)
            ? readPlatformEvents(ws.unerrDir, { startTs, endTs })
            : emptyPlatform();

          record = {
            instanceId: `${task.id}#${rep}`,
            taskId: task.id,
            arm,
            dependsOn: task.dependsOn ?? [],
            resolved: oracle.resolved,
            inputTokens: driver.inputTokens,
            outputTokens: driver.outputTokens,
            turns: driver.turns,
            wallMs: endTs - startTs,
            costUsd: driver.costUsd,
            breakages,
            platform,
          };
        }

        records.push(record);
        recordLines.push(JSON.stringify(record));

        // Reset between tasks so each oracle is independent. The nomemory arm
        // also has its memory wiped so a later dependent task starts cold.
        if (!opts.dryRun) {
          resetWorktree(ws, manifest.baseCommit, false);
          if (armUsesUnerr(arm) && !armKeepsMemory(arm)) {
            wipeUnerrMemory(ws);
          }
        }
      }
    }
  }

  writeFileSync(runsPath, `${recordLines.join("\n")}\n`);
  process.stderr.write(`\nwrote ${records.length} runs → ${runsPath}\n`);
  if (!opts.dryRun) {
    writeReport(records, opts.outDir);
  }
}

function writeReport(runs: RunRecord[], outDir: string): void {
  const report = buildReport(runs);
  const md = renderReport(report);
  const reportPath = join(outDir, "REPORT.md");
  writeFileSync(reportPath, md);
  process.stderr.write(`wrote report → ${reportPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
