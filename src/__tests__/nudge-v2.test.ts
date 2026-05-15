/**
 * Tests for Nudge v2 — drift detector + session state.
 *
 * Critical contract: the new system must NOT degrade unerr MCP tool adoption.
 * - Drift detector must fire on grep/find/cat on code paths.
 * - Drift detector must NOT fire on legitimate Bash commands (npm, git tag,
 *   mkdir, clean linters, ls without -R, grep of log files, etc.) so the
 *   agent isn't nudged for things that don't have an unerr equivalent.
 * - State machine must enforce one-Tier-1-per-kind-per-session.
 * - markUnerrToolUsed must reset the drift accumulator so Tier 2 only fires
 *   on PERSISTENT drift, never on a single mistake.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDriftNudge, isDriftCommand } from "../proxy/drift-detector.js";
import {
  _resetNudgeState,
  markUnerrToolUsed,
  readNudgeState,
  updateNudgeState,
} from "../proxy/nudge-state.js";

describe("isDriftCommand — TRUE POSITIVES (must nudge)", () => {
  it("flags grep on a code path", () => {
    const h = isDriftCommand("grep -r 'compressShellOutput' src/proxy/");
    expect(h?.kind).toBe("code_search");
    expect(h?.arg).toBe("compressShellOutput");
    expect(h?.suggest).toContain("search_code");
  });

  it("flags rg on a code path", () => {
    const h = isDriftCommand("rg foo src/");
    expect(h?.kind).toBe("code_search");
  });

  it("flags find -name *.ts", () => {
    const h = isDriftCommand("find . -name '*.ts'");
    expect(h?.kind).toBe("code_search");
    expect(h?.suggest).toContain("search_code");
  });

  it("flags cat on a .ts file", () => {
    const h = isDriftCommand("cat src/proxy/shell-compressor.ts");
    expect(h?.kind).toBe("code_read");
    expect(h?.suggest).toContain("file_read");
    expect(h?.suggest).toContain("src/proxy/shell-compressor.ts");
  });

  it("flags head -100 on a .py file", () => {
    const h = isDriftCommand("head -100 lib/foo.py");
    expect(h?.kind).toBe("code_read");
  });

  it("flags ls -R src/", () => {
    const h = isDriftCommand("ls -R src/");
    expect(h?.kind).toBe("dir_explore");
    expect(h?.suggest).toContain("file_outline");
  });

  it("strips leading env vars before classification", () => {
    const h = isDriftCommand("FOO=1 BAR=2 grep -r 'x' src/");
    expect(h?.kind).toBe("code_search");
  });

  it("strips leading sudo / time prefixes", () => {
    const h = isDriftCommand("time grep -r 'x' src/");
    expect(h?.kind).toBe("code_search");
  });

  // Regression: absolute paths like /Users/foo/repo/src/proxy/ must fire too.
  // CODE_PATH_HINT_RE previously required src/lib/etc to be preceded by
  // whitespace/quote/start — slashes were excluded, so abs paths silently
  // bypassed the v2 drift nudge.
  it("flags grep against an absolute path containing src/", () => {
    const h = isDriftCommand(
      "grep -rn 'compressShellOutput' /Users/foo/repo/src/proxy/"
    );
    expect(h?.kind).toBe("code_search");
    expect(h?.suggest).toContain("search_code");
  });

  it("flags grep against an absolute path containing lib/", () => {
    const h = isDriftCommand("grep -rn 'foo' /home/u/code/lib/");
    expect(h?.kind).toBe("code_search");
  });
});

describe("isDriftCommand — TRUE NEGATIVES (must NOT nudge)", () => {
  // These are the commands the v1 nudge fired on unnecessarily.
  // Each one should return null — there is no unerr alternative.

  it("does NOT flag npm version", () => {
    expect(
      isDriftCommand("npm version 0.0.0-beta.11 --no-git-tag-version")
    ).toBeNull();
  });

  it("does NOT flag git tag / git status / git log", () => {
    expect(isDriftCommand("git tag v1.0.0")).toBeNull();
    expect(isDriftCommand("git status")).toBeNull();
    expect(isDriftCommand("git log --oneline -10")).toBeNull();
  });

  it("does NOT flag mkdir / chmod / rm", () => {
    expect(isDriftCommand("mkdir -p /tmp/foo")).toBeNull();
    expect(isDriftCommand("chmod +x /tmp/foo.sh")).toBeNull();
    expect(isDriftCommand("rm -rf /tmp/foo")).toBeNull();
  });

  it("does NOT flag a clean eslint run", () => {
    expect(
      isDriftCommand("node_modules/.bin/eslint 'app/(launch)'")
    ).toBeNull();
  });

  it("does NOT flag pnpm install / build / test", () => {
    expect(isDriftCommand("pnpm install")).toBeNull();
    expect(isDriftCommand("pnpm run build")).toBeNull();
    expect(isDriftCommand("pnpm exec vitest run")).toBeNull();
  });

  it("does NOT flag grep on a log file (no code extension)", () => {
    expect(isDriftCommand("grep ERROR build.log")).toBeNull();
    expect(isDriftCommand("grep 'foo' /var/log/syslog")).toBeNull();
  });

  it("does NOT flag cat on a non-code file", () => {
    expect(isDriftCommand("cat README.md")).toBeNull();
    expect(isDriftCommand("cat package.json")).toBeNull();
    expect(isDriftCommand("cat /tmp/output.txt")).toBeNull();
  });

  it("does NOT flag ls without -R", () => {
    expect(isDriftCommand("ls src/")).toBeNull();
    expect(isDriftCommand("ls -la /tmp/")).toBeNull();
  });

  it("does NOT flag find without -name on code", () => {
    expect(isDriftCommand("find . -type d")).toBeNull();
    expect(isDriftCommand("find /tmp -mmin -5")).toBeNull();
  });

  it("does NOT flag find -name '*.log'", () => {
    expect(isDriftCommand("find . -name '*.log'")).toBeNull();
  });

  it("does NOT flag empty or whitespace command", () => {
    expect(isDriftCommand("")).toBeNull();
    expect(isDriftCommand("   ")).toBeNull();
  });
});

describe("formatDriftNudge — output shape", () => {
  it("produces a one-line nudge with the alternative", () => {
    // Post-trim format (table rows #1-4): drops the internal "drift(<kind>):
    // try" preamble. Line starts with "[unerr]" + the paste-ready call.
    const hint = isDriftCommand("grep -r foo src/")!;
    const line = formatDriftNudge(hint);
    expect(line).toMatch(/^\[unerr\] search_code\(/);
    expect(line).toContain("search_code");
    expect(line).not.toContain("drift("); // taxonomy prefix removed
    expect(line.length).toBeLessThan(200);
  });
});

describe("nudge-state — session flag persistence", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `unerr-nudge-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tmpRoot, ".unerr"), { recursive: true });
    _resetNudgeState(tmpRoot);
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("reads default state for a fresh session", () => {
    const s = readNudgeState(tmpRoot);
    expect(s.tier0_emitted).toBe(false);
    expect(s.tier1_emitted_kinds).toEqual([]);
    expect(s.drift_count).toBe(0);
    expect(s.tier2_emitted).toBe(false);
  });

  it("persists tier1 emissions per kind", () => {
    updateNudgeState(tmpRoot, (s) => {
      s.tier1_emitted_kinds.push("code_search");
      s.drift_count = 1;
    });
    const s2 = readNudgeState(tmpRoot);
    expect(s2.tier1_emitted_kinds).toEqual(["code_search"]);
    expect(s2.drift_count).toBe(1);
  });

  it("markUnerrToolUsed resets drift_count and clears Tier-2", () => {
    updateNudgeState(tmpRoot, (s) => {
      s.drift_count = 5;
      s.tier2_emitted = true;
    });
    markUnerrToolUsed(tmpRoot);
    const s = readNudgeState(tmpRoot);
    expect(s.drift_count).toBe(0);
    expect(s.tier2_emitted).toBe(false);
    expect(s.last_unerr_tool_at).toBeDefined();
  });

  it("readNudgeState recovers gracefully from corrupt state", () => {
    // Make sure the state dir exists, then write garbage
    mkdirSync(join(tmpRoot, ".unerr", "state"), { recursive: true });
    writeFileSync(
      join(tmpRoot, ".unerr", "state", `nudge-pid-${process.pid}.flags`),
      "{not json",
      { flag: "w" }
    );
    // Should not throw
    const s = readNudgeState(tmpRoot);
    expect(s.tier0_emitted).toBe(false);
  });
});

describe("anti-drift correctness — guarantees that protect MCP tool adoption", () => {
  // These are the safety properties the new system MUST preserve.

  it("every drift-positive command has a non-empty suggestion", () => {
    const positives = [
      "grep -r foo src/",
      "rg pattern src/proxy/",
      "find . -name '*.ts'",
      "cat src/foo.ts",
      "head src/bar.py",
      "tail -50 src/baz.rs",
      "ls -R src/",
    ];
    for (const cmd of positives) {
      const h = isDriftCommand(cmd);
      expect(h).not.toBeNull();
      expect(h?.suggest.length).toBeGreaterThan(20);
      expect(h?.suggest).toMatch(/search_code|file_read|file_outline|get_/);
    }
  });

  it("nudge text length is always shorter than ~10× a small command", () => {
    // The drift nudge must be tight enough that even a 30-byte command
    // gets a useful one-liner, not a paragraph.
    const h = isDriftCommand("grep -r x src/")!;
    expect(formatDriftNudge(h).length).toBeLessThan(150);
  });

  it("no drift-positive overlaps with build/test/install commands", () => {
    // If we ever falsely flag these, Phase B rollout would break agent flow.
    const benign = [
      "pnpm test",
      "pnpm install --frozen-lockfile",
      "npm run build",
      "cargo test",
      "go test ./...",
      "make all",
      "docker build -t foo .",
      "kubectl apply -f k8s.yaml",
    ];
    for (const cmd of benign) {
      expect(isDriftCommand(cmd)).toBeNull();
    }
  });
});
