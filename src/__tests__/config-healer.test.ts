/**
 * Tests for config-verify.ts (P5.6-ADV-04) — Self-healing MCP configuration.
 *
 * Tests the actual checkIdeConfig and repairIdeConfig functions
 * against real filesystem state to validate detection and repair logic.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkIdeConfig, repairIdeConfig } from "../commands/config-verify.js";

describe("Config Healer (P5.6-ADV-04)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-config-healer-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── checkIdeConfig ────────────────────────────────────────────────

  describe("checkIdeConfig", () => {
    it("returns found=false when config file does not exist", () => {
      const result = checkIdeConfig(
        "cursor",
        path.join(tmpDir, "nonexistent.json")
      );
      expect(result.found).toBe(false);
      expect(result.configured).toBe(false);
      expect(result.needsMigration).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toContain("not found");
    });

    it("returns configured=false when mcpServers section is missing", () => {
      const configPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(configPath, JSON.stringify({ someOther: true }));

      const result = checkIdeConfig("cursor", configPath);
      expect(result.found).toBe(true);
      expect(result.configured).toBe(false);
      expect(result.issues[0]).toContain("No mcpServers section");
    });

    it("returns configured=false when unerr key is absent from mcpServers", () => {
      const configPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { copilot: { command: "npx", args: ["copilot"] } },
        })
      );

      const result = checkIdeConfig("cursor", configPath);
      expect(result.found).toBe(true);
      expect(result.configured).toBe(false);
      expect(result.issues[0]).toContain("No unerr MCP server configured");
    });

    it("flags remote URL config as needing migration", () => {
      const configPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            unerr: { url: "https://api.unerr.io/mcp/sse" },
          },
        })
      );

      const result = checkIdeConfig("cursor", configPath);
      expect(result.found).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.needsMigration).toBe(true);
      expect(result.issues[0]).toContain("remote URL");
      expect(result.issues[0]).toContain("local proxy");
    });

    it("passes when using correct local proxy format", () => {
      const configPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            unerr: { command: "unerr", args: ["--mcp"] },
          },
        })
      );

      const result = checkIdeConfig("cursor", configPath);
      expect(result.found).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.needsMigration).toBe(false);
      expect(result.issues).toHaveLength(0);
    });

    it("flags unexpected config format as needing migration", () => {
      const configPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            unerr: { command: "node", args: ["custom-server.js"] },
          },
        })
      );

      const result = checkIdeConfig("cursor", configPath);
      expect(result.needsMigration).toBe(true);
      expect(result.issues[0]).toContain("unexpected format");
    });

    it("handles malformed JSON gracefully", () => {
      const configPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(configPath, "{ invalid json !!!");

      const result = checkIdeConfig("cursor", configPath);
      expect(result.found).toBe(true);
      expect(result.configured).toBe(false);
      expect(result.issues[0]).toContain("Failed to parse");
    });
  });

  // ── repairIdeConfig ───────────────────────────────────────────────

  describe("repairIdeConfig", () => {
    it("creates config file from scratch when none exists", () => {
      const configDir = path.join(tmpDir, ".cursor");
      const configPath = path.join(configDir, "mcp.json");
      expect(fs.existsSync(configPath)).toBe(false);

      const success = repairIdeConfig("cursor", configPath);
      expect(success).toBe(true);

      const written = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        mcpServers: Record<string, { command?: string; args?: string[] }>;
      };
      expect(written.mcpServers.unerr?.command).toContain("unerr");
      expect(written.mcpServers.unerr?.args).toContain("--mcp");
    });

    it("preserves existing non-unerr MCP servers during repair", () => {
      const configPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            copilot: { command: "npx", args: ["copilot-mcp"] },
            cody: { url: "http://localhost:4000/mcp" },
          },
        })
      );

      repairIdeConfig("cursor", configPath);

      const result = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(result.mcpServers)).toHaveLength(3);
      expect(result.mcpServers.copilot).toBeDefined();
      expect(result.mcpServers.cody).toBeDefined();
      expect(result.mcpServers.unerr).toBeDefined();
    });

    it("replaces remote URL config with local proxy config", () => {
      const configPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            unerr: { url: "https://api.unerr.io/mcp/sse" },
          },
        })
      );

      repairIdeConfig("cursor", configPath);

      const result = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        mcpServers: Record<string, { command?: string; url?: string }>;
      };
      // Should now be local proxy format, not remote URL
      expect(result.mcpServers.unerr?.command).toContain("unerr");
      expect(result.mcpServers.unerr?.url).toBeUndefined();
    });

    it("creates parent directory if it doesn't exist", () => {
      const deepPath = path.join(tmpDir, "a", "b", "c", "mcp.json");

      const success = repairIdeConfig("cursor", deepPath);
      expect(success).toBe(true);
      expect(fs.existsSync(deepPath)).toBe(true);
    });
  });

  // ── checkIdeConfig + repairIdeConfig integration ──────────────────

  describe("check → repair → re-check cycle", () => {
    it("repair fixes all issues detected by check", () => {
      const configPath = path.join(tmpDir, "mcp.json");
      // Start with broken config
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { other: { url: "http://example.com" } },
        })
      );

      // Step 1: check — should find issues
      const check1 = checkIdeConfig("cursor", configPath);
      expect(check1.configured).toBe(false);
      expect(check1.issues.length).toBeGreaterThan(0);

      // Step 2: repair
      const repaired = repairIdeConfig("cursor", configPath);
      expect(repaired).toBe(true);

      // Step 3: re-check — should pass
      const check2 = checkIdeConfig("cursor", configPath);
      expect(check2.configured).toBe(true);
      expect(check2.needsMigration).toBe(false);
      expect(check2.issues).toHaveLength(0);
    });
  });
});
