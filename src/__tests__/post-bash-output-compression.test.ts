import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OUTPUT_COMPRESSION_KEY } from "../config/output-compression-flag.js";
import { runPostBashHookAsync } from "../hooks/shell-hooks.js";
import { readNudgeState } from "../proxy/nudge-state.js";

/** A jest/vitest-shaped run: 200 PASS lines plus a summary. The test_results
 *  strategy cuts this to ~4% of its size, well past the 30% tee threshold. */
function compressibleTestOutput(): string {
  const lines = Array.from(
    { length: 200 },
    (_, i) => `PASS src/foo${i}.test.ts`
  );
  return `${lines.join("\n")}\n\nTest Suites: 200 passed, 200 total\nTests: 900 passed, 900 total\n`;
}

/** `ls -la` output: classified with high confidence but barely compressible
 *  (~96% of original), so the tee gate rejects it and nothing is replaced. */
function incompressibleTabularOutput(): string {
  return Array.from(
    { length: 120 },
    (_, i) =>
      `-rw-r--r--  1 me staff  ${1000 + i} Jul 26 10:0${i % 10} file${i}.txt`
  ).join("\n");
}

function stdin(
  command: string,
  stdout: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: {
      stdout,
      stderr: "",
      interrupted: false,
      isImage: false,
      ...extra,
    },
  });
}

interface HookOut {
  hookSpecificOutput?: {
    hookEventName?: string;
    updatedToolOutput?: {
      stdout: string;
      stderr: string;
      interrupted: boolean;
      isImage: boolean;
    };
    additionalContext?: string;
  };
}

