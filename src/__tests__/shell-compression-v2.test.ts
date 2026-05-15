/**
 * Tests for the RTK-parity shell compression upgrades (R1, R3, R4, R6, R7, R9).
 *
 * The per-classifier floor test lives in shell-compression-floor.test.ts (R10).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractFilePathCandidates } from "../proxy/shell-graph-boost.js";
import { tryCompressCloud } from "../proxy/shell-strategies/cloud.js";
import { compressErrorDiagnostic } from "../proxy/shell-strategies/error-diagnostic.js";
import {
  _clearFilterCache,
  applyUserFilter,
} from "../proxy/shell-strategies/filter-dsl.js";
import { compressLogText } from "../proxy/shell-strategies/log-text.js";
import {
  getBuiltinRedactRules,
  redactOutput,
} from "../proxy/shell-strategies/redact.js";
import { compressTreePaths } from "../proxy/shell-strategies/tree-paths.js";

describe("R6 — redact primitive", () => {
  it("redacts the user's home directory to ~", () => {
    const home = process.env.HOME ?? "/Users/test";
    const input = `Editing ${home}/projects/foo.ts`;
    const out = redactOutput(input);
    if (home) {
      expect(out).toContain("~/projects/foo.ts");
      expect(out).not.toContain(home);
    }
  });

  it("redacts ISO timestamps to <ts>", () => {
    const input = "2026-05-13T14:32:01.123Z something happened";
    expect(redactOutput(input)).toContain("<ts>");
  });

  it("redacts UUIDs", () => {
    const input = "request_id=12345678-1234-1234-1234-123456789012 done";
    expect(redactOutput(input)).toContain("<uuid>");
  });

  it("collapses 40-char SHA to first-7 + ellipsis", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    expect(redactOutput(`commit ${sha}`)).toMatch(/abcdef1[…]/);
  });

  it("applies extra user-supplied rules after builtins", () => {
    const out = redactOutput("foo bar baz", [
      { pattern: /bar/g, replacement: "QUX" },
    ]);
    expect(out).toBe("foo QUX baz");
  });

  it("exposes builtin rules read-only", () => {
    expect(getBuiltinRedactRules().length).toBeGreaterThan(0);
  });
});

describe("R7 — tree-paths grouping", () => {
  it("passes through small outputs unchanged", () => {
    const tiny = ["src/a.ts", "src/b.ts", "src/c.ts"].join("\n");
    expect(compressTreePaths(tiny)).toBe(tiny);
  });

  it("groups large path lists by directory + extension", () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(`src/components/file_${i}.tsx`);
    for (let i = 0; i < 40; i++) lines.push(`src/lib/util_${i}.ts`);
    const out = compressTreePaths(lines.join("\n"));
    expect(out).toContain("_shell_fmt:tree_paths");
    expect(out).toContain("src/components/");
    expect(out).toContain(".tsx");
    expect(out).toContain("src/lib/");
    // Should be substantially smaller
    expect(out.length).toBeLessThan(lines.join("\n").length * 0.6);
  });

  it("rolls up node_modules / .git / dist", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(`node_modules/pkg/${i}.js`);
    const out = compressTreePaths(lines.join("\n"));
    expect(out).toContain("node_modules/");
    expect(out).toContain("[collapsed]");
  });
});

describe("R1 — success short-circuit (log_text, error_diagnostic)", () => {
  it("collapses clean build logs to one line", () => {
    const lines: string[] = ["Starting compile..."];
    for (let i = 0; i < 200; i++) lines.push(`compiling module_${i}.ts`);
    lines.push("Finished release [optimized] target(s) in 12.3s");
    const out = compressLogText(lines.join("\n"), "cargo build");
    expect(out).toContain("build ok");
    expect(out.split("\n").length).toBeLessThanOrEqual(2);
  });

  it("does NOT short-circuit when an error is present", () => {
    const text = [
      "compiling foo.ts",
      "ERROR: type mismatch on line 42",
      "compiling bar.ts",
    ]
      .concat(Array.from({ length: 100 }, (_, i) => `line ${i}`))
      .join("\n");
    const out = compressLogText(text, "cargo build");
    expect(out).not.toMatch(/^_shell_fmt:log_text\nbuild ok/);
  });

  it("collapses lint output when no issues found", () => {
    const out = compressErrorDiagnostic(
      "Checked 47 files. All checks passed.",
      "eslint"
    );
    expect(out).toContain("eslint ok");
  });

  it("does NOT short-circuit lint output with errors", () => {
    const out = compressErrorDiagnostic(
      "src/foo.ts:10:5 error: Cannot find name 'bar'",
      "tsc"
    );
    expect(out).not.toContain("ok");
  });
});

describe("R3 — user filter DSL", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `unerr-filter-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tmpRoot, ".unerr"), { recursive: true });
    _clearFilterCache();
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    _clearFilterCache();
  });

  it("returns null when no filter matches", () => {
    writeFileSync(
      join(tmpRoot, ".unerr", "filters.toml"),
      `[filters.something]\nmatch_command = "^never-runs"\nmax_lines = 5\n`
    );
    expect(applyUserFilter("my-tool run", "hello", tmpRoot)).toBeNull();
  });

  it("applies strip_lines_matching", () => {
    writeFileSync(
      join(tmpRoot, ".unerr", "filters.toml"),
      `[filters.mytool]\nmatch_command = "^mytool"\nstrip_lines_matching = ["^DEBUG"]\n`
    );
    const r = applyUserFilter(
      "mytool run",
      "INFO: ok\nDEBUG: chatter\nDONE",
      tmpRoot
    );
    expect(r).not.toBeNull();
    expect(r?.text).not.toContain("DEBUG");
    expect(r?.text).toContain("INFO: ok");
  });

  it("short-circuits on match_output", () => {
    writeFileSync(
      join(tmpRoot, ".unerr", "filters.toml"),
      `[filters.green]\nmatch_command = "^anything"\nmatch_output = [{ pattern = "all green", message = "ok" }]\n`
    );
    const r = applyUserFilter("anything", "all green here", tmpRoot);
    expect(r?.text).toBe("_shell_fmt:user_filter\nok");
  });

  it("applies replace substitutions", () => {
    writeFileSync(
      join(tmpRoot, ".unerr", "filters.toml"),
      `[filters.scrub]\nmatch_command = "^scrub"\nreplace = [{ pattern = "secret", replacement = "***" }]\n`
    );
    const r = applyUserFilter("scrub run", "the secret thing", tmpRoot);
    expect(r?.text).toContain("***");
    expect(r?.text).not.toContain("secret");
  });

  it("respects tail_lines window", () => {
    writeFileSync(
      join(tmpRoot, ".unerr", "filters.toml"),
      `[filters.tail]\nmatch_command = "^tail"\ntail_lines = 3\n`
    );
    const lines = Array.from({ length: 20 }, (_, i) => `line_${i}`).join("\n");
    const r = applyUserFilter("tail run", lines, tmpRoot);
    expect(r?.text).toContain("line_19");
    expect(r?.text).toContain("earlier lines suppressed");
    expect(r?.text).not.toContain("line_5");
  });
});

describe("R4 — cloud parsers", () => {
  it("compresses aws ec2 describe-instances", () => {
    const payload = JSON.stringify({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-0abc",
              State: { Name: "running" },
              InstanceType: "t3.micro",
              PrivateIpAddress: "10.0.0.5",
              Placement: { AvailabilityZone: "us-east-1a" },
              Tags: [{ Key: "Name", Value: "web" }],
            },
            {
              InstanceId: "i-0def",
              State: { Name: "stopped" },
              InstanceType: "t3.nano",
              PrivateIpAddress: "10.0.0.6",
              Placement: { AvailabilityZone: "us-east-1b" },
              Tags: [],
            },
          ],
        },
      ],
    });
    const out = tryCompressCloud(payload, "aws ec2 describe-instances");
    expect(out).toContain("_shell_fmt:cloud[aws-ec2]");
    expect(out).toContain("i-0abc");
    expect(out).toContain("running");
    expect(out!.length).toBeLessThan(payload.length);
  });

  it("compresses aws iam list-users", () => {
    const payload = JSON.stringify({
      Users: Array.from({ length: 5 }, (_, i) => ({
        UserName: `user${i}`,
        Arn: `arn:aws:iam::123456789012:user/user${i}`,
      })),
    });
    const out = tryCompressCloud(payload, "aws iam list-users");
    expect(out).toContain("_shell_fmt:cloud[aws-iam]");
    expect(out).toContain("user0");
    expect(out).toContain("arn:…:");
  });

  it("compresses kubectl get -o json", () => {
    const payload = JSON.stringify({
      kind: "PodList",
      items: Array.from({ length: 4 }, (_, i) => ({
        metadata: { name: `pod-${i}`, namespace: "default" },
        status: { phase: "Running" },
      })),
    });
    const out = tryCompressCloud(payload, "kubectl get pods -o json");
    expect(out).toContain("_shell_fmt:cloud[kubectl-get]");
    expect(out).toContain("pod-0");
  });

  it("compresses docker inspect", () => {
    const payload = JSON.stringify([
      {
        Id: "abc123def456789",
        State: { Status: "running" },
        Config: { Image: "node:20" },
        Name: "/web",
      },
    ]);
    const out = tryCompressCloud(payload, "docker inspect web");
    expect(out).toContain("_shell_fmt:cloud[docker-inspect]");
    expect(out).toContain("running");
    expect(out).toContain("node:20");
  });

  it("returns null on unknown commands", () => {
    expect(tryCompressCloud("hello", "echo hello")).toBeNull();
  });

  it("returns null when JSON parse fails", () => {
    expect(
      tryCompressCloud("not json", "aws ec2 describe-instances")
    ).toBeNull();
  });
});

describe("R9 — file path extraction for graph boost", () => {
  it("extracts code-file paths from arbitrary output", () => {
    const text = `
  modified:   src/proxy/shell-compressor.ts
  modified:   src/intelligence/local-graph.ts
  new file:   docs/README.md
`;
    const paths = extractFilePathCandidates(text);
    expect(paths).toContain("src/proxy/shell-compressor.ts");
    expect(paths).toContain("src/intelligence/local-graph.ts");
  });

  it("ignores random strings without an extension", () => {
    const paths = extractFilePathCandidates("foo bar baz");
    expect(paths.length).toBe(0);
  });

  it("caps results at 64", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`src/file_${i}.ts`);
    expect(
      extractFilePathCandidates(lines.join("\n")).length
    ).toBeLessThanOrEqual(64);
  });
});

describe("F2 — git status dedicated parser", () => {
  it("compresses a typical git status output", async () => {
    const { compressGitStatus } = await import(
      "../proxy/shell-strategies/git-status.js"
    );
    const raw = `On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
\tmodified:   docs/USER_TESTING_CHECKLIST.md
\tmodified:   package.json
\tmodified:   src/proxy/shell-compressor.ts
\tmodified:   src/proxy/shell-graph-boost.ts
\tmodified:   src/proxy/shell-strategies/log-text.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
\tsrc/proxy/shell-strategies/git-status.ts
\tsrc/proxy/shell-strategies/redact.ts

no changes added to commit (use "git add" and/or "git commit -a")`;
    const out = compressGitStatus(raw);
    expect(out).not.toBeNull();
    expect(out).toContain("_shell_fmt:git_status");
    expect(out).toContain("branch=main");
    expect(out).toContain("modified: 5");
    expect(out).toContain("untracked: 2");
    expect(out).not.toContain('(use "git add'); // boilerplate stripped
    // Substantially smaller
    expect(out!.length).toBeLessThan(raw.length * 0.7);
  });

  it("returns null on non-git-status input", async () => {
    const { compressGitStatus } = await import(
      "../proxy/shell-strategies/git-status.js"
    );
    expect(compressGitStatus("some random output")).toBeNull();
    expect(compressGitStatus("hello world")).toBeNull();
  });

  it("groups large file lists by directory + extension", async () => {
    const { compressGitStatus } = await import(
      "../proxy/shell-strategies/git-status.js"
    );
    const lines = ["On branch main", "", "Untracked files:"];
    for (let i = 0; i < 25; i++) lines.push(`\tsrc/components/file_${i}.tsx`);
    for (let i = 0; i < 15; i++) lines.push(`\tsrc/lib/util_${i}.ts`);
    const out = compressGitStatus(lines.join("\n"));
    expect(out).toContain("untracked: 40");
    expect(out).toContain("src/components/");
    expect(out).toContain(".tsx");
  });
});

describe("F3 — R1 short-circuit no longer gated on build command", () => {
  it("collapses clean wrapper-script output (was rejected before)", async () => {
    const { compressLogText } = await import(
      "../proxy/shell-strategies/log-text.js"
    );
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`processing item_${i}`);
    lines.push("All checks passed");
    // No "build/cargo/gradle/..." in command — previously skipped short-circuit
    const out = compressLogText(lines.join("\n"), "/tmp/wrapper.sh");
    expect(out).toContain("ok — All checks passed");
    expect(out.split("\n").length).toBeLessThanOrEqual(2);
  });

  it("still uses 'build ok' label for build commands", async () => {
    const { compressLogText } = await import(
      "../proxy/shell-strategies/log-text.js"
    );
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`compiling foo_${i}.ts`);
    lines.push("Finished release [optimized] target(s) in 12.3s");
    const out = compressLogText(lines.join("\n"), "cargo build");
    expect(out).toContain("build ok");
  });
});

describe("F1 — graph boost diagnostic logging + cache", () => {
  it("exposes _clearShellBoostCache for tests", async () => {
    const mod = await import("../proxy/shell-graph-boost.js");
    expect(typeof mod._clearShellBoostCache).toBe("function");
    // Idempotent
    mod._clearShellBoostCache();
    mod._clearShellBoostCache();
  });

  it("returns null cleanly when snapshot is missing", async () => {
    const { tryLoadGraphForShellBoost, _clearShellBoostCache } = await import(
      "../proxy/shell-graph-boost.js"
    );
    _clearShellBoostCache();
    // Random cwd guaranteed to not have a snapshot
    const result = await tryLoadGraphForShellBoost(
      `/tmp/nonexistent-${Date.now()}`
    );
    expect(result).toBeNull();
  });
});
