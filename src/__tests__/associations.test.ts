import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectAssociations,
  extractSignalsFromUrTags,
  extractSignalsFromNudges,
  type DetectorInput,
} from "../router/associations/detector.js";
import { scoreOutcomeQuality, qualityToNumeric, averageQuality } from "../router/associations/quality.js";
import { AssociationStore } from "../router/associations/store.js";
import type { TriggerSignal, SubsequentCall } from "../router/associations/types.js";

function makeSignal(overrides: Partial<TriggerSignal> = {}): TriggerSignal {
  return {
    type: "ur_tag",
    tag: "rsk",
    turnNumber: 0,
    timestamp: 1000,
    ...overrides,
  };
}

function makeCall(overrides: Partial<SubsequentCall> = {}): SubsequentCall {
  return {
    toolName: "gh_search",
    family: "gh",
    turnNumber: 1,
    timestamp: 5000,
    outcome: "success",
    responseTokens: 300,
    ...overrides,
  };
}

describe("Association detector — basic matching", () => {
  it("detects signal → tool call within turn window", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ turnNumber: 0, timestamp: 1000, family: "gh" })],
      calls: [makeCall({ turnNumber: 1, timestamp: 5000 })],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.triggerSignal.tag).toBe("rsk");
    expect(result[0]!.subsequentCall.toolName).toBe("gh_search");
    expect(result[0]!.gapTurns).toBe(1);
  });

  it("detects signal at turn 0 → call at turn 3 (max gap)", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ turnNumber: 0, timestamp: 1000 })],
      calls: [makeCall({ turnNumber: 3, timestamp: 20000 })],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.gapTurns).toBe(3);
  });

  it("does NOT detect call at turn 4 (exceeds max gap)", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ turnNumber: 0, timestamp: 1000 })],
      calls: [makeCall({ turnNumber: 4, timestamp: 20000 })],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(0);
  });

  it("does NOT detect call at same turn (must be after)", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ turnNumber: 1, timestamp: 1000 })],
      calls: [makeCall({ turnNumber: 1, timestamp: 2000 })],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(0);
  });

  it("does NOT detect if time gap exceeds 30s", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ turnNumber: 0, timestamp: 1000 })],
      calls: [makeCall({ turnNumber: 1, timestamp: 40000 })],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(0);
  });
});

describe("Association detector — family matching", () => {
  it("matches signal with same family", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ family: "gh", turnNumber: 0, timestamp: 1000 })],
      calls: [makeCall({ family: "gh", turnNumber: 1, timestamp: 5000 })],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(1);
  });

  it("does NOT match signal with different family", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ family: "pg", turnNumber: 0, timestamp: 1000 })],
      calls: [makeCall({ family: "gh", turnNumber: 1, timestamp: 5000 })],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(0);
  });

  it("matches signal without family context (any call matches)", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ family: undefined, turnNumber: 0, timestamp: 1000 })],
      calls: [makeCall({ family: "gh", turnNumber: 1, timestamp: 5000 })],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(1);
  });
});

describe("Association detector — multi-signal traces", () => {
  it("matches multiple signals to different calls", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [
        makeSignal({ tag: "rsk", family: "gh", turnNumber: 0, timestamp: 1000 }),
        makeSignal({ tag: "hnt", family: "pg", turnNumber: 2, timestamp: 10000 }),
      ],
      calls: [
        makeCall({ toolName: "gh_search", family: "gh", turnNumber: 1, timestamp: 5000 }),
        makeCall({ toolName: "pg_query", family: "pg", turnNumber: 3, timestamp: 15000 }),
      ],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(2);
    expect(result[0]!.subsequentCall.toolName).toBe("gh_search");
    expect(result[1]!.subsequentCall.toolName).toBe("pg_query");
  });

  it("each call is used at most once", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [
        makeSignal({ turnNumber: 0, timestamp: 1000 }),
        makeSignal({ turnNumber: 0, timestamp: 1500 }),
      ],
      calls: [
        makeCall({ turnNumber: 1, timestamp: 5000 }),
      ],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(1);
  });

  it("first signal claims the call (greedy left-to-right)", () => {
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [
        makeSignal({ tag: "rsk", turnNumber: 0, timestamp: 1000 }),
        makeSignal({ tag: "hnt", turnNumber: 0, timestamp: 1200 }),
      ],
      calls: [
        makeCall({ turnNumber: 1, timestamp: 5000 }),
      ],
    };
    const result = detectAssociations(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.triggerSignal.tag).toBe("rsk");
  });
});