describe("post-bash output compression (opt-in)", () => {
  const realCwd = process.cwd();
  let repo: string;

  beforeEach(() => {
    repo = join(tmpdir(), `post-bash-oc-${Date.now()}-${Math.random()}`);
    mkdirSync(join(repo, ".unerr"), { recursive: true });
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(realCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  /** Write `.unerr/config.json` with the compression flag set to `value`. */
  function setFlag(value: unknown): void {
    writeFileSync(
      join(repo, ".unerr", "config.json"),
      JSON.stringify({ [OUTPUT_COMPRESSION_KEY]: value })
    );
  }

  it("compresses by default, with no config file present", async () => {
    const out = JSON.parse(
      await runPostBashHookAsync(stdin("npm test", compressibleTestOutput()))
    ) as HookOut;
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeDefined();
  });

  it("does not touch output when the repo opts out with false", async () => {
    setFlag(false);
    const out = JSON.parse(
      await runPostBashHookAsync(stdin("npm test", compressibleTestOutput()))
    ) as HookOut;
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
  });

  it("treats a corrupt config as no opt-out rather than a silent disable", async () => {
    writeFileSync(join(repo, ".unerr", "config.json"), "{not json");
    const out = JSON.parse(
      await runPostBashHookAsync(stdin("npm test", compressibleTestOutput()))
    ) as HookOut;
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeDefined();
  });

  it("stays off in a directory unerr does not manage", async () => {
    // No `.unerr/` at entry, so the compressor is never invoked and never tees
    // into a directory unerr does not own. The flag is read before the base
    // handler for exactly this reason: verify-tracking creates `.unerr/state/`
    // for a check command like `npm test`, so reading it afterwards would see a
    // managed directory that was unmanaged a moment earlier.
    const bare = join(tmpdir(), `post-bash-bare-${Date.now()}`);
    mkdirSync(bare, { recursive: true });
    process.chdir(bare);
    try {
      const out = JSON.parse(
        await runPostBashHookAsync(stdin("npm test", compressibleTestOutput()))
      ) as HookOut;
      expect(out.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
      expect(existsSync(join(bare, ".unerr", "tee"))).toBe(false);
    } finally {
      process.chdir(repo);
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("does not compress a command that reads a teed original back", async () => {
    setFlag(true);
    const out = JSON.parse(
      await runPostBashHookAsync(
        stdin(
          "cat .unerr/tee/1785074887351-npm-test.txt",
          compressibleTestOutput()
        )
      )
    ) as HookOut;
    // Cutting this output would cut the bytes the tee exists to recover.
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
  });

  it("replaces compressible output, keeping stderr verbatim", async () => {
    setFlag(true);
    const raw = compressibleTestOutput();
    const payload = stdin("npm test", raw, {
      stderr: "warning: deprecated flag --foo\n",
    });

    const out = JSON.parse(await runPostBashHookAsync(payload)) as HookOut;
    const replaced = out.hookSpecificOutput?.updatedToolOutput;
    expect(out.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(replaced).toBeDefined();
    if (!replaced) return;

    expect(replaced.stdout.length).toBeLessThan(raw.length * 0.7);
    // The summary line survives — the point is a cut, not a truncation.
    expect(replaced.stdout).toContain("900");
    // stderr is never compressed: the docs warn that dropping error detail makes
    // the model act on a false assumption.
    expect(replaced.stderr).toBe("warning: deprecated flag --foo\n");
    expect(replaced.interrupted).toBe(false);
    expect(replaced.isImage).toBe(false);
  });

  it("tees the pre-compression output and points at it inside the replacement", async () => {
    setFlag(true);
    const out = JSON.parse(
      await runPostBashHookAsync(stdin("npm test", compressibleTestOutput()))
    ) as HookOut;

    const stdoutText = out.hookSpecificOutput?.updatedToolOutput?.stdout ?? "";
    expect(stdoutText).toMatch(/\[full output [\d.]+KB: file_read\(/);

    const tees = readdirSync(join(repo, ".unerr", "tee"));
    expect(tees.length).toBe(1);
    // Exactly one tee file: the compressor tees internally, so the handler must
    // not write a second copy of the same output.
    expect(tees[0]).toMatch(/\.txt$/);

    // No additionalContext — the retrieval call is already inside stdout, and a
    // second copy would bill the same instruction twice.
    expect(out.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it("leaves output alone when compression saves too little to tee", async () => {
    setFlag(true);
    const out = JSON.parse(
      await runPostBashHookAsync(stdin("ls -la", incompressibleTabularOutput()))
    ) as HookOut;
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
  });

  it("leaves output under 1KB alone", async () => {
    setFlag(true);
    const small = "PASS src/a.test.ts\nTests: 1 passed, 1 total\n";
    const out = JSON.parse(
      await runPostBashHookAsync(stdin("npm test", small))
    ) as HookOut;
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
  });

  it("leaves an interrupted run alone", async () => {
    setFlag(true);
    const out = JSON.parse(
      await runPostBashHookAsync(
        stdin("npm test", compressibleTestOutput(), { interrupted: true })
      )
    ) as HookOut;
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
  });

  it("leaves an image response alone", async () => {
    setFlag(true);
    const out = JSON.parse(
      await runPostBashHookAsync(
        stdin("npm test", compressibleTestOutput(), { isImage: true })
      )
    ) as HookOut;
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
  });

  it("does not re-compress output that already came through unerr exec", async () => {
    setFlag(true);
    const out = JSON.parse(
      await runPostBashHookAsync(
        stdin("unerr exec -- npm test", compressibleTestOutput())
      )
    ) as HookOut;
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
  });

  it("leaves output alone when tool_response is not Bash's object shape", async () => {
    setFlag(true);
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: compressibleTestOutput(),
    });
    const out = JSON.parse(await runPostBashHookAsync(payload)) as HookOut;
    expect(out.hookSpecificOutput?.updatedToolOutput).toBeUndefined();
  });

  it("still records check-command runs when compression replaces the output", async () => {
    setFlag(true);
    const before = readNudgeState(repo).check_cmd_count;
    await runPostBashHookAsync(stdin("npm test", compressibleTestOutput()));
    // Verification awareness is load-bearing for the Stop-hook verify gate, so
    // it must survive the compression branch rather than short-circuit with it.
    expect(readNudgeState(repo).check_cmd_count).toBe(before + 1);
  });

  it("returns {} for empty stdin", async () => {
    expect(await runPostBashHookAsync("")).toBe("{}");
  });
});
