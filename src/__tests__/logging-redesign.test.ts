import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("log-paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-log-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.UNERR_SID = undefined;
    vi.resetModules();
  });

  describe("getOrCreateSid", () => {
    it("generates a 6-char base32 sid when UNERR_SID is absent", async () => {
      vi.resetModules();
      process.env.UNERR_SID = undefined;
      const { getOrCreateSid } = await import("../utils/log-paths.js");
      const sid = getOrCreateSid();
      expect(sid).toMatch(/^[a-z0-9]{6}$/);
    });

    it("publishes the generated sid to process.env for child inheritance", async () => {
      vi.resetModules();
      process.env.UNERR_SID = undefined;
      const { getOrCreateSid } = await import("../utils/log-paths.js");
      const sid = getOrCreateSid();
      expect(process.env.UNERR_SID).toBe(sid);
    });

    it("reuses UNERR_SID from the environment when valid", async () => {
      vi.resetModules();
      process.env.UNERR_SID = "ab12cd";
      const { getOrCreateSid } = await import("../utils/log-paths.js");
      expect(getOrCreateSid()).toBe("ab12cd");
    });

    it("ignores malformed UNERR_SID and generates a fresh one", async () => {
      vi.resetModules();
      process.env.UNERR_SID = "NOT-VALID-SID";
      const { getOrCreateSid } = await import("../utils/log-paths.js");
      const sid = getOrCreateSid();
      expect(sid).toMatch(/^[a-z0-9]{6}$/);
      expect(sid).not.toBe("NOT-VALID-SID");
    });

    it("returns the same value on repeated calls", async () => {
      vi.resetModules();
      process.env.UNERR_SID = undefined;
      const { getOrCreateSid } = await import("../utils/log-paths.js");
      expect(getOrCreateSid()).toBe(getOrCreateSid());
    });
  });

  describe("cleanupLegacyLogs", () => {
    it("removes mcp-<pid>.log files", async () => {
      const dir = join(tmpDir, "logs");
      mkdirSync(dir);
      writeFileSync(join(dir, "mcp-1234.log"), "x");
      writeFileSync(join(dir, "mcp-99999.log"), "x");
      writeFileSync(join(dir, "proxy.log"), "keep");

      const { cleanupLegacyLogs } = await import("../utils/log-paths.js");
      const removed = cleanupLegacyLogs(dir);

      expect(removed).toBe(2);
      expect(existsSync(join(dir, "mcp-1234.log"))).toBe(false);
      expect(existsSync(join(dir, "mcp-99999.log"))).toBe(false);
      expect(existsSync(join(dir, "proxy.log"))).toBe(true);
    });

    it("removes child-<pid>.log files", async () => {
      const dir = join(tmpDir, "logs");
      mkdirSync(dir);
      writeFileSync(join(dir, "child-321.log"), "x");
      writeFileSync(join(dir, "proxy.log"), "keep");

      const { cleanupLegacyLogs } = await import("../utils/log-paths.js");
      cleanupLegacyLogs(dir);

      expect(existsSync(join(dir, "child-321.log"))).toBe(false);
      expect(existsSync(join(dir, "proxy.log"))).toBe(true);
    });

    it("removes timestamped session logs but keeps canonical session.log", async () => {
      const dir = join(tmpDir, "logs");
      mkdirSync(dir);
      writeFileSync(join(dir, "session-2026-05-18-205326.log"), "x");
      writeFileSync(join(dir, "session-2025-12-01-000000.log.1"), "x");
      writeFileSync(join(dir, "session.log"), "keep");

      const { cleanupLegacyLogs } = await import("../utils/log-paths.js");
      cleanupLegacyLogs(dir);

      expect(existsSync(join(dir, "session-2026-05-18-205326.log"))).toBe(
        false
      );
      expect(existsSync(join(dir, "session-2025-12-01-000000.log.1"))).toBe(
        false
      );
      expect(existsSync(join(dir, "session.log"))).toBe(true);
    });

    it("removes unerr.jsonl, *.pre-sqlite.bak, and unerrd.boot.log", async () => {
      const dir = join(tmpDir, "logs");
      mkdirSync(dir);
      writeFileSync(join(dir, "unerr.jsonl"), "x");
      writeFileSync(join(dir, "compression.jsonl.pre-sqlite.bak"), "x");
      writeFileSync(join(dir, "unerrd.boot.log"), "x");
      writeFileSync(join(dir, "events.jsonl"), "keep");

      const { cleanupLegacyLogs } = await import("../utils/log-paths.js");
      cleanupLegacyLogs(dir);

      expect(existsSync(join(dir, "unerr.jsonl"))).toBe(false);
      expect(existsSync(join(dir, "compression.jsonl.pre-sqlite.bak"))).toBe(
        false
      );
      expect(existsSync(join(dir, "unerrd.boot.log"))).toBe(false);
      expect(existsSync(join(dir, "events.jsonl"))).toBe(true);
    });

    it("returns 0 on a non-existent directory without throwing", async () => {
      const { cleanupLegacyLogs } = await import("../utils/log-paths.js");
      expect(cleanupLegacyLogs(join(tmpDir, "does-not-exist"))).toBe(0);
    });

    it("leaves canonical files alone", async () => {
      const dir = join(tmpDir, "logs");
      mkdirSync(dir);
      const canonical = [
        "proxy.log",
        "bridge.log",
        "session.log",
        "events.jsonl",
        "unerrd.log",
        "proxy.log.1",
      ];
      for (const f of canonical) writeFileSync(join(dir, f), "keep");

      const { cleanupLegacyLogs } = await import("../utils/log-paths.js");
      cleanupLegacyLogs(dir);

      const remaining = readdirSync(dir);
      expect(remaining.sort()).toEqual([...canonical].sort());
    });
  });

  describe("cleanupLegacyStateArtefacts", () => {
    it("removes state/*.pre-sqlite.bak and the legacy sessions/ dir", async () => {
      const unerrDir = join(tmpDir, ".unerr");
      const stateDir = join(unerrDir, "state");
      const sessionsDir = join(unerrDir, "sessions");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(stateDir, "session-history.json.pre-sqlite.bak"), "x");
      writeFileSync(join(stateDir, "metrics.json.pre-sqlite.bak"), "y");
      writeFileSync(join(stateDir, "proxy.pid"), "123"); // canonical — keep
      writeFileSync(join(sessionsDir, "abc.jsonl"), "{}");

      const { cleanupLegacyStateArtefacts } = await import(
        "../utils/log-paths.js"
      );
      const removed = cleanupLegacyStateArtefacts(unerrDir);

      // 2 bak files + 1 sessions dir
      expect(removed).toBe(3);
      expect(
        existsSync(join(stateDir, "session-history.json.pre-sqlite.bak"))
      ).toBe(false);
      expect(existsSync(join(stateDir, "metrics.json.pre-sqlite.bak"))).toBe(
        false
      );
      expect(existsSync(join(stateDir, "proxy.pid"))).toBe(true);
      expect(existsSync(sessionsDir)).toBe(false);
    });

    it("is a no-op when nothing legacy is present", async () => {
      const unerrDir = join(tmpDir, ".unerr");
      mkdirSync(join(unerrDir, "state"), { recursive: true });
      writeFileSync(join(unerrDir, "state", "proxy.pid"), "1");

      const { cleanupLegacyStateArtefacts } = await import(
        "../utils/log-paths.js"
      );
      expect(cleanupLegacyStateArtefacts(unerrDir)).toBe(0);
      expect(existsSync(join(unerrDir, "state", "proxy.pid"))).toBe(true);
    });

    it("tolerates a missing .unerr dir", async () => {
      const { cleanupLegacyStateArtefacts } = await import(
        "../utils/log-paths.js"
      );
      expect(cleanupLegacyStateArtefacts(join(tmpDir, "nope", ".unerr"))).toBe(
        0
      );
    });

    it("removes a leftover facts.db (+ -wal/-shm siblings)", async () => {
      const unerrDir = join(tmpDir, ".unerr");
      mkdirSync(unerrDir, { recursive: true });
      writeFileSync(join(unerrDir, "facts.db"), "x");
      writeFileSync(join(unerrDir, "facts.db-wal"), "y");
      writeFileSync(join(unerrDir, "facts.db-shm"), "z");
      writeFileSync(join(unerrDir, "graph.db"), "keep"); // canonical — keep

      const { cleanupLegacyStateArtefacts } = await import(
        "../utils/log-paths.js"
      );
      const removed = cleanupLegacyStateArtefacts(unerrDir);

      expect(removed).toBe(3);
      expect(existsSync(join(unerrDir, "facts.db"))).toBe(false);
      expect(existsSync(join(unerrDir, "facts.db-wal"))).toBe(false);
      expect(existsSync(join(unerrDir, "facts.db-shm"))).toBe(false);
      expect(existsSync(join(unerrDir, "graph.db"))).toBe(true);
    });

    it("removes metrics.db from both <unerrDir> and <unerrDir>/logs", async () => {
      const unerrDir = join(tmpDir, ".unerr");
      const logsDir = join(unerrDir, "logs");
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(join(unerrDir, "metrics.db"), "root");
      writeFileSync(join(logsDir, "metrics.db"), "logs");
      writeFileSync(join(logsDir, "proxy.log"), "keep"); // canonical — keep

      const { cleanupLegacyStateArtefacts } = await import(
        "../utils/log-paths.js"
      );
      const removed = cleanupLegacyStateArtefacts(unerrDir);

      expect(removed).toBe(2);
      expect(existsSync(join(unerrDir, "metrics.db"))).toBe(false);
      expect(existsSync(join(logsDir, "metrics.db"))).toBe(false);
      expect(existsSync(join(logsDir, "proxy.log"))).toBe(true);
    });
  });

  describe("sweepStaleScipIntermediates", () => {
    const HOUR_MS = 3_600_000;

    function scipFile(unerrDir: string, name: string, ageMs: number): string {
      const dir = join(unerrDir, "scip");
      mkdirSync(dir, { recursive: true });
      const p = join(dir, name);
      writeFileSync(p, "x");
      if (ageMs > 0) {
        const t = (Date.now() - ageMs) / 1000;
        utimesSync(p, t, t);
      }
      return p;
    }

    it("deletes *.scip intermediates older than the age gate", async () => {
      const unerrDir = join(tmpDir, ".unerr");
      const stale = scipFile(unerrDir, "index.scip", 3 * HOUR_MS);
      const { sweepStaleScipIntermediates } = await import(
        "../utils/log-paths.js"
      );
      expect(sweepStaleScipIntermediates(unerrDir)).toBe(1);
      expect(existsSync(stale)).toBe(false);
    });

    it("spares a freshly-emitted .scip that may still be merging", async () => {
      const unerrDir = join(tmpDir, ".unerr");
      const fresh = scipFile(unerrDir, "index.scip", 0); // just written
      const { sweepStaleScipIntermediates } = await import(
        "../utils/log-paths.js"
      );
      expect(sweepStaleScipIntermediates(unerrDir)).toBe(0);
      expect(existsSync(fresh)).toBe(true);
    });

    it("ignores non-.scip files in the scip dir", async () => {
      const unerrDir = join(tmpDir, ".unerr");
      const dir = join(unerrDir, "scip");
      mkdirSync(dir, { recursive: true });
      const keep = join(dir, "manifest.json");
      writeFileSync(keep, "{}");
      utimesSync(keep, 1, 1); // ancient
      const { sweepStaleScipIntermediates } = await import(
        "../utils/log-paths.js"
      );
      expect(sweepStaleScipIntermediates(unerrDir)).toBe(0);
      expect(existsSync(keep)).toBe(true);
    });

    it("tolerates a missing scip dir", async () => {
      const { sweepStaleScipIntermediates } = await import(
        "../utils/log-paths.js"
      );
      expect(sweepStaleScipIntermediates(join(tmpDir, ".unerr"))).toBe(0);
    });
  });

  describe("repoLog / globalLog path helpers", () => {
    it("returns canonical per-repo paths", async () => {
      const { repoLog } = await import("../utils/log-paths.js");
      expect(repoLog.proxy("/r")).toBe("/r/.unerr/logs/proxy.log");
      expect(repoLog.bridge("/r")).toBe("/r/.unerr/logs/bridge.log");
      expect(repoLog.session("/r")).toBe("/r/.unerr/logs/session.log");
      expect(repoLog.events("/r")).toBe("/r/.unerr/logs/events.jsonl");
    });

    it("returns canonical global paths", async () => {
      const { globalLog } = await import("../utils/log-paths.js");
      expect(globalLog.unerrd("/g")).toBe("/g/logs/unerrd.log");
      expect(globalLog.events("/g")).toBe("/g/logs/events.jsonl");
    });
  });
});
