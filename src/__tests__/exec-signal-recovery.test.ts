/**
 * `unerr exec` signal recovery — integration through runExecMain.
 *
 * Reproduces the reported failure: `unerr exec -- pnpm test:run` died with
 * exit 143 and ZERO output. After the streaming-runner fix, a signal-killed
 * command must (a) return 128+signum, (b) print everything captured up to the
 * kill, (c) attribute the signal, and (d) never return an empty body for any
 * non-zero exit.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderEmptyOutputFallback, runExecMain } from "../commands/exec.js";
import { TEST_ARTIFACT_RELPATH } from "../proxy/test-artifact.js";

let dir: string;
let prevCwd: string;
let prevShell: string | undefined;
let stdoutChunks: string[];

function execArgv(cmd: string): string[] {
  return [
    "node",
    "unerr",
    "exec",
    "--b64",
    Buffer.from(cmd, "utf-8").toString("base64"),
  ];
}

function printed(): string {
  return stdoutChunks.join("");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unerr-exec-recovery-"));
  prevCwd = process.cwd();
  process.chdir(dir);
  prevShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  stdoutChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(
    (() => true) as typeof process.stderr.write
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(prevCwd);
  // NOT `process.env.SHELL = undefined` — env assignment coerces to the
  // string "undefined"; deleteProperty restores true absence.
  if (prevShell === undefined) Reflect.deleteProperty(process.env, "SHELL");
  else process.env.SHELL = prevShell;
  rmSync(dir, { recursive: true, force: true });
});

describe("runExecMain — signal-killed command", () => {
  it("returns 143, keeps captured output, and attributes the signal", async () => {
    const code = await runExecMain(
      execArgv("echo survived-the-signal; kill -TERM $$")
    );
    expect(code).toBe(143);
    expect(printed()).toContain("survived-the-signal");
    expect(printed()).toContain("received SIGTERM");
    expect(printed()).toContain("exit 143");
  }, 20000);

  it("renders the recovered test verdict when a fresh artifact exists", async () => {
    // Pre-stage the artifact write the way a completed vitest run does — the
    // file lands during the command (mtime after start), then SIGTERM hits.
    mkdirSync(join(dir, ".unerr"), { recursive: true });
    const artifact = join(dir, TEST_ARTIFACT_RELPATH);
    const report = JSON.stringify({
      numTotalTests: 10,
      numPassedTests: 9,
      numFailedTests: 1,
      numPendingTests: 0,
      success: false,
      testResults: [
        {
          assertionResults: [
            {
              status: "failed",
              fullName: "suite > failing case",
              failureMessages: ["expected 1 to be 2"],
            },
          ],
        },
      ],
    });
    writeFileSync(artifact, report, "utf8");

    const code = await runExecMain(execArgv("kill -TERM $$"));
    expect(code).toBe(143);
    expect(printed()).toContain("9 passed · 1 failed · 0 skipped (10 total)");
    expect(printed()).toContain("do not re-run");
    expect(printed()).toContain("✗ suite > failing case");
  }, 20000);
});

describe("runExecMain — non-zero exit with empty output (Phase 2.5)", () => {
  it("never returns an empty body: attributes the silent failure", async () => {
    const code = await runExecMain(execArgv("exit 7"));
    expect(code).toBe(7);
    expect(printed()).toContain("exited 7");
    expect(printed()).toContain("produced no output");
  }, 20000);

  it("stays silent for grep no-match (exit 1 + empty stdout is a result)", async () => {
    const code = await runExecMain(
      execArgv("grep zzz_no_such_token_zzz /dev/null")
    );
    expect(code).toBe(1);
    expect(printed()).not.toContain("exited 1");
    expect(printed()).not.toContain("produced no output");
  }, 20000);
});

describe("renderEmptyOutputFallback", () => {
  it("surfaces the last 30 raw lines with the tee path", () => {
    const raw = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join(
      "\n"
    );
    const out = renderEmptyOutputFallback(
      raw,
      "/repo/.unerr/tee/123-live-pnpm-test.txt",
      143,
      "SIGTERM"
    );
    expect(out).toContain("killed by SIGTERM (exit 143)");
    expect(out).toContain("last 30 raw lines");
    expect(out).toContain("line-50");
    expect(out).toContain("line-21");
    expect(out).not.toContain("line-20\n");
    expect(out).toContain("/repo/.unerr/tee/123-live-pnpm-test.txt");
  });

  it("reports plainly when stdout+stderr were genuinely empty", () => {
    const out = renderEmptyOutputFallback("", null, 7, null);
    expect(out).toContain("exited 7");
    expect(out).toContain("produced no output (stdout+stderr empty)");
  });

  it("caps a megaline tail at 4000 bytes", () => {
    const out = renderEmptyOutputFallback("x".repeat(20_000), null, 1, null);
    // header line + capped tail
    expect(out.length).toBeLessThan(4200);
  });
});
