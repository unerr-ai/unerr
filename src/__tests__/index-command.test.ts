/**
 * Tests for `unerr index` — proxy liveness guard.
 *
 * When a live per-repo proxy holds graph.db, `unerr index` must refuse to
 * run (two concurrent SQLite writers corrupt the file with code 11).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All mock factories use plain arrow functions (not vi.fn()) so that
// vi.restoreAllMocks() in afterEach cannot accidentally reset them.

// Toggled per-test so the non-git bypass path can be exercised; defaults to
// true so the existing proxy-liveness tests behave as before.
let _isGitRepo = true;
vi.mock("../utils/git.js", () => ({
  isGitRepo: () => Promise.resolve(_isGitRepo),
  getRemoteUrl: () => Promise.resolve(null),
}));

vi.mock("../hooks/login-nudge.js", () => ({
  nudgeIfLoggedOut: () => undefined,
}));

// shouldReindex is toggled per-test via this module-level flag so that
// tests which need the "fresh" exit-0 path don't require a real DB.
let _shouldReindex = true;
vi.mock("../intelligence/local-snapshot.js", () => ({
  shouldReindex: () => _shouldReindex,
}));

import { registerIndexCommand } from "../commands/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Write a well-formed proxy.pid for the given pid into stateDir. */
function writePidFile(stateDir: string, pid: number): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "proxy.pid"),
    JSON.stringify({ pid, startedAt: "", healthPort: 0 })
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("index command — proxy liveness guard", () => {
  let tempDir: string;
  let origCwd: string;
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    _shouldReindex = true; // default: needs re-index (reaches the guard)
    _isGitRepo = true; // default: inside a git repo (git check is transparent)
    origCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "ur-idx-guard-"));
    process.chdir(tempDir);
    stdoutBuf = [];
    stderrBuf = [];
    // Capture both output streams for every test.
    vi.spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }
    );
    // Make process.exit throw so the test runner is not terminated.
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    // Restores the vi.spyOn stubs (stdout, stderr, exit) without touching the
    // plain-function module mocks defined above.
    vi.restoreAllMocks();
    process.chdir(origCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── (a) live pid ─────────────────────────────────────────────────────────────

  it("(a) --json emits proxy_running and exits 1 when proxy pid is alive", async () => {
    writePidFile(join(tempDir, ".unerr", "state"), process.pid);

    const program = new Command().exitOverride();
    registerIndexCommand(program);

    await expect(
      program.parseAsync(["node", "unerr", "index", "--json"])
    ).rejects.toThrow("__exit__");

    expect(process.exit).toHaveBeenCalledWith(1);
    const parsed = JSON.parse(stdoutBuf.join("")) as {
      status: string;
      reindexed: boolean;
    };
    expect(parsed.status).toBe("proxy_running");
    expect(parsed.reindexed).toBe(false);
  });

  it("(a) stderr message names the pid and exits 1 when proxy pid is alive", async () => {
    writePidFile(join(tempDir, ".unerr", "state"), process.pid);

    const program = new Command().exitOverride();
    registerIndexCommand(program);

    await expect(
      program.parseAsync(["node", "unerr", "index"])
    ).rejects.toThrow("__exit__");

    expect(process.exit).toHaveBeenCalledWith(1);
    const out = stderrBuf.join("");
    expect(out).toContain("proxy is already serving this repo");
    expect(out).toContain(String(process.pid));
    expect(out).toContain("unerr pm stop");
  });

  // ── (b) no / dead pid ────────────────────────────────────────────────────────

  it("(b) guard passes (exits 0 fresh) when no proxy.pid file exists", async () => {
    _shouldReindex = false; // exits 0 as "fresh" — never reaches the DB

    const program = new Command().exitOverride();
    registerIndexCommand(program);

    await expect(
      program.parseAsync(["node", "unerr", "index"])
    ).rejects.toThrow("__exit__");

    // Guard didn't fire → exits 0 (fresh path), not 1 (proxy_running)
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("(b) guard passes (exits 0 fresh) when proxy.pid holds a dead PID", async () => {
    // PID 9999999 is above macOS/Linux limits — guaranteed dead
    writePidFile(join(tempDir, ".unerr", "state"), 9999999);
    _shouldReindex = false;

    const program = new Command().exitOverride();
    registerIndexCommand(program);

    await expect(
      program.parseAsync(["node", "unerr", "index"])
    ).rejects.toThrow("__exit__");

    // Dead pid → guard is transparent → exits 0 (fresh path)
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  // ── (c) non-git directory ──────────────────────────────────────────────────────

  it("(c) refuses a non-git directory without --force (exit 1, names --force)", async () => {
    _isGitRepo = false;

    const program = new Command().exitOverride();
    registerIndexCommand(program);

    await expect(
      program.parseAsync(["node", "unerr", "index"])
    ).rejects.toThrow("__exit__");

    expect(process.exit).toHaveBeenCalledWith(1);
    const out = stderrBuf.join("");
    expect(out).toContain("not inside a git repository");
    expect(out).toContain("--force");
    // Never reached runIndex: no fresh/proxy/index JSON on stdout.
    expect(stdoutBuf.join("")).toBe("");
  });

  it("(c) --force bypasses the git check on a non-git directory (reaches runIndex)", async () => {
    _isGitRepo = false;
    // A live proxy.pid makes runIndex return proxy_running before it opens the
    // real cozo DB — so reaching that status proves the git wall was bypassed
    // (and keeps the test off a real worker-thread index).
    writePidFile(join(tempDir, ".unerr", "state"), process.pid);

    const program = new Command().exitOverride();
    registerIndexCommand(program);

    await expect(
      program.parseAsync(["node", "unerr", "index", "--force", "--json"])
    ).rejects.toThrow("__exit__");

    // Git wall did NOT fire — no git error, and runIndex ran (proxy_running).
    expect(stderrBuf.join("")).not.toContain("not inside a git repository");
    const parsed = JSON.parse(stdoutBuf.join("")) as { status: string };
    expect(parsed.status).toBe("proxy_running");
  });
});
