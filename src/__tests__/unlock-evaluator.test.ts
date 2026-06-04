/**
 * Sprint P0-2 — Unlock evaluator + JSONL persistence tests.
 *
 * Three concerns under test:
 *   1. `evaluateCondition` correctly handles every leaf variant and the
 *      And/Or composites — true cases, false cases, and the boundary
 *      values for ≥-style thresholds.
 *   2. `evaluateUnlocks` returns *only* newly-firing unlocks (monotonic),
 *      never re-emits a tool that the session already exposes, and
 *      attaches the human-readable reason text from describeCondition.
 *   3. `ToolExposureStore` writes one JSONL line per event, creates its
 *      directory lazily, round-trips records, and is robust to a missing
 *      file on first read.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionState } from "../proxy/session-state.js";
import { ToolExposureStore } from "../proxy/tool-exposure-store.js";
import { C } from "../proxy/tool-tiers.js";
import {
  type UnlockEvent,
  evaluateCondition,
  evaluateUnlocks,
} from "../proxy/unlock-evaluator.js";

describe("evaluateCondition: leaf variants", () => {
  it("UrTagEmitted — true when tag observed", () => {
    const s = new SessionState();
    s.recordCall({ toolName: "search_code", urTags: ["rsk"] });
    expect(evaluateCondition(C.urTag("rsk"), s)).toBe(true);
    expect(evaluateCondition(C.urTag("hnt"), s)).toBe(false);
  });

  it("EntityFanInAtLeast — boundary cases", () => {
    const s = new SessionState();
    s.recordCall({ toolName: "get_entity", entityFanIn: 9 });
    expect(evaluateCondition(C.fanIn(10), s)).toBe(false);
    s.recordCall({ toolName: "get_entity", entityFanIn: 10 });
    expect(evaluateCondition(C.fanIn(10), s)).toBe(true);
    expect(evaluateCondition(C.fanIn(11), s)).toBe(false);
  });

  it("FileImportCountAtLeast — boundary cases", () => {
    const s = new SessionState();
    s.recordCall({ toolName: "file_outline", fileImports: 4 });
    expect(evaluateCondition(C.imports(5), s)).toBe(false);
    s.recordCall({ toolName: "file_outline", fileImports: 5 });
    expect(evaluateCondition(C.imports(5), s)).toBe(true);
  });

  it("FilesInSameDirAtLeast — counts files under same parent dir", () => {
    const s = new SessionState();
    s.recordCall({ toolName: "file_read", filePath: "src/proxy/a.ts" });
    expect(evaluateCondition(C.sameDir(2), s)).toBe(false);
    s.recordCall({ toolName: "file_read", filePath: "src/proxy/b.ts" });
    expect(evaluateCondition(C.sameDir(2), s)).toBe(true);
  });

  it("TestFileAccessed — true once any test file seen", () => {
    const s = new SessionState();
    expect(evaluateCondition(C.testFile(), s)).toBe(false);
    s.recordCall({
      toolName: "file_read",
      filePath: "src/__tests__/x.test.ts",
      testFile: true,
    });
    expect(evaluateCondition(C.testFile(), s)).toBe(true);
  });

  it("FirstFileReadCompleted — true after one file accessed", () => {
    const s = new SessionState();
    expect(evaluateCondition(C.firstRead(), s)).toBe(false);
    s.recordCall({ toolName: "file_read", filePath: "src/a.ts" });
    expect(evaluateCondition(C.firstRead(), s)).toBe(true);
  });

  it("EditOrWriteAttempted — sticky true after first attempt", () => {
    const s = new SessionState();
    expect(evaluateCondition(C.editOrWrite(), s)).toBe(false);
    s.recordCall({ toolName: "file_read", editOrWrite: true });
    expect(evaluateCondition(C.editOrWrite(), s)).toBe(true);
  });

  it("FileReadTruncated — fires only on a truncated response", () => {
    const s = new SessionState();
    s.recordCall({ toolName: "file_read", fileReadTruncated: false });
    expect(evaluateCondition(C.readTruncated(), s)).toBe(false);
    s.recordCall({ toolName: "file_read", fileReadTruncated: true });
    expect(evaluateCondition(C.readTruncated(), s)).toBe(true);
  });

  it("IntentMarkerAtLeast — typed bucket counts", () => {
    const s = new SessionState();
    s.recordCall({ toolName: "mark_intent", intentMarker: "intent" });
    expect(evaluateCondition(C.intent("intent"), s)).toBe(true);
    expect(evaluateCondition(C.intent("decision"), s)).toBe(false);
    expect(evaluateCondition(C.intent("intent", 2), s)).toBe(false);
    s.recordCall({ toolName: "mark_intent", intentMarker: "intent" });
    expect(evaluateCondition(C.intent("intent", 2), s)).toBe(true);
  });

  it("ToolCallCountAtLeast — per-tool counter", () => {
    const s = new SessionState();
    s.recordCall({ toolName: "get_entity" });
    s.recordCall({ toolName: "get_entity" });
    expect(evaluateCondition(C.called("get_entity", 2), s)).toBe(true);
    expect(evaluateCondition(C.called("get_entity", 3), s)).toBe(false);
  });

  it("PriorSessionFactSurfaced — sticky true once seen", () => {
    const s = new SessionState();
    expect(evaluateCondition(C.priorFact(), s)).toBe(false);
    s.recordCall({
      toolName: "recall_facts",
      priorSessionFactSurfaced: true,
    });
    expect(evaluateCondition(C.priorFact(), s)).toBe(true);
  });

  it("SessionTurnsAtLeast — fires on turn boundary", () => {
    const s = new SessionState();
    expect(evaluateCondition(C.turns(3), s)).toBe(false);
    s.advanceTurn();
    s.advanceTurn();
    expect(evaluateCondition(C.turns(3), s)).toBe(false);
    s.advanceTurn();
    expect(evaluateCondition(C.turns(3), s)).toBe(true);
  });

  it("NonTrivialActionObserved — fires on edit/write OR ≥5 reads", () => {
    const editSession = new SessionState();
    editSession.recordCall({ toolName: "file_read", editOrWrite: true });
    expect(evaluateCondition(C.nonTrivial(), editSession)).toBe(true);

    const readSession = new SessionState();
    for (let i = 0; i < 5; i++) {
      readSession.recordCall({
        toolName: "file_read",
        filePath: `src/x/f${i}.ts`,
      });
    }
    expect(evaluateCondition(C.nonTrivial(), readSession)).toBe(true);
  });
});

describe("evaluateCondition: And/Or composites", () => {
  it("And — true only when every child true", () => {
    const s = new SessionState();
    s.advanceTurn();
    s.advanceTurn();
    s.advanceTurn();
    expect(evaluateCondition(C.and(C.turns(3), C.nonTrivial()), s)).toBe(false);
    s.recordCall({ toolName: "file_read", editOrWrite: true });
    expect(evaluateCondition(C.and(C.turns(3), C.nonTrivial()), s)).toBe(true);
  });

  it("Or — true when any child true", () => {
    const s = new SessionState();
    expect(evaluateCondition(C.or(C.urTag("hnt"), C.sameDir(2)), s)).toBe(
      false
    );
    s.recordCall({ toolName: "search_code", urTags: ["hnt"] });
    expect(evaluateCondition(C.or(C.urTag("hnt"), C.sameDir(2)), s)).toBe(true);
  });

  it("Empty And is vacuously true; empty Or is vacuously false", () => {
    const s = new SessionState();
    expect(evaluateCondition(C.and(), s)).toBe(true);
    expect(evaluateCondition(C.or(), s)).toBe(false);
  });
});

describe("evaluateUnlocks: only newly-firing tools", () => {
  it("returns empty when no condition has fired", () => {
    const s = new SessionState();
    expect(evaluateUnlocks(s)).toEqual([]);
  });

  it("emits one event per newly-satisfied policy", () => {
    // After the token-overhead catalog reduction, unerr_track is the SOLE
    // gated tool. Its policy is C.and(C.turns(3), C.nonTrivial()) — once
    // both children hold, exactly one unlock event fires.
    const s = new SessionState();
    s.advanceTurn();
    s.advanceTurn();
    s.advanceTurn();
    s.recordCall({ toolName: "file_read", editOrWrite: true });
    const events = evaluateUnlocks(s);
    const tools = events.map((e) => e.toolName).sort();
    expect(tools).toEqual(["unerr_track"]);
  });

  it("does not re-emit tools that are already exposed", () => {
    const s = new SessionState();
    s.expose(["unerr_track"]);
    s.advanceTurn();
    s.advanceTurn();
    s.advanceTurn();
    s.recordCall({ toolName: "file_read", editOrWrite: true });
    const events = evaluateUnlocks(s);
    expect(events.find((e) => e.toolName === "unerr_track")).toBeUndefined();
  });

  it("attaches a non-empty reason and the current turn", () => {
    const s = new SessionState();
    s.advanceTurn();
    s.advanceTurn();
    s.advanceTurn();
    s.recordCall({ toolName: "file_read", editOrWrite: true });
    const events = evaluateUnlocks(s);
    // unerr_track is the sole gated policy — fires once turns≥3 AND a
    // non-trivial action is observed. Any firing event has the standard shape.
    const event = events.find((e) => e.toolName === "unerr_track");
    expect(event).toBeDefined();
    expect(event?.reasonText.length).toBeGreaterThan(0);
    expect(event?.firedAtTurn).toBe(3);
    expect(event?.timestampMs).toBeGreaterThan(0);
  });

  it("compound unlocks fire only when every child condition holds", () => {
    // unerr_track: C.and(C.turns(3), C.nonTrivial())
    const s = new SessionState();
    s.advanceTurn();
    s.advanceTurn();
    s.recordCall({ toolName: "file_read", editOrWrite: true });
    // nonTrivial holds, but turns is only 2 — the compound must not fire.
    const before = evaluateUnlocks(s).map((e) => e.toolName);
    expect(before).not.toContain("unerr_track");

    s.advanceTurn();
    const after = evaluateUnlocks(s).map((e) => e.toolName);
    expect(after).toContain("unerr_track");
  });
});

describe("ToolExposureStore: JSONL persistence", () => {
  let dir: string;
  let store: ToolExposureStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unerr-router-test-"));
    store = new ToolExposureStore(dir, "session-abc");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sampleEvent = (name: string, turn: number): UnlockEvent => ({
    toolName: name,
    reasonText: "test reason",
    firedAtTurn: turn,
    timestampMs: 1_700_000_000_000,
  });

  it("writes nothing when called with an empty array", async () => {
    const written = await store.append([]);
    expect(written).toBe(0);
    const rows = await store.readAll();
    expect(rows).toEqual([]);
  });

  it("returns an empty list when the file does not yet exist", async () => {
    const rows = await store.readAll();
    expect(rows).toEqual([]);
  });

  it("writes one line per event with the documented record shape", async () => {
    const written = await store.append([
      sampleEvent("get_critical_nodes", 2),
      sampleEvent("get_imports", 2),
    ]);
    expect(written).toBeGreaterThan(0);

    const body = await readFile(
      join(dir, "router", "exposure-events.jsonl"),
      "utf8"
    );
    const lines = body.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string);
    expect(first).toMatchObject({
      v: 1,
      session_id: "session-abc",
      tool: "get_critical_nodes",
      reason: "test reason",
      turn: 2,
      ts: 1_700_000_000_000,
    });
  });

  it("round-trips records via readAll", async () => {
    await store.append([sampleEvent("get_critical_nodes", 1)]);
    await store.append([sampleEvent("get_imports", 2)]);
    const rows = await store.readAll();
    expect(rows.map((r) => r.tool)).toEqual([
      "get_critical_nodes",
      "get_imports",
    ]);
  });

  it("appends rather than truncates on subsequent calls", async () => {
    await store.append([sampleEvent("get_critical_nodes", 1)]);
    await store.append([sampleEvent("get_imports", 2)]);
    await store.append([sampleEvent("file_connections", 3)]);
    const rows = await store.readAll();
    expect(rows).toHaveLength(3);
    expect(rows[2]?.turn).toBe(3);
  });
});
