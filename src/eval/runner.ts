/**
 * Smoke eval runner — Sprint A skeleton.
 *
 * Responsibilities:
 *   1. Load a task definition.
 *   2. Stage a fresh workspace for the task's repo fixture.
 *   3. Optionally run `unerr install` (config B).
 *   4. Invoke the agent CLI — "noop" in smoke; real headless agent in
 *      ship-gate/live phases.
 *   5. Capture transcript + a copy of the proxy events.jsonl.
 *   6. Run metric extraction → RunSummary.
 *
 * The smoke harness exercises (1), (2), (3), (5), (6) end-to-end against
 * a no-op agent so the orchestration glue is proven before Sprint D adds
 * the real agent invocation in step (4).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./configs.js";
import { listToolsCalled, parseEventsJsonl } from "./metrics.js";
import type {
  AgentConfig,
  RunArtifacts,
  RunSummary,
  TaskDef,
} from "./types.js";

const EVAL_DIR = resolve(fileURLToPath(import.meta.url), "..");
const TASKS_DIR = join(EVAL_DIR, "tasks");

export function loadTask(taskId: string): TaskDef {
  const path = join(TASKS_DIR, `${taskId}.json`);
  if (!existsSync(path)) {
    throw new Error(`task not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as TaskDef;
}

export interface RunOptions {
  /** Override the workspace root for testability. Defaults to a tmpdir. */
  workspaceRoot?: string;
  /** Override the source repo path. Defaults to the current unerr-cli repo. */
  sourceRepoOverride?: string;
  /** Skip the `unerr install` step even when the config requests it. */
  skipInstall?: boolean;
}

/**
 * Stage a workspace for one run. Smoke implementation copies a minimal
 * subset (package.json, src/, no node_modules) to keep clones fast — the
 * full ship-gate runner will use `git clone --depth 1` against the
 * fixture repo.
 */
async function stageWorkspace(
  task: TaskDef,
  workspaceRoot: string
): Promise<string> {
  await mkdirIfMissing(workspaceRoot);
  const ws = await mkdtemp(join(workspaceRoot, `eval-${task.id}-`));
  // Smoke: do not actually copy fixture contents — a no-op agent doesn't
  // read them. Ship-gate will fill this in.
  writeFileSync(
    join(ws, "TASK.md"),
    `# ${task.title}\n\nrepo: ${task.repo}\n\n${task.prompt}\n`,
    "utf8"
  );
  return ws;
}

async function mkdirIfMissing(dir: string): Promise<void> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function maybeRunInstall(config: AgentConfig, workspace: string): void {
  if (!config.install_unerr) return;
  // Smoke: only record the intent. Ship-gate will exec
  //   `node dist/cli.js install claude-code --cwd <workspace>`
  // once the install command supports a target-cwd flag and we have a
  // packaged fixture to install into.
  writeFileSync(
    join(workspace, ".unerr-install-marker"),
    `would-install: claude-code\nconfig: ${config.id}\n`,
    "utf8"
  );
}

async function invokeAgent(
  config: AgentConfig,
  workspace: string,
  task: TaskDef
): Promise<{ transcript: string; events: string; durationMs: number }> {
  const start = Date.now();
  if (config.agent_cli === "noop") {
    // No-op contract: produce an empty transcript and empty events
    // stream. This proves the harness reads zero-state without errors.
    const transcript = "";
    const events = "";
    return { transcript, events, durationMs: Date.now() - start };
  }
  // claude-code-headless path lands in Sprint C ship-gate. Once it
  // exists, this branch spawns the headless agent, pipes the prompt,
  // captures stdout/stderr, and reads `${workspace}/.unerr/logs/events.jsonl`.
  const _unused = spawnSync; // ESLint: keep import live for the ship-gate path.
  void _unused;
  void task;
  throw new Error(
    `agent_cli '${config.agent_cli}' is not implemented in the smoke harness — Sprint C wires the real headless path`
  );
}

function persistArtifacts(
  workspace: string,
  transcript: string,
  events: string
): RunArtifacts {
  const transcriptPath = join(workspace, "transcript.txt");
  const eventsPath = join(workspace, "events.jsonl");
  writeFileSync(transcriptPath, transcript, "utf8");
  writeFileSync(eventsPath, events, "utf8");
  return {
    workspace_dir: workspace,
    transcript_path: transcriptPath,
    events_path: eventsPath,
  };
}

function summarize(
  task: TaskDef,
  config: AgentConfig,
  artifacts: RunArtifacts,
  durationMs: number
): RunSummary {
  const events = parseEventsJsonl(readFileSync(artifacts.events_path, "utf8"));
  const tools_called = listToolsCalled(events);
  const assertions_passed = (task.assertions ?? []).length === 0; // smoke: empty assertions always pass
  const notes: string[] = [];
  if (config.agent_cli === "noop") {
    notes.push("noop agent — no transcript or events captured");
  }
  return {
    task_id: task.id,
    config_id: config.id,
    duration_ms: durationMs,
    tools_called,
    tokens_used: null,
    turns: null,
    assertions_passed,
    notes,
  };
}

/** Run one (task, config) cell of the eval matrix. */
export async function runOne(
  taskId: string,
  configId: string,
  opts: RunOptions = {}
): Promise<RunSummary> {
  const task = loadTask(taskId);
  const config = getConfig(configId);
  const workspaceRoot = opts.workspaceRoot ?? tmpdir();
  const workspace = await stageWorkspace(task, workspaceRoot);
  if (!opts.skipInstall) maybeRunInstall(config, workspace);
  const { transcript, events, durationMs } = await invokeAgent(
    config,
    workspace,
    task
  );
  const artifacts = persistArtifacts(workspace, transcript, events);
  return summarize(task, config, artifacts, durationMs);
}

/** Run one cell and clean up the workspace. Returns the summary only. */
export async function runOneAndCleanup(
  taskId: string,
  configId: string,
  opts: RunOptions = {}
): Promise<RunSummary> {
  const summary = await runOne(taskId, configId, opts);
  // best-effort cleanup; ignore errors
  try {
    if (existsSync(summary.task_id))
      await rm(summary.task_id, { recursive: true, force: true });
  } catch {
    // ignore
  }
  return summary;
}

// CLI entrypoint: `tsx eval/runner.ts <task-id> <config-id>`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , taskId, configId] = process.argv;
  if (!taskId || !configId) {
    process.stderr.write(
      "usage: tsx eval/runner.ts <task-id> <config-id>\n" +
        "  e.g. tsx eval/runner.ts 001-add-health-endpoint a-naive\n"
    );
    process.exit(1);
  }
  runOne(taskId, configId).then(
    (summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    },
    (err: unknown) => {
      process.stderr.write(`eval-runner error: ${(err as Error).message}\n`);
      process.exit(2);
    }
  );
}
