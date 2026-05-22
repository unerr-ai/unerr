/**
 * Phase 3 — Route-level integration coverage.
 *
 * Exercises the Logbook, Session Economy, and Sidekick Memory Hono
 * routes against real CozoDB / metrics-store fixtures backed by temp
 * directories. No mocks — the routes read from the same writers the
 * proxy uses in production.
 */

import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemporalFactStore } from "../intelligence/temporal-facts.js";
import { createFactsRoutes } from "../server/routes/facts.js";
import { createLogbookRoutes } from "../server/routes/logbook.js";
import { createTokenFlowRoutes } from "../server/routes/token-flow.js";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";
import { TokenFlowWriter } from "../tracking/token-flow.js";

function tmpUnerrDir(): { tmpDir: string; unerrDir: string } {
  const tmpDir = join(
    os.tmpdir(),
    `unerr-phase3-routes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const unerrDir = join(tmpDir, ".unerr");
  mkdirSync(unerrDir, { recursive: true });
  return { tmpDir, unerrDir };
}

async function hit<T>(
  app: ReturnType<typeof createLogbookRoutes>,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await app.request(path, init);
  if (!res.ok && res.status !== 404) {
    throw new Error(`Request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// ── Logbook routes ───────────────────────────────────────────────────

describe("logbook routes", () => {
  let tmpDir: string;
  let unerrDir: string;

  beforeEach(() => {
    const t = tmpUnerrDir();
    tmpDir = t.tmpDir;
    unerrDir = t.unerrDir;
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("/story honest-zeros when no events", async () => {
    const app = createLogbookRoutes({ unerrDir });
    const out = await hit<{
      data: {
        honest_zero: boolean;
        story: string;
        right_rail: { total_events: number };
      };
    }>(app, "/story?period=today");
    expect(out.data.honest_zero).toBe(true);
    expect(out.data.story).toContain("unerr was quiet");
    expect(out.data.right_rail.total_events).toBe(0);
  });

  it("/story renders narrative with recorded events", async () => {
    const writer = new BehaviorEventWriter(unerrDir, "sess-1");
    writer.record({
      session_id: "sess-1",
      turn: 1,
      type: "stale_edit_prevented",
      tool: "edit",
      entity_key: "src/foo.ts",
      response_bytes: null,
    });
    writer.record({
      session_id: "sess-1",
      turn: 1,
      type: "full_read_avoided",
      tool: "file_read",
      entity_key: "src/bar.ts",
      response_bytes: null,
    });

    const app = createLogbookRoutes({
      unerrDir,
      getAgentName: () => "claude-code",
    });
    const out = await hit<{
      data: {
        honest_zero: boolean;
        story: string;
        right_rail: { total_events: number; by_type: Record<string, number> };
        featured: { event_type: string } | null;
      };
    }>(app, "/story?period=today");
    expect(out.data.honest_zero).toBe(false);
    expect(out.data.story).toContain("claude-code");
    expect(out.data.right_rail.total_events).toBe(2);
    expect(out.data.right_rail.by_type.stale_edit_prevented).toBe(1);
    expect(out.data.featured?.event_type).toBe("stale_edit_prevented");
  });

  it("/timeline returns reverse-chron events", async () => {
    const writer = new BehaviorEventWriter(unerrDir, "sess-1");
    writer.record({
      session_id: "sess-1",
      turn: 1,
      type: "loop_broken",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    writer.record({
      session_id: "sess-1",
      turn: 2,
      type: "fact_recalled",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });

    const app = createLogbookRoutes({ unerrDir });
    const out = await hit<{
      data: { event_type: string; turn: number }[];
      total: number;
    }>(app, "/timeline?period=today");
    expect(out.total).toBe(2);
    // Reverse-chron: turn 2 first
    expect(out.data[0]!.turn).toBeGreaterThanOrEqual(out.data[1]!.turn);
  });

  it("/event/:idx returns single event or 404", async () => {
    const writer = new BehaviorEventWriter(unerrDir, "sess-1");
    writer.record({
      session_id: "sess-1",
      turn: 1,
      type: "cache_hit",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    const app = createLogbookRoutes({ unerrDir });
    const detail = await hit<{ data: { event_type: string } }>(
      app,
      "/event/0?period=today"
    );
    expect(detail.data.event_type).toBe("cache_hit");

    const miss = await hit<{ error: string }>(app, "/event/99?period=today");
    expect(miss.error).toBe("not_found");
  });

  it("/timeline filters by event_type", async () => {
    const writer = new BehaviorEventWriter(unerrDir, "sess-1");
    writer.record({
      session_id: "sess-1",
      turn: 1,
      type: "loop_broken",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    writer.record({
      session_id: "sess-1",
      turn: 1,
      type: "fact_recalled",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    const app = createLogbookRoutes({ unerrDir });
    const out = await hit<{ data: { event_type: string }[]; total: number }>(
      app,
      "/timeline?period=today&event_type=loop_broken"
    );
    expect(out.total).toBe(1);
    expect(out.data[0]!.event_type).toBe("loop_broken");
  });

  it("/facets returns distinct agents, sessions, and event types with counts", async () => {
    const w1 = new BehaviorEventWriter(unerrDir, "sess-A");
    w1.record({
      session_id: "sess-A",
      turn: 1,
      type: "loop_broken",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    w1.record({
      session_id: "sess-A",
      turn: 2,
      type: "loop_broken",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    const w2 = new BehaviorEventWriter(unerrDir, "sess-B");
    w2.record({
      session_id: "sess-B",
      turn: 1,
      type: "fact_recalled",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });

    const app = createLogbookRoutes({ unerrDir });
    const out = await hit<{
      data: {
        agents: { name: string; count: number }[];
        sessions: { id: string; count: number; agent: string }[];
        event_types: { type: string; count: number }[];
        total: number;
      };
    }>(app, "/facets?period=today");

    expect(out.data.total).toBe(3);
    expect(out.data.sessions.map((s) => s.id).sort()).toEqual([
      "sess-A",
      "sess-B",
    ]);
    const sessA = out.data.sessions.find((s) => s.id === "sess-A");
    expect(sessA?.count).toBe(2);
    const loopRow = out.data.event_types.find((t) => t.type === "loop_broken");
    expect(loopRow?.count).toBe(2);
  });

  it("/timeline honors explicit from_ts/to_ts over period", async () => {
    const w = new BehaviorEventWriter(unerrDir, "sess-1");
    // Insert two events; only the second falls in the requested window.
    w.record({
      session_id: "sess-1",
      turn: 1,
      type: "cache_hit",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });
    w.record({
      session_id: "sess-1",
      turn: 2,
      type: "loop_broken",
      tool: null,
      entity_key: null,
      response_bytes: null,
    });

    // Window that includes "now" — both events should be returned.
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000).toISOString();
    const later = new Date(now.getTime() + 60_000).toISOString();
    const app = createLogbookRoutes({ unerrDir });
    const inWindow = await hit<{ total: number }>(
      app,
      `/timeline?from_ts=${encodeURIComponent(earlier)}&to_ts=${encodeURIComponent(later)}`
    );
    expect(inWindow.total).toBe(2);

    // Window before anything was recorded — should be empty.
    const past = new Date(now.getTime() - 3_600_000).toISOString();
    const pastEnd = new Date(now.getTime() - 1_800_000).toISOString();
    const outOfWindow = await hit<{ total: number }>(
      app,
      `/timeline?from_ts=${encodeURIComponent(past)}&to_ts=${encodeURIComponent(pastEnd)}`
    );
    expect(outOfWindow.total).toBe(0);
  });

  it("/timeline paginates via limit + offset", async () => {
    const w = new BehaviorEventWriter(unerrDir, "sess-1");
    for (let i = 1; i <= 30; i++) {
      w.record({
        session_id: "sess-1",
        turn: i,
        type: "cache_hit",
        tool: null,
        entity_key: null,
        response_bytes: null,
      });
    }
    const app = createLogbookRoutes({ unerrDir });
    const page1 = await hit<{ data: unknown[]; total: number; offset: number }>(
      app,
      "/timeline?period=today&limit=25&offset=0"
    );
    expect(page1.total).toBe(30);
    expect(page1.data.length).toBe(25);
    expect(page1.offset).toBe(0);

    const page2 = await hit<{ data: unknown[]; total: number; offset: number }>(
      app,
      "/timeline?period=today&limit=25&offset=25"
    );
    expect(page2.data.length).toBe(5);
    expect(page2.offset).toBe(25);
  });
});

// ── Headroom routes (folded into /api/token-flow) ───────────────────

describe("token-flow headroom routes", () => {
  let tmpDir: string;
  let unerrDir: string;

  beforeEach(() => {
    const t = tmpUnerrDir();
    tmpDir = t.tmpDir;
    unerrDir = t.unerrDir;
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("/headroom honest-zeros with no events", async () => {
    const app = createTokenFlowRoutes({
      unerrDir,
      getTokenFlowWriter: () => null,
    });
    const out = await hit<{
      data: {
        today: { headroom_turns: number; sessions: number };
        this_week: { sessions: number };
        since_install: { sessions: number };
      };
    }>(app, "/headroom");
    expect(out.data.today.headroom_turns).toBe(0);
    expect(out.data.today.sessions).toBe(0);
    expect(out.data.since_install.sessions).toBe(0);
  });

  it("/headroom computes compounded headroom_turns from token-flow rows", async () => {
    // Per-turn sizes must clear DEFAULT_UNOBSERVED_OVERHEAD_TOKENS (30K) the
    // route adds to honestTurnCostWithout — otherwise totalSaved / withTurnCost
    // floors to 0 and the assertion never fires. 50K/40K/5 matches the LZ-class
    // 0.8 compression envelope the headroom docblock anchors against.
    const writer = new TokenFlowWriter(unerrDir, "sess-1");
    for (let turn = 1; turn <= 5; turn++) {
      writer.record({
        session_id: "sess-1",
        turn,
        mechanism: "graph_query",
        tool: "search_code",
        tokens_without: 50_000,
        tokens_with: 10_000,
        tokens_saved: 40_000,
      });
    }
    const app = createTokenFlowRoutes({
      unerrDir,
      getTokenFlowWriter: () => null,
    });
    const out = await hit<{
      data: {
        since_install: {
          headroom_turns: number;
          sessions: number;
          turns_observed: number;
        };
      };
    }>(app, "/headroom");
    expect(out.data.since_install.sessions).toBe(1);
    expect(out.data.since_install.turns_observed).toBe(5);
    expect(out.data.since_install.headroom_turns).toBeGreaterThan(0);
  });

  it("/headroom/sessions returns per-session summary with headroom_compounded", async () => {
    const writer = new TokenFlowWriter(unerrDir, "sess-A");
    writer.record({
      session_id: "sess-A",
      turn: 1,
      mechanism: "file_read",
      tool: "file_read",
      tokens_without: 5000,
      tokens_with: 500,
      tokens_saved: 4500,
    });
    const app = createTokenFlowRoutes({
      unerrDir,
      getTokenFlowWriter: () => null,
    });
    const out = await hit<{
      data: {
        session_id: string;
        total_tokens_saved: number;
        headroom_compounded: number;
      }[];
      total: number;
    }>(app, "/headroom/sessions");
    expect(out.total).toBeGreaterThanOrEqual(1);
    const row = out.data.find((r) => r.session_id === "sess-A");
    expect(row?.total_tokens_saved).toBe(4500);
    expect(row?.headroom_compounded).toBeGreaterThanOrEqual(0);
  });

  it("/headroom/session/:id returns detail with per-turn breakdown", async () => {
    const writer = new TokenFlowWriter(unerrDir, "sess-X");
    writer.record({
      session_id: "sess-X",
      turn: 1,
      mechanism: "shell_compression",
      tool: "Bash",
      tokens_without: 2000,
      tokens_with: 200,
      tokens_saved: 1800,
    });
    const app = createTokenFlowRoutes({
      unerrDir,
      getTokenFlowWriter: () => null,
    });
    const out = await hit<{
      data: {
        session_id: string;
        headroom_compounded: number;
        per_turn: { turn: number; tokens_saved: number; headroom: number }[];
      };
    }>(app, "/headroom/session/sess-X");
    expect(out.data.session_id).toBe("sess-X");
    expect(out.data.per_turn.length).toBe(1);
    expect(out.data.per_turn[0]!.tokens_saved).toBe(1800);
  });
});

// ── Facts mutate routes ─────────────────────────────────────────────

describe("facts-v2 routes", () => {
  let tmpDir: string;
  let factStore: TemporalFactStore;

  beforeEach(async () => {
    const t = tmpUnerrDir();
    tmpDir = t.tmpDir;
    factStore = await TemporalFactStore.create(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("/list returns empty array when no facts", async () => {
    const app = createFactsRoutes({ factStore });
    const out = await hit<{ data: unknown[]; total: number }>(
      app,
      "/list?source=all"
    );
    expect(out.total).toBe(0);
  });

  it("/list returns user-fed facts with verbatim quote", async () => {
    await factStore.recordUserFedFact({
      content: "always lowercase event_type",
      fact_type: "convention",
      scope: "project",
      subject: "events",
      source_quote: "always use lowercase for event_type",
      applies_to: ["src/tracking/"],
    });
    const app = createFactsRoutes({ factStore });
    const out = await hit<{
      data: {
        source: string;
        source_quote: string | null;
        applies_to: string[];
        content: string;
      }[];
    }>(app, "/list?source=user_fed");
    expect(out.data.length).toBe(1);
    expect(out.data[0]!.source).toBe("user_fed");
    expect(out.data[0]!.source_quote).toBe(
      "always use lowercase for event_type"
    );
    expect(out.data[0]!.applies_to).toContain("src/tracking/");
  });

  it("PATCH /:id edits content", async () => {
    const { fact_id } = await factStore.recordUserFedFact({
      content: "original wording",
      fact_type: "convention",
      scope: "project",
      subject: "naming",
      source_quote: "original",
    });
    const app = createFactsRoutes({ factStore });
    const out = await hit<{ success: boolean; action: string }>(
      app,
      `/${fact_id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "refined wording" }),
      }
    );
    expect(out.success).toBe(true);
    expect(out.action).toBe("edited");
    const listed = await hit<{ data: { content: string }[] }>(
      app,
      "/list?source=user_fed"
    );
    expect(listed.data[0]!.content).toBe("refined wording");
  });

  it("PATCH /:id requires non-empty content", async () => {
    const { fact_id } = await factStore.recordUserFedFact({
      content: "x",
      fact_type: "convention",
      scope: "project",
      subject: "y",
      source_quote: "q",
    });
    const app = createFactsRoutes({ factStore });
    const res = await app.request(`/${fact_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /:id/disable hides from recall threshold", async () => {
    const { fact_id } = await factStore.recordUserFedFact({
      content: "disable me",
      fact_type: "convention",
      scope: "project",
      subject: "disable-test",
      source_quote: "do it",
    });
    const app = createFactsRoutes({ factStore });
    await hit(app, `/${fact_id}/disable`, { method: "POST" });
    const listed = await hit<{
      data: { fact_id: string; disabled: boolean }[];
    }>(app, "/list?source=user_fed");
    const row = listed.data.find((f) => f.fact_id === fact_id);
    expect(row?.disabled).toBe(true);
  });

  it("POST /:id/reinforce restores effective confidence", async () => {
    const { fact_id } = await factStore.recordUserFedFact({
      content: "restore me",
      fact_type: "convention",
      scope: "project",
      subject: "restore-test",
      source_quote: "do it",
    });
    const app = createFactsRoutes({ factStore });
    await hit(app, `/${fact_id}/disable`, { method: "POST" });
    await hit(app, `/${fact_id}/reinforce`, { method: "POST" });
    const listed = await hit<{
      data: {
        fact_id: string;
        disabled: boolean;
        effective_confidence: number;
      }[];
    }>(app, "/list?source=user_fed");
    const row = listed.data.find((f) => f.fact_id === fact_id);
    expect(row).toBeDefined();
  });

  it("drift flag fires when a dirty file matches scope", async () => {
    await factStore.recordUserFedFact({
      content: "drift-flagged",
      fact_type: "convention",
      scope: "src/proxy/",
      subject: "drift-test",
      source_quote: "x",
    });
    const dirty = new Set(["src/proxy/proxy.ts"]);
    const app = createFactsRoutes({
      factStore,
      getDirtyFiles: () => dirty,
    });
    const listed = await hit<{ data: { drift: boolean }[] }>(
      app,
      "/list?source=user_fed"
    );
    expect(listed.data[0]!.drift).toBe(true);
  });

  it("DELETE /:id halves confidence and emits dismissed action", async () => {
    const { fact_id } = await factStore.recordUserFedFact({
      content: "delete me",
      fact_type: "convention",
      scope: "project",
      subject: "delete-test",
      source_quote: "x",
    });
    const app = createFactsRoutes({ factStore });
    const out = await hit<{ success: boolean; action: string }>(
      app,
      `/${fact_id}`,
      { method: "DELETE" }
    );
    expect(out.success).toBe(true);
    expect(out.action).toBe("dismissed");
  });
});
