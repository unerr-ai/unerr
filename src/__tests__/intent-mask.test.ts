import { describe, it, expect } from "vitest";

import { FamilyMaskEngine, type MaskSnapshot } from "../router/family-mask.js";
import { buildIntentMaskRefuse } from "../router/intent-mask-refuse.js";
import { IntentDispatcher } from "../router/dispatch.js";
import { scoreIntent, type ScorerInput } from "../router/intent/scorer.js";
import { createStickinessState, recordFamilyCall } from "../router/intent/stickiness.js";
import { createEmptyDecayState } from "../router/intent/threshold-decay.js";

const ALL_FAMILIES = new Set(["pg", "gh", "slk", "str", "aws"]);

function baseInput(overrides: Partial<ScorerInput> = {}): ScorerInput {
  return {
    recentFiles: [],
    entityFamilyTags: new Map(),
    recentToolFamilies: [],
    stickinessState: createStickinessState(),
    decayState: createEmptyDecayState(),
    knownFamilies: ALL_FAMILIES,
    ...overrides,
  };
}

describe("FamilyMaskEngine — Basic masking", () => {
  it("initially masks families not in scorer's exposed set", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const exposed = new Set(["pg"]);
    const snapshot = engine.recompute(exposed, 0);

    expect(snapshot.maskedFamilies.has("gh")).toBe(true);
    expect(snapshot.maskedFamilies.has("slk")).toBe(true);
    expect(snapshot.maskedFamilies.has("str")).toBe(true);
    expect(snapshot.maskedFamilies.has("aws")).toBe(true);
    expect(snapshot.exposedFamilies.has("pg")).toBe(true);
  });

  it("always-on families are never masked", () => {
    const alwaysOn = new Set(["unerr"]);
    const allPlusUnerr = new Set([...ALL_FAMILIES, "unerr"]);
    const engine = new FamilyMaskEngine(allPlusUnerr, alwaysOn);

    const snapshot = engine.recompute(new Set<string>(), 0);
    expect(snapshot.exposedFamilies.has("unerr")).toBe(true);
    expect(snapshot.maskedFamilies.has("unerr")).toBe(false);
  });

  it("isMasked reflects current state", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    engine.recompute(new Set(["pg"]), 0);

    expect(engine.isMasked("pg")).toBe(false);
    expect(engine.isMasked("gh")).toBe(true);
    expect(engine.isMasked("slk")).toBe(true);
  });

  it("multiple families exposed: only non-exposed are masked", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    engine.recompute(new Set(["pg", "gh"]), 0);

    expect(engine.isMasked("pg")).toBe(false);
    expect(engine.isMasked("gh")).toBe(false);
    expect(engine.isMasked("slk")).toBe(true);
    expect(engine.isMasked("str")).toBe(true);
  });
});

describe("FamilyMaskEngine — Monotonic exposure", () => {
  it("once exposed, family is never re-masked", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);

    engine.recompute(new Set(["pg", "gh"]), 0);
    expect(engine.isMasked("gh")).toBe(false);

    engine.recompute(new Set(["pg"]), 1);
    expect(engine.isMasked("gh")).toBe(false);
  });

  it("everExposed grows monotonically", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);

    engine.recompute(new Set(["pg"]), 0);
    expect(engine.getEverExposed().size).toBe(1);

    engine.recompute(new Set(["pg", "gh"]), 1);
    expect(engine.getEverExposed().size).toBe(2);

    engine.recompute(new Set(["pg"]), 2);
    expect(engine.getEverExposed().size).toBe(2);
  });

  it("intent shift: new families become exposed without losing old ones", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);

    engine.recompute(new Set(["pg"]), 0);
    const snap2 = engine.recompute(new Set(["gh"]), 1);

    expect(snap2.exposedFamilies.has("pg")).toBe(true);
    expect(snap2.exposedFamilies.has("gh")).toBe(true);
    expect(snap2.maskedFamilies.has("slk")).toBe(true);
  });
});

describe("FamilyMaskEngine — Manual overrides", () => {
  it("unmask forces a family to be exposed", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    engine.recompute(new Set(["pg"]), 0);

    expect(engine.isMasked("slk")).toBe(true);
    engine.unmask("slk");
    expect(engine.isMasked("slk")).toBe(false);
  });

  it("unmasked family stays exposed on subsequent recomputes", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    engine.recompute(new Set(["pg"]), 0);
    engine.unmask("slk");
    engine.recompute(new Set(["pg"]), 1);
    expect(engine.isMasked("slk")).toBe(false);
  });

  it("forceMask overrides monotonic guarantee (debug tool)", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    engine.recompute(new Set(["pg", "gh"]), 0);
    expect(engine.isMasked("gh")).toBe(false);

    engine.forceMask("gh");
    expect(engine.isMasked("gh")).toBe(true);
  });

  it("forceMask cannot mask always-on families", () => {
    const alwaysOn = new Set(["unerr"]);
    const all = new Set([...ALL_FAMILIES, "unerr"]);
    const engine = new FamilyMaskEngine(all, alwaysOn);
    engine.recompute(new Set(["pg"]), 0);

    engine.forceMask("unerr");
    expect(engine.isMasked("unerr")).toBe(false);
  });
});

