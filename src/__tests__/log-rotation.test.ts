import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION_DAYS,
  isRotatedLog,
  rotateLogIfNeeded,
  sweepRotatedLogs,
} from "../utils/log-rotation.js";

const DAY_MS = 86_400_000;

function setMtimeDaysAgo(path: string, days: number): void {
  const t = (Date.now() - days * DAY_MS) / 1000;
  utimesSync(path, t, t);
}

describe("log-rotation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-log-rot-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("isRotatedLog", () => {
    it("matches the new gzip form", () => {
      expect(isRotatedLog("proxy.log.2026-05-19.gz")).toBe(true);
      expect(isRotatedLog("session.log.2026-05-19.1.gz")).toBe(true);
      expect(isRotatedLog("events.jsonl.2026-05-19.gz")).toBe(true);
    });

    it("matches the legacy numbered form", () => {
      expect(isRotatedLog("proxy.log.1")).toBe(true);
      expect(isRotatedLog("session.log.5")).toBe(true);
      expect(isRotatedLog("events.jsonl.3")).toBe(true);
    });

    it("rejects canonical live files", () => {
      expect(isRotatedLog("proxy.log")).toBe(false);
      expect(isRotatedLog("session.log")).toBe(false);
      expect(isRotatedLog("events.jsonl")).toBe(false);
      expect(isRotatedLog("README.md")).toBe(false);
    });
  });

  describe("rotateLogIfNeeded", () => {
    it("returns false for a missing file", () => {
      expect(rotateLogIfNeeded(join(tmpDir, "ghost.log"))).toBe(false);
    });

    it("returns false for an empty file", () => {
      const p = join(tmpDir, "proxy.log");
      writeFileSync(p, "");
      expect(rotateLogIfNeeded(p)).toBe(false);
    });

    it("does not roll a fresh small file", () => {
      const p = join(tmpDir, "proxy.log");
      writeFileSync(p, "hello\n");
      expect(rotateLogIfNeeded(p)).toBe(false);
      expect(existsSync(p)).toBe(true);
    });

    it("rolls when the size cap is exceeded and gzips the content", () => {
      const p = join(tmpDir, "proxy.log");
      const big = "x".repeat(64);
      writeFileSync(p, big);
      expect(rotateLogIfNeeded(p, { maxBytes: 16 })).toBe(true);
      expect(existsSync(p)).toBe(false);
      const rolled = readdirSync(tmpDir).find((n) => n.endsWith(".gz"));
      expect(rolled).toBeDefined();
      const inflated = gunzipSync(readFileSync(join(tmpDir, rolled!)));
      expect(inflated.toString("utf-8")).toBe(big);
    });

    it("rolls when the file's mtime is on a previous UTC day", () => {
      const p = join(tmpDir, "proxy.log");
      writeFileSync(p, "yesterday\n");
      setMtimeDaysAgo(p, 2);
      expect(rotateLogIfNeeded(p)).toBe(true);
      expect(existsSync(p)).toBe(false);
      const rolled = readdirSync(tmpDir).find((n) => /\.gz$/.test(n));
      expect(rolled).toBeDefined();
      // The rolled name should encode a UTC date older than today.
      expect(rolled).toMatch(/\.\d{4}-\d{2}-\d{2}\.gz$/);
    });

    it("handles same-day repeat rolls with numeric suffix", () => {
      const p = join(tmpDir, "proxy.log");
      writeFileSync(p, "x".repeat(64));
      expect(rotateLogIfNeeded(p, { maxBytes: 16 })).toBe(true);
      writeFileSync(p, "y".repeat(64));
      expect(rotateLogIfNeeded(p, { maxBytes: 16 })).toBe(true);
      const rolls = readdirSync(tmpDir).filter((n) => n.endsWith(".gz"));
      expect(rolls.length).toBe(2);
      // One bare YYYY-MM-DD.gz and one .1.gz collision slot.
      expect(rolls.some((n) => /\.\d{4}-\d{2}-\d{2}\.1\.gz$/.test(n))).toBe(
        true
      );
    });

    it("sweeps stale rolls while rotating", () => {
      const stale = join(tmpDir, "proxy.log.2020-01-01.gz");
      writeFileSync(stale, "old");
      setMtimeDaysAgo(stale, 30);
      const fresh = join(tmpDir, "proxy.log");
      writeFileSync(fresh, "x".repeat(64));
      expect(rotateLogIfNeeded(fresh, { maxBytes: 16, retentionDays: 7 })).toBe(
        true
      );
      expect(existsSync(stale)).toBe(false);
    });
  });

  describe("sweepRotatedLogs", () => {
    it("returns 0 on a missing directory", () => {
      expect(sweepRotatedLogs(join(tmpDir, "nope"))).toBe(0);
    });

    it("deletes rolls older than the retention window", () => {
      const old = join(tmpDir, "proxy.log.2020-01-01.gz");
      const recent = join(tmpDir, "proxy.log.2026-05-19.gz");
      writeFileSync(old, "old");
      writeFileSync(recent, "recent");
      setMtimeDaysAgo(old, 30);
      setMtimeDaysAgo(recent, 2);
      const removed = sweepRotatedLogs(tmpDir, 7);
      expect(removed).toBe(1);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
    });

    it("deletes legacy `.N` rolls older than the window", () => {
      const legacy = join(tmpDir, "proxy.log.3");
      writeFileSync(legacy, "old");
      setMtimeDaysAgo(legacy, 30);
      expect(sweepRotatedLogs(tmpDir, 7)).toBe(1);
      expect(existsSync(legacy)).toBe(false);
    });

    it("never touches canonical live files", () => {
      const live = join(tmpDir, "proxy.log");
      writeFileSync(live, "live");
      setMtimeDaysAgo(live, 30);
      expect(sweepRotatedLogs(tmpDir, 7)).toBe(0);
      expect(existsSync(live)).toBe(true);
    });

    it("uses 7-day default retention", () => {
      const old = join(tmpDir, "proxy.log.2020-01-01.gz");
      writeFileSync(old, "old");
      setMtimeDaysAgo(old, DEFAULT_RETENTION_DAYS + 1);
      expect(sweepRotatedLogs(tmpDir)).toBe(1);
    });
  });

  describe("module constants", () => {
    it("exposes the default cap and retention", () => {
      expect(DEFAULT_MAX_BYTES).toBe(5_000_000);
      expect(DEFAULT_RETENTION_DAYS).toBe(7);
    });
  });
});
