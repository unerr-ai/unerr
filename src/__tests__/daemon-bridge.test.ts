/**
 * MCP Bridge integration tests (post process-manager migration).
 *
 * After the daemon→pm rename and lazy-spawn migration, the bridge
 * (`unerr --mcp`) auto-spawns the process manager via O_EXCL spawn lock on
 * first MCP contact. There is no boot-time registration, no LaunchAgent /
 * systemd unit / schtasks task — same lifecycle pattern as tsserver.
 *
 * Tests cover:
 *   - client.ts: sendRequest, sendFireAndForget, probeDaemon
 *   - spawn-lock.ts: O_EXCL acquire, release, stale-recovery
 *   - mcpBoot socket discovery (repo sock → unerrd if running → auto-spawn)
 *   - Bridge lifecycle: connect/disconnect through unerrd
 *   - Module isolation (bridge imports nothing from intelligence/)
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUdsBridge } from "../proxy/bridge.js";

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
    expect(() =>
      sendFireAndForget("/tmp/nonexistent-unerr-test.sock", {
        cmd: "activity",
        repo: "/tmp/fake",
      })
    ).not.toThrow();
  });
});

// ── Spawn lock tests ───────────────────────────────────────────────

describe("Spawn lock (spawn-lock.ts)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testHome = join(tmpdir(), `unerr-spawnlock-${Date.now()}-${Math.random()}`);
    mkdirSync(testHome, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    if (existsSync(testHome))
      rmSync(testHome, { recursive: true, force: true });
  });

  it("exports tryAcquireSpawnLock, releaseSpawnLock, spawnLockPath", async () => {
    const m = await import("../daemon/spawn-lock.js");
    expect(typeof m.tryAcquireSpawnLock).toBe("function");
    expect(typeof m.releaseSpawnLock).toBe("function");
    expect(typeof m.spawnLockPath).toBe("function");
  });

  it("acquires the lock when it does not exist", async () => {
    const { tryAcquireSpawnLock, releaseSpawnLock, spawnLockPath } =
      await import("../daemon/spawn-lock.js");
    expect(tryAcquireSpawnLock()).toBe(true);
    expect(existsSync(spawnLockPath())).toBe(true);
    releaseSpawnLock();
    expect(existsSync(spawnLockPath())).toBe(false);
  });

  it("returns false when a fresh lock is already held", async () => {
    const { tryAcquireSpawnLock, releaseSpawnLock } = await import(
      "../daemon/spawn-lock.js"
    );
    expect(tryAcquireSpawnLock()).toBe(true);
    expect(tryAcquireSpawnLock()).toBe(false);
    releaseSpawnLock();
  });

  it("reclaims a stale lock owned by a dead PID", async () => {
    const { tryAcquireSpawnLock, releaseSpawnLock, spawnLockPath } =
      await import("../daemon/spawn-lock.js");
    const {
      mkdirSync: mk,
      writeFileSync,
      readFileSync: rf,
    } = await import("node:fs");
    const path = spawnLockPath();
    mk(join(testHome, ".unerr", "state"), { recursive: true });
    // PID 1 is alive; use PID 999999 (unlikely to exist) with old timestamp.
    writeFileSync(
      path,
      JSON.stringify({ pid: 999_999, startedAt: Date.now() - 60_000 })
    );
    expect(tryAcquireSpawnLock()).toBe(true);
    const body = JSON.parse(rf(path, "utf8"));
    expect(body.pid).toBe(process.pid);
    releaseSpawnLock();
  });

  it("refuses to reclaim a fresh lock even if PID is dead", async () => {
    const { tryAcquireSpawnLock, spawnLockPath } = await import(
      "../daemon/spawn-lock.js"
    );
    const {
      mkdirSync: mk,
      writeFileSync,
      unlinkSync,
    } = await import("node:fs");
    const path = spawnLockPath();
    mk(join(testHome, ".unerr", "state"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ pid: 999_999, startedAt: Date.now() })
    );
    expect(tryAcquireSpawnLock()).toBe(false);
    unlinkSync(path);
  });
});

// ── Module isolation tests ─────────────────────────────────────────

describe("Bridge module isolation", () => {
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

    expect(content).toMatch(/from\s+["']\.\/registry/);
    expect(content).toMatch(/from\s+["']\.\/protocol/);
  });

  it("bridge.ts still imports nothing from intelligence/, behaviors/, tracking/", () => {
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

  it("spawn-lock.ts imports only from daemon/ and node builtins", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/daemon/spawn-lock.ts"),
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

    expect(content).toMatch(/from\s+["']\.\/registry/);
  });
});

// ── Auto-spawn behavior tests ──────────────────────────────────────

describe("mcpBoot auto-spawn", () => {
  it("imports spawn-lock primitives", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );
    expect(content).toContain("tryAcquireSpawnLock");
    expect(content).toContain("releaseSpawnLock");
    expect(content).toContain("../daemon/spawn-lock.js");
  });

  it("auto-spawns the process manager on first MCP contact", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );
    // Lock-acquire branch performs spawn + wait.
    expect(content).toContain("spawnProcessManager(");
    expect(content).toContain("waitForSupervisor(");
    // Double-checked locking: losers wait without spawning.
    expect(content).toContain("waiting for concurrent process-manager spawn");
  });

  it("spawns detached via `pm start --detached` (no boot persistence)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );
    expect(content).toContain('"pm", "start", "--detached"');
    expect(content).toContain("detached: true");
    expect(content).toContain('stdio: "ignore"');
    expect(content).toContain("windowsHide: true");
    expect(content).toContain("child.unref()");
  });

  it("is unerrd-first: probes the daemon before ensuring the per-repo proxy", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );
    // The bridge goes THROUGH unerrd — it must not connect to a proxy sock
    // directly (the old standalone-first bypass orphaned proxies + lied in
    // `pm status`). Inside discoverWithRetry, probeDaemon precedes ensureRepo.
    const discoStart = content.indexOf("async function discoverWithRetry");
    expect(discoStart).toBeGreaterThan(-1);
    const disco = content.slice(discoStart, content.indexOf("\n}", discoStart));
    const probeIdx = disco.indexOf("await probeDaemon(");
    const ensureIdx = disco.indexOf("await ensureRepo(");
    expect(probeIdx).toBeGreaterThan(-1);
    expect(ensureIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeLessThan(ensureIdx);
    // No standalone-first proxy.sock probe remains in discovery.
    expect(disco).not.toContain("probeResult.alive");
    expect(disco).not.toContain('kind: "standalone"');
  });

  it("does NOT auto-register repos (registration goes through ensureRepo only)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );
    // The bridge must never silently call addRepo() from MCP boot.
    // Registration happens via the `unerr install` path or via
    // the supervisor's ensureRepo handler — never from the bridge itself.
    expect(content).not.toContain("addRepo(cwd, {})");
    expect(content).not.toContain("addRepo(cwd,{})");
    expect(content).toContain("ensureRepo(daemonSock, cwd)");
  });

  it("uses 60s activity-throttle on the supervisor", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
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
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );

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

  it("hands off stdin gaplessly on a warm reconnect (no -32001 tools/list drop)", () => {
    // Regression: the IDE fires `tools/list` the instant `initialize` is
    // answered. With a warm daemon+proxy the bridge is still connecting when
    // that frame arrives. If the interceptor were detached before
    // `await connectRepo`, or the bridge only attached its relay handler inside
    // the async `connect` callback, the frame would be dropped between handlers
    // → "MCP error -32001: Request timed out". Two invariants keep it gapless.
    const cli = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );
    const daemonBlock = cli.slice(cli.indexOf('discovery.kind === "daemon"'));

    // (1) cli.ts: the interceptor stays attached THROUGH connectRepo — detached
    // only after `await connectRepo`, immediately before startUdsBridge.
    const connectRepoIdx = daemonBlock.indexOf("await connectRepo(");
    const detachIdx = daemonBlock.indexOf(
      'removeListener("data", preBufferHandler)'
    );
    const bridgeIdx = daemonBlock.indexOf("await startUdsBridge(");
    expect(detachIdx).toBeGreaterThan(-1);
    expect(connectRepoIdx).toBeLessThan(detachIdx);
    expect(detachIdx).toBeLessThan(bridgeIdx);

    // (2) bridge.ts: the relay handler is attached in the Promise executor
    // (before the async `connect` event) and queues frames until connected, so
    // frames arriving during connect are captured, not dropped.
    const bridge = readFileSync(
      resolve(process.cwd(), "src/proxy/bridge.ts"),
      "utf-8"
    );
    expect(bridge).toContain("preConnectQueue.push");
    expect(bridge).toContain("if (!connected)");
    const handlerAttachIdx = bridge.indexOf(
      'process.stdin.on("data", stdinDataHandler)'
    );
    const connectCbIdx = bridge.indexOf('socket.on("connect"');
    expect(handlerAttachIdx).toBeGreaterThan(-1);
    expect(connectCbIdx).toBeGreaterThan(-1);
    expect(handlerAttachIdx).toBeLessThan(connectCbIdx);
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

    expect(content).toContain("JSON.stringify(request)}\\n");
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

// ── Retry/reconnect behavior tests ─────────────────────────────────

describe("mcpBoot retry behavior", () => {
  it("uses exponential backoff retry constants", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );

    expect(content).toContain("MCP_INITIAL_RETRY_MS");
    expect(content).toContain("MCP_MAX_RETRY_MS");
    expect(content).toContain("MCP_RETRY_BACKOFF");
  });

  it("has a discoverWithRetry loop that retries instead of exiting", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );

    expect(content).toContain("discoverWithRetry");
    expect(content).toContain(
      "Waiting for unerr process manager to become available"
    );
    expect(content).not.toContain("No unerr process found for this project");
  });

  it("fails loudly on a stale-daemon repo-cap refusal instead of polling forever", () => {
    // Regression guard: a daemon still on pre-OSS-conversion code can return
    // `refused: "already_active"` from ensureRepo. By the time discovery sees
    // it, StaticCatalogInterceptor has already told the IDE `initialize`
    // succeeded, so silently retrying leaves every `tools/call` unanswered
    // until the IDE's own timeout — a hang, not a graceful degrade. The fix
    // must return immediately (never fall into the retry tail) and the
    // bridge must answer a protocol-level JSON-RPC error + exit non-zero.
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );

    // ── discoverWithRetry: the refused branch returns, it does not poll ──
    const discoStart = content.indexOf("async function discoverWithRetry");
    expect(discoStart).toBeGreaterThan(-1);
    const refusedCheckIdx = content.indexOf(
      'if ("refused" in ensured)',
      discoStart
    );
    expect(refusedCheckIdx).toBeGreaterThan(-1);
    const nextDestructureIdx = content.indexOf(
      "const { sock, daemonVersion } = ensured;",
      refusedCheckIdx
    );
    expect(nextDestructureIdx).toBeGreaterThan(refusedCheckIdx);
    const refusedBlock = content.slice(refusedCheckIdx, nextDestructureIdx);
    expect(refusedBlock).toContain("return {");
    expect(refusedBlock).toContain('kind: "refused"');
    // Names the actual fix — not a silent poll, not a dead-ended message.
    expect(refusedBlock).toContain("unerr pm stop");
    // Must NOT regress to log-and-fall-through (no branch, no retry log).
    expect(refusedBlock).not.toContain("} else {");
    expect(refusedBlock).not.toContain(", retrying...");

    // ── mcpBoot: a refused discovery answers -32003 and exits non-zero ──
    const refusedHandlerIdx = content.indexOf('discovery.kind === "refused"');
    expect(refusedHandlerIdx).toBeGreaterThan(-1);
    const daemonHandlerIdx = content.indexOf(
      'discovery.kind === "daemon"',
      refusedHandlerIdx
    );
    expect(daemonHandlerIdx).toBeGreaterThan(refusedHandlerIdx);
    const refusedHandlerBlock = content.slice(
      refusedHandlerIdx,
      daemonHandlerIdx
    );
    expect(refusedHandlerBlock).toContain("jsonrpc");
    expect(refusedHandlerBlock).toContain("-32003");
    expect(refusedHandlerBlock).toContain("process.exit(1)");
  });

  it("reconnects on daemon_dead or socket_closed (not stdin_closed)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );

    expect(content).toContain('result.reason === "stdin_closed"');
    expect(content).toContain("Connection lost");
    // Reconnect path: immediate when the session was healthy, exponential
    // backoff ("retrying in <ms>") when it was short-lived (FIX C).
    expect(content).toContain("reconnecting");
    expect(content).toContain("retrying in");
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
    expect(content).not.toContain("reject(err)");
    expect(content).not.toContain("reject(");
  });
});

// ── Error handling tests ───────────────────────────────────────────

describe("Error handling", () => {
  it("mcpBoot logs ensureRepo failures and retries", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );

    expect(content).toContain("ensureRepo failed");
    expect(content).toContain("retrying");
  });

  it("mcpBoot handles connection loss from bridge by retrying", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );

    expect(content).toContain("Connection lost");
    expect(content).toContain("reconnecting");
    expect(content).toContain('result.reason === "stdin_closed"');
  });

  it("backs off exponentially on short-lived reconnects (FIX C)", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/entrypoints/cli-main.ts"),
      "utf-8"
    );

    // A healthy session resets the counter; a short-lived one escalates and
    // sleeps before re-discovering, so a sock that won't connect can't hot-loop.
    expect(content).toContain("MCP_MIN_HEALTHY_MS");
    expect(content).toContain("reconnectFailures");
    expect(content).toContain("retrying in");
  });
});

// ── Heartbeat reset behavior tests ────────────────────────────────────
//
// A forwarded tool response from the proxy proves its event loop ran just as
// well as a pong frame. The bridge must reset missedHeartbeats on ANY inbound
// frame so a slow tool call does not trigger a spurious "daemon_dead".

describe("Heartbeat reset on any proxy frame", () => {
  it("resets missedHeartbeats unconditionally before the sawPong branch", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/proxy/bridge.ts"),
      "utf-8"
    );

    // Locate the socket data handler that processes frames from the proxy.
    const dataHandlerStart = content.indexOf('socket.on("data", ');
    expect(dataHandlerStart).toBeGreaterThan(-1);

    // Extract a window large enough to see the full reset + sawPong pattern.
    const window = content.slice(dataHandlerStart, dataHandlerStart + 800);

    const resetIdx = window.indexOf("missedHeartbeats = 0");
    const sawPongIdx = window.indexOf("if (sawPong)");

    // Both must be present in this handler.
    expect(resetIdx).toBeGreaterThan(-1);
    expect(sawPongIdx).toBeGreaterThan(-1);

    // The unconditional reset must precede the pong-specific branch so that
    // any proxy frame (tool response, notification, pong) resets the counter,
    // not only explicit pong frames.
    expect(resetIdx).toBeLessThan(sawPongIdx);
  });
});

// ── Option B: pid + socket liveness ────────────────────────────────
// Missed pongs alone must not reap a busy-but-alive proxy. On a local UDS a
// real proxy death already fires socket 'close'/'error'; stalled pongs on an
// open socket mean the proxy's event loop is busy (long reindex), not dead.
// The bridge confirms with the OS (PidLock.readPidFile) before declaring death.

describe("Bridge pid+socket liveness (Option B)", () => {
  it("derives the proxy state dir from the socket path", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/proxy/bridge.ts"),
      "utf-8"
    );
    // stateDir = dirname(sockPath) — sibling of proxy.sock holds proxy.pid.
    expect(content).toMatch(/const stateDir = dirname\(sockPath\)/);
    expect(content).toMatch(/from\s+["']\.\/pid-lock\.js["']/);
  });

  it("on max missed heartbeats, only reaps when PidLock reports the pid gone", () => {
    const content = readFileSync(
      resolve(process.cwd(), "src/proxy/bridge.ts"),
      "utf-8"
    );

    // Find the heartbeat interval's missed-pong branch.
    const branchStart = content.indexOf(
      "if (missedHeartbeats >= MAX_MISSED_HEARTBEATS)"
    );
    expect(branchStart).toBeGreaterThan(-1);
    const window = content.slice(branchStart, branchStart + 1400);

    // The death decision is gated on an OS liveness check, not the counter.
    const pidCheckIdx = window.indexOf(
      "PidLock.readPidFile(stateDir) === null"
    );
    const cleanupIdx = window.indexOf('cleanup("daemon_dead")');
    expect(pidCheckIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(-1);
    // cleanup must sit inside the pid-gone branch (after the check).
    expect(pidCheckIdx).toBeLessThan(cleanupIdx);

    // Busy-but-alive path keeps the relay: it resets the counter and does NOT
    // call cleanup. The "staying connected" log marks that branch.
    const stayIdx = window.indexOf("staying connected");
    expect(stayIdx).toBeGreaterThan(-1);
    expect(stayIdx).toBeGreaterThan(cleanupIdx);
  });
});

// ── Live wiring: in-flight request drain on connection loss ─────────

/** Minimal fake stdin: an EventEmitter with the no-op `resume()` the bridge calls. */
class FakeStdin extends EventEmitter {
  resume(): void {
    /* no-op */
  }
}

