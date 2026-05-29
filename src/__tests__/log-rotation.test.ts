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

    it("does not roll a fresh same-day file", () => {
      const p = join(tmpDir, "proxy.log");
      writeFileSync(p, "hello\n");
      expect(rotateLogIfNeeded(p)).toBe(false);
      expect(existsSync(p)).toBe(true);
    });

    it("does not roll a large same-day file (size is not a trigger)", () => {
      const p = join(tmpDir, "proxy.log");
      writeFileSync(p, "x".repeat(10_000_000));
      expect(rotateLogIfNeeded(p)).toBe(false);
      expect(existsSync(p)).toBe(true);
    });

    it("rolls when the file's mtime is on a previous local day and gzips the content", () => {
      const p = join(tmpDir, "proxy.log");
      const content = "yesterday's bytes\n";
      writeFileSync(p, content);
      setMtimeDaysAgo(p, 2);
      expect(rotateLogIfNeeded(p)).toBe(true);
      expect(existsSync(p)).toBe(false);
      const rolled = readdirSync(tmpDir).find((n) => /\.gz$/.test(n));
      expect(rolled).toBeDefined();
      expect(rolled).toMatch(/\.\d{4}-\d{2}-\d{2}\.gz$/);
      const inflated = gunzipSync(readFileSync(join(tmpDir, rolled!)));
      expect(inflated.toString("utf-8")).toBe(content);
    });

    it("produces exactly one gz per day even on repeated rotation calls", () => {
      const p = join(tmpDir, "proxy.log");
      writeFileSync(p, "day-1 bytes\n");
      setMtimeDaysAgo(p, 1);
      expect(rotateLogIfNeeded(p)).toBe(true);
      // Subsequent calls with no live file should be no-ops, not new gzs.
      expect(rotateLogIfNeeded(p)).toBe(false);
      expect(rotateLogIfNeeded(p)).toBe(false);
      const gzs = readdirSync(tmpDir).filter((n) => n.endsWith(".gz"));
      expect(gzs.length).toBe(1);
    });

    it("sweeps stale rolls while rotating", () => {
      const stale = join(tmpDir, "proxy.log.2020-01-01.gz");
      writeFileSync(stale, "old");
      setMtimeDaysAgo(stale, 30);
      const fresh = join(tmpDir, "proxy.log");
      writeFileSync(fresh, "yesterday\n");
      setMtimeDaysAgo(fresh, 1);
      expect(rotateLogIfNeeded(fresh, { retentionDays: 7 })).toBe(true);
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

    it("deletes buggy same-day `.N.gz` artifacts once they age out", () => {
      // Simulates the v0.1.10 bug where the size-cap fired multiple times
      // per day. The new sweep does not discriminate by suffix — it just
      // ages out the artifact when it crosses the retention window.
      const buggy1 = join(tmpDir, "bridge.log.2020-01-01.1.gz");
      const buggy45 = join(tmpDir, "bridge.log.2020-01-01.45.gz");
      writeFileSync(buggy1, "old");
      writeFileSync(buggy45, "old");
      setMtimeDaysAgo(buggy1, 30);
      setMtimeDaysAgo(buggy45, 30);
      expect(sweepRotatedLogs(tmpDir, 7)).toBe(2);
      expect(existsSync(buggy1)).toBe(false);
      expect(existsSync(buggy45)).toBe(false);
    });

    it("never touches canonical live files", () => {
      const live = join(tmpDir, "proxy.log");
      writeFileSync(live, "live");
      setMtimeDaysAgo(live, 30);
      expect(sweepRotatedLogs(tmpDir, 7)).toBe(0);
      expect(existsSync(live)).toBe(true);
    });

    it("reclaims orphaned `.rotating-*` temp slots older than an hour", () => {
      // The 8.8 GB orphan: a crashed/OOM'd roll left its temp behind and
      // nothing ever swept it. A real roll finishes in seconds, so an
      // hour-old temp is unambiguously orphaned.
      const orphan = join(tmpDir, "bridge.log.rotating-94108-1779734773663");
      writeFileSync(orphan, "leaked bytes");
      setMtimeDaysAgo(orphan, 1);
      expect(sweepRotatedLogs(tmpDir, 7)).toBe(1);
      expect(existsSync(orphan)).toBe(false);
    });

    it("leaves a fresh in-flight `.rotating-*` temp alone", () => {
      // A temp from a roll happening right now must survive the sweep.
      const inflight = join(tmpDir, "bridge.log.rotating-12345-1779734773663");
      writeFileSync(inflight, "in flight");
      // mtime = now (fresh)
      expect(sweepRotatedLogs(tmpDir, 7)).toBe(0);
      expect(existsSync(inflight)).toBe(true);
    });

    it("uses 7-day default retention", () => {
      const old = join(tmpDir, "proxy.log.2020-01-01.gz");
      writeFileSync(old, "old");
      setMtimeDaysAgo(old, DEFAULT_RETENTION_DAYS + 1);
      expect(sweepRotatedLogs(tmpDir)).toBe(1);
    });
  });

  describe("rotateLogIfNeeded — temp hygiene", () => {
    it("leaves no `.rotating-*` temp behind after a successful roll", () => {
      const p = join(tmpDir, "proxy.log");
      writeFileSync(p, "yesterday\n");
      setMtimeDaysAgo(p, 1);
      expect(rotateLogIfNeeded(p)).toBe(true);
      const temps = readdirSync(tmpDir).filter((n) => /\.rotating-/.test(n));
      expect(temps).toEqual([]);
    });
  });

  describe("module constants", () => {
    it("exposes the default retention window", () => {
      expect(DEFAULT_RETENTION_DAYS).toBe(7);
    });
  });
});
