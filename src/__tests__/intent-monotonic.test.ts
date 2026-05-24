import { describe, expect, it } from "vitest";

import { IntentDispatcher } from "../router/dispatch.js";
import { FamilyMaskEngine } from "../router/family-mask.js";
import type { ScorerInput } from "../router/intent/scorer.js";
import {
  createStickinessState,
  recordFamilyCall,
} from "../router/intent/stickiness.js";
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

describe("Monotonic Exposure — Intent shifts mid-session", () => {
  it("DB→GitHub shift: pg stays exposed, gh becomes exposed", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "mono-1",
    });

    // Turn 0: pure DB intent
    const eval0 = dispatcher.evaluateIntent(
      baseInput({ entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]) }),
      0
    );
    expect(eval0.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(eval0.maskSnapshot.maskedFamilies.has("gh")).toBe(true);
    expect(eval0.intentShifted).toBe(false);

    // Turn 1: intent shifts to GitHub
    const eval1 = dispatcher.evaluateIntent(
      baseInput({
        entityFamilyTags: new Map([["PRService", new Set(["gh"])]]),
      }),
      1
    );
    expect(eval1.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(eval1.maskSnapshot.exposedFamilies.has("gh")).toBe(true);
    expect(eval1.intentShifted).toBe(true);
    expect(eval1.newlyExposedFamilies).toContain("gh");
  });

  it("DB→GitHub→Slack: all three end up exposed", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "mono-2",
    });

    dispatcher.evaluateIntent(
      baseInput({ entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]) }),
      0
    );
    dispatcher.evaluateIntent(
      baseInput({
        entityFamilyTags: new Map([["PRService", new Set(["gh"])]]),
      }),
      1
    );
    const eval2 = dispatcher.evaluateIntent(
      baseInput({ recentFiles: ["src/integrations/slack/bot.ts"] }),
      2
    );

    expect(eval2.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(eval2.maskSnapshot.exposedFamilies.has("gh")).toBe(true);
    expect(eval2.maskSnapshot.exposedFamilies.has("slk")).toBe(true);
    expect(eval2.maskSnapshot.maskedFamilies.has("str")).toBe(true);
    expect(eval2.maskSnapshot.maskedFamilies.has("aws")).toBe(true);
  });

  it("losing signal does not re-mask previously exposed families", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "mono-3",
    });

    // Strong pg + gh signal
    dispatcher.evaluateIntent(
      baseInput({
        entityFamilyTags: new Map([
          ["UserRepo", new Set(["pg"])],
          ["PRService", new Set(["gh"])],
        ]),
      }),
      0
    );

    // Only pg signal (gh signal gone)
    const eval1 = dispatcher.evaluateIntent(
      baseInput({ entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]) }),
      1
    );

    expect(eval1.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(eval1.maskSnapshot.exposedFamilies.has("gh")).toBe(true);
    expect(eval1.intentShifted).toBe(false);
  });

  it("no signal turns: nothing new exposed, no intent shift", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "mono-4",
    });

    dispatcher.evaluateIntent(
      baseInput({ entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]) }),
      0
    );

    const eval1 = dispatcher.evaluateIntent(baseInput(), 1);
    expect(eval1.intentShifted).toBe(false);
    expect(eval1.newlyExposedFamilies).toHaveLength(0);
    expect(eval1.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
  });

  it("stickiness keeps family exposed even after signal fades", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "mono-5",
    });

    let state = createStickinessState();
    state = recordFamilyCall(state, "slk", 0);

    const eval0 = dispatcher.evaluateIntent(
      baseInput({
        stickinessState: state,
        entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
      }),
      0
    );

    expect(eval0.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(eval0.maskSnapshot.exposedFamilies.has("slk")).toBe(true);
  });
});

describe("Monotonic Exposure — Override interaction", () => {
  it("manual unmask + intent shift: both stay exposed", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "mono-6",
    });

    dispatcher.evaluateIntent(
      baseInput({ entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]) }),
      0
    );

    dispatcher.unmaskFamily("aws");

    const eval1 = dispatcher.evaluateIntent(
      baseInput({
        entityFamilyTags: new Map([["PRService", new Set(["gh"])]]),
      }),
      1
    );

    expect(eval1.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(eval1.maskSnapshot.exposedFamilies.has("gh")).toBe(true);
    expect(eval1.maskSnapshot.exposedFamilies.has("aws")).toBe(true);
  });

  it("evaluations accumulate correctly", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "mono-7",
    });

    dispatcher.evaluateIntent(
      baseInput({ entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]) }),
      0
    );
    dispatcher.evaluateIntent(
      baseInput({
        entityFamilyTags: new Map([["PRService", new Set(["gh"])]]),
      }),
      1
    );
    dispatcher.evaluateIntent(
      baseInput({ recentFiles: ["src/integrations/slack/bot.ts"] }),
      2
    );

    const evals = dispatcher.getEvaluations();
    expect(evals).toHaveLength(3);
    expect(evals[0]!.turnNumber).toBe(0);
    expect(evals[1]!.turnNumber).toBe(1);
    expect(evals[2]!.turnNumber).toBe(2);
    expect(evals[1]!.intentShifted).toBe(true);
    expect(evals[2]!.intentShifted).toBe(true);
  });
});

describe("Monotonic Exposure — Verification gate (end-to-end session)", () => {
  it("full session: intent shifts mid-stream, masking correct, telemetry records", () => {
    const engine = new FamilyMaskEngine(ALL_FAMILIES);
    const dispatcher = new IntentDispatcher({
      maskEngine: engine,
      sessionId: "gate-1",
    });

    // Phase 1: DB-focused (turns 0-2)
    for (let turn = 0; turn < 3; turn++) {
      const eval_ = dispatcher.evaluateIntent(
        baseInput({
          entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
          recentFiles: ["db/schema.sql"],
        }),
        turn
      );
      expect(eval_.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
      expect(eval_.maskSnapshot.maskedFamilies.has("gh")).toBe(true);
    }

    // Phase 2: Intent shifts to GitHub (turn 3)
    const evalShift = dispatcher.evaluateIntent(
      baseInput({
        entityFamilyTags: new Map([["PRService", new Set(["gh"])]]),
        recentFiles: [".github/workflows/ci.yml"],
      }),
      3
    );
    expect(evalShift.intentShifted).toBe(true);
    expect(evalShift.newlyExposedFamilies).toContain("gh");
    expect(evalShift.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(evalShift.maskSnapshot.exposedFamilies.has("gh")).toBe(true);

    // Phase 3: Mixed signals (turn 4)
    const evalMixed = dispatcher.evaluateIntent(baseInput(), 4);
    expect(evalMixed.maskSnapshot.exposedFamilies.has("pg")).toBe(true);
    expect(evalMixed.maskSnapshot.exposedFamilies.has("gh")).toBe(true);
    expect(evalMixed.intentShifted).toBe(false);

    // Verify telemetry
    const telemetry = engine.getTelemetryLog();
    expect(telemetry.length).toBe(5);
    expect(telemetry[0]!.maskedFamilies).toContain("gh");
    expect(telemetry[3]!.exposedFamilies).toContain("gh");
    expect(telemetry[3]!.exposedFamilies).toContain("pg");
  });
});
