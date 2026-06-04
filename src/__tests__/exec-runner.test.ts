/**
 * Streaming exec runner — signal resilience + live tee.
 *
 * The scenario behind these tests: `pnpm run test:run` completes its suite,
 * then a teardown-time SIGTERM kills the process. The buffered runner died
 * with exit masked to 0 and ZERO output; the streaming runner must report
 * 128+signum AND keep everything captured up to the kill.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discardLiveTee, runStreamingShell } from "../commands/exec-runner.js";
import { signalExitCode } from "../utils/exec.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unerr-exec-runner-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("signalExitCode", () => {
  it("maps signals to 128+signum", () => {
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGHUP")).toBe(129);
  });

  it("maps unknown signal names to SIGTERM's 143", () => {
    expect(signalExitCode("SIGNOTREAL")).toBe(143);
  });
});

describe("runStreamingShell", () => {
  it("captures stdout and exits 0 for a normal command", async () => {
    const result = await runStreamingShell("/bin/sh", "echo hello-stream", dir);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("hello-stream");
  }, 15000);

  it("captures stderr separately from stdout", async () => {
    const result = await runStreamingShell(
      "/bin/sh",
      "echo to-out; echo to-err 1>&2",
      dir
    );
    expect(result.stdout).toContain("to-out");
    expect(result.stdout).not.toContain("to-err");
    expect(result.stderr).toContain("to-err");
  }, 15000);

  it("reports non-zero exit codes", async () => {
    const result = await runStreamingShell("/bin/sh", "exit 7", dir);
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
  }, 15000);

  it("keeps partial output and reports 143 when the child dies by SIGTERM", async () => {
    const result = await runStreamingShell(
      "/bin/sh",
      "echo partial-before-kill; kill -TERM $$",
      dir
    );
    expect(result.signal).toBe("SIGTERM");
    expect(result.exitCode).toBe(143);
    // The whole point: output produced before the signal survives.
    expect(result.stdout).toContain("partial-before-kill");
  }, 15000);

  it("tees output to disk as it arrives — the tee survives a signal death", async () => {
    const result = await runStreamingShell(
      "/bin/sh",
      "echo teed-line; kill -TERM $$",
      dir
    );
    expect(result.liveTeePath).not.toBeNull();
    expect(result.liveTeePath).toContain(join(".unerr", "tee"));
    const teed = readFileSync(result.liveTeePath as string, "utf8");
    expect(teed).toContain("teed-line");
    expect(teed).toContain("# unerr live tee");
  }, 15000);

  it("creates no tee file for a command with no output", async () => {
    const result = await runStreamingShell("/bin/sh", "true", dir);
    expect(result.liveTeePath).toBeNull();
  }, 15000);

  it("resolves with exit 127 when the shell binary doesn't exist", async () => {
    const result = await runStreamingShell(
      "/nonexistent-shell-zzz",
      "echo hi",
      dir
    );
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("failed to spawn");
  }, 15000);
});

describe("discardLiveTee", () => {
  it("removes the tee file and tolerates null / already-gone paths", async () => {
    const result = await runStreamingShell("/bin/sh", "echo discard-me", dir);
    const teePath = result.liveTeePath as string;
    expect(existsSync(teePath)).toBe(true);
    discardLiveTee(teePath);
    expect(existsSync(teePath)).toBe(false);
    // Idempotent + null-safe
    discardLiveTee(teePath);
    discardLiveTee(null);
  }, 15000);
});

describe("exec (tinyexec wrapper) signal mapping", () => {
  it("reports 143 + signal instead of masking a SIGTERM'd child as exit 0", async () => {
    const { exec } = await import("../utils/exec.js");
    const result = await exec("/bin/sh", ["-c", "kill -TERM $$"]);
    expect(result.signal).toBe("SIGTERM");
    expect(result.exitCode).toBe(143);
  }, 15000);
});

// Sanity guard for the test helper itself: `kill -TERM $$` must actually kill
// the direct child (signal reaches spawn's ChildProcess, not a grandchild).
describe("self-kill harness", () => {
  it("spawned shell receives the signal directly", async () => {
    const seen = await new Promise<string | null>((resolve) => {
      const child = spawn("/bin/sh", ["-c", "kill -TERM $$"]);
      child.on("close", (_code, signal) => resolve(signal));
    });
    expect(seen).toBe("SIGTERM");
  }, 15000);
});
