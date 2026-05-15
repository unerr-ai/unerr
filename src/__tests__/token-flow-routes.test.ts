/**
 * Integration tests for token-flow API routes.
 * Tests all 6 endpoints against real data in `.unerr/metrics.db`
 * (token_flow_events table).
 */

import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createTokenFlowRoutes } from "../server/routes/token-flow.js";
import { readTokenFlowEvents } from "../tracking/token-flow.js";

const unerrDir = join(process.cwd(), ".unerr");

// Count raw events for validation — driven by the same reader the routes use.
// The routes strip "persistent_memory" events before aggregating (see
// stripPersistentMemory in src/server/routes/token-flow.ts), so we match that
// filter here to keep totals comparable.
function countRawEvents() {
  const events = readTokenFlowEvents(unerrDir).filter(
    (e) => e.mechanism !== "persistent_memory"
  );
  const sessions = new Set<string>();
  let saved = 0;
  let without = 0;
  let with_ = 0;
  for (const e of events) {
    sessions.add(e.session_id);
    saved += e.tokens_saved;
    without += e.tokens_without;
    with_ += e.tokens_with;
  }
  return { total: events.length, sessions, saved, without, with_ };
}

const hasData = countRawEvents().total > 0;

async function fetchRoute(
  app: ReturnType<typeof createTokenFlowRoutes>,
  path: string
) {
  const res = await app.fetch(new Request(`http://localhost${path}`));
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

describe.skipIf(!hasData)("token-flow API routes", () => {
  let app: ReturnType<typeof createTokenFlowRoutes>;
  let raw: ReturnType<typeof countRawEvents>;

  beforeAll(() => {
    app = createTokenFlowRoutes({ unerrDir, getTokenFlowWriter: () => null });
    raw = countRawEvents();
  });

  describe("GET /global", () => {
    it("returns aggregate KPIs across all sessions", async () => {
      const { status, json } = await fetchRoute(app, "/global");
      expect(status).toBe(200);
      const d = json.data as Record<string, unknown>;

      expect(d.total_sessions).toBe(raw.sessions.size);
      expect(d.event_count).toBe(raw.total);
      expect(d.total_tokens_saved).toBe(raw.saved);
      expect(d.total_tokens_without).toBe(raw.without);
      expect(d.total_tokens_with).toBe(raw.with_);
      expect(d.efficiency_pct).toBe(
        Math.round((raw.saved / raw.without) * 100)
      );
    });

    it("mechanism percentages sum to ~100", async () => {
      const { json } = await fetchRoute(app, "/global");
      const mechs = (json.data as Record<string, unknown>)
        .by_mechanism as Record<
        string,
        { pct_of_total: number; event_count: number }
      >;
      const pctSum = Object.values(mechs).reduce(
        (s, m) => s + m.pct_of_total,
        0
      );
      expect(pctSum).toBeGreaterThanOrEqual(98);
      expect(pctSum).toBeLessThanOrEqual(102);
    });

    it("mechanism event counts sum to total", async () => {
      const { json } = await fetchRoute(app, "/global");
      const mechs = (json.data as Record<string, unknown>)
        .by_mechanism as Record<string, { event_count: number }>;
      const evtSum = Object.values(mechs).reduce(
        (s, m) => s + m.event_count,
        0
      );
      expect(evtSum).toBe(raw.total);
    });
  });

  describe("GET /sessions", () => {
    it("lists all unique sessions sorted by recency", async () => {
      const { status, json } = await fetchRoute(app, "/sessions");
      expect(status).toBe(200);
      const sessions = json.data as Array<{
        session_id: string;
        event_count: number;
        total_saved: number;
        last_ts: string;
        mechanisms: string[];
      }>;

      expect(sessions.length).toBe(raw.sessions.size);

      // Event counts sum to total
      const evtSum = sessions.reduce((s, x) => s + x.event_count, 0);
      expect(evtSum).toBe(raw.total);

      // Saved sums match
      const savedSum = sessions.reduce((s, x) => s + x.total_saved, 0);
      expect(savedSum).toBe(raw.saved);

      // Sorted descending by last_ts
      for (let i = 1; i < sessions.length; i++) {
        expect(sessions[i]!.last_ts <= sessions[i - 1]!.last_ts).toBe(true);
      }

      // Each session has mechanisms
      for (const s of sessions) {
        expect(s.mechanisms.length).toBeGreaterThan(0);
      }
    });
  });

  describe("GET /session", () => {
    it("returns current session summary when no session_id param", async () => {
      const { status, json } = await fetchRoute(app, "/session");
      expect(status).toBe(200);
      // With no writer, it picks the most recent session from disk
      const d = json.data as Record<string, unknown> | null;
      // Could be null if aggregation yields 0 (unlikely with real data)
      if (d) {
        expect(d.session_id).toBeDefined();
        expect(typeof d.total_tokens_saved).toBe("number");
        expect(typeof d.efficiency_pct).toBe("number");
        expect(d.by_mechanism).toBeDefined();
      }
    });

    it("returns specific session when session_id param provided", async () => {
      // Get first session ID from /sessions
      const { json: sessionsJson } = await fetchRoute(app, "/sessions");
      const sessions = sessionsJson.data as Array<{
        session_id: string;
        event_count: number;
      }>;
      const targetId = sessions[sessions.length - 1]!.session_id; // oldest session
      const expectedEvents = sessions[sessions.length - 1]!.event_count;

      const { status, json } = await fetchRoute(
        app,
        `/session?session_id=${targetId}`
      );
      expect(status).toBe(200);
      const d = json.data as Record<string, unknown>;
      expect(d).not.toBeNull();
      expect(d.session_id).toBe(targetId);
      expect(d.event_count).toBe(expectedEvents);
      expect(typeof d.total_tokens_saved).toBe("number");
      expect(d.total_tokens_saved as number).toBeGreaterThan(0);
    });
  });

  describe("GET /cumulative", () => {
    it("returns monotonically increasing cumulative data", async () => {
      const { json: sessionsJson } = await fetchRoute(app, "/sessions");
      const sessions = sessionsJson.data as Array<{ session_id: string }>;
      const targetId = sessions[0]!.session_id;

      const { status, json } = await fetchRoute(
        app,
        `/cumulative?session_id=${targetId}`
      );
      expect(status).toBe(200);

      const turns = json.data as CumulativeTurn[];
      expect(turns.length).toBeGreaterThan(0);

      // Monotonically non-decreasing
      for (let i = 1; i < turns.length; i++) {
        expect(turns[i]!.cumulative_tokens_saved).toBeGreaterThanOrEqual(
          turns[i - 1]!.cumulative_tokens_saved
        );
      }

      // Last cumulative equals total_saved
      expect(turns[turns.length - 1]!.cumulative_tokens_saved).toBe(
        json.total_saved
      );

      // Each turn has events and tools array
      for (const t of turns) {
        expect(t.event_count).toBeGreaterThan(0);
        expect(Array.isArray(t.tools)).toBe(true);
        expect(typeof t.tokens_saved_this_turn).toBe("number");
        expect(typeof t.mechanisms_this_turn).toBe("object");
        expect(typeof t.cumulative_by_mechanism).toBe("object");
      }
    });
  });

  describe("GET /events", () => {
    it("filters by session_id and turn", async () => {
      const { json: sessionsJson } = await fetchRoute(app, "/sessions");
      const sessions = sessionsJson.data as Array<{ session_id: string }>;
      const targetId = sessions[0]!.session_id;

      const { status, json } = await fetchRoute(
        app,
        `/events?session_id=${targetId}&turn=0`
      );
      expect(status).toBe(200);
      const evts = json.data as TokenFlowEvent[];
      expect(evts.length).toBeGreaterThan(0);

      for (const e of evts) {
        expect(e.session_id).toBe(targetId);
        expect(e.turn).toBe(0);
        expect(typeof e.tokens_saved).toBe("number");
        expect(typeof e.tokens_without).toBe("number");
        expect(typeof e.tokens_with).toBe("number");
        expect(typeof e.mechanism).toBe("string");
        expect(typeof e.ts).toBe("string");
      }
    });

    it("filters by mechanism", async () => {
      const { status, json } = await fetchRoute(
        app,
        "/events?mechanism=graph_query"
      );
      expect(status).toBe(200);
      const evts = json.data as TokenFlowEvent[];
      for (const e of evts) {
        expect(e.mechanism).toBe("graph_query");
      }
    });
  });

  describe("cross-endpoint consistency", () => {
    it("global totals match sum of all session totals", async () => {
      const { json: globalJson } = await fetchRoute(app, "/global");
      const g = globalJson.data as {
        total_tokens_saved: number;
        total_sessions: number;
      };

      const { json: sessionsJson } = await fetchRoute(app, "/sessions");
      const sessions = sessionsJson.data as Array<{ total_saved: number }>;

      const sessionSavedSum = sessions.reduce((s, x) => s + x.total_saved, 0);
      expect(sessionSavedSum).toBe(g.total_tokens_saved);
    });

    it("session detail matches session list entry", async () => {
      const { json: sessionsJson } = await fetchRoute(app, "/sessions");
      const sessions = sessionsJson.data as Array<{
        session_id: string;
        event_count: number;
        total_saved: number;
      }>;

      for (const s of sessions) {
        const { json } = await fetchRoute(
          app,
          `/session?session_id=${s.session_id}`
        );
        const d = json.data as {
          event_count: number;
          total_tokens_saved: number;
        } | null;
        if (d) {
          expect(d.event_count).toBe(s.event_count);
          expect(d.total_tokens_saved).toBe(s.total_saved);
        }
      }
    });
  });
});

// Type stubs for test assertions
interface CumulativeTurn {
  turn: number;
  tools: string[];
  tokens_saved_this_turn: number;
  cumulative_tokens_saved: number;
  mechanisms_this_turn: Record<string, number>;
  cumulative_by_mechanism: Record<string, number>;
  event_count: number;
}

interface TokenFlowEvent {
  id: number;
  ts: string;
  pid: number;
  turn: number;
  mechanism: string;
  tool: string | null;
  tokens_without: number;
  tokens_with: number;
  tokens_saved: number;
  session_id: string;
}
