/**
 * Verifies the /reasoning-quality routes surface persistent-memory metrics
 * derived from token-flow events with mechanism: "persistent_memory".
 */

import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReasoningQualityRoutes } from "../server/routes/reasoning-quality.js";
import { PersistenceEffectivenessTracker } from "../tracking/persistence-effectiveness.js";
import { TokenFlowWriter } from "../tracking/token-flow.js";

async function getGlobal(
  app: ReturnType<typeof createReasoningQualityRoutes>,
): Promise<Record<string, unknown>> {
  const res = await app.fetch(new Request("http://localhost/global"));
  const body = (await res.json()) as { data: Record<string, unknown> };
  return body.data;
}

describe("reasoning-quality route — persistent memory metrics", () => {
  let tmpDir: string;
  let unerrDir: string;
  let writer: TokenFlowWriter;
  let tracker: PersistenceEffectivenessTracker;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-rq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    unerrDir = join(tmpDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
    writer = new TokenFlowWriter(unerrDir, "rq-session");
    tracker = new PersistenceEffectivenessTracker(writer, { windowTurns: 3 });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zero memory metrics when no persistent_memory events exist", async () => {
    writer.record({
      session_id: "rq-session",
      turn: 1,
      mechanism: "graph_query",
      tool: "search_code",
      tokens_without: 1000,
      tokens_with: 200,
      tokens_saved: 800,
    });
    const app = createReasoningQualityRoutes({
      unerrDir,
      getTokenFlowWriter: () => writer,
    });
    const data = await getGlobal(app);
    expect(data.memory_signals_fired).toBe(0);
    expect(data.memory_verdicts_total).toBe(0);
    expect(data.memory_effectiveness_pct).toBe(0);
  });

  it("computes effectiveness when verdicts resolve", async () => {
    // 1 reinforced (re-fired + no correction)
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "f-reinforced",
      entity_key: "EntityR",
      turn: 1,
    });
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "f-reinforced",
      entity_key: "EntityR",
      turn: 2,
    });

    // 1 acted_on (edit observed + no correction)
    tracker.recordSignalFired({
      kind: "convention_injected",
      signal_id: "c-acted",
      entity_key: "EntityA",
      turn: 1,
    });
    tracker.recordEdit("EntityA");

    // 1 caught (negative warning + no correction)
    tracker.recordSignalFired({
      kind: "negative_warned",
      signal_id: "n-caught",
      entity_key: "EntityN",
      turn: 1,
    });

    // 1 corrected (signal fired + correction observed)
    tracker.recordSignalFired({
      kind: "convention_injected",
      signal_id: "c-corrected",
      entity_key: "EntityX",
      turn: 1,
    });
    tracker.recordCorrection("EntityX", "circuit_breaker");

    // 1 ignored
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "f-ignored",
      entity_key: "EntityI",
      turn: 1,
    });

    // 1 resume + 1 fact_recalled — verdict counts
    tracker.recordSignalFired({
      kind: "resume_injected",
      signal_id: "resume-1",
      entity_key: null,
      turn: 1,
    });
    tracker.recordSignalFired({
      kind: "fact_recalled",
      signal_id: "r-1",
      entity_key: "EntityRec",
      turn: 1,
    });
    tracker.recordSignalFired({
      kind: "fact_recorded",
      signal_id: "rec-1",
      entity_key: "EntitySub",
      turn: 1,
    });

    tracker.closeWindow(10);

    const app = createReasoningQualityRoutes({
      unerrDir,
      getTokenFlowWriter: () => writer,
    });
    const data = await getGlobal(app);

    // Fired counts by kind
    expect(data.facts_surfaced).toBe(2); // f-reinforced, f-ignored
    expect(data.facts_recalled).toBe(1);
    expect(data.facts_recorded).toBe(1);
    expect(data.conventions_surfaced).toBe(2);
    expect(data.resume_hits).toBe(1);
    expect(data.negative_warnings).toBe(1);
    expect(data.memory_signals_fired).toBe(8);

    // Verdict tallies (8 total verdicts after closeWindow)
    expect(data.verdicts_reinforced).toBe(1);
    expect(data.verdicts_acted_on).toBe(1);
    expect(data.verdicts_caught).toBe(1);
    expect(data.verdicts_corrected).toBe(1);
    expect(data.verdicts_ignored).toBe(4); // c-acted no-edit-target, others with no signals
    expect(data.memory_verdicts_total).toBe(8);

    // Effectiveness = (reinforced + acted_on + caught) / total = 3/8 = 38%
    expect(data.memory_effectiveness_pct).toBe(38);
  });
});
