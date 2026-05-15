/**
 * Sprint S6: CLI Hooks Integration — Integration Tests.
 *
 * Verifies:
 *   - Auto-detection identifies installed AI tools by directory presence
 *   - `unerr init` installs Claude Code hook at correct path
 *   - `unerr init` writes MCP config for detected tools
 *   - `compress-output` command accepts graph risk map
 *   - `unerr uninstall` removes hooks cleanly
 *   - Hook status appears in status output data
 *   - Existing tests still pass
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../commands/init.js";
import {
  installClaudeHook,
  isClaudeHookInstalled,
  removeClaudeHook,
} from "../config/hook-installer.js";
import {
  isConfigured,
  removeMcpConfig,
  writeMcpConfig,
} from "../config/mcp-config-writer.js";
import { detectTools, formatDetectedTools } from "../config/tool-detector.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `unerr-s6-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Sprint S6: CLI Hooks Integration", () => {
  describe("S6.1: AI Tool Auto-Detection", () => {
    it("detects Claude Code by .claude/ directory", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".claude"), { recursive: true });

      const tools = detectTools(cwd);
      expect(tools.some((t) => t.ide === "claude-code")).toBe(true);
    });

    it("detects Cursor by .cursor/ directory", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".cursor"), { recursive: true });

      const tools = detectTools(cwd);
      expect(tools.some((t) => t.ide === "cursor")).toBe(true);
    });

    it("detects VS Code by .vscode/ directory", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".vscode"), { recursive: true });

      const tools = detectTools(cwd);
      expect(tools.some((t) => t.ide === "vscode")).toBe(true);
    });

    it("detects Windsurf by .windsurf/ directory", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".windsurf"), { recursive: true });

      const tools = detectTools(cwd);
      expect(tools.some((t) => t.ide === "windsurf")).toBe(true);
    });

    it("detects multiple tools simultaneously", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      mkdirSync(join(cwd, ".cursor"), { recursive: true });
      mkdirSync(join(cwd, ".vscode"), { recursive: true });

      const tools = detectTools(cwd);
      expect(tools.length).toBe(3);
      expect(tools.map((t) => t.ide).sort()).toEqual([
        "claude-code",
        "cursor",
        "vscode",
      ]);
    });

    it("returns empty array when no tools found", () => {
      const cwd = makeTmpDir();
      const tools = detectTools(cwd);
      expect(tools).toEqual([]);
    });

    it("formatDetectedTools returns readable string", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      mkdirSync(join(cwd, ".cursor"), { recursive: true });

      const tools = detectTools(cwd);
      const formatted = formatDetectedTools(tools);
      expect(formatted).toContain("Claude Code");
      expect(formatted).toContain("Cursor");
    });
  });

  describe("S6.2: Hook installation via init", () => {
    it("installs Claude Code PostToolUse hook at correct path", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".claude"), { recursive: true });

      const result = runInit(cwd);

      const hookPath = join(cwd, ".claude", "hooks", "PostToolUse.sh");
      expect(existsSync(hookPath)).toBe(true);
      expect(result.hooksInstalled.length).toBeGreaterThan(0);
      expect(result.hooksInstalled[0]).toContain("Claude Code hook");
    });

    it("skips hook if already installed", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".claude", "hooks"), { recursive: true });
      writeFileSync(
        join(cwd, ".claude", "hooks", "PostToolUse.sh"),
        "#!/bin/bash\n# existing"
      );

      const result = runInit(cwd);
      expect(result.skipped.some((s) => s.includes("already installed"))).toBe(
        true
      );
    });

    it("hook content references unerr compress-output", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".claude"), { recursive: true });

      installClaudeHook(cwd);

      const hookContent = readFileSync(
        join(cwd, ".claude", "hooks", "PostToolUse.sh"),
        "utf-8"
      );
      expect(hookContent).toContain("compress-output");
      expect(hookContent).toContain("unerr");
    });
  });

  describe("S6.3: MCP config writing via init", () => {
    it("writes .cursor/mcp.json for Cursor project", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".cursor"), { recursive: true });

      const result = runInit(cwd);

      const configPath = join(cwd, ".cursor", "mcp.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.mcpServers.unerr).toBeDefined();
      expect(config.mcpServers.unerr.command).toContain("unerr");
      expect(config.mcpServers.unerr.args).toContain("--mcp");
      expect(result.configsWritten.length).toBeGreaterThan(0);
    });

    it("writes .mcp.json for Claude Code project", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".claude"), { recursive: true });

      const result = runInit(cwd);

      const configPath = join(cwd, ".mcp.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.mcpServers.unerr).toBeDefined();
    });

    it("merges into existing config without overwriting", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".cursor"), { recursive: true });
      const existingConfig = {
        mcpServers: { other: { command: "other-tool", args: [] } },
      };
      writeFileSync(
        join(cwd, ".cursor", "mcp.json"),
        JSON.stringify(existingConfig)
      );

      runInit(cwd);

      const config = JSON.parse(
        readFileSync(join(cwd, ".cursor", "mcp.json"), "utf-8")
      );
      expect(config.mcpServers.other).toBeDefined();
      expect(config.mcpServers.unerr).toBeDefined();
    });

    it("skips if unerr already configured with same command", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".cursor"), { recursive: true });
      // First install writes the resolved command
      runInit(cwd);
      const configPath = join(cwd, ".cursor", "mcp.json");
      const written = JSON.parse(readFileSync(configPath, "utf-8"));
      const resolvedCmd = written.mcpServers.unerr.command;
      expect(resolvedCmd).toContain("unerr");

      // Second install with same command should skip
      const result = runInit(cwd);
      expect(result.skipped.some((s) => s.includes("already configured"))).toBe(
        true
      );
    });
  });

  describe("S6.4: compress-output uses graph risk map", () => {
    it("compressOutput accepts entityRiskMap parameter", async () => {
      const { compressOutput } = await import("../proxy/output-compressor.js");

      const riskMap = new Map([
        [
          "src/main.ts",
          { riskLevel: "high" as const, fanIn: 10, isChokepoint: true },
        ],
      ]);

      const result = compressOutput(
        "diff --git a/src/main.ts b/src/main.ts\n+++ changed\n- old\n+ new\n",
        {
          tokenBudget: 2000,
          entityRiskMap: riskMap,
        }
      );

      expect(result.output).toBeDefined();
      expect(result.originalTokens).toBeGreaterThan(0);
    });

    it("compressOutput works without entityRiskMap", async () => {
      const { compressOutput } = await import("../proxy/output-compressor.js");

      const result = compressOutput("test output\nline 2\nline 3", {
        tokenBudget: 2000,
      });

      expect(result.output).toBeDefined();
    });
  });

  describe("S6.5: Hook uninstall", () => {
    it("removes Claude Code hook cleanly", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".claude", "hooks"), { recursive: true });
      writeFileSync(
        join(cwd, ".claude", "hooks", "PostToolUse.sh"),
        "#!/bin/bash\n"
      );

      expect(isClaudeHookInstalled(cwd)).toBe(true);
      const removed = removeClaudeHook(cwd);
      expect(removed).toBe(true);
      expect(isClaudeHookInstalled(cwd)).toBe(false);
    });

    it("removeMcpConfig removes unerr entry from config", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".cursor"), { recursive: true });
      const config = {
        mcpServers: {
          unerr: { command: "npx", args: [] },
          other: { command: "x", args: [] },
        },
      };
      writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify(config));

      const removed = removeMcpConfig(cwd, "cursor");
      expect(removed).toBe(true);

      const updated = JSON.parse(
        readFileSync(join(cwd, ".cursor", "mcp.json"), "utf-8")
      );
      expect(updated.mcpServers.unerr).toBeUndefined();
      expect(updated.mcpServers.other).toBeDefined();
    });
  });

  describe("S6.6: Hook status in status output", () => {
    it("isClaudeHookInstalled returns true when hook exists", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".claude", "hooks"), { recursive: true });
      writeFileSync(
        join(cwd, ".claude", "hooks", "PostToolUse.sh"),
        "#!/bin/bash\n"
      );

      expect(isClaudeHookInstalled(cwd)).toBe(true);
    });

    it("isConfigured returns true when MCP config has unerr entry", () => {
      const cwd = makeTmpDir();
      mkdirSync(join(cwd, ".cursor"), { recursive: true });
      writeMcpConfig(cwd, "cursor");

      expect(isConfigured(cwd, "cursor")).toBe(true);
    });

    it("isConfigured returns false when no config exists", () => {
      const cwd = makeTmpDir();
      expect(isConfigured(cwd, "cursor")).toBe(false);
    });
  });
});
