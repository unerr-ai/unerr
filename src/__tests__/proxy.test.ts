/**
 * P10-TEST-01: Proxy Lifecycle Tests
 *
 * Tests PID lock and session stats.
 * Note: Full MCP server integration tests require cozo-node and stdio — kept as
 * focused unit tests for the core proxy subsystems.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PidLock, isUnerrProxyCommand } from "../proxy/pid-lock.js";
import {
  computePercentiles,
  createSessionStats,
  formatSessionStats,
  recordLatency,
  recordRiskWarning,
  recordToolCall,
  recordViolation,
} from "../proxy/session-stats.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * Spawn a long-lived dummy process. `asProxy` puts `cli.js --daemon-child` in
 * its argv so `isUnerrProxyPid` (which runs `isUnerrProxyCommand` over `ps`,
 * mirroring `isUnerrProxyProcess` in src/daemon/process-manager.ts)
 * classifies it as a real unerr proxy — `cli.js` stands in for unerr's CLI
 * entry point, satisfying the argv anchor a bare `--daemon-child` no longer
 * would; without either token the process stands in for an UNRELATED program
 * that a recycled pid might point at. Tracked for teardown.
 */
function spawnDummy(asProxy: boolean, kids: ChildProcess[]): ChildProcess {
  // `--` ends node's own option parsing so the trailing args survive as user
  // args (node rejects them as unknown options otherwise) and show up in `ps`.
  const args = ["-e", "setInterval(() => {}, 1e9)"];
  if (asProxy) args.push("--", "cli.js", "--daemon-child");
  const child = spawn(process.execPath, args, { stdio: "ignore" });
  kids.push(child);
  return child;
}

/** Bind an ephemeral port, then release it — a port nothing is listening on,
 * so a health-check fetch against it fails fast with ECONNREFUSED. */
function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// ── PID Lock Tests ────────────────────────────────────────────────

