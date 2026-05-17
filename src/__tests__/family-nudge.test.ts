import { describe, it, expect } from "vitest";

import { FamilyNudgeEmitter, type NudgeResult } from "../router/family-nudge.js";

function makeEmitter(aliases: string[] = ["gh", "pg", "slk"]): FamilyNudgeEmitter {
  return new FamilyNudgeEmitter(new Set(aliases));
}

describe("FamilyNudgeEmitter", () => {
  // ── Basic nudge emission ───────────────────────────────────────

  it("emits nudge for DB context", () => {
    const emitter = makeEmitter();
    const result = emitter.evaluate(["db/schema.sql"]);

    expect(result.emitted).toBe(true);
    expect(result.nudgeText).toContain("ur|hnt");
    expect(result.nudgeText).toContain("pg_*");
    expect(result.nudgeText).toContain("DB/Postgres");
  });

  it("emits nudge for GitHub context", () => {
    const emitter = makeEmitter();
    const result = emitter.evaluate([".github/workflows/ci.yml"]);

    expect(result.emitted).toBe(true);
    expect(result.nudgeText).toContain("ur|hnt");
    expect(result.nudgeText).toContain("gh_*");
    expect(result.nudgeText).toContain("GitHub/CI");
  });

  it("emits multi-domain nudge", () => {
    const emitter = makeEmitter();
    const result = emitter.evaluate([
      "db/schema.sql",
      ".github/workflows/ci.yml",
    ]);

    expect(result.emitted).toBe(true);
    expect(result.nudgeText).toContain("ur|hnt");
    expect(result.nudgeText).toContain("Multi-domain");
  });

  it("does not emit for unrecognized files", () => {
    const emitter = makeEmitter();
    const result = emitter.evaluate(["src/utils/helpers.ts"]);

    expect(result.emitted).toBe(false);
    expect(result.nudgeText).toBeNull();
  });

  it("does not emit for empty file list", () => {
    const emitter = makeEmitter();
    const result = emitter.evaluate([]);

    expect(result.emitted).toBe(false);
    expect(result.nudgeText).toBeNull();
  });

  // ── Nudge text follows CLAUDE.md rules ─────────────────────────

  it("nudge text uses imperative verb, not hedge verb", () => {
    const emitter = makeEmitter();
    const result = emitter.evaluate(["db/schema.sql"]);

    expect(result.nudgeText).toMatch(/Use \w+_\*/);
    expect(result.nudgeText).not.toContain("consider");
    expect(result.nudgeText).not.toContain("try");
    expect(result.nudgeText).not.toContain("verify");
    expect(result.nudgeText).not.toContain("may want to");
  });

  it("nudge mentions locked families explicitly", () => {
    const emitter = makeEmitter();
    const result = emitter.evaluate(["db/schema.sql"]);

    expect(result.nudgeText).toContain("locked");
    expect(result.nudgeText).toContain("gh_*");
    expect(result.nudgeText).toContain("slk_*");
  });

  // ── Throttle (1 per 5 turns) ───────────────────────────────────

  it("throttles nudges to 1 per 5 turns", () => {
    const emitter = makeEmitter();

    const first = emitter.evaluate(["db/schema.sql"]);
    expect(first.emitted).toBe(true);

    emitter.advanceTurn();
    const second = emitter.evaluate(["db/migrations/001.sql"]);
    expect(second.emitted).toBe(false);
    expect(second.throttled).toBe(true);

    emitter.advanceTurn();
    emitter.advanceTurn();
    emitter.advanceTurn();
    const third = emitter.evaluate(["db/seeds/users.ts"]);
    expect(third.emitted).toBe(false);
    expect(third.throttled).toBe(true);

    emitter.advanceTurn();
    const fourth = emitter.evaluate(["db/seeds/users.ts"]);
    expect(fourth.emitted).toBe(true);
    expect(fourth.throttled).toBe(false);
  });

  it("throttle resets after cooldown period", () => {
    const emitter = makeEmitter();

    emitter.evaluate(["db/schema.sql"]);

    for (let i = 0; i < 5; i++) emitter.advanceTurn();

    const result = emitter.evaluate([".github/workflows/ci.yml"]);
    expect(result.emitted).toBe(true);
  });

  // ── Accuracy tracking ──────────────────────────────────────────

  it("records follow-up as followed when family matches", () => {
    const emitter = makeEmitter();
    emitter.evaluate(["db/schema.sql"]);

    emitter.recordFollowUp("pg");

    const log = emitter.getAccuracyLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.nudgedFamily).toBe("pg");
    expect(log[0]!.followed).toBe(true);
  });

  it("records follow-up as not followed when family differs", () => {
    const emitter = makeEmitter();
    emitter.evaluate(["db/schema.sql"]);

    emitter.recordFollowUp("gh");

    const log = emitter.getAccuracyLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.followed).toBe(false);
  });

  it("records null follow-up (unerr-native tool) as not followed", () => {
    const emitter = makeEmitter();
    emitter.evaluate(["db/schema.sql"]);

    emitter.recordFollowUp(null);

    const log = emitter.getAccuracyLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.followed).toBe(false);
  });

  it("ignores recordFollowUp when no nudge was pending", () => {
    const emitter = makeEmitter();
    emitter.recordFollowUp("pg");

    const log = emitter.getAccuracyLog();
    expect(log).toHaveLength(0);
  });

  it("calculates accuracy rate correctly", () => {
    const emitter = makeEmitter();

    emitter.evaluate(["db/schema.sql"]);
    emitter.recordFollowUp("pg");

    for (let i = 0; i < 5; i++) emitter.advanceTurn();
    emitter.evaluate([".github/workflows/ci.yml"]);
    emitter.recordFollowUp("slk");

    expect(emitter.getAccuracyRate()).toBe(0.5);
  });

  it("returns null accuracy rate when no nudges tracked", () => {
    const emitter = makeEmitter();
    expect(emitter.getAccuracyRate()).toBeNull();
  });

  it("getStats returns complete summary", () => {
    const emitter = makeEmitter();

    emitter.evaluate(["db/schema.sql"]);
    emitter.recordFollowUp("pg");

    const stats = emitter.getStats();
    expect(stats.totalNudges).toBe(1);
    expect(stats.totalFollowed).toBe(1);
    expect(stats.accuracyRate).toBe(1.0);
  });

  // ── Turn counter ───────────────────────────────────────────────

  it("tracks turn count", () => {
    const emitter = makeEmitter();
    expect(emitter.turn).toBe(0);
    emitter.advanceTurn();
    emitter.advanceTurn();
    expect(emitter.turn).toBe(2);
  });

  // ── Nudge accuracy log records turn number ─────────────────────

  it("accuracy log includes correct turn number", () => {
    const emitter = makeEmitter();
    emitter.advanceTurn();
    emitter.advanceTurn();

    emitter.evaluate(["db/schema.sql"]);
    emitter.recordFollowUp("pg");

    const log = emitter.getAccuracyLog();
    expect(log[0]!.turnNumber).toBe(2);
  });

  // ── Multi-session nudge sequence ───────────────────────────────

  it("handles multiple nudge → follow-up cycles correctly", () => {
    const emitter = makeEmitter();

    emitter.evaluate(["db/schema.sql"]);
    emitter.recordFollowUp("pg");

    for (let i = 0; i < 5; i++) emitter.advanceTurn();
    emitter.evaluate([".github/workflows/ci.yml"]);
    emitter.recordFollowUp("gh");

    for (let i = 0; i < 5; i++) emitter.advanceTurn();
    emitter.evaluate(["src/integrations/slack/bot.ts"]);
    emitter.recordFollowUp("pg");

    const log = emitter.getAccuracyLog();
    expect(log).toHaveLength(3);
    expect(log[0]!.followed).toBe(true);
    expect(log[1]!.followed).toBe(true);
    expect(log[2]!.followed).toBe(false);
    expect(emitter.getAccuracyRate()).toBeCloseTo(2 / 3);
  });
});