describe("FamilyMaskEngine — Telemetry", () => {
  it("records telemetry events on each recompute", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    engine.recompute(new Set(["pg"]), 0);
    engine.recompute(new Set(["pg", "gh"]), 1);

    const log = engine.getTelemetryLog();
    expect(log).toHaveLength(2);
    expect(log[0]!.turnNumber).toBe(0);
    expect(log[1]!.turnNumber).toBe(1);
  });

  it("telemetry includes all decision categories", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    engine.unmask("aws");
    const snap = engine.recompute(new Set(["pg"]), 0);

    const log = engine.getTelemetryLog();
    expect(log[0]!.exposedFamilies).toContain("pg");
    expect(log[0]!.exposedFamilies).toContain("aws");
    expect(log[0]!.overriddenFamilies).toContain("aws");
    expect(log[0]!.maskedFamilies).toContain("gh");
    expect(log[0]!.maskedFamilies).toContain("slk");
  });
});

describe("IntentMaskRefuse — Soft-refuse for masked tools", () => {
  it("builds structured refusal with family and override info", () => {
    const result = buildIntentMaskRefuse({
      toolName: "gh_search",
      maskedFamily: "gh",
      dominantFamilies: ["pg"],
      dominantReasons: ["import-graph: UserRepo imports pg-family library"],
    });

    expect(result._gate.status).toBe("intent_masked");
    expect(result._gate.family).toBe("gh");
    expect(result._gate.dominant_intent).toBe("pg");
    expect(result._gate.override_command).toBe("unerr router unmask gh");
    expect(result.content[0]!.text).toContain("ur|hnt gh_search hidden");
    expect(result.content[0]!.text).toContain("pg work");
    expect(result.content[0]!.text).toContain("unerr router unmask gh");
  });

  it("handles multi-domain dominant intent", () => {
    const result = buildIntentMaskRefuse({
      toolName: "aws_deploy",
      maskedFamily: "aws",
      dominantFamilies: ["pg", "gh"],
      dominantReasons: ["file pattern: SQL file"],
    });

    expect(result._gate.dominant_intent).toBe("pg, gh");
    expect(result.content[0]!.text).toContain("pg, gh work");
  });

  it("handles empty dominant families gracefully", () => {
    const result = buildIntentMaskRefuse({
      toolName: "slk_post",
      maskedFamily: "slk",
      dominantFamilies: [],
      dominantReasons: [],
    });

    expect(result._gate.dominant_intent).toBe("unknown");
    expect(result.content[0]!.text).toContain("no strong signal");
  });

  it("text follows CLAUDE.md rules (imperative verb, no hedging)", () => {
    const result = buildIntentMaskRefuse({
      toolName: "gh_pr_list",
      maskedFamily: "gh",
      dominantFamilies: ["pg"],
      dominantReasons: ["recent tool calls: 4× in last 5 calls"],
    });

    const text = result.content[0]!.text;
    expect(text).not.toContain("consider");
    expect(text).not.toContain("verify");
    expect(text).not.toContain("this ");
    expect(text).toContain("Run `unerr router unmask gh`");
  });
});

describe("IntentDispatcher — End-to-end with scorer", () => {
  it("high DB score session masks gh tools", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "test-1",
    });

    const input = baseInput({
      entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
      recentFiles: ["db/schema.sql"],
    });

    const evaluation = dispatcher.evaluateIntent(input, 0);

    expect(evaluation.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(evaluation.maskSnapshot.maskedFamilies.has("gh")).toBe(true);
    expect(evaluation.maskSnapshot.maskedFamilies.has("slk")).toBe(true);
    expect(dispatcher.isFamilyMasked("gh")).toBe(true);
  });

  it("multi-domain session exposes multiple families", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "test-2",
    });

    const input = baseInput({
      entityFamilyTags: new Map([
        ["UserRepo", new Set(["pg"])],
        ["PRService", new Set(["gh"])],
      ]),
    });

    const evaluation = dispatcher.evaluateIntent(input, 0);

    expect(evaluation.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(evaluation.maskSnapshot.exposedFamilies.has("gh")).toBe(true);
    expect(evaluation.maskSnapshot.maskedFamilies.has("slk")).toBe(true);
  });

  it("getDominantFamilies returns exposed families with scores", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "test-3",
    });

    const input = baseInput({
      entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
    });

    dispatcher.evaluateIntent(input, 0);
    const dominant = dispatcher.getDominantFamilies();
    expect(dominant).toContain("pg");
  });

  it("getDominantReasons returns reasons from scorer output", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "test-4",
    });

    const input = baseInput({
      entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
    });

    dispatcher.evaluateIntent(input, 0);
    const reasons = dispatcher.getDominantReasons();
    expect(reasons.some((r) => r.includes("import-graph"))).toBe(true);
  });

  it("unmaskFamily overrides masking for session", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "test-5",
    });

    const input = baseInput({
      entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
    });

    dispatcher.evaluateIntent(input, 0);
    expect(dispatcher.isFamilyMasked("slk")).toBe(true);

    dispatcher.unmaskFamily("slk");
    expect(dispatcher.isFamilyMasked("slk")).toBe(false);
  });
});
