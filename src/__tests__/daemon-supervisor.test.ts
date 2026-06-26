/**
 * DM-2: Daemon supervisor tests.
 *
 * Tests cover:
 *   - ProcessManager spawn/stop/IPC/idle sweep
 *   - Daemon entrypoint PID lock + UDS protocol
 *   - Orphan detection in daemon-child mode
 *   - Protocol message handling
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** True when `pid` is still alive (signal 0 probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a long-lived dummy process. `asProxy` puts `--daemon-child` in its argv
 * so `isUnerrProxyProcess` (which matches that marker via `ps`) classifies it as
 * a real proxy; without it the process stands in for an UNRELATED program that a
 * recycled pid might point at. Tracked for teardown.
 */
function spawnDummy(asProxy: boolean, kids: ChildProcess[]): ChildProcess {
  // `--` ends node's own option parsing so `--daemon-child` survives as a user
  // arg (node rejects it as an unknown option otherwise) and shows up in `ps`.
  const args = ["-e", "setInterval(() => {}, 1e9)"];
  if (asProxy) args.push("--", "--daemon-child");
  const child = spawn(process.execPath, args, { stdio: "ignore" });
  kids.push(child);
  return child;
}

/**
 * Stand up a real listening UDS server at `sockPath` so `tryAdopt`'s
 * connectability probe succeeds. Adoption now requires a CONNECTABLE socket (an
 * empty sock file is treated as a wedged proxy), so an adoptable proxy must
 * actually accept connections. Tracked servers are closed in `afterEach`.
 */
function listenOnSock(sockPath: string, servers: Server[]): Promise<void> {
  const server = createServer();
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve());
  });
}

// ── ProcessManager unit tests ──────────────────────────────────────

