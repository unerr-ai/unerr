/**
 * Work-mode `run_command` — run a shell command, compress what it printed,
 * keep the full output on disk.
 *
 * WHY THIS IS A TOOL AND NOT A HOOK
 *
 * In code mode the same compression happens invisibly: a PreToolUse hook wraps
 * the host's own shell tool and pipes its output through `unerr compress-output`.
 * Document hosts do not fire that hook (anthropics/claude-code#40495), so there
 * is nothing to intercept. `run_command` is the doorway instead — the agent has
 * to call it to run anything, which is what puts the output on the compressed
 * path.
 *
 * Behaviour matches `unerr compress-output` (`src/commands/compress-output.ts`),
 * the stdin→stdout version, with one difference: NO entity risk map is passed.
 * That map ranks output lines by how risky the entities they mention are, and it
 * is read out of the graph. There is no graph here, so compression falls back to
 * its structural scoring (errors, diff headers, first and last lines).
 *
 * The full, uncompressed output is teed to a file inside the work state dir and
 * its path is returned, so a truncated run is always recoverable with one
 * `file_read`.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { resolve } from "node:path";
import { compressOutput } from "../../proxy/output-compressor.js";
import { teeShellOutput } from "../../proxy/shell-tee.js";
import { type WorkState, ensureWorkStateDir } from "../state.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TOKEN_BUDGET = 2000;

/** Stop buffering a runaway command rather than filling memory. */
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024;

export interface WorkRunCommandArgs {
  readonly command?: unknown;
  readonly cwd?: unknown;
  readonly timeout_ms?: unknown;
  readonly token_budget?: unknown;
}

interface RunOutcome {
  readonly output: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly capped: boolean;
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<RunOutcome> {
  const started = Date.now();
  return new Promise<RunOutcome>((resolvePromise) => {
    const options: SpawnOptions = {
      cwd,
      shell: true,
      // stdin closed: a command that prompts must fail fast, not hang the server.
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    };
    const child = spawn(command, options);

    const chunks: string[] = [];
    let bytes = 0;
    let capped = false;
    let timedOut = false;
    let settled = false;

    const collect = (data: Buffer): void => {
      if (capped) return;
      const text = data.toString("utf8");
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > MAX_CAPTURE_BYTES) {
        capped = true;
        chunks.push(
          `\n[unerr] output passed ${MAX_CAPTURE_BYTES} bytes — capture stopped here.\n`
        );
        return;
      }
      chunks.push(text);
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        output: chunks.join(""),
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        capped,
      });
    };

    child.on("error", (err) => {
      chunks.push(`\n[unerr] spawn failed: ${err.message}\n`);
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/**
 * Run one shell command and return the compressed transcript plus the tee path.
 */
export async function runWorkCommand(
  args: WorkRunCommandArgs,
  state: WorkState
): Promise<string> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command.length === 0) {
    return "run_command requires command. Pass command:'<shell command line>'.";
  }

  const rawCwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
  const cwd =
    rawCwd.length > 0 ? resolve(state.workRoot, rawCwd) : state.workRoot;
  const timeoutMs = clampInt(
    args.timeout_ms,
    DEFAULT_TIMEOUT_MS,
    1_000,
    MAX_TIMEOUT_MS
  );
  const tokenBudget = clampInt(
    args.token_budget,
    DEFAULT_TOKEN_BUDGET,
    100,
    100_000
  );

  const outcome = await runShell(command, cwd, timeoutMs);

  const status = outcome.timedOut
    ? `timed out after ${timeoutMs}ms`
    : outcome.signal !== null
      ? `killed by ${outcome.signal}`
      : `exit ${outcome.exitCode ?? "unknown"}`;
  const header = `$ ${command}\n[${status}, ${outcome.durationMs}ms]`;

  if (outcome.output.length === 0) {
    return `${header}\n(no output)`;
  }

  // No entityRiskMap — work mode has no graph, so there are no entity risk
  // signals to rank lines by. Structural scoring stands on its own.
  const compressed = compressOutput(outcome.output, {
    tokenBudget,
  });

  const lines: string[] = [header, compressed.output];

  // Tee only when the state dir is writable AND the compressor actually
  // dropped something worth recovering (teeShellOutput enforces its own
  // ratio/size floor and returns null below it).
  if (compressed.output.length < outcome.output.length) {
    if (ensureWorkStateDir(state) !== null) {
      const tee = teeShellOutput(
        state.teeBase,
        command,
        outcome.output,
        compressed.output
      );
      if (tee !== null) {
        const dropped = outcome.output.length - compressed.output.length;
        lines.push(
          `ur|fct ${dropped} bytes withheld from run_command output — full ${tee.sizeBytes}-byte transcript at ${tee.filePath}; call file_read({file_path:'${tee.filePath}', offset:0, limit:400}) for the raw lines`
        );
      }
    }
  }

  if (outcome.capped) {
    lines.push(
      `ur|fct run_command stopped capturing at ${MAX_CAPTURE_BYTES} bytes — re-run with output redirected to a file, then call file_read on it`
    );
  }

  return lines.join("\n\n");
}
