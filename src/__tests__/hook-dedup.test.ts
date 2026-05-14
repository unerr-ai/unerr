/**
 * hook-dedup — file-based TTL dedup for PostToolUse hooks.
 *
 * The module persists to `.unerr/state/hook-recent.json` relative to CWD, so
 * tests chdir into a fresh temp dir per case and restore CWD on teardown.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetHookDedup, shouldEmitOnce } from "../hooks/hook-dedup.js";

const STATE_FILE = path.join(".unerr", "state", "hook-recent.json");

describe("hook-dedup", () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-hook-dedup-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("shouldEmitOnce", () => {
    it("first call returns true and persists the key", () => {
      expect(shouldEmitOnce("Read:/a/b.ts")).toBe(true);
      expect(fs.existsSync(STATE_FILE)).toBe(true);
      const map = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<
        string,
        number
      >;
      expect(typeof map["Read:/a/b.ts"]).toBe("number");
    });

    it("second call within TTL returns false", () => {
      expect(shouldEmitOnce("Read:/a/b.ts", 30_000)).toBe(true);
      expect(shouldEmitOnce("Read:/a/b.ts", 30_000)).toBe(false);
      expect(shouldEmitOnce("Read:/a/b.ts", 30_000)).toBe(false);
    });

    it("call after TTL window returns true again", () => {
      // Tiny TTL — wait it out instead of mocking the clock.
      expect(shouldEmitOnce("Read:/a/b.ts", 10)).toBe(true);
      expect(shouldEmitOnce("Read:/a/b.ts", 10)).toBe(false);
      const waitUntil = Date.now() + 25;
      // Busy wait — short enough not to slow the suite.
      while (Date.now() < waitUntil) {
        /* spin */
      }
      expect(shouldEmitOnce("Read:/a/b.ts", 10)).toBe(true);
    });

    it("different keys are tracked independently", () => {
      expect(shouldEmitOnce("Read:/a/b.ts")).toBe(true);
      expect(shouldEmitOnce("Read:/a/c.ts")).toBe(true);
      expect(shouldEmitOnce("Edit:/a/b.ts")).toBe(true);
      // Each repeated within TTL is suppressed.
      expect(shouldEmitOnce("Read:/a/b.ts")).toBe(false);
      expect(shouldEmitOnce("Read:/a/c.ts")).toBe(false);
      expect(shouldEmitOnce("Edit:/a/b.ts")).toBe(false);
    });

    it("default TTL is 30s — repeated calls suppress", () => {
      expect(shouldEmitOnce("k1")).toBe(true);
      // No explicit ttlMs — should use the 30s default.
      expect(shouldEmitOnce("k1")).toBe(false);
    });

    it("persists timestamps across invocations (simulated via state file)", () => {
      shouldEmitOnce("k:x", 30_000);
      const before = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<
        string,
        number
      >;
      expect(before["k:x"]).toBeGreaterThan(0);
      // A second call within TTL should NOT overwrite the timestamp (it's
      // suppressed before the write).
      shouldEmitOnce("k:x", 30_000);
      const after = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<
        string,
        number
      >;
      expect(after["k:x"]).toBe(before["k:x"]);
    });

    it("degrades safely when state dir is missing", () => {
      // No .unerr dir exists yet — first call must still return true and
      // create the file.
      expect(fs.existsSync(".unerr")).toBe(false);
      expect(shouldEmitOnce("first")).toBe(true);
      expect(fs.existsSync(STATE_FILE)).toBe(true);
    });

    it("degrades safely on corrupt state file (treats as empty)", () => {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, "{ not valid json");
      // Corrupt file should not crash; first call returns true.
      expect(shouldEmitOnce("k")).toBe(true);
    });
  });

  describe("resetHookDedup", () => {
    it("clears the on-disk dedup file so next call emits again", () => {
      expect(shouldEmitOnce("k", 30_000)).toBe(true);
      expect(shouldEmitOnce("k", 30_000)).toBe(false);
      resetHookDedup();
      expect(shouldEmitOnce("k", 30_000)).toBe(true);
    });

    it("is a no-op when the state file does not exist", () => {
      expect(() => resetHookDedup()).not.toThrow();
    });
  });

  describe("prune behavior", () => {
    it("prunes entries older than ttlMs * PRUNE_FACTOR on write", () => {
      // Seed the state file with an old entry that should be pruned by the
      // next write. PRUNE_FACTOR is 10, so with ttl=10ms the cutoff is 100ms
      // before now.
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const stale = Date.now() - 5_000; // 5s old — well past 100ms cutoff
      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({ "stale:key": stale, "fresh:key": Date.now() }),
      );

      // Use a small TTL so PRUNE_FACTOR * ttl = 100ms cutoff.
      shouldEmitOnce("new:key", 10);

      const map = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<
        string,
        number
      >;
      expect(map["stale:key"]).toBeUndefined();
      expect(map["new:key"]).toBeDefined();
    });
  });
});
