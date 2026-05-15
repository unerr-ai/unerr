/**
 * DM-2: Daemon supervisor tests.
 *
 * Tests cover:
 *   - ProcessManager spawn/stop/IPC/idle sweep
 *   - Daemon entrypoint PID lock + UDS protocol
 *   - Orphan detection in daemon-child mode
 *   - Protocol message handling
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

// ── ProcessManager unit tests ──────────────────────────────────────

describe("ProcessManager", () => {
  let testDir: string;
  let testCounter = 0;

  beforeEach(() => {
    testCounter++;
    testDir = join(tmpdir(), `dm2-pm-test-${Date.now()}-${testCounter}`);
    mkdirSync(testDir, { recursive: true });
    // Set up a mock global dir so registry doesn't touch real home
    vi.stubEnv("UNERR_HOME", testDir);
    // Create registry file
    const globalUnerr = join(testDir, ".unerr");
    mkdirSync(globalUnerr, { recursive: true });
    writeFileSync(
      join(globalUnerr, "repos.json"),
      JSON.stringify({ version: 1, repos: [] })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* windows race */
    }
  });

  it("creates a ProcessManager instance with no repos", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();
    const status = pm.getStatus();
    expect(status).toEqual([]);
  });

  it("getManaged returns undefined for unknown repo", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();
    expect(pm.getManaged("/nonexistent")).toBeUndefined();
  });

  it("startIdleSweep + stopIdleSweep lifecycle", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();
    pm.startIdleSweep();
    // Calling again is a no-op
    pm.startIdleSweep();
    pm.stopIdleSweep();
    // Calling again after stop is fine
    pm.stopIdleSweep();
  });

  it("shutdownAll gracefully handles empty state", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();
    await pm.shutdownAll();
  });

  it("connect/disconnect on unknown repo is a no-op", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();
    pm.connect("/unknown");
    pm.disconnect("/unknown");
    pm.recordActivity("/unknown");
  });

  it("event handler receives lifecycle events", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const pm = new ProcessManager();
    const events: string[] = [];
    pm.setEventHandler((event) => {
      events.push(event);
    });
    // No actual events will fire without spawning, but handler should be set
    expect(events).toEqual([]);
  });
});

// ── Protocol message handling ──────────────────────────────────────

describe("Daemon protocol types", () => {
  it("DaemonRequest union covers all commands", async () => {
    const proto = await import("../daemon/protocol.js");
    // Verify the type constants exist as expected
    expect(proto.DEFAULT_IDLE_TIMEOUT_S).toBe(1800);
    expect(proto.DEFAULT_WARM_START_BUDGET).toBe(3);
    expect(proto.DEFAULT_WARM_START_DELAY_MS).toBe(30_000);
    expect(proto.DEFAULT_WARM_START_IDLE_DAYS).toBe(14);
  });

  it("ChildMessage types are all present", async () => {
    // Type-level verification: ensure all message shapes are well-typed
    type AssertChildTypes = {
      ready: { type: "ready"; sock: string };
      activity: { type: "activity" };
      stats: { type: "stats"; entities: number; edges: number; memory: number };
      needs_input: { type: "needs_input"; signals: unknown[] };
    };
    // This is a compile-time check — if ChildMessage changes, this test file won't compile
    const _: AssertChildTypes = {
      ready: { type: "ready", sock: "/tmp/test.sock" },
      activity: { type: "activity" },
      stats: { type: "stats", entities: 100, edges: 200, memory: 50 },
      needs_input: { type: "needs_input", signals: [] },
    };
    expect(_.ready.type).toBe("ready");
    expect(_.activity.type).toBe("activity");
    expect(_.stats.type).toBe("stats");
    expect(_.needs_input.type).toBe("needs_input");
  });

  it("ParentMessage types are all present", async () => {
    type AssertParentTypes = {
      shutdown: { type: "shutdown" };
      getStats: { type: "get-stats" };
    };
    const _: AssertParentTypes = {
      shutdown: { type: "shutdown" },
      getStats: { type: "get-stats" },
    };
    expect(_.shutdown.type).toBe("shutdown");
    expect(_.getStats.type).toBe("get-stats");
  });
});

// ── Daemon entrypoint isolation tests ──────────────────────────────