function shortBridgeSockPath(): string {
  // Keep the path short — macOS sun_path is capped at ~104 bytes.
  return join(
    tmpdir(),
    `ur-b-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  );
}

describe("startUdsBridge — in-flight request drain on connection loss", () => {
  let server: Server | undefined;
  let sockPath: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    server?.close();
    server = undefined;
    if (sockPath && existsSync(sockPath)) rmSync(sockPath, { force: true });
    sockPath = undefined;
  });

  it("answers an in-flight tools/call with a -32000 error when the proxy connection drops mid-call", async () => {
    sockPath = shortBridgeSockPath();
    let serverSocket: Socket | undefined;
    let resolveHello: () => void;
    const helloReceived = new Promise<void>((resolve) => {
      resolveHello = resolve;
    });
    server = createServer((socket) => {
      serverSocket = socket;
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        if (buf.includes('"unerr/hello"')) resolveHello();
      });
    });
    await new Promise<void>((resolve) => server?.listen(sockPath, resolve));

    const fakeStdin = new FakeStdin();
    const prevStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      const bridgePromise = startUdsBridge(sockPath);
      await helloReceived;

      // The IDE forwards a tools/call the proxy never gets to answer.
      fakeStdin.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            method: "tools/call",
            params: { name: "search_code" },
          })}\n`,
          "utf8"
        )
      );

      // Simulate the proxy crashing: its side of the socket closes.
      serverSocket?.destroy();

      const result = await bridgePromise;
      // Peer RST (Linux) surfaces as socket 'error'/ECONNRESET → daemon_dead
      // (bridge.ts:416) before 'close' → socket_closed; a clean FIN (macOS)
      // fires 'close' first. Both are valid connection-loss reasons that drain
      // the in-flight call (see the "reconnects on daemon_dead or socket_closed"
      // case above) — accept either so the assertion isn't platform-fragile.
      expect(["socket_closed", "daemon_dead"]).toContain(result.reason);

      const frames = written
        .join("")
        .split("\n")
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as {
              id?: unknown;
              error?: { code?: number; message?: string };
            }
        );
      const errorFrame = frames.find((f) => f.id === 99);
      expect(errorFrame).toBeDefined();
      expect(errorFrame?.error?.code).toBe(-32000);
      expect(errorFrame?.error?.message).toContain(
        "proxy connection lost mid-call"
      );
    } finally {
      if (prevStdin) Object.defineProperty(process, "stdin", prevStdin);
    }
  });
});
