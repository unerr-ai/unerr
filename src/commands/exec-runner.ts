/**
 * Streaming shell runner for `unerr exec` — spawns the user's shell, captures
 * stdout/stderr incrementally, tees raw output to disk AS IT ARRIVES, and
 * survives SIGTERM/SIGINT/SIGHUP: the signal is forwarded to the child, the
 * partial capture is finalized, and the exit code reports 128+signum.
 *
 * Why this exists: `pnpm run test:run` completes its suite, then a
 * teardown-time SIGTERM kills the foreground job. The old buffered runner
 * (tinyexec) died holding everything in memory — the agent saw exit 143 with
 * ZERO output and re-ran the whole suite. Streaming capture + the live tee
 * mean the results survive the signal and reach the agent on the first turn.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanupOldTees, commandSlug } from "../proxy/shell-tee.js";
import { signalExitCode } from "../utils/exec.js";

export interface StreamRunResult {
  /** Raw (untrimmed) stdout captured up to process end. */
  stdout: string;
  /** Raw (untrimmed) stderr captured up to process end. */
  stderr: string;
  /** Child's exit code, or 128+signum when the run ended by signal. */
  exitCode: number;
  /** Signal that ended the run — relayed by us or delivered straight to the child. */
  signal: NodeJS.Signals | null;
  durationMs: number;
  /**
   * Incremental raw capture on disk (arrival-ordered stdout+stderr interleave),
   * created lazily on the first output chunk. Null when the command produced
   * no output or the tee write failed.
   */
  liveTeePath: string | null;
}

/** Signals we forward to the child instead of dying with the buffer unflushed. */
const RELAYED_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
/** After relaying a signal, give the child this long to exit before SIGKILL. */
const KILL_GRACE_MS = 2000;
/**
 * 'close' waits for the stdio pipes to drain — grandchildren that inherited
 * the pipes (vitest fork workers) can hold them open past the shell's death.
 * After 'exit' fires, wait at most this long for 'close' before finalizing.
 */
const CLOSE_WAIT_AFTER_EXIT_MS = 1000;

/**
 * Run `<shell> -lc <cmd>` with streaming capture and live tee.
 * Never rejects — spawn failures resolve with exitCode 127 and the error on stderr.
 */
export function runStreamingShell(
  shell: string,
  cmd: string,
  cwd: string
): Promise<StreamRunResult> {
  const startMs = Date.now();
  return new Promise((resolve) => {
    const child = spawn(shell, ["-lc", cmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let liveTeePath: string | null = null;
    let teeBroken = false;
    let relayedSignal: NodeJS.Signals | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let exitTimer: NodeJS.Timeout | null = null;
    let settled = false;

    // Tee logs pin to the repo root (process.cwd() after the caller's exec
    // chdir — see runExecMain in exec.ts), while the child above still spawns
    // with the `cwd` param (the agent's real working directory) so relative
    // commands keep working.
    const teeDir = join(process.cwd(), ".unerr", "tee");

    // Tee is best-effort recovery data — a failed write must never break the
    // command, so the first failure disables it for the rest of the run.
    const appendTee = (chunk: string): void => {
      if (teeBroken) return;
      try {
        if (liveTeePath === null) {
          mkdirSync(teeDir, { recursive: true });
          const ts = Date.now();
          const candidate = join(teeDir, `${ts}-live-${commandSlug(cmd)}.txt`);
          const header = [
            "# unerr live tee — raw output (streamed as it arrived)",
            `# command: ${cmd}`,
            `# started: ${new Date(ts).toISOString()}`,
            "# ---",
            "",
          ].join("\n");
          appendFileSync(candidate, header, "utf8");
          liveTeePath = candidate;
          cleanupOldTees(teeDir);
        }
        appendFileSync(liveTeePath, chunk, "utf8");
      } catch {
        teeBroken = true;
      }
    };

    child.stdout?.on("data", (buf: Buffer) => {
      const s = buf.toString("utf8");
      stdout += s;
      appendTee(s);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const s = buf.toString("utf8");
      stderr += s;
      appendTee(s);
    });

    // Relay terminal-delivered signals to the child, then SIGKILL after a
    // grace window. We stay alive to finalize the capture — the whole point.
    const onRelaySignal = (sig: NodeJS.Signals): void => {
      if (relayedSignal === null) relayedSignal = sig;
      try {
        child.kill(sig);
      } catch {
        // child already gone — 'close' will finalize
      }
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead
          }
        }, KILL_GRACE_MS);
      }
    };
    const handlers = RELAYED_SIGNALS.map((sig) => {
      const handler = (): void => onRelaySignal(sig);
      process.on(sig, handler);
      return [sig, handler] as const;
    });

    const finalize = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      if (settled) return;
      settled = true;
      for (const [sig, handler] of handlers) {
        process.removeListener(sig, handler);
      }
      if (killTimer !== null) clearTimeout(killTimer);
      if (exitTimer !== null) clearTimeout(exitTimer);
      const endSignal = relayedSignal ?? signal;
      const exitCode =
        typeof code === "number"
          ? code
          : endSignal !== null
            ? signalExitCode(endSignal)
            : 0;
      resolve({
        stdout,
        stderr,
        exitCode,
        signal: endSignal,
        durationMs: Date.now() - startMs,
        liveTeePath,
      });
    };

    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}unerr exec: failed to spawn ${shell}: ${err.message}`;
      finalize(127, null);
    });
    child.on("exit", (code, signal) => {
      // Backstop: if orphaned grandchildren hold the pipes open, 'close'
      // never fires — finalize with the capture we already have.
      exitTimer = setTimeout(
        () => finalize(code, signal),
        CLOSE_WAIT_AFTER_EXIT_MS
      );
    });
    child.on("close", (code, signal) => finalize(code, signal));
  });
}

/**
 * Remove a live tee after a clean run — `compressShellOutput` writes its own
 * tee for significant compressions, so keeping both duplicates disk usage.
 * Keep the live tee on any failure or signal path: it is the recovery source.
 */
export function discardLiveTee(path: string | null): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone or unwritable — nothing to recover either way
  }
}
