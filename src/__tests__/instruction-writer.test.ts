import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type InstructionWriteResult,
  removeInstructionSection,
  writeInstructionFile,
} from "../config/instruction-writer.js";

describe("instruction-writer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `unerr-instr-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("writeInstructionFile — markdown (claude-code)", () => {
    it("creates CLAUDE.md with sentinel markers when file does not exist", () => {
      const result = writeInstructionFile(tmpDir, "claude-code");
      expect(result.action).toBe("created");
      expect(result.path).toBe(join(tmpDir, "CLAUDE.md"));

      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain("<!-- unerr:start -->");
      expect(content).toContain("<!-- unerr:end -->");
      expect(content).toContain("get_references");
      expect(content).toContain("search_code");
      expect(content).toContain("fetch_url");
    });

    it("appends to existing CLAUDE.md without sentinel", () => {
      const existingContent = "# My Project\n\nExisting instructions.\n";
      writeFileSync(join(tmpDir, "CLAUDE.md"), existingContent);

      const result = writeInstructionFile(tmpDir, "claude-code");
      expect(result.action).toBe("updated");

      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain("# My Project");
      expect(content).toContain("Existing instructions.");
      expect(content).toContain("<!-- unerr:start -->");
      expect(content).toContain("get_references");
    });

    it("skips when sentinel content is identical", () => {
      writeInstructionFile(tmpDir, "claude-code");
      const result = writeInstructionFile(tmpDir, "claude-code");
      expect(result.action).toBe("skipped");
    });

    it("updates when sentinel content differs", () => {
      // Write with old content
      const oldContent =
        "<!-- unerr:start -->\nOld content\n<!-- unerr:end -->\n";
      writeFileSync(join(tmpDir, "CLAUDE.md"), oldContent);

      const result = writeInstructionFile(tmpDir, "claude-code");
      expect(result.action).toBe("updated");

      const content = readFileSync(result.path, "utf-8");
      expect(content).not.toContain("Old content");
      expect(content).toContain("get_references");
    });

    it("preserves content before and after sentinel block", () => {
      const existing =
        "# Header\n\n<!-- unerr:start -->\nOld\n<!-- unerr:end -->\n\n# Footer\n";
      writeFileSync(join(tmpDir, "CLAUDE.md"), existing);

      writeInstructionFile(tmpDir, "claude-code");

      const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# Header");
      expect(content).toContain("# Footer");
      expect(content).toContain("get_references");
    });
  });

  describe("writeInstructionFile — mdc (cursor)", () => {
    it("creates .cursor/rules/unerr-instructions.mdc", () => {
      const result = writeInstructionFile(tmpDir, "cursor");
      expect(result.action).toBe("created");

      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain("alwaysApply: true");
      expect(content).toContain("get_references");
    });

    it("skips when content is identical", () => {
      writeInstructionFile(tmpDir, "cursor");
      const result = writeInstructionFile(tmpDir, "cursor");
      expect(result.action).toBe("skipped");
    });

    it("updates when content differs", () => {
      const filePath = join(
        tmpDir,
        ".cursor",
        "rules",
        "unerr-instructions.mdc"
      );
      mkdirSync(join(tmpDir, ".cursor", "rules"), { recursive: true });
      writeFileSync(filePath, "old mdc content");

      const result = writeInstructionFile(tmpDir, "cursor");
      expect(result.action).toBe("updated");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("alwaysApply: true");
    });
  });

  describe("writeInstructionFile — windsurf-rule (windsurf)", () => {
    it("creates .windsurf/rules/unerr-instructions.md with trigger frontmatter", () => {
      const result = writeInstructionFile(tmpDir, "windsurf");
      expect(result.action).toBe("created");

      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain("trigger: always_on");
      expect(content).toContain("get_references");
    });

    it("skips when content is identical", () => {
      writeInstructionFile(tmpDir, "windsurf");
      const result = writeInstructionFile(tmpDir, "windsurf");
      expect(result.action).toBe("skipped");
    });

    it("updates when content differs", () => {
      const filePath = join(
        tmpDir,
        ".windsurf",
        "rules",
        "unerr-instructions.md"
      );
      mkdirSync(join(tmpDir, ".windsurf", "rules"), { recursive: true });
      writeFileSync(filePath, "old windsurf content");

      const result = writeInstructionFile(tmpDir, "windsurf");
      expect(result.action).toBe("updated");

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("trigger: always_on");
    });
  });

  describe("writeInstructionFile — agents without instruction files", () => {
    it("returns skipped for zed", () => {
      const result = writeInstructionFile(tmpDir, "zed");
      expect(result.action).toBe("skipped");
    });
  });

  describe("writeInstructionFile — other agents", () => {
    it("creates AGENTS.md for codex", () => {
      const result = writeInstructionFile(tmpDir, "codex");
      expect(result.action).toBe("created");
      expect(result.path).toContain("AGENTS.md");
    });

    it("creates GEMINI.md for gemini-cli", () => {
      const result = writeInstructionFile(tmpDir, "gemini-cli");
      expect(result.action).toBe("created");
      expect(result.path).toContain("GEMINI.md");
    });

    it("creates .github/copilot-instructions.md for vscode", () => {
      const result = writeInstructionFile(tmpDir, "vscode");
      expect(result.action).toBe("created");
      expect(result.path).toContain("copilot-instructions.md");
    });

    it("creates .clinerules for cline", () => {
      const result = writeInstructionFile(tmpDir, "cline");
      expect(result.action).toBe("created");
      expect(result.path).toContain(".clinerules");
    });
  });

  describe("removeInstructionSection", () => {
    it("removes sentinel block from markdown file", () => {
      const existing = "# Header\n\nSome content.\n";
      writeFileSync(join(tmpDir, "CLAUDE.md"), existing);
      writeInstructionFile(tmpDir, "claude-code");

      const removed = removeInstructionSection(tmpDir, "claude-code");
      expect(removed).toBe(true);

      const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# Header");
      expect(content).not.toContain("<!-- unerr:start -->");
      expect(content).not.toContain("get_references");
    });

    it("deletes .mdc file for cursor", () => {
      writeInstructionFile(tmpDir, "cursor");
      const filePath = join(
        tmpDir,
        ".cursor",
        "rules",
        "unerr-instructions.mdc"
      );
      expect(existsSync(filePath)).toBe(true);

      const removed = removeInstructionSection(tmpDir, "cursor");
      expect(removed).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    });

    it("returns false when no instruction file exists", () => {
      const removed = removeInstructionSection(tmpDir, "claude-code");
      expect(removed).toBe(false);
    });

    it("removes windsurf-rule file", () => {
      writeInstructionFile(tmpDir, "windsurf");
      const filePath = join(
        tmpDir,
        ".windsurf",
        "rules",
        "unerr-instructions.md"
      );
      expect(existsSync(filePath)).toBe(true);

      const removed = removeInstructionSection(tmpDir, "windsurf");
      expect(removed).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    });

    it("returns false for agents without instruction files", () => {
      const removed = removeInstructionSection(tmpDir, "zed");
      expect(removed).toBe(false);
    });

    it("deletes file if only sentinel content remains", () => {
      writeInstructionFile(tmpDir, "claude-code");
      const removed = removeInstructionSection(tmpDir, "claude-code");
      expect(removed).toBe(true);
      expect(existsSync(join(tmpDir, "CLAUDE.md"))).toBe(false);
    });
  });

  describe("fallback rule — no-graph escape hatch", () => {
    it("names the escape hatch: switch to built-ins the moment unerr is unavailable or reports no graph", () => {
      const result = writeInstructionFile(tmpDir, "claude-code");
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain(
        "If unerr MCP is unavailable, errors, or reports no graph: use built-in Read/Grep/Glob for the rest of the session."
      );
      expect(content).not.toContain("(the #1 rule)");
      expect(content).not.toContain("there is always an unerr tool");
    });
  });

  describe("Layer 8 §2.4 — `@sem` section (repo detection + comments.maintain)", () => {
    const MARKER = "### `@sem` comments";

    function writeMaintainSetting(value: boolean): void {
      mkdirSync(join(tmpDir, ".unerr"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".unerr", "settings.json"),
        JSON.stringify({ comments: { maintain: value } })
      );
    }

    // tmpDir carries no .git dir, so repoHasSemComments falls back to the
    // capped filesystem scan — writing this fixture is enough to flip it true.
    function markRepoAsSemAdopter(): void {
      writeFileSync(
        join(tmpDir, "sem-fixture.ts"),
        "// A thing.\n// @sem domain=testing role=fixture\nexport function thing() {}\n"
      );
    }

    it("omits the section when the repo carries no @sem comments (no config)", () => {
      const result = writeInstructionFile(tmpDir, "claude-code");
      const content = readFileSync(result.path, "utf-8");
      expect(content).not.toContain(MARKER);
      expect(content).toContain("get_references");
    });

    it("includes the section once the repo carries an @sem comment — claude-code", () => {
      markRepoAsSemAdopter();
      const result = writeInstructionFile(tmpDir, "claude-code");
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain(MARKER);
      expect(content).toContain("@sem domain=");
    });

    it("includes the section once the repo carries an @sem comment — cursor (mdc)", () => {
      markRepoAsSemAdopter();
      const result = writeInstructionFile(tmpDir, "cursor");
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain(MARKER);
    });

    it('includes the "files changed" receipt note for claude-code', () => {
      const result = writeInstructionFile(tmpDir, "claude-code");
      const content = readFileSync(result.path, "utf-8");
      // The deterministic end-of-turn receipt is Stop-hook only (Claude Code).
      expect(content).toContain('"files changed" receipt');
      expect(content).toContain("You need not echo each edit");
    });

    it("omits the receipt note for cursor (no Stop-hook receipt channel)", () => {
      const result = writeInstructionFile(tmpDir, "cursor");
      const content = readFileSync(result.path, "utf-8");
      expect(content).not.toContain('"files changed" receipt');
      expect(content).not.toContain("You need not echo each edit");
      // but the file_edit routing section itself is still present.
      expect(content).toContain("file_edit");
    });

    it("comments.maintain=false omits the section even when the repo has @sem comments — claude-code", () => {
      markRepoAsSemAdopter();
      writeMaintainSetting(false);
      const result = writeInstructionFile(tmpDir, "claude-code");
      const content = readFileSync(result.path, "utf-8");
      expect(content).not.toContain(MARKER);
      // The rest of the instruction block is untouched.
      expect(content).toContain("get_references");
      expect(content).toContain("<!-- unerr:start -->");
    });

    it("comments.maintain=false omits the section — cursor (mdc)", () => {
      markRepoAsSemAdopter();
      writeMaintainSetting(false);
      const result = writeInstructionFile(tmpDir, "cursor");
      const content = readFileSync(result.path, "utf-8");
      expect(content).not.toContain(MARKER);
      expect(content).toContain("get_references");
    });

    it("comments.maintain=true is explicit-on and keeps the section", () => {
      markRepoAsSemAdopter();
      writeMaintainSetting(true);
      const result = writeInstructionFile(tmpDir, "claude-code");
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain(MARKER);
    });

    it("is idempotent — second write with the section skips", () => {
      markRepoAsSemAdopter();
      writeInstructionFile(tmpDir, "claude-code");
      const second = writeInstructionFile(tmpDir, "claude-code");
      expect(second.action).toBe("skipped");
    });

    it("toggling the flag off rewrites the section away", () => {
      markRepoAsSemAdopter();
      const first = writeInstructionFile(tmpDir, "claude-code");
      expect(first.action).toBe("created");
      expect(readFileSync(first.path, "utf-8")).toContain(MARKER);

      writeMaintainSetting(false);
      const second = writeInstructionFile(tmpDir, "claude-code");
      expect(second.action).toBe("updated");
      expect(readFileSync(second.path, "utf-8")).not.toContain(MARKER);
    });
  });

  describe("delegation pointer — unerr-worker/unerr-junior (replaces the tier table)", () => {
    it("points to unerr-worker/unerr-junior instead of the old tier table — claude-code", () => {
      const result = writeInstructionFile(tmpDir, "claude-code");
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain("unerr-worker");
      expect(content).toContain("unerr-junior");
      expect(content).not.toContain("Tier by the hardest part");
    });

    it("points to unerr-worker/unerr-junior instead of the old tier table — codex", () => {
      const result = writeInstructionFile(tmpDir, "codex");
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain("unerr-worker");
      expect(content).toContain("unerr-junior");
      expect(content).not.toContain("Tier by the hardest part");
    });
  });

  describe("recon + background one-liner (all agents)", () => {
    it("includes the recon-first and background-first one-liners for claude-code", () => {
      const result = writeInstructionFile(tmpDir, "claude-code");
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain(
        'search_code({query:"<task phrase>"})` recon call'
      );
      expect(content).toContain(
        "run in the background with output to a log file"
      );
    });

    it("includes the recon-first and background-first one-liners for codex", () => {
      const result = writeInstructionFile(tmpDir, "codex");
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain(
        "run in the background with output to a log file"
      );
    });

    it("includes the recon-first and background-first one-liners for cursor", () => {
      const result = writeInstructionFile(tmpDir, "cursor");
      const content = readFileSync(result.path, "utf-8");
      expect(content).toContain(
        "run in the background with output to a log file"
      );
    });
  });
});