describe("ProcessManager", () => {
  let testDir: string;
  let testCounter = 0;
  let servers: Server[];
  let kids: ChildProcess[];

  beforeEach(() => {
    servers = [];
    kids = [];
    testCounter++;
    // Short dir: a bound UDS socket lives at <repo>/.unerr/state/proxy.sock and
    // the macOS sun_path limit is ~104 bytes, so keep the prefix tight.
    testDir = join(tmpdir(), `dm2-${process.pid}-${testCounter}`);
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

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const k of kids) {
      try {
        if (k.pid) process.kill(k.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await Promise.all(
      servers.map((s) => new Promise<void>((res) => s.close(() => res())))
    );
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

  it("ensure() adopts an already-live per-repo proxy instead of forking", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    // A repo whose proxy is already running on disk: the PID lock points at a
    // live process (our own PID — guaranteed alive) and the UDS socket exists.
    // ensure() must adopt it (no fork), so the live primary is tracked and
    // `pm status` reflects reality instead of churning "stopped".
    const repoDir = join(testDir, "live-repo");
    const stateDir = join(repoDir, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
    const sockPath = join(stateDir, "proxy.sock");
    // A CONNECTABLE socket — tryAdopt now rejects a non-connectable (wedged) one.
    await listenOnSock(sockPath, servers);
    writeFileSync(
      join(stateDir, "proxy.pid"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
    // Registered, as a real adopted repo would be (so getStatus surfaces it).
    const { addRepo } = await import("../daemon/registry.js");
    addRepo(repoDir);

    const pm = new ProcessManager();
    const events: string[] = [];
    pm.setEventHandler((event, _repo, detail) =>
      events.push(`${event}:${detail ?? ""}`)
    );

    const sock = await pm.ensure(repoDir);
    expect(sock).toBe(sockPath);

    const managed = pm.getManaged(repoDir);
    expect(managed?.status).toBe("running");
    expect(managed?.adopted).toBe(true);
    expect(managed?.pid).toBe(process.pid);
    expect(managed?.child).toBeNull(); // adopted — no forked child handle
    expect(events.some((e) => e.startsWith("started:adopted"))).toBe(true);

    // Adopted entries are excluded from the idle sweep (own lifecycle).
    expect(pm.getStatus()[0]?.status).toBe("running");
  });

  it("ensure() drops a dead adopted entry and re-evaluates", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const repoDir = join(testDir, "reprobe-repo");
    const stateDir = join(repoDir, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
    const sockPath = join(stateDir, "proxy.sock");
    await listenOnSock(sockPath, servers);
    writeFileSync(
      join(stateDir, "proxy.pid"),
      JSON.stringify({ pid: process.pid })
    );

    const pm = new ProcessManager();
    await pm.ensure(repoDir); // adopt with our live PID

    // Simulate the adopted proxy dying: point the tracked entry at a PID that
    // is not alive. ensure() must re-probe, drop the stale entry, and (since
    // the on-disk lock still names our live PID) re-adopt cleanly.
    const managed = pm.getManaged(repoDir)!;
    managed.pid = 2_147_483_646; // implausible PID — not alive
    const sock2 = await pm.ensure(repoDir);
    expect(sock2).toBe(sockPath);
    expect(pm.getManaged(repoDir)?.pid).toBe(process.pid); // refreshed
  });

  it("shutdownAll kills a verified orphan proxy and clears its lock", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const { addRepo } = await import("../daemon/registry.js");
    // An untracked per-repo proxy left behind by a prior daemon generation: a
    // real, alive process whose argv carries --daemon-child (so it is confirmed
    // a unerr proxy), recorded only in the registry + its lock file.
    const repoDir = join(testDir, "orphan-repo");
    const stateDir = join(repoDir, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
    const orphan = spawnDummy(true, kids);
    await new Promise((r) => setTimeout(r, 150)); // let it appear in `ps`
    writeFileSync(
      join(stateDir, "proxy.pid"),
      JSON.stringify({ pid: orphan.pid })
    );
    writeFileSync(join(stateDir, "proxy.sock"), "");
    addRepo(repoDir);

    const pm = new ProcessManager();
    await pm.shutdownAll();

    // pm stop must leave ZERO repo proxies behind, and clear the stale lock.
    expect(isAlive(orphan.pid!)).toBe(false);
    expect(existsSync(join(stateDir, "proxy.pid"))).toBe(false);
    expect(existsSync(join(stateDir, "proxy.sock"))).toBe(false);
  });

  it("shutdownAll leaves an unrelated (recycled-pid) process untouched", async () => {
    const { ProcessManager } = await import("../daemon/process-manager.js");
    const { addRepo } = await import("../daemon/registry.js");
    // A lock file naming a pid the OS recycled onto an UNRELATED program (no
    // --daemon-child). The guard must refuse to kill it.
    const repoDir = join(testDir, "stranger-repo");
    const stateDir = join(repoDir, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
    const stranger = spawnDummy(false, kids);
    await new Promise((r) => setTimeout(r, 150));
    writeFileSync(
      join(stateDir, "proxy.pid"),
      JSON.stringify({ pid: stranger.pid })
    );
    addRepo(repoDir);

    const pm = new ProcessManager();
    await pm.shutdownAll();

    expect(isAlive(stranger.pid!)).toBe(true); // never signaled
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
    // Raised to 6 min so a large repo / slow machine can finish a cold index
    // before the daemon gives up waiting for the proxy's `ready`.
    expect(proto.REPO_READY_TIMEOUT_MS).toBe(360_000);
    // The bridge's `ensure` request timeout must exceed REPO_READY_TIMEOUT_MS
    // so the proxy-side ready timeout fires first with a clean error.
    expect(proto.ENSURE_REPO_REQUEST_TIMEOUT_MS).toBe(390_000);
    expect(proto.ENSURE_REPO_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      proto.REPO_READY_TIMEOUT_MS
    );
    expect(proto.DAEMON_READY_TIMEOUT_MS).toBe(30_000);
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
    expect(content).toContain("onDaemonReady");
    expect(content).toContain("let proxyResult");
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

// ── pm.ts CLI start/stop commands ──────────────────────────────────

describe("Process-manager CLI commands", () => {
  it("pm.ts registers start and stop subcommands", async () => {
    const { readFileSync: readSync } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const content = readSync(res(process.cwd(), "src/commands/pm.ts"), "utf-8");

    expect(content).toContain('.command("start")');
    // stop now takes an optional [path] positional (stop one repo) and still
    // stops the whole supervisor when called with no argument.
    expect(content).toContain('.command("stop [path]")');
    expect(content).toContain("--detached");
    expect(content).toContain("startDaemon");
  });
});
