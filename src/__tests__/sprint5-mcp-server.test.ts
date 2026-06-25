/**
 * Sprint 5.4: IDE Auto-Configuration — tests for checkIdeConfig and repairIdeConfig.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkIdeConfig, repairIdeConfig } from "../commands/config-verify.js";

describe("Sprint 5.4: IDE Auto-Configuration", () => {
  it("checkIdeConfig detects missing MCP config", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-test-ide-"));
    try {
      const configPath = path.join(tmpDir, ".cursor", "mcp.json");
      const result = checkIdeConfig("cursor", configPath);
      expect(result.configured).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("repairIdeConfig creates config for Cursor", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-test-rep-"));
    try {
      const configPath = path.join(tmpDir, ".cursor", "mcp.json");
      repairIdeConfig("cursor", configPath);
      expect(fs.existsSync(configPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(content.mcpServers).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("repairIdeConfig creates config for Claude Code", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-test-cc-"));
    try {
      const configPath = path.join(tmpDir, ".mcp.json");
      repairIdeConfig("claude-code", configPath);
      expect(fs.existsSync(configPath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("repairIdeConfig creates config for VS Code", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-test-vsc-"));
    try {
      const configPath = path.join(tmpDir, ".vscode", "mcp.json");
      repairIdeConfig("vscode", configPath);
      expect(fs.existsSync(configPath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("checkIdeConfig detects existing config", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-test-ex-"));
    try {
      const configPath = path.join(tmpDir, ".cursor", "mcp.json");
      repairIdeConfig("cursor", configPath);
      const result = checkIdeConfig("cursor", configPath);
      expect(result.configured).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("repairIdeConfig is idempotent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-test-id-"));
    try {
      const configPath = path.join(tmpDir, ".cursor", "mcp.json");
      repairIdeConfig("cursor", configPath);
      const before = fs.readFileSync(configPath, "utf-8");
      repairIdeConfig("cursor", configPath);
      const after = fs.readFileSync(configPath, "utf-8");
      expect(JSON.parse(before)).toEqual(JSON.parse(after));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("checkIdeConfig supports windsurf IDE", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-test-ws-"));
    try {
      const configPath = path.join(tmpDir, ".windsurf", "mcp.json");
      repairIdeConfig("windsurf", configPath);
      const result = checkIdeConfig("windsurf", configPath);
      expect(result.configured).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
