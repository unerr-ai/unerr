/**
 * UX-1 / UX-3: session_agents store + /agents route + /sessions agent_name.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTimelineRoutes } from "../server/routes/timeline.js";
import { CozoTimelineStore, type TurnRow } from "../timeline/timeline-store.js";

let tempDir: string;
let store: CozoTimelineStore;

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `unerr-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tempDir, ".unerr"), { recursive: true });
  store = await CozoTimelineStore.create(tempDir);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function turn(overrides: Partial<TurnRow> & { turn_id: string }): TurnRow {
  return {
    session_id: overrides.session_id ?? "s1",
    started_at: overrides.started_at ?? 1_000,
    ended_at: overrides.ended_at ?? 2_000,
    opened_by: overrides.opened_by ?? "first_call",
    closed_reason: overrides.closed_reason ?? "session_end",
    tool_count: overrides.tool_count ?? 3,
    file_count: overrides.file_count ?? 2,
    edit_count: overrides.edit_count ?? 1,
    title: overrides.title ?? "",
    outcome: overrides.outcome ?? "unknown",
    ...overrides,
  };
}

describe("session_agents store", () => {
  it("setSessionAgent / getSessionAgent round-trip", async () => {
    await store.setSessionAgent("sA", "claude-code", 1_000);
    expect(await store.getSessionAgent("sA")).toBe("claude-code");
    expect(await store.getSessionAgent("sB")).toBeNull();
  });

  it("setSessionAgent is a no-op for empty agent name", async () => {
    await store.setSessionAgent("sA", "", 1_000);
    expect(await store.getSessionAgent("sA")).toBeNull();
  });

  it("setSessionAgent preserves first_seen across refresh", async () => {
    await store.setSessionAgent("sA", "claude-code", 1_000);
    await store.setSessionAgent("sA", "claude-code", 5_000);
    const result = await store.getDb().run(
      `?[first_seen, last_seen] := *session_agents{session_id, first_seen, last_seen}, session_id = $sid`,
      { sid: "sA" },
    );
    const row = result.rows[0]!;
    expect(row[0]).toBe(1_000);
    expect(row[1]).toBe(5_000);
  });

  it("getSessionAgents batch lookup returns only requested ids", async () => {
    await store.setSessionAgent("sA", "claude-code", 1_000);
    await store.setSessionAgent("sB", "cursor", 2_000);
    await store.setSessionAgent("sC", "codex", 3_000);
    const map = await store.getSessionAgents(["sA", "sC"]);
    expect(map.get("sA")).toBe("claude-code");
    expect(map.get("sC")).toBe("codex");
    expect(map.has("sB")).toBe(false);
  });

  it("listAgents returns distinct agent names with session counts", async () => {
    await store.setSessionAgent("s1", "claude-code", 1_000);
    await store.setSessionAgent("s2", "claude-code", 2_000);
    await store.setSessionAgent("s3", "cursor", 3_000);
    const agents = await store.listAgents();
    const cc = agents.find((a) => a.agent_name === "claude-code")!;
    const cu = agents.find((a) => a.agent_name === "cursor")!;
    expect(cc.session_count).toBe(2);
    expect(cu.session_count).toBe(1);
    // Ordering: most-recently-seen first.
    expect(agents[0]?.agent_name).toBe("cursor");
  });

  it("listSessions joins agent_name onto each row", async () => {
    await store.upsertTurn(turn({ turn_id: "t1", session_id: "sa" }));
    await store.upsertTurn(turn({ turn_id: "t2", session_id: "sb", started_at: 2_000 }));
    await store.setSessionAgent("sa", "claude-code", 1_500);
    const list = await store.listSessions();
    const a = list.find((s) => s.session_id === "sa");
    const b = list.find((s) => s.session_id === "sb");
    expect(a?.agent_name).toBe("claude-code");
    expect(b?.agent_name).toBe("unknown");
  });
});

describe("HTTP routes — /agents + /sessions?agent=", () => {
  it("GET /agents returns the agent inventory", async () => {
    await store.setSessionAgent("s1", "claude-code", 1_000);
    await store.setSessionAgent("s2", "cursor", 2_000);
    const app = createTimelineRoutes({ store });
    const res = await app.request("/agents");
    const body = (await res.json()) as {
      data: Array<{ agent_name: string }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.data.map((a) => a.agent_name).sort()).toEqual([
      "claude-code",
      "cursor",
    ]);
  });

  it("GET /sessions?agent=claude-code filters by agent", async () => {
    await store.upsertTurn(turn({ turn_id: "t1", session_id: "sa" }));
    await store.upsertTurn(turn({ turn_id: "t2", session_id: "sb", started_at: 2_000 }));
    await store.setSessionAgent("sa", "claude-code", 1_500);
    await store.setSessionAgent("sb", "cursor", 2_500);
    const app = createTimelineRoutes({ store });
    const res = await app.request("/sessions?agent=cursor");
    const body = (await res.json()) as {
      data: Array<{ session_id: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.data[0]?.session_id).toBe("sb");
  });
});
