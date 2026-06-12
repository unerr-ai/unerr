import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configuredAgents,
  refreshAgentInstallsIfUpgraded,
} from "../config/agent-reinstall.js";
import { UNERR_VERSION } from "../version.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "unerr-reinstall-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Write an `.mcp.json` carrying the `unerr` server entry (Claude Code install). */
function writeClaudeMcpConfig(): void {
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: { unerr: { command: "unerr", args: ["--mcp"] } },
    })
  );
}

function markerVersion(): string | null {
  try {
    const raw = readFileSync(
      join(cwd, ".unerr", "state", "agent-install.json"),
      "utf-8"
    );
    return (
      (JSON.parse(raw) as { installedVersion?: string }).installedVersion ??
      null
    );
  } catch {
    return null;
  }
}

describe("configuredAgents — derived from the unerr MCP footprint", () => {
  it("is empty in a repo with no agent config", () => {
    expect(configuredAgents(cwd)).toEqual([]);
  });

  it("detects claude-code once its .mcp.json carries the unerr entry", () => {
    writeClaudeMcpConfig();
    expect(configuredAgents(cwd)).toContain("claude-code");
  });
});

describe("refreshAgentInstallsIfUpgraded — version-gated, idempotent", () => {
  it("stamps the running version and reports no refresh when no agent is configured", async () => {
    const r = await refreshAgentInstallsIfUpgraded(cwd);
    expect(r).not.toBeNull();
    expect(r?.fromVersion).toBeNull();
    expect(r?.toVersion).toBe(UNERR_VERSION);
    expect(r?.refreshed).toEqual([]);
    expect(markerVersion()).toBe(UNERR_VERSION);
  });

  it("is a no-op once the marker already matches the running version", async () => {
    // Pre-stamp the marker with the current version.
    mkdirSync(join(cwd, ".unerr", "state"), { recursive: true });
    writeFileSync(
      join(cwd, ".unerr", "state", "agent-install.json"),
      JSON.stringify({ installedVersion: UNERR_VERSION })
    );
    expect(await refreshAgentInstallsIfUpgraded(cwd)).toBeNull();
  });

  it("re-checks after the first stamp only when the version changes again", async () => {
    // First call stamps; second call short-circuits to null.
    await refreshAgentInstallsIfUpgraded(cwd);
    expect(await refreshAgentInstallsIfUpgraded(cwd)).toBeNull();

    // Simulate a downgrade/older marker → the gate re-opens.
    writeFileSync(
      join(cwd, ".unerr", "state", "agent-install.json"),
      JSON.stringify({ installedVersion: "0.0.1" })
    );
    const r = await refreshAgentInstallsIfUpgraded(cwd);
    expect(r?.fromVersion).toBe("0.0.1");
    expect(r?.toVersion).toBe(UNERR_VERSION);
  });
});
