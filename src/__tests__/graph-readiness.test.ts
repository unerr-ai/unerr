/**
 * Graph readiness — the filesystem-only predicate navigation hooks and the
 * per-repo proxy share to answer "does this repo have a graph worth steering
 * an agent toward?".
 *
 * Every reason code is exercised directly against `readGraphReadiness`
 * (no chdir needed — the module takes `cwd` explicitly), plus the
 * `publishGraphStats` -> `readGraphReadiness` round-trip the proxy relies on
 * after each index, and the best-effort degrade path when the write fails.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_USEFUL_ENTITIES,
  graphStatsPath,
  isGraphReady,
  publishGraphStats,
  readGraphReadiness,
} from "../intelligence/graph-readiness.js";

/** Write `.unerr/{config.json,graph.db,state/graph-stats.json}` fixtures.
 *  Passing `entities: undefined` (and no `statsRaw`) skips the stats file
 *  entirely (the "indexing" / never-published case); `statsRaw` writes
 *  malformed content instead of valid JSON; `skipStateDir` withholds
 *  `.unerr/state/` so a subsequent `publishGraphStats` write fails. */
function writeUnerrFixture(
  dir: string,
  opts: {
    config?: boolean;
    graphDb?: boolean;
    entities?: number;
    statsRaw?: string;
  }
): void {
  const unerrDir = path.join(dir, ".unerr");
  fs.mkdirSync(unerrDir, { recursive: true });
  if (opts.config !== false) {
    fs.writeFileSync(path.join(unerrDir, "config.json"), "{}");
  }
  if (opts.graphDb !== false) {
    fs.writeFileSync(path.join(unerrDir, "graph.db"), "");
  }
  if (opts.statsRaw !== undefined || opts.entities !== undefined) {
    fs.mkdirSync(path.join(unerrDir, "state"), { recursive: true });
    const raw =
      opts.statsRaw ??
      JSON.stringify({
        entities: opts.entities,
        edges: 10,
        rules: 1,
        indexedAt: new Date().toISOString(),
      });
    fs.writeFileSync(path.join(unerrDir, "state", "graph-stats.json"), raw);
  }
}