describe("PidLock", () => {
  it("acquires lock when no PID file exists", async () => {
    const lock = new PidLock(tempDir);
    const result = await lock.acquire();
    expect(result.acquired).toBe(true);
    expect(result.outcome).toBe("primary");
    expect(existsSync(join(tempDir, "proxy.pid"))).toBe(true);
    lock.release();
  });

  it("writes JSON PID data to file", async () => {
    const lock = new PidLock(tempDir);
    await lock.acquire();
    const content = readFileSync(join(tempDir, "proxy.pid"), "utf-8").trim();
    const data = JSON.parse(content);
    expect(data.pid).toBe(process.pid);
    expect(data.startedAt).toBeTruthy();
    expect(typeof data.healthPort).toBe("number");
    expect(data.healthPort).toBeGreaterThan(0);
    lock.release();
  });

  it("rejects second lock when PID is alive", async () => {
    const lock1 = new PidLock(tempDir);
    await lock1.acquire();

    const lock2 = new PidLock(tempDir);
    const result = await lock2.acquire();
    expect(result.acquired).toBe(false);
    expect(result.outcome).toBe("secondary");
    expect(result.existingPid).toBe(process.pid);

    lock1.release();
  });

  it("cleans up stale PID (legacy format) and acquires lock", async () => {
    // Write a dead PID in legacy plain number format
    writeFileSync(join(tempDir, "proxy.pid"), "9999999", "utf-8");

    const lock = new PidLock(tempDir);
    const result = await lock.acquire();
    expect(result.acquired).toBe(true);
    expect(result.outcome).toBe("stale_recovered");
    lock.release();
  });

  it("cleans up stale PID (JSON format) and acquires lock", async () => {
    // Write a dead PID in JSON format
    writeFileSync(
      join(tempDir, "proxy.pid"),
      JSON.stringify({
        pid: 9999999,
        startedAt: new Date().toISOString(),
        healthPort: 0,
      }),
      "utf-8"
    );

    const lock = new PidLock(tempDir);
    const result = await lock.acquire();
    expect(result.acquired).toBe(true);
    expect(result.outcome).toBe("stale_recovered");
    lock.release();
  });

  it("release removes PID file", async () => {
    const lock = new PidLock(tempDir);
    await lock.acquire();
    expect(existsSync(join(tempDir, "proxy.pid"))).toBe(true);
    lock.release();
    expect(existsSync(join(tempDir, "proxy.pid"))).toBe(false);
  });

  it("release only removes own PID", () => {
    // Write someone else's PID in JSON format
    writeFileSync(
      join(tempDir, "proxy.pid"),
      JSON.stringify({ pid: 1, startedAt: "", healthPort: 0 }),
      "utf-8"
    );
    const lock = new PidLock(tempDir);
    // Don't acquire — just try to release
    lock.release();
    // File should still exist (PID 1 is not our PID)
    expect(existsSync(join(tempDir, "proxy.pid"))).toBe(true);
  });

  it("isLocked reports correctly", async () => {
    const lock = new PidLock(tempDir);

    expect(lock.isLocked().locked).toBe(false);

    await lock.acquire();
    expect(lock.isLocked().locked).toBe(true);
    expect(lock.isLocked().pid).toBe(process.pid);
    expect(lock.isLocked().healthPort).toBeGreaterThan(0);

    lock.release();
    expect(lock.isLocked().locked).toBe(false);
  });

  it("health endpoint responds with status", async () => {
    const lock = new PidLock(tempDir);
    const result = await lock.acquire();
    expect(result.healthPort).toBeGreaterThan(0);

    lock.recordToolCall();
    lock.recordToolCall();
    lock.setMode("local");

    const res = await fetch(`http://127.0.0.1:${result.healthPort}/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      status: string;
      tool_calls: number;
      mode: string;
      pid: number;
    };
    expect(body.status).toBe("ok");
    expect(body.tool_calls).toBe(2);
    expect(body.mode).toBe("local");
    expect(body.pid).toBe(process.pid);

    lock.release();
  });

  it("readPidFile returns data for running process", async () => {
    const lock = new PidLock(tempDir);
    await lock.acquire();

    const data = PidLock.readPidFile(tempDir);
    expect(data).not.toBeNull();
    expect(data?.pid).toBe(process.pid);
    expect(data?.healthPort).toBeGreaterThan(0);

    lock.release();
  });

  // Regression: `unerr status` used to `Number.parseInt` the raw pid file
  // instead of parsing its JSON shape, so a live proxy was always reported as
  // a stale PID. `unerr status` now delegates to PidLock.readPidFile — these
  // cover the two outcomes it must distinguish for a JSON-shaped lock file.
  it("readPidFile returns data for a JSON pid file pointing at a live pid", () => {
    writeFileSync(
      join(tempDir, "proxy.pid"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        healthPort: 53886,
      }),
      "utf-8"
    );

    const data = PidLock.readPidFile(tempDir);
    expect(data).not.toBeNull();
    expect(data?.pid).toBe(process.pid);
  });

  it("readPidFile returns null for a JSON pid file pointing at a dead pid", () => {
    writeFileSync(
      join(tempDir, "proxy.pid"),
      JSON.stringify({
        pid: 9999999,
        startedAt: new Date().toISOString(),
        healthPort: 53886,
      }),
      "utf-8"
    );

    expect(PidLock.readPidFile(tempDir)).toBeNull();
  });

  it("returns wedged (not stale_recovered) when an alive unerr proxy fails health after retries", async () => {
    const kids: ChildProcess[] = [];
    try {
      const proxy = spawnDummy(true, kids);
      await new Promise((r) => setTimeout(r, 150)); // let it appear in `ps`

      const deadPort = await unusedPort();
      writeFileSync(
        join(tempDir, "proxy.pid"),
        JSON.stringify({
          pid: proxy.pid,
          startedAt: new Date().toISOString(),
          healthPort: deadPort,
        }),
        "utf-8"
      );

      const lock = new PidLock(tempDir);
      const result = await lock.acquire();
      expect(result.acquired).toBe(false);
      expect(result.outcome).toBe("wedged");
      expect(result.existingPid).toBe(proxy.pid);
      // Lock file must be left untouched — a wedged proxy still owns it.
      expect(existsSync(join(tempDir, "proxy.pid"))).toBe(true);
    } finally {
      for (const k of kids) k.kill("SIGKILL");
    }
  }, 15_000);

  it("still reclaims (stale_recovered) when the alive pid is not a unerr process", async () => {
    const kids: ChildProcess[] = [];
    try {
      const stranger = spawnDummy(false, kids);
      await new Promise((r) => setTimeout(r, 150));

      const deadPort = await unusedPort();
      writeFileSync(
        join(tempDir, "proxy.pid"),
        JSON.stringify({
          pid: stranger.pid,
          startedAt: new Date().toISOString(),
          healthPort: deadPort,
        }),
        "utf-8"
      );

      const lock = new PidLock(tempDir);
      const result = await lock.acquire();
      expect(result.acquired).toBe(true);
      expect(result.outcome).toBe("stale_recovered");
      lock.release();
    } finally {
      for (const k of kids) k.kill("SIGKILL");
    }
  }, 15_000);
});

// ── isUnerrProxyCommand argv classifier ─────────────────────────────

describe("isUnerrProxyCommand", () => {
  it("classifies a managed proxy (cli.js --daemon-child) as a proxy", () => {
    expect(
      isUnerrProxyCommand("node /x/unerr-cli/dist/cli.js --daemon-child")
    ).toBe(true);
  });

  it("classifies a standalone proxy (bare cli.js, no subcommand) as a proxy", () => {
    expect(isUnerrProxyCommand("node /x/unerr-cli/dist/cli.js")).toBe(true);
  });

  it("classifies the compiled binary form as a proxy", () => {
    expect(isUnerrProxyCommand("/usr/local/bin/unerr")).toBe(true);
  });

  it("excludes the --mcp bridge", () => {
    expect(
      isUnerrProxyCommand(
        "node /x/unerr-cli/dist/cli.js --mcp --coding-agent=claude"
      )
    ).toBe(false);
  });

  it("excludes the exec runner", () => {
    expect(
      isUnerrProxyCommand("node /x/unerr-cli/dist/cli.js exec --b64 abc")
    ).toBe(false);
  });

  it("excludes the process manager (unerrd)", () => {
    expect(isUnerrProxyCommand("unerrd")).toBe(false);
  });

  it("excludes an unrelated program", () => {
    expect(isUnerrProxyCommand("node /x/some-other/app.js")).toBe(false);
  });
});

// ── Session Stats Tests ───────────────────────────────────────────

describe("SessionStats", () => {
  it("creates stats with zero counters", () => {
    const stats = createSessionStats();
    expect(stats.toolCallsLocal).toBe(0);
    expect(stats.estimatedTokensSaved).toBe(0);
    expect(stats.violationsCaught).toBe(0);
    expect(stats.riskWarningsIssued).toBe(0);
  });

  it("increments local tool calls", () => {
    const stats = createSessionStats();
    recordToolCall(stats);
    recordToolCall(stats);
    expect(stats.toolCallsLocal).toBe(2);
    expect(stats.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it("tracks violations and risk warnings", () => {
    const stats = createSessionStats();
    recordViolation(stats);
    recordViolation(stats);
    recordRiskWarning(stats);
    expect(stats.violationsCaught).toBe(2);
    expect(stats.riskWarningsIssued).toBe(1);
  });

  it("returns null format when no calls made", () => {
    const stats = createSessionStats();
    expect(formatSessionStats(stats)).toBeNull();
  });

  it("formats stats with local percentage and savings", () => {
    const stats = createSessionStats();
    recordToolCall(stats);
    recordToolCall(stats);
    recordToolCall(stats);

    const output = formatSessionStats(stats);
    expect(output).not.toBeNull();
    expect(output).toContain("3 (all local)");
    expect(output).toContain("Tokens saved");
  });

  it("includes violations and risk warnings in output", () => {
    const stats = createSessionStats();
    recordToolCall(stats);
    recordViolation(stats);
    recordRiskWarning(stats);

    const output = formatSessionStats(stats)!;
    expect(output).toContain("Violations");
    expect(output).toContain("Risk warnings");
  });
});

// ── Latency Tracking Tests ────────────────────────────────────────

describe("LatencyTracker", () => {
  it("records latency samples and computes percentiles", () => {
    const stats = createSessionStats();

    // Simulate 100 local tool calls with increasing latency
    for (let i = 1; i <= 100; i++) {
      recordLatency(stats.latency, i * 0.05); // 0.05ms to 5.0ms
    }

    const p = computePercentiles(
      stats.latency.localSamples,
      stats.latency.localTotalSamples
    );
    expect(p).not.toBeNull();
    expect(p?.count).toBe(100);
    expect(p?.min).toBeCloseTo(0.05, 1);
    expect(p?.max).toBeCloseTo(5.0, 1);
    expect(p?.p50).toBeGreaterThan(0);
    expect(p?.p95).toBeGreaterThan(p!.p50);
    expect(p?.p99).toBeGreaterThanOrEqual(p!.p95);
  });

  it("records all samples as local", () => {
    const stats = createSessionStats();

    recordLatency(stats.latency, 1.5);
    recordLatency(stats.latency, 1.8);
    recordLatency(stats.latency, 2.5);

    expect(stats.latency.localTotalSamples).toBe(3);
    expect(stats.latency.totalSamples).toBe(3);

    const localP = computePercentiles(
      stats.latency.localSamples,
      stats.latency.localTotalSamples
    );
    expect(localP?.max).toBeLessThan(5);
  });

  it("returns null percentiles for zero samples", () => {
    const stats = createSessionStats();
    const p = computePercentiles(stats.latency.localSamples, 0);
    expect(p).toBeNull();
  });

  it("circular buffer wraps correctly at capacity", () => {
    const stats = createSessionStats();

    // Fill past capacity (1000) — buffer should wrap
    for (let i = 0; i < 1200; i++) {
      recordLatency(stats.latency, i < 1000 ? 1.0 : 50.0);
    }

    expect(stats.latency.localTotalSamples).toBe(1200);

    // Percentiles should reflect the circular nature
    // Buffer has 200 samples of 50ms + 800 samples of 1ms
    const p = computePercentiles(
      stats.latency.localSamples,
      stats.latency.localTotalSamples
    );
    expect(p?.count).toBe(1200);
    // p50 should be 1.0ms (800/1000 are 1ms)
    expect(p?.p50).toBe(1.0);
  });

  it("formatSessionStats includes latency section", () => {
    const stats = createSessionStats();
    recordToolCall(stats);
    recordLatency(stats.latency, 2.3);
    recordToolCall(stats);
    recordLatency(stats.latency, 280);

    const output = formatSessionStats(stats)!;
    expect(output).toContain("Latency");
    expect(output).toContain("p50=");
    expect(output).toContain("p95=");
    expect(output).toContain("p99=");
  });
});
