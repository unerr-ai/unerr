import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistenceEffectivenessTracker } from "../tracking/persistence-effectiveness.js";
import {
  TokenFlowWriter,
  readTokenFlowEvents,
} from "../tracking/token-flow.js";

interface VerdictDetail {
  kind?: string;
  verdict?: string;
  signal_id?: string;
  entity_key?: string | null;
}

function verdicts(unerrDir: string): VerdictDetail[] {
  return readTokenFlowEvents(unerrDir)
    .filter((e) => e.mechanism === "persistent_memory")
    .map((e) => (e.detail ?? {}) as VerdictDetail);
}

describe("PersistenceEffectivenessTracker", () => {
  let tmpDir: string;
  let unerrDir: string;
  let writer: TokenFlowWriter;
  let tracker: PersistenceEffectivenessTracker;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-eff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    unerrDir = join(tmpDir, ".unerr");
    mkdirSync(unerrDir, { recursive: true });
    writer = new TokenFlowWriter(unerrDir, "test-session");
    tracker = new PersistenceEffectivenessTracker(writer, { windowTurns: 5 });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits a fired verdict when a signal first fires", () => {
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "fact-1",
      entity_key: "EntityA",
      turn: 1,
    });
    const v = verdicts(unerrDir);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("fact_injected");
    expect(v[0]?.verdict).toBe("fired");
    expect(v[0]?.signal_id).toBe("fact-1");
  });

  it("re-firing within window counts as a reinforcement, not a new fired event", () => {
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "fact-1",
      entity_key: "EntityA",
      turn: 1,
    });
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "fact-1",
      entity_key: "EntityA",
      turn: 2,
    });
    const fired = verdicts(unerrDir).filter((v) => v.verdict === "fired");
    expect(fired).toHaveLength(1);
  });

  it("classifies a re-fired signal with no correction as reinforced on close", () => {
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "fact-1",
      entity_key: "EntityA",
      turn: 1,
    });
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "fact-1",
      entity_key: "EntityA",
      turn: 2,
    });
    tracker.closeWindow(7);
    const resolved = verdicts(unerrDir).find(
      (v) => v.verdict === "reinforced",
    );
    expect(resolved?.signal_id).toBe("fact-1");
  });

  it("classifies as acted_on when entity received an edit and no correction", () => {
    tracker.recordSignalFired({
      kind: "convention_injected",
      signal_id: "conv-1",
      entity_key: "EntityB",
      turn: 1,
    });
    tracker.recordEdit("EntityB");
    tracker.closeWindow(7);
    const resolved = verdicts(unerrDir).find(
      (v) => v.verdict === "acted_on",
    );
    expect(resolved?.signal_id).toBe("conv-1");
  });

  it("classifies as corrected when a correction fires for the entity", () => {
    tracker.recordSignalFired({
      kind: "convention_injected",
      signal_id: "conv-2",
      entity_key: "EntityC",
      turn: 1,
    });
    tracker.recordEdit("EntityC");
    tracker.recordCorrection("EntityC", "circuit_breaker");
    tracker.closeWindow(7);
    const resolved = verdicts(unerrDir).find(
      (v) => v.verdict === "corrected",
    );
    expect(resolved?.signal_id).toBe("conv-2");
  });

  it("classifies negative_warned with no correction as caught", () => {
    tracker.recordSignalFired({
      kind: "negative_warned",
      signal_id: "neg-1",
      entity_key: "EntityD",
      turn: 1,
    });
    tracker.closeWindow(7);
    const resolved = verdicts(unerrDir).find(
      (v) => v.verdict === "caught",
    );
    expect(resolved?.signal_id).toBe("neg-1");
  });

  it("classifies as ignored when nothing happens in the window", () => {
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "fact-99",
      entity_key: "EntityZ",
      turn: 1,
    });
    tracker.closeWindow(7);
    const resolved = verdicts(unerrDir).find((v) => v.verdict === "ignored");
    expect(resolved?.signal_id).toBe("fact-99");
  });

  it("does not close windows still inside the K-turn observation period", () => {
    tracker.recordSignalFired({
      kind: "fact_injected",
      signal_id: "fact-young",
      entity_key: null,
      turn: 5,
    });
    tracker.closeWindow(7); // delta 2 < 5
    expect(tracker.openCount()).toBe(1);
    expect(
      verdicts(unerrDir).filter((v) => v.verdict !== "fired"),
    ).toHaveLength(0);
  });

  it("closeAll forces verdicts regardless of turn distance", () => {
    tracker.recordSignalFired({
      kind: "resume_injected",
      signal_id: "session-X",
      entity_key: null,
      turn: 50,
    });
    tracker.closeAll(50);
    expect(tracker.openCount()).toBe(0);
    const resolved = verdicts(unerrDir).filter(
      (v) => v.signal_id === "session-X" && v.verdict !== "fired",
    );
    expect(resolved).toHaveLength(1);
  });
});