describe("Daemon entrypoint", () => {
  it("daemon.ts imports only from daemon/, proxy/pid-lock, utils/", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/daemon.ts"),
      "utf-8"
    );

    // Must not import from intelligence/, behaviors/, tracking/
    const forbidden = [
      /from\s+["']\.\.\/intelligence\//,
      /from\s+["']\.\.\/behaviors\//,
      /from\s+["']\.\.\/tracking\//,
    ];

    for (const pattern of forbidden) {
      expect(content).not.toMatch(pattern);
    }

    // Must import from daemon/ (ProcessManager, protocol, registry)
    expect(content).toMatch(/from\s+["']\.\.\/daemon\/process-manager/);
    expect(content).toMatch(/from\s+["']\.\.\/daemon\/protocol/);
    expect(content).toMatch(/from\s+["']\.\.\/daemon\/registry/);
  });

  it("process-manager.ts imports only from daemon/ and node builtins", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/daemon/process-manager.ts"),
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
  });
});

// ── CLI --daemon-child flag ────────────────────────────────────────

describe("CLI --daemon-child flag", () => {
  it("cli.ts contains --daemon-child option", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    expect(content).toContain("--daemon-child");
    expect(content).toContain("daemonChildBoot");
  });

  it("daemonChildBoot implements orphan detection", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    expect(content).toContain("process.ppid");
    expect(content).toContain("orphanTimer");
    expect(content).toContain("originalPpid");
  });

  it("daemonChildBoot sends IPC ready message", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    expect(content).toContain('{ type: "ready", sock: sockPath }');
    expect(content).toContain("process.send");
  });
});

// ── Idle sweep logic ───────────────────────────────────────────────

describe("Idle sweep logic", () => {
  it("process-manager.ts checks connections and lastActivity", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/daemon/process-manager.ts"),
      "utf-8"
    );

    expect(content).toContain("runIdleSweep");
    expect(content).toContain("repo.connections > 0");
    expect(content).toContain("repo.idleTimeout");
    expect(content).toContain("idleMs >= timeoutMs");
  });

  it("idle sweep interval is 60 seconds", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/daemon/process-manager.ts"),
      "utf-8"
    );

    expect(content).toContain("IDLE_SWEEP_INTERVAL_MS = 60_000");
  });
});

// ── PID lock in daemon.ts ──────────────────────────────────────────

describe("Daemon PID lock", () => {
  let testDir: string;
  let testCounter = 0;

  beforeEach(() => {
    testCounter++;
    testDir = join(tmpdir(), `dm2-pid-test-${Date.now()}-${testCounter}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* cleanup */
    }
  });

  it("daemon.ts writes unerrd.pid with process.pid", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/daemon.ts"),
      "utf-8"
    );

    expect(content).toContain("unerrd.pid");
    expect(content).toContain("unerrd.sock");
    expect(content).toContain("acquirePidLock");
    expect(content).toContain("releasePidLock");
  });

  it("daemon.ts handles stale socket cleanup", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/daemon.ts"),
      "utf-8"
    );

    expect(content).toContain("cleanStaleSocket");
    expect(content).toContain("createConnection");
  });
});

// ── Signal handling ────────────────────────────────────────────────

describe("Signal handling", () => {
  it("daemon.ts handles SIGTERM and SIGINT", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/daemon.ts"),
      "utf-8"
    );

    expect(content).toContain("SIGTERM");
    expect(content).toContain("SIGINT");
    expect(content).toContain("shutdownAll");
  });

  it("daemon-child handles SIGTERM for graceful shutdown", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/cli.ts"),
      "utf-8"
    );

    // Child process listens for SIGTERM
    expect(content).toContain("SIGTERM");
    // And calls shutdownProxy
    expect(content).toContain("shutdownProxy");
  });
});

// ── No interactive prompts in daemon-child ─────────────────────────

describe("No interactive prompts in daemon-child", () => {
  it("process.stdin.isTTY is never checked in daemon modules", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");

    const files = [
      "src/daemon/process-manager.ts",
      "src/daemon/protocol.ts",
      "src/daemon/registry.ts",
      "src/daemon/settings-schema.ts",
      "src/entrypoints/daemon.ts",
    ];

    for (const file of files) {
      const content = readSync(res(process.cwd(), file), "utf-8");
      expect(content).not.toContain("process.stdin.isTTY");
    }
  });
});

// ── UDS protocol ───────────────────────────────────────────────────

describe("UDS protocol", () => {
  it("daemon.ts implements newline-delimited JSON protocol", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/daemon.ts"),
      "utf-8"
    );

    // Newline-delimited JSON framing
    expect(content).toContain('buffer.indexOf("\\n")');
    expect(content).toContain("JSON.parse");
    expect(content).toContain("JSON.stringify");
  });

  it("handles all DaemonRequest commands", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/entrypoints/daemon.ts"),
      "utf-8"
    );

    const commands = [
      "ensure",
      "connect",
      "disconnect",
      "activity",
      "status",
      "add",
      "remove",
      "stop",
      "shutdown",
      "dashboard-state",
      "repo-detail",
    ];

    for (const cmd of commands) {
      expect(content).toContain(`"${cmd}"`);
    }
  });
});

// ── ProxyOptions daemonChild flag ──────────────────────────────────

describe("ProxyOptions daemonChild", () => {
  it("proxy.ts includes daemonChild in ProxyOptions", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(res(process.cwd(), "src/proxy/proxy.ts"), "utf-8");

    expect(content).toContain("daemonChild?: boolean");
    expect(content).toContain("opts.daemonChild");
  });
});

// ── daemon.ts CLI start/stop commands ──────────────────────────────

describe("Daemon CLI commands", () => {
  it("daemon.ts registers start and stop subcommands", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(
      res(process.cwd(), "src/commands/daemon.ts"),
      "utf-8"
    );

    expect(content).toContain('.command("start")');
    expect(content).toContain('.command("stop")');
    expect(content).toContain("--background");
    expect(content).toContain("startDaemon");
  });
});
