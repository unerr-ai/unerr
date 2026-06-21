/**
 * §7 PromptTrace assembler + route — verifies the prompt-centric spine joins
 * the two halves of a prompt's story:
 *   • unerr-only half (savings, mechanisms, tools, files, drift, reasoning)
 *     is ALWAYS present, sourced from token_flow_events + behavior_events.
 *   • external transcript half (tokens_used) is gated: off by default, and
 *     degrades fail-soft to null when the flag is off or no transcript matches.
 *
 * Populates a real metrics store via the production writers, then asserts the
 * assembled trace — no mocking of the read path.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PromptTraceRouteDeps,
  assemblePromptTrace,
  createPromptTraceRoutes,
} from "../server/routes/prompt-trace.js";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";
import { TokenFlowWriter } from "../tracking/token-flow.js";

let repoCwd: string;
let unerrDir: string;
const SID = "sess-trace";
const TURN = 5;

function seedEvents(): void {
  const tf = new TokenFlowWriter(unerrDir, SID, { agent: "claude-code" });
  // Two savings events on TURN 5; one earlier turn that must NOT bleed in.
  tf.record({
    session_id: SID,
    turn: TURN,
    mechanism: "graph_query",
    tool: "search_code",
    tokens_without: 2000,
    tokens_with: 800,
    tokens_saved: 1200,
  });
  tf.record({
    session_id: SID,
    turn: TURN,
    mechanism: "file_read",
    tool: "file_read",
    tokens_without: 3000,
    tokens_with: 1000,
    tokens_saved: 2000,
  });
  tf.record({
    session_id: SID,
    turn: TURN + 1,
    mechanism: "graph_query",
    tool: "get_entity",
    tokens_without: 500,
    tokens_with: 100,
    tokens_saved: 400, // different turn — excluded
  });

  const beh = new BehaviorEventWriter(unerrDir, SID, { agent: "claude-code" });
  beh.record({
    session_id: SID,
    turn: TURN,
    type: "user_prompt_received",
    tool: null,
    entity_key: null,
    response_bytes: null,
    detail: {
      prompt: "fix the cursor install deleting the mdc",
      length: 39,
      classified_as: "fix",
    },
  });
  beh.record({
    session_id: SID,
    turn: TURN,
    type: "stale_edit_prevented",
    tool: "Edit",
    entity_key: "src/commands/install.ts",
    response_bytes: null,
  });
  beh.record({
    session_id: SID,
    turn: TURN,
    type: "graph_query_served",
    tool: "search_code",
    entity_key: "src/config/agent-registry.ts",
    response_bytes: 1024,
  });
}

beforeEach(() => {
  repoCwd = join(
    tmpdir(),
    `unerr-pt-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  unerrDir = join(repoCwd, ".unerr");
  mkdirSync(unerrDir, { recursive: true });
  seedEvents();
});

afterEach(() => {
  try {
    closeMetricsStore(unerrDir);
  } catch {
    /* ignore */
  }
  try {
    rmSync(repoCwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function deps(
  getAgentName?: (s: string) => string | undefined
): PromptTraceRouteDeps {
  return {
    unerrDir,
    repoCwd,
    getAgentName: getAgentName ?? (() => "claude-code"),
  };
}

describe("assemblePromptTrace — unerr-only half (always present)", () => {
  it("aggregates savings, mechanisms, tools, files, drift scoped to the turn", async () => {
    const trace = await assemblePromptTrace(deps(), SID, TURN);

    expect(trace.session_id).toBe(SID);
    expect(trace.turn).toBe(TURN);
    expect(trace.prompt?.prompt).toBe(
      "fix the cursor install deleting the mdc"
    );
    // Only the two TURN-5 token-flow events count; turn 6 is excluded.
    expect(trace.tokens_saved).toBe(3200);
    expect(trace.mechanisms.sort()).toEqual(["file_read", "graph_query"]);
    expect(trace.tools).toContain("search_code");
    expect(trace.tools).toContain("file_read");
    expect(trace.tools).not.toContain("get_entity"); // turn 6 tool
    expect(trace.files).toEqual(
      expect.arrayContaining([
        "src/commands/install.ts",
        "src/config/agent-registry.ts",
      ])
    );
    expect(trace.drift_caught).toBe(1); // stale_edit_prevented
    expect(trace.reasoning).toHaveProperty("noise_removed_pct");
    expect(trace.reasoning).toHaveProperty("first_call_resolution_rate");
    expect(trace.reasoning).toHaveProperty("turns_saved");
  });

  it("resolves the agent from getAgentName, then capability", async () => {
    const trace = await assemblePromptTrace(deps(), SID, TURN);
    expect(trace.agent).toBe("claude-code");
    expect(trace.capability).toBe("jsonl");
  });

  it("falls back to the token-flow agent when no resolver is wired", async () => {
    const trace = await assemblePromptTrace({ unerrDir, repoCwd }, SID, TURN);
    expect(trace.agent).toBe("claude-code");
  });
});

describe("assemblePromptTrace — external transcript half (gated)", () => {
  it("is on by default: no config → flag on, capability reported", async () => {
    // rev-3: transcript materialization is opt-OUT (default on), so an unset
    // flag means on. With no real agent JSONL under the temp repoCwd the reader
    // still finds nothing, so token usage stays null (fail-soft).
    const trace = await assemblePromptTrace(deps(), SID, TURN);
    expect(trace.flag_on).toBe(true);
    expect(trace.transcript_available).toBe(false);
    expect(trace.tokens_used).toBeNull();
    expect(trace.capability).toBe("jsonl");
  });

  it("is off only when explicitly opted out: flag false → no token usage", async () => {
    writeFileSync(
      join(unerrDir, "config.json"),
      JSON.stringify({ read_agent_transcripts: false })
    );
    const trace = await assemblePromptTrace(deps(), SID, TURN);
    expect(trace.flag_on).toBe(false);
    expect(trace.transcript_available).toBe(false);
    expect(trace.tokens_used).toBeNull();
    // capability is still surfaced so the UI can render an enable hint.
    expect(trace.capability).toBe("jsonl");
  });

  it("degrades fail-soft when flag is on but no transcript matches", async () => {
    writeFileSync(
      join(unerrDir, "config.json"),
      JSON.stringify({ read_agent_transcripts: true })
    );
    const trace = await assemblePromptTrace(deps(), SID, TURN);
    expect(trace.flag_on).toBe(true);
    // No real Claude JSONL under this temp repoCwd → reader returns nothing.
    expect(trace.transcript_available).toBe(false);
    expect(trace.tokens_used).toBeNull();
  });

  it("reports null capability for an agent with no reader", async () => {
    const trace = await assemblePromptTrace(
      deps(() => "vscode"),
      SID,
      TURN
    );
    expect(trace.capability).toBeNull();
    expect(trace.tokens_used).toBeNull();
  });
});

describe("createPromptTraceRoutes", () => {
  it("GET /:session/:turn returns the assembled trace", async () => {
    const app = createPromptTraceRoutes(deps());
    const res = await app.request(`/${SID}/${TURN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tokens_saved: number } };
    expect(body.data.tokens_saved).toBe(3200);
  });

  it("rejects a non-numeric turn with 400", async () => {
    const app = createPromptTraceRoutes(deps());
    const res = await app.request(`/${SID}/not-a-turn`);
    expect(res.status).toBe(400);
  });

  it("rejects a negative turn with 400", async () => {
    const app = createPromptTraceRoutes(deps());
    const res = await app.request(`/${SID}/-1`);
    expect(res.status).toBe(400);
  });
});
