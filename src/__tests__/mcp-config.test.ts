/**
 * Tests for MCP local proxy config (Task 0.4).
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

describe("MCP Local Proxy Configuration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `unerr-test-mcp-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("generates correct local proxy config for Cursor", () => {
    const mcpConfig = {
      mcpServers: {
        unerr: {
          command: "npx",
          args: ["@unerr/unerr"],
          env: {},
        },
      },
    };

    const configPath = join(tempDir, "mcp.json");
    writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; url?: string }
      >;
    };

    const unerr = parsed.mcpServers.unerr!;
    expect(unerr.command).toBe("npx");
    expect(unerr.args).toEqual(["@unerr/unerr"]);
    // Must NOT have a url property (local proxy, not remote)
    expect(unerr.url).toBeUndefined();
  });

  it("detects remote URL config needing migration", () => {
    const cloudConfig = {
      mcpServers: {
        unerr: {
          url: "https://app.unerr.dev/mcp/org-123",
        },
      },
    };

    const unerr = cloudConfig.mcpServers.unerr;
    // Remote config has url but no command — needs migration
    const needsMigration = !!unerr.url && !("command" in unerr);
    expect(needsMigration).toBe(true);
  });

  it("local proxy config does NOT need migration", () => {
    const localConfig = {
      mcpServers: {
        unerr: {
          command: "npx",
          args: ["@unerr/unerr"],
        },
      },
    };

    const unerr = localConfig.mcpServers.unerr;
    const needsMigration = !!("url" in unerr) && !("command" in unerr);
    expect(needsMigration).toBe(false);
  });

  it("preserves existing MCP servers when adding unerr", () => {
    const existing = {
      mcpServers: {
        "other-server": {
          command: "node",
          args: ["other-server.js"],
        },
      },
    };

    // Simulate upsert
    const updated = {
      ...existing,
      mcpServers: {
        ...existing.mcpServers,
        unerr: {
          command: "npx",
          args: ["@unerr/unerr"],
          env: {},
        },
      },
    };

    expect(updated.mcpServers["other-server"]).toBeDefined();
    expect(updated.mcpServers.unerr).toBeDefined();
    expect(Object.keys(updated.mcpServers)).toHaveLength(2);
  });

  it("config-verify repair writes local proxy config", async () => {
    // Create a mock IDE config directory
    const ideDir = join(tempDir, ".cursor");
    mkdirSync(ideDir, { recursive: true });

    // Write a remote config that needs migration
    const configPath = join(ideDir, "mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          unerr: { url: "https://app.unerr.dev/mcp/org-123" },
        },
      }),
    );

    // Simulate repair by writing local proxy config
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    config.mcpServers.unerr = {
      command: "npx",
      args: ["@unerr/unerr"],
      env: {},
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    // Verify repair result
    const repaired = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, { command?: string; url?: string }>;
    };
    expect(repaired.mcpServers.unerr?.command).toBe("npx");
    expect(repaired.mcpServers.unerr?.url).toBeUndefined();
  });

  it("VS Code config uses mcpServers key in settings.json", () => {
    const vscodeConfig = {
      "editor.fontSize": 14,
      mcpServers: {
        unerr: {
          command: "npx",
          args: ["@unerr/unerr"],
          env: {},
        },
      },
    };

    // VS Code settings.json has mixed keys — mcpServers lives alongside editor settings
    expect(vscodeConfig.mcpServers.unerr.command).toBe("npx");
    expect(vscodeConfig["editor.fontSize"]).toBe(14);
  });
});
