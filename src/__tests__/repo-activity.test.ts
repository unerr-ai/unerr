import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// emitRepoRemoved does a one-shot cloud drain after spooling. Stub the reporter
// so the test never touches the network (a logged-in dev machine would push for
// real otherwise); the spool we assert on still runs against the real metrics.db.
vi.mock("../daemon/push-reporter.js", () => ({
  PushReporter: class {
    drainRepoNow(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { emitRepoRemoved } from "../cloud/repo-removal.js";
import { openMetricsStore } from "../tracking/metrics-store.js";
import {
  emitRepoActivity,
  recordRepoActivity,
} from "../tracking/repo-activity.js";
import {
  type ProfileGraph,
  buildRepoProfile,
} from "../tracking/repo-profile.js";

/**
 * A fake graph store with just the two methods buildRepoProfile reads. `stats`
 * and `domains` are injectable so each test pins exactly what the graph returns.
 */
function fakeGraph(opts: {
  stats?: Partial<{
    entityCount: number;
    edgeCount: number;
    fileCount: number;
    ruleCount: number;
    driftCount: number;
    languageBreakdown: Record<string, number>;
  }>;
  statsThrows?: boolean;
  domains?: string[];
  domainsThrows?: boolean;
}): ProfileGraph {
  return {
    getLocalProjectStats() {
      if (opts.statsThrows)
        return Promise.reject(new Error("graph rebuilding"));
      return Promise.resolve({
        entityCount: 0,
        edgeCount: 0,
        fileCount: 0,
        ruleCount: 0,
        driftCount: 0,
        languageBreakdown: {},
        ...opts.stats,
      });
    },
    query() {
      if (opts.domainsThrows)
        return Promise.reject(new Error("no domain graph"));
      const rows = (opts.domains ?? []).map((d, i) => [d, 100 - i]);
      return Promise.resolve({ rows });
    },
  };
}

describe("buildRepoProfile", () => {
  it("maps graph stats + collapses extensions to language labels", async () => {
    const graph = fakeGraph({
      stats: {
        entityCount: 1200,
        edgeCount: 3400,
        fileCount: 210,
        ruleCount: 14,
        driftCount: 2,
        languageBreakdown: { ts: 150, tsx: 30, js: 20, other: 999, py: 5 },
      },
      domains: ["cloud", "intelligence"],
    });
    const profile = await buildRepoProfile(graph, {
      factCount: 7,
      indexedAt: "2026-06-15T11:00:00.000Z",
    });

    expect(profile.entity_count).toBe(1200);
    expect(profile.edge_count).toBe(3400);
    expect(profile.file_count).toBe(210);
    expect(profile.convention_count).toBe(14);
    expect(profile.drift_count).toBe(2);
    expect(profile.fact_count).toBe(7);
    expect(profile.indexed_at).toBe("2026-06-15T11:00:00.000Z");
    // ts(150)+tsx(30)=180 typescript first, js(20) second, py(5) third; `other` dropped.
    expect(profile.languages).toEqual(["typescript", "javascript", "python"]);
    expect(profile.top_domains).toEqual(["cloud", "intelligence"]);
  });

  it("omits languages when only extensionless files exist", async () => {
    const graph = fakeGraph({
      stats: { fileCount: 3, languageBreakdown: { other: 3 } },
    });
    const profile = await buildRepoProfile(graph);
    expect(profile.languages).toBeUndefined();
  });

  it("degrades to an empty profile when the graph is not ready", async () => {
    const graph = fakeGraph({ statsThrows: true, domainsThrows: true });
    const profile = await buildRepoProfile(graph);
    expect(profile).toEqual({});
  });

  it("keeps stats even when the domain query throws", async () => {
    const graph = fakeGraph({
      stats: { entityCount: 5 },
      domainsThrows: true,
    });
    const profile = await buildRepoProfile(graph);
    expect(profile.entity_count).toBe(5);
    expect(profile.top_domains).toBeUndefined();
  });
});

describe("recordRepoActivity / emitRepoActivity (metrics.db round-trip)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repo-activity-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Read one row back through a fresh read-only connection (db is private). */
  function readRow(id: number): Record<string, unknown> {
    const db = new Database(join(dir, "metrics.db"), { readonly: true });
    try {
      return db
        .prepare("SELECT * FROM repo_activity_events WHERE id = ?")
        .get(id) as Record<string, unknown>;
    } finally {
      db.close();
    }
  }

  it("spools a row and returns a non-zero rowid", () => {
    const store = openMetricsStore(dir);
    const id = recordRepoActivity(store, "removed", {
      sessionId: "sess_x",
      agent: "claude-code",
    });
    expect(id).toBeGreaterThan(0);

    const row = readRow(id);
    expect(row.action).toBe("removed");
    expect(row.agent).toBe("claude-code");
    expect(row.session_id).toBe("sess_x");
    expect(row.profile).toBeNull();
  });

  it("emitRepoActivity attaches a profile for `started`", async () => {
    const store = openMetricsStore(dir);
    const graph = fakeGraph({
      stats: { entityCount: 42, languageBreakdown: { ts: 10 } },
      domains: ["cloud"],
    });
    const id = await emitRepoActivity(store, "started", {
      graph,
      extras: { factCount: 3 },
      context: { sessionId: "sess_y" },
    });
    expect(id).toBeGreaterThan(0);

    const row = readRow(id);
    expect(row.action).toBe("started");
    const profile = JSON.parse(row.profile as string);
    expect(profile.entity_count).toBe(42);
    expect(profile.languages).toEqual(["typescript"]);
    expect(profile.top_domains).toEqual(["cloud"]);
    expect(profile.fact_count).toBe(3);
  });

  it("emitRepoActivity omits the profile for non-profile actions", async () => {
    const store = openMetricsStore(dir);
    const graph = fakeGraph({ stats: { entityCount: 9 } });
    const id = await emitRepoActivity(store, "agent_attached", {
      graph,
      context: { sessionId: "sess_z", agent: "cursor" },
    });
    const row = readRow(id);
    expect(row.action).toBe("agent_attached");
    expect(row.profile).toBeNull();
  });
});

describe("emitRepoRemoved (spool + final drain)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "repo-removed-"));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("spools a `removed` row under <repo>/.unerr even when logged out", async () => {
    // Logged out: the final drain no-ops (no credentials), but the row must
    // still be spooled so it ships on the next login / drain.
    await emitRepoRemoved(repoDir);

    const db = new Database(join(repoDir, ".unerr", "metrics.db"), {
      readonly: true,
    });
    try {
      const row = db
        .prepare(
          "SELECT * FROM repo_activity_events WHERE action = 'removed' ORDER BY id DESC LIMIT 1"
        )
        .get() as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row?.action).toBe("removed");
      expect(row?.profile).toBeNull();
    } finally {
      db.close();
    }
  });

  it("never throws when the repo .unerr is already gone", async () => {
    const gone = join(tmpdir(), "repo-removed-missing-does-not-exist-xyz");
    await expect(emitRepoRemoved(gone)).resolves.toBeUndefined();
  });
});
