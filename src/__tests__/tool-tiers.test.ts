/**
 * Sprint P0-2 — Tier policy & SessionState tests.
 *
 * Three concerns under test:
 *   1. The unlock-policy table aligns with the tier registry — every
 *      tier-2/3 tool has a policy, every policy key is a known tool, no
 *      tier-1 tool carries a policy. (Module-load assertion in
 *      tool-tiers.ts already enforces this; the test pins the contract.)
 *   2. SessionState exposes tier-1 tools at construction and never
 *      removes anything from the exposed set ("monotonic surface").
 *   3. Signal accumulators behave correctly: max-trackers grow only,
 *      file-by-dir is bounded, intent-marker counts are typed, and the
 *      "non-trivial action" gate fires on the documented criteria.
 */

import { describe, expect, it } from "vitest";

import { extractSignals } from "../proxy/call-signals.js";
import { type CallSignals, SessionState } from "../proxy/session-state.js";
import { TIER_ENTRIES, toolsByTier } from "../proxy/tool-descriptions.js";
import {
  C,
  UNLOCK_CONDITIONS,
  describeCondition,
} from "../proxy/tool-tiers.js";
import { evaluateUnlocks } from "../proxy/unlock-evaluator.js";

describe("tool-tiers: UNLOCK_CONDITIONS alignment with TIER_ENTRIES", () => {
  it("has a policy for every tier 2/3 tool", () => {
    const tier23 = [...toolsByTier(2), ...toolsByTier(3)];
    for (const name of tier23) {
      expect(UNLOCK_CONDITIONS[name]).toBeDefined();
    }
  });

  it("has no policy for any tier 1 tool", () => {
    for (const name of toolsByTier(1)) {
      expect(UNLOCK_CONDITIONS[name]).toBeUndefined();
    }
  });

  it("never references a tool that is not in TIER_ENTRIES", () => {
    for (const name of Object.keys(UNLOCK_CONDITIONS)) {
      expect(TIER_ENTRIES[name]).toBeDefined();
    }
  });

  it("expected tier sizes — 11 / 8 / 6 (Tier 2 added review_changes — Surface C)", () => {
    expect(toolsByTier(1)).toHaveLength(11);
    expect(toolsByTier(2)).toHaveLength(8);
    expect(toolsByTier(3)).toHaveLength(6);
  });
});

describe("tool-tiers: C constructors round-trip describeCondition", () => {
  it("produces stable, non-empty descriptions for every variant", () => {
    const variants = [
      C.urTag("rsk"),
      C.fanIn(10),
      C.imports(5),
      C.sameDir(2),
      C.testFile(),
      C.firstRead(),
      C.editOrWrite(),
      C.readTruncated(),
      C.intent("intent"),
      C.intent("blocker", 2),
      C.called("get_entity", 3),
      C.priorFact(),
      C.turns(3),
      C.nonTrivial(),
      C.and(C.turns(3), C.nonTrivial()),
      C.or(C.urTag("hnt"), C.sameDir(2)),
    ];
    for (const v of variants) {
      const text = describeCondition(v);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("undefined");
    }
  });
});

describe("SessionState: tier 1 always exposed", () => {
  it("auto-exposes every tier 1 tool at construction", () => {
    const s = new SessionState();
    for (const name of toolsByTier(1)) {
      expect(s.isExposed(name)).toBe(true);
    }
    expect(s.exposedTools().size).toBe(toolsByTier(1).length);
  });

  it("does not expose any tier 2/3 tool at construction", () => {
    const s = new SessionState();
    for (const name of [...toolsByTier(2), ...toolsByTier(3)]) {
      expect(s.isExposed(name)).toBe(false);
    }
  });
});

describe("SessionState: monotonic exposure", () => {
  it("expose() adds new tools and returns the delta", () => {
    const s = new SessionState();
    const added = s.expose(["get_critical_nodes", "get_imports"]);
    expect(added).toEqual(["get_critical_nodes", "get_imports"]);
    expect(s.isExposed("get_critical_nodes")).toBe(true);
  });

  it("expose() filters tools that are already exposed", () => {
    const s = new SessionState();
    s.expose(["get_imports"]);
    const added = s.expose(["get_imports", "get_conventions"]);
    expect(added).toEqual(["get_conventions"]);
  });

  it("a tool, once exposed, stays exposed across many calls", () => {
    const s = new SessionState();
    s.expose(["get_critical_nodes"]);
    for (let i = 0; i < 50; i++) {
      s.recordCall({ toolName: "search_code" });
      s.advanceTurn();
    }
    expect(s.isExposed("get_critical_nodes")).toBe(true);
  });
});

