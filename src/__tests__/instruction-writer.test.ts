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
});
