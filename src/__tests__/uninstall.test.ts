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
import { normalizeAgentName } from "../config/agent-registry.js";
import {
  mergePreToolUseBashHook,
  removePreToolUseBashHook,
} from "../config/claude-settings-hooks.js";
import {
  removeInstructionSection,
  writeInstructionFile,
} from "../config/instruction-writer.js";
import {
  removeMcpConfig,
  writeMcpConfig,
} from "../config/mcp-config-writer.js";
import { removeInstalledSkills } from "../skills/resolver.js";

describe("uninstall", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `unerr-uninstall-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("normalizeAgentName", () => {
    it("resolves 'claude' to 'claude-code'", () => {
      expect(normalizeAgentName("claude")).toBe("claude-code");
    });

    it("resolves 'Claude' case-insensitively", () => {
      expect(normalizeAgentName("Claude")).toBe("claude-code");
    });

    it("resolves 'gemini' to 'gemini-cli'", () => {
      expect(normalizeAgentName("gemini")).toBe("gemini-cli");
    });

    it("passes through unknown names unchanged", () => {
      expect(normalizeAgentName("cursor")).toBe("cursor");
    });
  });

  describe("removeInstalledSkills", () => {
    it("removes flat skill files for cursor", () => {
      const rulesDir = join(tmpDir, ".cursor", "rules");
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(join(rulesDir, "unerr-graph-first.mdc"), "content");
      writeFileSync(join(rulesDir, "unerr-search.mdc"), "content");
      writeFileSync(join(rulesDir, "other-rule.mdc"), "should stay");

      const removed = removeInstalledSkills("cursor", tmpDir);
      expect(removed).toBe(2);
      expect(existsSync(join(rulesDir, "unerr-graph-first.mdc"))).toBe(false);
      expect(existsSync(join(rulesDir, "unerr-search.mdc"))).toBe(false);
      expect(existsSync(join(rulesDir, "other-rule.mdc"))).toBe(true);
    });

    it("removes directory-per-skill for claude-code", () => {
      const skillsDir = join(tmpDir, ".claude", "skills");
      const skillDir = join(skillsDir, "unerr-graph-first");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "content");

      const removed = removeInstalledSkills("claude-code", tmpDir);
      expect(removed).toBe(1);
      expect(existsSync(skillDir)).toBe(false);
    });

    it("returns 0 when no skills exist", () => {
      const removed = removeInstalledSkills("cursor", tmpDir);
      expect(removed).toBe(0);
    });
  });

  describe("removePreToolUseBashHook", () => {
    it("removes unerr hook from settings.json", () => {
      // First merge it in
      mergePreToolUseBashHook(tmpDir);
      const settingsPath = join(tmpDir, ".claude", "settings.json");
      expect(existsSync(settingsPath)).toBe(true);

      const before = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(before.hooks.PreToolUse).toHaveLength(6); // Bash, Read, Grep, Glob, Write, Edit

      // Now remove
      const removed = removePreToolUseBashHook(tmpDir);
      expect(removed).toBe(true);

      const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
      // PreToolUse should be cleaned up
      expect(after.hooks?.PreToolUse).toBeUndefined();
    });

    it("preserves other hooks when removing unerr hook", () => {
      const dir = join(tmpDir, ".claude");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "other-tool" }],
              },
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "unerr hook pre-bash" }],
              },
            ],
            PostToolUse: [
              {
                matcher: "Write",
                hooks: [{ type: "command", command: "lint" }],
              },
            ],
          },
        }),
      );

      const removed = removePreToolUseBashHook(tmpDir);
      expect(removed).toBe(true);

      const after = JSON.parse(
        readFileSync(join(dir, "settings.json"), "utf-8"),
      );
      expect(after.hooks.PreToolUse).toHaveLength(1);
      expect(after.hooks.PreToolUse[0].hooks[0].command).toBe("other-tool");
      expect(after.hooks.PostToolUse).toHaveLength(1);
    });

    it("returns false when no settings.json exists", () => {
      expect(removePreToolUseBashHook(tmpDir)).toBe(false);
    });

    it("returns false when no unerr hook present", () => {
      const dir = join(tmpDir, ".claude");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ hooks: { PreToolUse: [] } }),
      );
      expect(removePreToolUseBashHook(tmpDir)).toBe(false);
    });
  });

  describe("per-agent uninstall symmetry", () => {
    it("removeMcpConfig reverses writeMcpConfig for cursor", () => {
      const result = writeMcpConfig(tmpDir, "cursor");
      expect(existsSync(result.path)).toBe(true);

      const removed = removeMcpConfig(tmpDir, "cursor");
      expect(removed).toBe(true);
    });

    it("removeInstructionSection reverses writeInstructionFile", () => {
      writeInstructionFile(tmpDir, "claude-code");
      const claudeMd = join(tmpDir, "CLAUDE.md");
      expect(existsSync(claudeMd)).toBe(true);

      const removed = removeInstructionSection(tmpDir, "claude-code");
      expect(removed).toBe(true);
      // File should be deleted since it only had sentinel content
      expect(existsSync(claudeMd)).toBe(false);
    });

    it("uninstall is idempotent — second call returns false/0", () => {
      // Install then uninstall
      writeMcpConfig(tmpDir, "cursor");
      removeMcpConfig(tmpDir, "cursor");

      // Second uninstall should be no-ops
      expect(removeMcpConfig(tmpDir, "cursor")).toBe(false);
      expect(removeInstalledSkills("cursor", tmpDir)).toBe(0);
      expect(removeInstructionSection(tmpDir, "cursor")).toBe(false);
    });
  });
});