describe("SessionState: signal accumulators", () => {
  const baseCall = (overrides: Partial<CallSignals> = {}): CallSignals => ({
    toolName: "search_code",
    ...overrides,
  });

  it("counts tool calls per name", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ toolName: "get_entity" }));
    s.recordCall(baseCall({ toolName: "get_entity" }));
    s.recordCall(baseCall({ toolName: "file_read" }));
    expect(s.toolCallCount("get_entity")).toBe(2);
    expect(s.toolCallCount("file_read")).toBe(1);
    expect(s.toolCallCount("never_called")).toBe(0);
  });

  it("tracks ur|tag emissions as a set", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ urTags: ["rsk", "hnt"] }));
    s.recordCall(baseCall({ urTags: ["rsk"] }));
    expect(s.hasUrTag("rsk")).toBe(true);
    expect(s.hasUrTag("hnt")).toBe(true);
    expect(s.hasUrTag("wrn")).toBe(false);
  });

  it("entity fan_in is max-tracked, not last-write-wins", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ entityFanIn: 15 }));
    s.recordCall(baseCall({ entityFanIn: 4 }));
    expect(s.maxEntityFanInSeen()).toBe(15);
  });

  it("file imports are max-tracked", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ fileImports: 7 }));
    s.recordCall(baseCall({ fileImports: 2 }));
    expect(s.maxFileImportsSeen()).toBe(7);
  });

  it("files-per-dir uses the immediate parent directory", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ filePath: "src/proxy/a.ts" }));
    s.recordCall(baseCall({ filePath: "src/proxy/b.ts" }));
    s.recordCall(baseCall({ filePath: "src/proxy/c.ts" }));
    s.recordCall(baseCall({ filePath: "src/intelligence/x.ts" }));
    expect(s.maxFilesPerDirSeen()).toBe(3);
  });

  it("repeats of the same file path do not double-count", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ filePath: "src/proxy/a.ts" }));
    s.recordCall(baseCall({ filePath: "src/proxy/a.ts" }));
    expect(s.filesAccessedCount()).toBe(1);
    expect(s.maxFilesPerDirSeen()).toBe(1);
  });

  it("test file flag is sticky", () => {
    const s = new SessionState();
    expect(s.testFileSeen()).toBe(false);
    s.recordCall(baseCall({ testFile: true }));
    s.recordCall(baseCall({ testFile: false }));
    expect(s.testFileSeen()).toBe(true);
  });

  it("edit/write flag is sticky", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ editOrWrite: true }));
    expect(s.editOrWriteAttempted()).toBe(true);
  });

  it("file_read truncation flag is sticky", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ fileReadTruncated: true }));
    expect(s.fileReadTruncatedSeen()).toBe(true);
  });

  it("prior-session fact flag is sticky", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ priorSessionFactSurfaced: true }));
    expect(s.priorSessionFactSurfaced()).toBe(true);
  });

  it("counts intent markers by typed bucket", () => {
    const s = new SessionState();
    s.recordCall(baseCall({ intentMarker: "intent" }));
    s.recordCall(baseCall({ intentMarker: "intent" }));
    s.recordCall(baseCall({ intentMarker: "blocker" }));
    expect(s.intentMarkerCount("intent")).toBe(2);
    expect(s.intentMarkerCount("blocker")).toBe(1);
    expect(s.intentMarkerCount("decision")).toBe(0);
  });

  it("turn counter increments on advanceTurn only", () => {
    const s = new SessionState();
    s.recordCall(baseCall());
    s.recordCall(baseCall());
    expect(s.turnCount()).toBe(0);
    s.advanceTurn();
    s.advanceTurn();
    expect(s.turnCount()).toBe(2);
  });
});

describe("SessionState: nonTrivialActionObserved gate", () => {
  it("is false on a fresh session", () => {
    expect(new SessionState().nonTrivialActionObserved()).toBe(false);
  });

  it("becomes true on any edit/write", () => {
    const s = new SessionState();
    s.recordCall({ toolName: "file_read", editOrWrite: true });
    expect(s.nonTrivialActionObserved()).toBe(true);
  });

  it("becomes true at five distinct file reads", () => {
    const s = new SessionState();
    for (let i = 0; i < 4; i++) {
      s.recordCall({ toolName: "file_read", filePath: `src/x/f${i}.ts` });
    }
    expect(s.nonTrivialActionObserved()).toBe(false);
    s.recordCall({ toolName: "file_read", filePath: "src/x/f4.ts" });
    expect(s.nonTrivialActionObserved()).toBe(true);
  });

  it("does not count file-path repeats toward the threshold", () => {
    const s = new SessionState();
    for (let i = 0; i < 10; i++) {
      s.recordCall({ toolName: "file_read", filePath: "src/x/same.ts" });
    }
    expect(s.nonTrivialActionObserved()).toBe(false);
  });
});

describe("A23 regression: get_file unlocks after file_read truncation", () => {
  // L-section testing flagged that calling `file_read` on a large file
  // produced a truncated response but the follow-up `get_file` call did
  // NOT unlock. This pins the full chain:
  //   extractSignals(file_read, meta.truncated=true)
  //     → SessionState.recordCall (sets fileReadTruncatedSeen)
  //     → evaluateUnlocks() lists `get_file` as newly unlocked.

  it("end-to-end: meta.truncated=true on file_read makes get_file unlock", () => {
    const s = new SessionState();
    expect(s.isExposed("get_file")).toBe(false);

    const signals = extractSignals("file_read", {
      args: { file_path: "src/proxy/proxy.ts" },
      content: { text: "<truncated body>" },
      meta: { truncated: true } as never,
    });
    expect(signals.fileReadTruncated).toBe(true);
    s.recordCall(signals);

    const unlocks = evaluateUnlocks(s);
    const unlockedNames = unlocks.map((u) => u.toolName);
    expect(unlockedNames).toContain("get_file");
  });

  it("does NOT unlock get_file when file_read returns within budget", () => {
    const s = new SessionState();
    const signals = extractSignals("file_read", {
      args: { file_path: "src/proxy/small.ts" },
      content: { text: "small body" },
      meta: { truncated: false } as never,
    });
    expect(signals.fileReadTruncated).toBeUndefined();
    s.recordCall(signals);
    const unlocks = evaluateUnlocks(s);
    expect(unlocks.map((u) => u.toolName)).not.toContain("get_file");
  });
});
