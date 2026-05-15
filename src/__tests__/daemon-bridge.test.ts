/**
 * DM-3: MCP Bridge Integration tests.
 *
 * Tests cover:
 *   - client.ts: sendRequest, sendFireAndForget, probeDaemon
 *   - bootstrap.ts: waitForDaemonReady (poll-only, no spawn)
 *   - mcpBoot socket discovery order (repo sock → unerrd if running + registered)
 *   - Retry/reconnect behavior when no process available
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
      sendRequest("/tmp/nonexistent-unerr-test.sock", { cmd: "status" }, 1000)
    ).rejects.toThrow();
  });

  it("sendFireAndForget does not throw on nonexistent socket", async () => {
    const { sendFireAndForget } = await import("../daemon/client.js");
    // Should not throw — it's fire-and-forget
    expect(() =>
      sendFireAndForget("/tmp/nonexistent-unerr-test.sock", {
        cmd: "activity",
        repo: "/tmp/fake",
      })
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
      "utf-8"
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
      "utf-8"
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
      "utf-8"
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
      "utf-8"
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
      "utf-8"
    );

    expect(content).toContain("findRepo(cwd)");
    expect(content).not.toContain("addRepo(cwd, {})");
  });

  it("mcpBoot includes activity throttle at 60s", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    expect(content).toContain("ACTIVITY_THROTTLE_MS = 60_000");
    expect(content).toContain("sendActivity(discovery.daemonSock, cwd)");
  });
});

// ── Bridge lifecycle tests ─────────────────────────────────────────

describe("Bridge connect/disconnect lifecycle", () => {
  it("mcpBoot daemon path calls connectRepo before bridging and disconnectRepo after", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    // Find the daemon code block (starts after 'discovery.kind === "daemon"')
    const daemonBlockStart = content.indexOf('discovery.kind === "daemon"');
    expect(daemonBlockStart).toBeGreaterThan(-1);
    const daemonBlock = content.slice(daemonBlockStart);

    const connectIdx = daemonBlock.indexOf("await connectRepo(");
    const bridgeIdx = daemonBlock.indexOf("await startUdsBridge(");
    const disconnectIdx = daemonBlock.indexOf("await disconnectRepo(");

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
      "utf-8"
    );

    expect(content).not.toContain("detached: true");
    expect(content).not.toContain("child_process");
    expect(content).not.toContain("spawn(");
  });

  it("polls at 100ms intervals with 5s timeout", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8"
    );

    expect(content).toContain("POLL_INTERVAL_MS = 100");
    expect(content).toContain("WAIT_TIMEOUT_MS = 5_000");
  });

  it("uses probeDaemon for fast-path check", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8"
    );

    expect(content).toContain("probeDaemon(sock)");
  });

  it("exports waitForDaemonReady as primary + ensureDaemonRunning alias", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8"
    );

    expect(content).toContain("export async function waitForDaemonReady");
    expect(content).toContain(
      "export const ensureDaemonRunning = waitForDaemonReady"
    );
  });
});

// ── Protocol integration tests ─────────────────────────────────────

describe("Client protocol integration", () => {
  it("client methods use correct cmd values", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/client.ts"),
      "utf-8"
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
      "utf-8"
    );

    // Sends JSON with newline delimiter
    expect(content).toContain("JSON.stringify(request)}\\n");
    // Parses response up to newline
    expect(content).toContain('buffer.indexOf("\\n")');
  });

  it("sendRequest has configurable timeout", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/client.ts"),
      "utf-8"
    );

    expect(content).toContain("timeoutMs = 30_000");
  });
});

// ── Race safety tests ──────────────────────────────────────────────

describe("Race safety", () => {
  it("bootstrap.ts is poll-only (no file locks, no spawn)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/bootstrap.ts"),
      "utf-8"
    );

    expect(content).not.toContain("lockFile");
    expect(content).not.toContain("flock");
    expect(content).not.toContain("spawn(");
    expect(content).toContain("probeDaemon(sock)");
  });
});

// ── Retry/reconnect behavior tests ─────────────────────────────────

describe("mcpBoot retry behavior", () => {
  it("uses exponential backoff retry constants", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    expect(content).toContain("MCP_INITIAL_RETRY_MS");
    expect(content).toContain("MCP_MAX_RETRY_MS");
    expect(content).toContain("MCP_RETRY_BACKOFF");
  });

  it("has a discoverWithRetry loop that retries instead of exiting", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    expect(content).toContain("discoverWithRetry");
    expect(content).toContain(
      "Waiting for unerr process to become available"
    );
    // No hard exit on "no process found" — retries instead
    expect(content).not.toContain(
      'No unerr process found for this project'
    );
  });

  it("reconnects on daemon_dead or socket_closed (not stdin_closed)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    // stdin_closed is the only reason that exits the main loop
    expect(content).toContain('result.reason === "stdin_closed"');
    expect(content).toContain("Connection lost");
    expect(content).toContain("will retry");
  });

  it("bridge cleans up stdin listeners on disconnect for safe reconnect", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/proxy/bridge.ts"),
      "utf-8"
    );

    expect(content).toContain("stdinDataHandler");
    expect(content).toContain("stdinEndHandler");
    expect(content).toContain('removeListener("data"');
    expect(content).toContain('removeListener("end"');
  });

  it("bridge resolves with connect_error on initial failure (never rejects)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/proxy/bridge.ts"),
      "utf-8"
    );

    expect(content).toContain('"connect_error"');
    // The bridge promise should never reject — always resolve with a reason
    expect(content).not.toContain("reject(err)");
    expect(content).not.toContain("reject(");
  });
});

// ── Error handling tests ───────────────────────────────────────────

describe("Error handling", () => {
  it("mcpBoot logs when repo not registered (retry, not exit)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    expect(content).toContain("not registered with unerrd");
    expect(content).toContain("waiting for registration");
  });

  it("mcpBoot logs ensureRepo failures and retries", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    expect(content).toContain("ensureRepo failed");
    expect(content).toContain("retrying");
  });

  it("mcpBoot handles connection loss from bridge by retrying", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    expect(content).toContain("Connection lost");
    expect(content).toContain("will retry");
    // Only stdin_closed exits the loop — all other reasons trigger retry
    expect(content).toContain('result.reason === "stdin_closed"');
  });
});
