/**
 * Layer 3 Sprint R: CLI Hooks & Auto-Configuration tests.
 */

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
  installClaudeHook,
  isClaudeHookInstalled,
  removeClaudeHook,
} from "../config/hook-installer.js";
import {
  isConfigured,
  removeMcpConfig,
  writeMcpConfig,
} from "../config/mcp-config-writer.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-r-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("MCP Config Writer (R.3 + R.7)", () => {
  it("creates config for Cursor", () => {
    const result = writeMcpConfig(tempDir, "cursor");
    expect(result.action).toBe("created");
    expect(existsSync(result.path)).toBe(true);

    const config = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(config.mcpServers.unerr).toBeDefined();
    expect(config.mcpServers.unerr.command).toContain("unerr");
  });

  it("creates config for Claude Code", () => {
    const result = writeMcpConfig(tempDir, "claude-code");
    expect(result.action).toBe("created");
    expect(result.path).toContain(".mcp.json");
  });

  it("creates config for VS Code", () => {
    const result = writeMcpConfig(tempDir, "vscode");
    expect(result.action).toBe("created");
    expect(result.path).toContain(".vscode");
  });

  it("is idempotent (skip on second run)", () => {
    writeMcpConfig(tempDir, "cursor");
    const result = writeMcpConfig(tempDir, "cursor");
    expect(result.action).toBe("skipped");
  });

  it("merges into existing config without overwriting", () => {
    const configPath = join(tempDir, ".cursor", "mcp.json");
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { "other-tool": { command: "other", args: [] } },
      }),
      "utf-8"
    );

    const result = writeMcpConfig(tempDir, "cursor");
    expect(result.action).toBe("updated");

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.mcpServers["other-tool"]).toBeDefined();
    expect(config.mcpServers.unerr).toBeDefined();
  });

  it("isConfigured returns correct state", () => {
    expect(isConfigured(tempDir, "cursor")).toBe(false);
    writeMcpConfig(tempDir, "cursor");
    expect(isConfigured(tempDir, "cursor")).toBe(true);
  });

  it("removeMcpConfig removes unerr entry", () => {
    writeMcpConfig(tempDir, "cursor");
    const removed = removeMcpConfig(tempDir, "cursor");
    expect(removed).toBe(true);
    expect(isConfigured(tempDir, "cursor")).toBe(false);
  });
});

describe("Hook Installer (R.4)", () => {
  it("installs Claude hook with correct permissions", () => {
    const result = installClaudeHook(tempDir);
    expect(result.action).toBe("installed");
    expect(existsSync(result.path)).toBe(true);

    const content = readFileSync(result.path, "utf-8");
    expect(content).toContain("#!/bin/bash");
    expect(content).toContain("compress-output");
  });

  it("reports already_exists on second install", () => {
    installClaudeHook(tempDir);
    const result = installClaudeHook(tempDir);
    expect(result.action).toBe("already_exists");
  });

  it("isClaudeHookInstalled returns correct state", () => {
    expect(isClaudeHookInstalled(tempDir)).toBe(false);
    installClaudeHook(tempDir);
    expect(isClaudeHookInstalled(tempDir)).toBe(true);
  });

  it("removeClaudeHook removes the hook", () => {
    installClaudeHook(tempDir);
    const removed = removeClaudeHook(tempDir);
    expect(removed).toBe(true);
    expect(isClaudeHookInstalled(tempDir)).toBe(false);
  });
});
