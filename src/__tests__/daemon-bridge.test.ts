/**
 * DM-3: MCP Bridge Integration tests.
 *
 * Tests cover:
 *   - client.ts: sendRequest, sendFireAndForget, probeDaemon
 *   - bootstrap.ts: waitForDaemonReady (poll-only, no spawn)
 *   - mcpBoot socket discovery order (repo sock → unerrd if running + registered)
 *   - Explicit error exits when no process / repo not registered
 *   - Bridge lifecycle: connect/disconnect through daemon
 *   - Activity throttling
 *   - Module isolation (no intelligence imports)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Client module tests ────────────────────────────────────────────

describe("Daemon client (client.ts)", () => {
  it("exports all required methods", async () => {
    const client = await import("../daemon/client.js");
    expect(typeof client.sendRequest).toBe("function");
    expect(typeof client.sendFireAndForget).toBe("function");
    expect(typeof client.ensureRepo).toBe("function");
    expect(typeof client.connectRepo).toBe("function");
    expect(typeof client.disconnectRepo).toBe("function");
    expect(typeof client.sendActivity).toBe("function");
    expect(typeof client.getStatus).toBe("function");
    expect(typeof client.probeDaemon).toBe("function");
    expect(typeof client.daemonSockPath).toBe("function");
  });

  it("daemonSockPath returns path under ~/.unerr/", async () => {
    const { daemonSockPath } = await import("../daemon/client.js");
    const p = daemonSockPath();
    expect(p).toContain(".unerr");
    expect(p).toContain("unerrd.sock");
  });

  it("probeDaemon returns false for nonexistent socket", async () => {
    const { probeDaemon } = await import("../daemon/client.js");
    const result = await probeDaemon("/tmp/nonexistent-unerr-test.sock");
    expect(result).toBe(false);
  });

  it("sendRequest rejects on nonexistent socket", async () => {
    const { sendRequest } = await import("../daemon/client.js");
    await expect(
      sendRequest("/tmp/nonexistent-unerr-test.sock", { cmd: "status" }, 1000),
    ).rejects.toThrow();
  });

  it("sendFireAndForget does not throw on nonexistent socket", async () => {
    const { sendFireAndForget } = await import("../daemon/client.js");
    // Should not throw — it's fire-and-forget
    expect(() =>
      sendFireAndForget("/tmp/nonexistent-unerr-test.sock", {
        cmd: "activity",
        repo: "/tmp/fake",
      }),
    ).not.toThrow();
  });
});

// ── Bootstrap module tests ─────────────────────────────────────────

describe("Daemon bootstrap (bootstrap.ts)", () => {
  it("exports waitForDaemonReady and ensureDaemonRunning alias", async () => {
    const bootstrap = await import("../daemon/bootstrap.js");
    expect(typeof bootstrap.waitForDaemonReady).toBe("function");
    expect(typeof bootstrap.ensureDaemonRunning).toBe("function");
    expect(bootstrap.ensureDaemonRunning).toBe(bootstrap.waitForDaemonReady);
  });
});

// ── Module isolation tests ─────────────────────────────────────────

describe("DM-3 module isolation", () => {
  it("client.ts imports only from daemon/ and node builtins", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/client.ts"),
      "utf-8",
    );

    const forbidden = [
      /from\s+["']\.\.\/intelligence\//,
      /from\s+["']\.\.\/behaviors\//,
      /from\s+["']\.\.\/tracking\//,
      /from\s+["']\.\.\/proxy\//,
    ];

    for (const pattern of forbidden) {
      expect(content).not.toMatch(pattern);
    }

    // Must import from daemon/
    expect(content).toMatch(/from\s+["']\.\/registry/);
    expect(content).toMatch(/from\s+["']\.\/protocol/);
  });

  it("bootstrap.ts imports only from daemon/ and node builtins", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8",
    );

    const forbidden = [
      /from\s+["']\.\.\/intelligence\//,
      /from\s+["']\.\.\/behaviors\//,
      /from\s+["']\.\.\/tracking\//,
      /from\s+["']\.\.\/proxy\//,
    ];

    for (const pattern of forbidden) {
      expect(content).not.toMatch(pattern);
    }

    expect(content).toMatch(/from\s+["']\.\/client/);
  });

  it("bridge.ts still imports nothing from intelligence/", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/proxy/bridge.ts"),
      "utf-8",
    );

    const forbidden = [
      /from\s+["']\.\.\/intelligence\//,
      /from\s+["']\.\.\/behaviors\//,
      /from\s+["']\.\.\/tracking\//,
    ];

    for (const pattern of forbidden) {
      expect(content).not.toMatch(pattern);
    }
  });
});

// ── Socket discovery flow tests ────────────────────────────────────

describe("mcpBoot socket discovery", () => {
  it("cli.ts mcpBoot checks per-repo sock first", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8",
    );

    // Step 1: per-repo proxy sock
    expect(content).toContain("proxy.sock");
    expect(content).toContain("probeResult.alive");

    // Step 2: unerrd (no auto-spawn, just probe + bridge)
    expect(content).toContain("probeDaemon");
    expect(content).toContain("ensureRepo");
    expect(content).toContain("connectRepo");
    expect(content).toContain("disconnectRepo");
  });

  it("mcpBoot does NOT auto-register repos (explicit registration only)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8",
    );

    // mcpBoot checks findRepo but never calls addRepo
    expect(content).toContain("findRepo(cwd)");
    expect(content).not.toContain("addRepo(cwd, {})");
  });

  it("mcpBoot includes activity throttle at 60s", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8",
    );

    expect(content).toContain("ACTIVITY_THROTTLE_MS = 60_000");
    expect(content).toContain("sendActivity(daemonSock, cwd)");
  });
});

// ── Bridge lifecycle tests ─────────────────────────────────────────

describe("Bridge connect/disconnect lifecycle", () => {
  it("mcpBoot calls connectRepo before bridging and disconnectRepo after", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8",
    );

    // Ordering: connectRepo comes before startUdsBridge, disconnectRepo after
    const connectIdx = content.indexOf("await connectRepo(daemonSock, cwd)");
    const bridgeIdx = content.indexOf(
      "await startUdsBridge(repoSockViaEnsure)",
    );
    const disconnectIdx = content.indexOf(
      "await disconnectRepo(daemonSock, cwd)",
    );

    expect(connectIdx).toBeGreaterThan(-1);
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(disconnectIdx).toBeGreaterThan(-1);
    expect(connectIdx).toBeLessThan(bridgeIdx);
    expect(bridgeIdx).toBeLessThan(disconnectIdx);
  });
});

// ── Readiness polling design tests (bootstrap.ts) ─────────────────

describe("Readiness polling (bootstrap.ts)", () => {
  it("does NOT spawn processes (poll-only, no child_process)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8",
    );

    expect(content).not.toContain("detached: true");
    expect(content).not.toContain("child_process");
    expect(content).not.toContain("spawn(");
  });

  it("polls at 100ms intervals with 5s timeout", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8",
    );

    expect(content).toContain("POLL_INTERVAL_MS = 100");
    expect(content).toContain("WAIT_TIMEOUT_MS = 5_000");
  });

  it("uses probeDaemon for fast-path check", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8",
    );

    expect(content).toContain("probeDaemon(sock)");
  });

  it("exports waitForDaemonReady as primary + ensureDaemonRunning alias", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8",
    );

    expect(content).toContain("export async function waitForDaemonReady");
    expect(content).toContain("export const ensureDaemonRunning = waitForDaemonReady");
  });
});

// ── Protocol integration tests ─────────────────────────────────────

describe("Client protocol integration", () => {
  it("client methods use correct cmd values", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/client.ts"),
      "utf-8",
    );

    expect(content).toContain('cmd: "ensure"');
    expect(content).toContain('cmd: "connect"');
    expect(content).toContain('cmd: "disconnect"');
    expect(content).toContain('cmd: "activity"');
    expect(content).toContain('cmd: "status"');
  });

  it("sendRequest uses newline-delimited JSON", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/client.ts"),
      "utf-8",
    );

    // Sends JSON with newline delimiter
    expect(content).toContain("JSON.stringify(request)}\\n");
    // Parses response up to newline
    expect(content).toContain('buffer.indexOf("\\n")');
  });

  it("sendRequest has configurable timeout", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/client.ts"),
      "utf-8",
    );

    expect(content).toContain("timeoutMs = 30_000");
  });
});

// ── Race safety tests ──────────────────────────────────────────────

describe("Race safety", () => {
  it("bootstrap.ts is poll-only (no file locks, no spawn)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8",
    );

    expect(content).not.toContain("lockFile");
    expect(content).not.toContain("flock");
    expect(content).not.toContain("spawn(");
    expect(content).toContain("probeDaemon(sock)");
  });
});

// ── Error handling tests ───────────────────────────────────────────

describe("Error handling", () => {
  it("mcpBoot exits 1 when no process found (no auto-spawn)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8",
    );

    expect(content).toContain("No unerr process found");
    expect(content).toContain("unerr daemon initialize");
    expect(content).toContain("process.exit(1)");
  });

  it("mcpBoot exits 1 when repo not registered", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8",
    );

    expect(content).toContain("Repo not registered with unerrd");
    expect(content).toContain("unerr install <agent>");
  });

  it("mcpBoot exits 1 on ensure failure", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8",
    );

    expect(content).toContain("Failed to ensure repo process");
  });

  it("mcpBoot handles daemon_dead from bridge", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8",
    );

    expect(content).toContain('"daemon_dead"');
    expect(content).toContain("idle-stopped or crashed");
  });
});