describe("graph-readiness", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-graph-readiness-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readGraphReadiness reason codes", () => {
    it('"no-config" — no .unerr/config.json at all', () => {
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: false,
        entities: null,
        reason: "no-config",
      });
    });

    it('"no-graph" — config.json exists, graph.db does not', () => {
      writeUnerrFixture(tmpDir, { config: true, graphDb: false });
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: false,
        entities: null,
        reason: "no-graph",
      });
    });

    it('"indexing" — config.json + graph.db exist, stats file missing', () => {
      writeUnerrFixture(tmpDir, { config: true, graphDb: true });
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: false,
        entities: null,
        reason: "indexing",
      });
    });

    it('"indexing" — stats file exists but is malformed JSON', () => {
      writeUnerrFixture(tmpDir, {
        config: true,
        graphDb: true,
        statsRaw: "{not json",
      });
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: false,
        entities: null,
        reason: "indexing",
      });
    });

    it('"indexing" — stats file has no numeric entities field', () => {
      writeUnerrFixture(tmpDir, {
        config: true,
        graphDb: true,
        statsRaw: JSON.stringify({ edges: 10, rules: 1 }),
      });
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: false,
        entities: null,
        reason: "indexing",
      });
    });

    it('"empty" — entities published below MIN_USEFUL_ENTITIES', () => {
      writeUnerrFixture(tmpDir, {
        config: true,
        graphDb: true,
        entities: MIN_USEFUL_ENTITIES - 1,
      });
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: false,
        entities: MIN_USEFUL_ENTITIES - 1,
        reason: "empty",
      });
    });

    it('"ready" — entities published at or above MIN_USEFUL_ENTITIES', () => {
      writeUnerrFixture(tmpDir, {
        config: true,
        graphDb: true,
        entities: MIN_USEFUL_ENTITIES + 500,
      });
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: true,
        entities: MIN_USEFUL_ENTITIES + 500,
        reason: "ready",
      });
    });

    it('"ready" — entities exactly at the MIN_USEFUL_ENTITIES floor', () => {
      writeUnerrFixture(tmpDir, {
        config: true,
        graphDb: true,
        entities: MIN_USEFUL_ENTITIES,
      });
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: true,
        entities: MIN_USEFUL_ENTITIES,
        reason: "ready",
      });
    });
  });

  describe("isGraphReady", () => {
    it("mirrors readGraphReadiness().ready in both directions", () => {
      writeUnerrFixture(tmpDir, {
        config: true,
        graphDb: true,
        entities: MIN_USEFUL_ENTITIES + 1,
      });
      expect(isGraphReady(tmpDir)).toBe(true);

      const belowDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "unerr-graph-readiness-below-")
      );
      try {
        writeUnerrFixture(belowDir, {
          config: true,
          graphDb: true,
          entities: MIN_USEFUL_ENTITIES - 1,
        });
        expect(isGraphReady(belowDir)).toBe(false);
      } finally {
        fs.rmSync(belowDir, { recursive: true, force: true });
      }
    });
  });

  describe("publishGraphStats -> readGraphReadiness round-trip", () => {
    // `.unerr/state/` is created by PidLock early in real proxy boot, well
    // before any index completes — pre-create it here so these tests exercise
    // a successful write, not the ENOENT degrade path (covered separately below).
    function ensureStateDir(dir: string): void {
      fs.mkdirSync(path.join(dir, ".unerr", "state"), { recursive: true });
    }

    it("publishing counts above threshold makes the graph ready", () => {
      writeUnerrFixture(tmpDir, { config: true, graphDb: true });
      ensureStateDir(tmpDir);
      const ok = publishGraphStats(tmpDir, {
        entities: MIN_USEFUL_ENTITIES + 100,
        edges: 500,
        rules: 5,
      });
      expect(ok).toBe(true);
      expect(fs.existsSync(graphStatsPath(tmpDir))).toBe(true);
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: true,
        entities: MIN_USEFUL_ENTITIES + 100,
        reason: "ready",
      });
    });

    it("publishing counts below threshold round-trips to not-ready (empty)", () => {
      writeUnerrFixture(tmpDir, { config: true, graphDb: true });
      ensureStateDir(tmpDir);
      const ok = publishGraphStats(tmpDir, { entities: 3, edges: 1, rules: 0 });
      expect(ok).toBe(true);
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: false,
        entities: 3,
        reason: "empty",
      });
    });

    it("writes indexedAt from the injected clock", () => {
      writeUnerrFixture(tmpDir, { config: true, graphDb: true });
      ensureStateDir(tmpDir);
      const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");
      publishGraphStats(
        tmpDir,
        { entities: MIN_USEFUL_ENTITIES + 1, edges: 1, rules: 0 },
        fixedNow
      );
      const raw = JSON.parse(
        fs.readFileSync(graphStatsPath(tmpDir), "utf-8")
      ) as { indexedAt: string };
      expect(raw.indexedAt).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("publish failure degrades safely", () => {
    it("returns false and leaves readers reporting 'indexing' when the write throws", () => {
      // config.json + graph.db exist, but .unerr/state/ was never created —
      // writeFileSync throws ENOENT. publishGraphStats must swallow it and
      // never throw into the caller (boot must never block or fail on this).
      writeUnerrFixture(tmpDir, { config: true, graphDb: true });
      expect(fs.existsSync(path.join(tmpDir, ".unerr", "state"))).toBe(false);

      let ok: boolean | undefined;
      expect(() => {
        ok = publishGraphStats(tmpDir, {
          entities: MIN_USEFUL_ENTITIES + 1,
          edges: 1,
          rules: 0,
        });
      }).not.toThrow();
      expect(ok).toBe(false);

      // Degrades to "indexing" — never a false "no-graph"/"empty" claim, and
      // never a thrown error propagated to the reader.
      expect(readGraphReadiness(tmpDir)).toEqual({
        ready: false,
        entities: null,
        reason: "indexing",
      });
    });
  });
});
