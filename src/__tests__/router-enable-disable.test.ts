/**
 * Sprint P0-4 — enable/disable mcp-router roundtrip tests.
 *
 * Tests the full activation cycle:
 *   1. IDE config inspector reads existing MCP configs
 *   2. Router config writer builds config + backs up IDE configs
 *   3. IDE config rewriter replaces servers with single unerr endpoint
 *   4. Disable restores IDE configs from backups
 *
 * All tests use a temp directory to avoid touching real configs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectIdeMcpConfigs, getNonUnerrServers } from "../config/ide-mcp-inspector.js";
import {
  backupIdeConfigs,
  backupPath,
  buildRouterConfig,
  readRouterConfig,
  removeRouterConfig,
  restoreIdeConfigs,
  writeRouterConfig,
} from "../config/router-config-writer.js";
import { rewriteIdeConfig } from "../config/ide-mcp-rewriter.js";

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `unerr-router-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCursorConfig(cwd: string, config: object): string {
  const dir = join(cwd, ".cursor");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  return path;
}

function writeClaudeConfig(cwd: string, config: object): string {
  const path = join(cwd, ".mcp.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  return path;
}

function writeVscodeConfig(cwd: string, config: object): string {
  const dir = join(cwd, ".vscode");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  return path;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  // temp dirs are cleaned by OS
});

// ── Inspector Tests ──────────────────────────────────────────────

describe("ide-mcp-inspector", () => {
  it("returns empty array when no IDE configs exist", () => {
    const results = inspectIdeMcpConfigs(tempDir);
    expect(results).toEqual([]);
  });

  it("detects Cursor config with multiple servers", () => {
    writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
        postgres: { type: "stdio", command: "pg-mcp", args: [] },
        unerr: { type: "stdio", command: "unerr", args: ["--mcp"] },
      },
    });

    const results = inspectIdeMcpConfigs(tempDir);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const cursor = results.find((r) => r.agentId === "cursor");
    expect(cursor).toBeDefined();
    expect(cursor!.servers).toHaveLength(3);
    expect(cursor!.isUnerrAlreadyRouter).toBe(true);
  });

  it("detects Claude Code config", () => {
    writeClaudeConfig(tempDir, {
      mcpServers: {
        slack: { type: "stdio", command: "slack-mcp", args: [] },
      },
    });

    const results = inspectIdeMcpConfigs(tempDir);
    const claude = results.find((r) => r.agentId === "claude-code");
    expect(claude).toBeDefined();
    expect(claude!.servers).toHaveLength(1);
    expect(claude!.servers[0]!.name).toBe("slack");
  });

  it("detects multiple IDE configs simultaneously", () => {
    writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
      },
    });
    writeClaudeConfig(tempDir, {
      mcpServers: {
        postgres: { type: "stdio", command: "pg-mcp", args: [] },
      },
    });

    const results = inspectIdeMcpConfigs(tempDir);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores malformed config files", () => {
    const dir = join(tempDir, ".cursor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), "not json", "utf-8");

    const results = inspectIdeMcpConfigs(tempDir);
    const cursor = results.find((r) => r.agentId === "cursor");
    expect(cursor).toBeUndefined();
  });

  it("ignores configs with empty mcpServers", () => {
    writeCursorConfig(tempDir, { mcpServers: {} });
    const results = inspectIdeMcpConfigs(tempDir);
    const cursor = results.find((r) => r.agentId === "cursor");
    expect(cursor).toBeUndefined();
  });
});

describe("getNonUnerrServers", () => {
  it("filters out unerr server entries", () => {
    writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
        unerr: { type: "stdio", command: "unerr", args: ["--mcp"] },
      },
    });

    const configs = inspectIdeMcpConfigs(tempDir);
    const nonUnerr = getNonUnerrServers(configs);
    expect(nonUnerr.has("github")).toBe(true);
    expect(nonUnerr.has("unerr")).toBe(false);
  });

  it("deduplicates servers present in multiple IDE configs", () => {
    writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
      },
    });
    writeClaudeConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
        slack: { type: "stdio", command: "slack-mcp", args: [] },
      },
    });

    const configs = inspectIdeMcpConfigs(tempDir);
    const nonUnerr = getNonUnerrServers(configs);
    expect(nonUnerr.size).toBe(2);
    const ghEntry = nonUnerr.get("github");
    expect(ghEntry).toBeDefined();
    expect(ghEntry!.agentIds.length).toBe(2);
  });
});

// ── Router Config Writer Tests ───────────────────────────────────

describe("router-config-writer", () => {
  it("buildRouterConfig filters unerr and generates aliases", () => {
    writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
        unerr: { type: "stdio", command: "unerr", args: ["--mcp"] },
        "slack-mcp": { type: "stdio", command: "slack-mcp", args: [] },
      },
    });

    const inspections = inspectIdeMcpConfigs(tempDir);
    const { proxiedServers } = buildRouterConfig(inspections);

    expect(proxiedServers.length).toBe(2);
    expect(proxiedServers.find((s) => s.name === "unerr")).toBeUndefined();
    expect(proxiedServers.find((s) => s.name === "github")?.alias).toBe("gh");
    expect(proxiedServers.find((s) => s.name === "slack-mcp")?.alias).toBe("slk");
  });

  it("writeRouterConfig creates config.json in .unerr/router/", () => {
    const unerr = join(tempDir, ".unerr");

    writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
      },
    });

    const inspections = inspectIdeMcpConfigs(tempDir);
    const { proxiedServers, rewrittenConfigs } = buildRouterConfig(inspections);
    const outPath = writeRouterConfig(unerr, proxiedServers, rewrittenConfigs);

    expect(existsSync(outPath)).toBe(true);

    const config = readRouterConfig(unerr);
    expect(config).not.toBeNull();
    expect(config!.version).toBe(1);
    expect(config!.enabled).toBe(true);
    expect(config!.proxiedServers.length).toBe(1);
    expect(config!.proxiedServers[0]!.name).toBe("github");
  });

  it("backupIdeConfigs creates .pre-router backups", () => {
    const configPath = writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
      },
    });

    const inspections = inspectIdeMcpConfigs(tempDir);
    const { rewrittenConfigs } = buildRouterConfig(inspections);

    backupIdeConfigs(rewrittenConfigs);

    const bkPath = backupPath(configPath);
    expect(existsSync(bkPath)).toBe(true);
    expect(readFileSync(bkPath, "utf-8")).toBe(readFileSync(configPath, "utf-8"));
  });

  it("backupIdeConfigs is idempotent — does not overwrite existing backup", () => {
    writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
      },
    });

    const inspections = inspectIdeMcpConfigs(tempDir);
    const { rewrittenConfigs } = buildRouterConfig(inspections);

    backupIdeConfigs(rewrittenConfigs);

    const bkContent = readFileSync(rewrittenConfigs[0]!.backupPath, "utf-8");

    writeCursorConfig(tempDir, {
      mcpServers: { changed: { type: "stdio", command: "different", args: [] } },
    });

    backupIdeConfigs(rewrittenConfigs);

    expect(readFileSync(rewrittenConfigs[0]!.backupPath, "utf-8")).toBe(bkContent);
  });

  it("readRouterConfig returns null when no config exists", () => {
    expect(readRouterConfig(join(tempDir, ".unerr"))).toBeNull();
  });

  it("removeRouterConfig deletes config.json", () => {
    const unerr = join(tempDir, ".unerr");
    writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
      },
    });
    const inspections = inspectIdeMcpConfigs(tempDir);
    const { proxiedServers, rewrittenConfigs } = buildRouterConfig(inspections);
    writeRouterConfig(unerr, proxiedServers, rewrittenConfigs);

    expect(readRouterConfig(unerr)).not.toBeNull();

    removeRouterConfig(unerr);
    expect(readRouterConfig(unerr)).toBeNull();
  });
});

// ── IDE Config Rewriter Tests ────────────────────────────────────

describe("ide-mcp-rewriter", () => {
  it("rewrites Cursor mcp-json to single unerr endpoint", () => {
    const configPath = writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
        postgres: { type: "stdio", command: "pg-mcp", args: [] },
      },
    });

    const modified = rewriteIdeConfig(configPath, "mcp-json");
    expect(modified).toBe(true);

    const result = readJson(configPath) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(result.mcpServers)).toEqual(["unerr"]);
    expect(result.mcpServers.unerr).toHaveProperty("args", ["--mcp"]);
  });

  it("is idempotent — returns false when already correct", () => {
    const configPath = writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
      },
    });

    rewriteIdeConfig(configPath, "mcp-json");
    const secondResult = rewriteIdeConfig(configPath, "mcp-json");
    expect(secondResult).toBe(false);
  });

  it("preserves non-mcpServers keys in the config", () => {
    const configPath = writeCursorConfig(tempDir, {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: [] },
      },
      customSetting: "preserved",
    });

    rewriteIdeConfig(configPath, "mcp-json");

    const result = readJson(configPath) as { customSetting: string };
    expect(result.customSetting).toBe("preserved");
  });

  it("rewrites settings-json format (VS Code style)", () => {
    const configPath = writeVscodeConfig(tempDir, {
      "editor.fontSize": 14,
      mcp: {
        servers: {
          github: { type: "stdio", command: "github-mcp", args: [] },
        },
      },
    });

    const modified = rewriteIdeConfig(configPath, "settings-json");
    expect(modified).toBe(true);

    const result = readJson(configPath) as {
      "editor.fontSize": number;
      mcp: { servers: Record<string, unknown> };
    };
    expect(result["editor.fontSize"]).toBe(14);
    expect(Object.keys(result.mcp.servers)).toEqual(["unerr"]);
  });
});

// ── Full Enable → Disable Roundtrip ─────────────────────────────

describe("enable → disable roundtrip", () => {
  it("enable rewrites all IDE configs; disable restores originals exactly", () => {
    const cursorOriginal = {
      mcpServers: {
        github: { type: "stdio", command: "github-mcp", args: ["--token", "abc"] },
        "postgres-dev": { type: "stdio", command: "pg-mcp", args: [] },
        unerr: { type: "stdio", command: "unerr", args: ["--mcp"] },
      },
    };
    const claudeOriginal = {
      mcpServers: {
        "slack-mcp": { type: "stdio", command: "slack-mcp", args: [] },
      },
    };

    const cursorPath = writeCursorConfig(tempDir, cursorOriginal);
    const claudePath = writeClaudeConfig(tempDir, claudeOriginal);

    const cursorOriginalText = readFileSync(cursorPath, "utf-8");
    const claudeOriginalText = readFileSync(claudePath, "utf-8");

    // ── Enable ──
    const inspections = inspectIdeMcpConfigs(tempDir);
    const { proxiedServers, rewrittenConfigs } = buildRouterConfig(inspections);

    backupIdeConfigs(rewrittenConfigs);

    for (const inspection of inspections) {
      if (inspection.agentId === "cursor") {
        rewriteIdeConfig(inspection.configPath, "mcp-json");
      } else if (inspection.agentId === "claude-code") {
        rewriteIdeConfig(inspection.configPath, "mcp-json");
      }
    }

    const unerr = join(tempDir, ".unerr");
    writeRouterConfig(unerr, proxiedServers, rewrittenConfigs);

    const cursorRewritten = readJson(cursorPath) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(cursorRewritten.mcpServers)).toEqual(["unerr"]);

    const claudeRewritten = readJson(claudePath) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(claudeRewritten.mcpServers)).toEqual(["unerr"]);

    expect(proxiedServers.length).toBe(3);
    expect(proxiedServers.map((s) => s.name).sort()).toEqual(["github", "postgres-dev", "slack-mcp"]);

    // ── Disable ──
    const config = readRouterConfig(unerr);
    expect(config).not.toBeNull();

    const restored = restoreIdeConfigs(config!);
    expect(restored.length).toBe(2);

    expect(readFileSync(cursorPath, "utf-8")).toBe(cursorOriginalText);
    expect(readFileSync(claudePath, "utf-8")).toBe(claudeOriginalText);

    removeRouterConfig(unerr);
    expect(readRouterConfig(unerr)).toBeNull();
  });

  it("enable with no third-party servers produces empty proxiedServers", () => {
    writeCursorConfig(tempDir, {
      mcpServers: {
        unerr: { type: "stdio", command: "unerr", args: ["--mcp"] },
      },
    });

    const inspections = inspectIdeMcpConfigs(tempDir);
    const { proxiedServers } = buildRouterConfig(inspections);

    expect(proxiedServers).toHaveLength(0);
  });

  it("preserves server entry details (args, env) through the config roundtrip", () => {
    writeCursorConfig(tempDir, {
      mcpServers: {
        github: {
          type: "stdio",
          command: "github-mcp-server",
          args: ["--token", "ghp_abc123", "--org", "myorg"],
          env: { GITHUB_TOKEN: "ghp_abc123" },
        },
      },
    });

    const inspections = inspectIdeMcpConfigs(tempDir);
    const { proxiedServers } = buildRouterConfig(inspections);

    expect(proxiedServers[0]!.command).toBe("github-mcp-server");
    expect(proxiedServers[0]!.args).toEqual(["--token", "ghp_abc123", "--org", "myorg"]);
    expect(proxiedServers[0]!.env).toEqual({ GITHUB_TOKEN: "ghp_abc123" });
  });
});
