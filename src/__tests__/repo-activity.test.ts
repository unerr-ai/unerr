import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// emitRepoRemoved does a one-shot cloud drain after spooling. Stub the reporter
// so the test never touches the network (a logged-in dev machine would push for
// real otherwise); the spool we assert on still runs against the real JSONL
// event store.
vi.mock("../daemon/push-reporter.js", () => ({
  PushReporter: class {
    drainRepoNow(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { emitRepoRemoved } from "../cloud/sync/repo-removal.js";
import {
  type RepoActivityEventRow,
  openMetricsStore,
} from "../tracking/metrics-store.js";
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

describe("recordRepoActivity / emitRepoActivity (JSONL round-trip)", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    // MetricsStore writes its JSONL store to dirname(dir)/.unerr/events, so the
    // store dir must be nested as `<uniqueRoot>/.unerr` to keep each test's
    // repo_activity rows isolated from siblings sharing os.tmpdir().
    root = mkdtempSync(join(tmpdir(), "repo-activity-"));
    dir = join(root, ".unerr");
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Read the latest repo_activity row back through the JSONL store. */
  function readRow(): RepoActivityEventRow {
    const rows = openMetricsStore(dir).recentRepoActivity(1);
    return rows[0] as RepoActivityEventRow;
  }

  it("spools a row and returns a non-zero rowid", () => {
    const store = openMetricsStore(dir);
    const id = recordRepoActivity(store, "removed", {
      sessionId: "sess_x",
      agent: "claude-code",
    });
    expect(id).toBeGreaterThan(0);

    const row = readRow();
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

    const row = readRow();
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
    const row = readRow();
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

    const store = openMetricsStore(join(repoDir, ".unerr"));
    const row = store
      .recentRepoActivity(10)
      .find((r) => r.action === "removed");
    expect(row).toBeDefined();
    expect(row?.action).toBe("removed");
    expect(row?.profile).toBeNull();
  });

  it("never throws when the repo .unerr is already gone", async () => {
    const gone = join(tmpdir(), "repo-removed-missing-does-not-exist-xyz");
    await expect(emitRepoRemoved(gone)).resolves.toBeUndefined();
  });
});