describe("Outcome quality scorer", () => {
  it("returns high for success + edit + meaningful tokens", () => {
    const q = scoreOutcomeQuality(makeCall({ outcome: "success", responseTokens: 300 }), true);
    expect(q).toBe("high");
  });

  it("returns medium for success + high tokens without edit", () => {
    const q = scoreOutcomeQuality(makeCall({ outcome: "success", responseTokens: 500 }), false);
    expect(q).toBe("medium");
  });

  it("returns low for error outcome", () => {
    const q = scoreOutcomeQuality(makeCall({ outcome: "error" }), true);
    expect(q).toBe("low");
  });

  it("returns low for empty outcome", () => {
    const q = scoreOutcomeQuality(makeCall({ outcome: "empty" }), false);
    expect(q).toBe("low");
  });

  it("returns low for success with tiny response and no edit", () => {
    const q = scoreOutcomeQuality(makeCall({ outcome: "success", responseTokens: 20 }), false);
    expect(q).toBe("low");
  });

  it("qualityToNumeric maps correctly", () => {
    expect(qualityToNumeric("high")).toBe(1.0);
    expect(qualityToNumeric("medium")).toBe(0.66);
    expect(qualityToNumeric("low")).toBe(0.33);
    expect(qualityToNumeric("unknown")).toBe(0.0);
  });

  it("averageQuality computes correctly", () => {
    const avg = averageQuality(["high", "medium", "low"]);
    expect(avg).toBeCloseTo((1.0 + 0.66 + 0.33) / 3);
  });

  it("averageQuality empty array returns 0", () => {
    expect(averageQuality([])).toBe(0);
  });
});

describe("Signal extractors", () => {
  it("extractSignalsFromUrTags maps correctly", () => {
    const signals = extractSignalsFromUrTags([
      { tag: "rsk", turnNumber: 0, timestamp: 1000, entityName: "User.ts" },
      { tag: "hnt", turnNumber: 2, timestamp: 5000, family: "gh" },
    ]);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.type).toBe("ur_tag");
    expect(signals[0]!.tag).toBe("rsk");
    expect(signals[0]!.entityName).toBe("User.ts");
    expect(signals[1]!.family).toBe("gh");
  });

  it("extractSignalsFromNudges maps correctly", () => {
    const signals = extractSignalsFromNudges([
      { family: "gh", turnNumber: 1, timestamp: 3000 },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.type).toBe("family_nudge");
    expect(signals[0]!.family).toBe("gh");
  });
});

describe("AssociationStore — persistence", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "assoc-store-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("append + readAll round-trips", async () => {
    const store = new AssociationStore(testDir);
    const input: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ family: "gh", turnNumber: 0, timestamp: 1000 })],
      calls: [makeCall({ turnNumber: 1, timestamp: 5000 })],
    };
    const detected = detectAssociations(input);
    store.append(detected);

    const records = await store.readAll();
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe("s1");
    expect(records[0]!.subsequentCall.toolName).toBe("gh_search");
  });

  it("readAll returns empty for non-existent file", async () => {
    const store = new AssociationStore(join(testDir, "nonexist"));
    const records = await store.readAll();
    expect(records).toHaveLength(0);
  });

  it("readSession filters by sessionId", async () => {
    const store = new AssociationStore(testDir);
    const input1: DetectorInput = {
      sessionId: "s1",
      signals: [makeSignal({ turnNumber: 0, timestamp: 1000 })],
      calls: [makeCall({ turnNumber: 1, timestamp: 5000 })],
    };
    const input2: DetectorInput = {
      sessionId: "s2",
      signals: [makeSignal({ turnNumber: 0, timestamp: 1000 })],
      calls: [makeCall({ turnNumber: 2, timestamp: 8000 })],
    };
    store.append(detectAssociations(input1));
    store.append(detectAssociations(input2));

    const s1Records = await store.readSession("s1");
    expect(s1Records).toHaveLength(1);
    expect(s1Records[0]!.sessionId).toBe("s1");
  });
});

describe("Verification gate: ur|rsk → gh_search association", () => {
  it("ur|rsk on User.ts → gh_search 'User refactor' → high quality", () => {
    const input: DetectorInput = {
      sessionId: "gate-session",
      signals: [
        makeSignal({
          type: "ur_tag",
          tag: "rsk",
          entityName: "User.ts",
          family: "gh",
          turnNumber: 0,
          timestamp: 1000,
        }),
      ],
      calls: [
        makeCall({
          toolName: "gh_search",
          family: "gh",
          turnNumber: 1,
          timestamp: 5000,
          outcome: "success",
          responseTokens: 400,
        }),
      ],
      editAfterCalls: new Set([0]),
    };

    const result = detectAssociations(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.triggerSignal.tag).toBe("rsk");
    expect(result[0]!.triggerSignal.entityName).toBe("User.ts");
    expect(result[0]!.subsequentCall.toolName).toBe("gh_search");
    expect(result[0]!.outcomeQuality).toBe("high");
    expect(result[0]!.gapTurns).toBe(1);
  });
});
