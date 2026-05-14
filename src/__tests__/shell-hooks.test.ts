import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseExecCommandLine, runExecMain } from "../commands/exec.js";
import { mergePreToolUseBashHook } from "../config/claude-settings-hooks.js";
import { runPreBashHook } from "../hooks/shell-hooks.js";

describe("runPreBashHook", () => {
  it("rewrites single-line Bash command to unerr exec -- (Claude Code protocol)", () => {
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_input: { command: "ps aux" },
    });
    const out = JSON.parse(runPreBashHook(stdin)) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        updatedInput: { command: string };
      };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput.command).toBe(
      "unerr exec -- ps aux",
    );
  });

  it("rewrites multi-line Bash command to unerr exec --b64", () => {
    const multiLine = 'python3 -c "import os\nprint(os.getcwd())"';
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_input: { command: multiLine },
    });
    const out = JSON.parse(runPreBashHook(stdin)) as {
      hookSpecificOutput: {
        updatedInput: { command: string };
      };
    };
    const rewritten = out.hookSpecificOutput.updatedInput.command;
    expect(rewritten).toMatch(/^unerr exec --b64 /);
    const b64 = rewritten.replace("unerr exec --b64 ", "");
    expect(Buffer.from(b64, "base64").toString("utf-8")).toBe(multiLine);
  });

  it("returns {} for empty stdin", () => {
    expect(runPreBashHook("")).toBe("{}");
  });

  it("passthrough when already unerr exec", () => {
    const stdin = JSON.stringify({
      tool_input: { command: "unerr exec -- echo hi" },
    });
    expect(runPreBashHook(stdin)).toBe("{}");
  });
});

describe("parseExecCommandLine", () => {
  it("parses tokens after exec and optional --", () => {
    expect(
      parseExecCommandLine(["node", "cli", "exec", "--", "echo", "a"]),
    ).toBe("echo a");
    expect(parseExecCommandLine(["exec", "pwd"])).toBe("pwd");
  });

  it("decodes --b64 base64-encoded commands", () => {
    const cmd = "python3 -c \"print('hello\\nworld')\"";
    const b64 = Buffer.from(cmd, "utf-8").toString("base64");
    expect(parseExecCommandLine(["exec", "--b64", b64])).toBe(cmd);
  });
});

describe("runExecMain", () => {
  it("runs echo via bash -lc", async () => {
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = await runExecMain([
      "node",
      "cli.js",
      "exec",
      "--",
      "echo",
      "ok",
    ]);
    expect(code).toBe(0);
    spy.mockRestore();
  });

  it("falls back to raw output on shell parse error", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    // Unterminated quote — zsh emits "unmatched", bash emits "syntax error"
    const code = await runExecMain([
      "node",
      "cli.js",
      "exec",
      "--b64",
      Buffer.from('echo "unterminated', "utf-8").toString("base64"),
    ]);
    expect(code).not.toBe(0);
    // stdout should contain raw shell error without compression header
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toMatch(/unmatched|parse error|syntax error|unexpected/i);
    expect(output).not.toMatch(/^_shell_fmt:/);
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe("mergePreToolUseBashHook", () => {
  it("writes settings.json with PreToolUse entry", () => {
    const dir = join(tmpdir(), `fe-d-st-${Date.now()}`);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const r = mergePreToolUseBashHook(dir);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("merged");
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf-8"),
    ) as { hooks: { PreToolUse: unknown[] } };
    expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rewrites hooks idempotently on subsequent merges (binary-path refresh)", () => {
    // Behavior change: every merge now strips existing unerr hooks and re-adds
    // them, so binary paths stay current (handles `pnpm link` upgrades from bare
    // to absolute paths). The result is `merged` on every call but the on-disk
    // state stays stable (same hook count, same shape).
    const dir = join(tmpdir(), `fe-d-st2-${Date.now()}`);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const r1 = mergePreToolUseBashHook(dir);
    const r2 = mergePreToolUseBashHook(dir);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Idempotent in the on-disk sense: two merges produce identical settings.
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf-8"),
    );
    const preTool = settings.hooks?.PreToolUse;
    expect(Array.isArray(preTool)).toBe(true);
    // No duplicate unerr entries.
    // 6 PreToolUse matcher entries: Bash, Read, Grep, Glob, Write, Edit — each
    // with one `unerr hook pre-*` command. No duplicates (key check: each
    // matcher appears exactly once).
    const unerrEntries = (
      preTool as Array<{
        matcher?: string;
        hooks?: Array<{ command?: string }>;
      }>
    ).filter((entry) =>
      entry.hooks?.some((h) => (h.command ?? "").includes("unerr")),
    );
    expect(unerrEntries.length).toBe(6);
    const matchers = unerrEntries.map((e) => e.matcher).sort();
    expect(matchers).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
