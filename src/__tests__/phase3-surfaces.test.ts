/**
 * Phase 3 — Surface 1 dashboard + Session Economy + Sidekick Memory +
 * Parity + Engagement Telemetry.
 *
 * Pure unit coverage. The route handlers themselves are exercised in
 * `phase3-routes.test.ts`. This file covers the IO-free renderers,
 * pickers, parity helpers, and telemetry projections.
 */

import { describe, expect, it } from "vitest";
import {
  renderStoryParagraph,
  sortByEmotionalWeight,
} from "../server/routes/logbook.js";
import type { BehaviorEvent } from "../tracking/behavior-events.js";
import {
  ambientFallback,
  confirmationStats,
  enforcementCorrelation,
  followupLatency,
  renderEngagementReport,
  userFedRetention,
} from "../tracking/engagement-telemetry.js";
import type { NamedEvent } from "../tracking/named-events.js";
import {
  emptyReport,
  logbookCountersParity,
  namedEventsBehaviorParity,
  sessionEconomyTokenFlowParity,
  sidekickFactsParity,
} from "../tracking/parity.js";

function makeEvent(overrides: Partial<NamedEvent> = {}): NamedEvent {
  return {
    event_type: "stale_edit_prevented",
    verb: "prevented",
    object: "stale edit",
    agent: "claude-code",
    file_path: "src/foo.ts",
    entity_key: null,
    session_id: "s1",
    turn: 1,
    ts: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

// ── Sprint 9 — Logbook story paragraph ───────────────────────────────

describe("renderStoryParagraph", () => {
  it("honest-zeros when no events", () => {
    const out = renderStoryParagraph([], "Today", "claude-code");
    expect(out.honest_zero).toBe(true);
    expect(out.paragraph).toContain("unerr was quiet");
    expect(out.featured).toBeNull();
  });

  it("renders the full read avoidance clause with the agent name", () => {
    const out = renderStoryParagraph(
      [
        makeEvent({
          event_type: "full_read_avoided",
          verb: "avoided",
          object: "full file read",
        }),
        makeEvent({
          event_type: "full_read_avoided",
          verb: "avoided",
          object: "full file read",
          ts: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
      "Today",
      "claude-code"
    );
    expect(out.honest_zero).toBe(false);
    expect(out.paragraph).toContain("claude-code");
    expect(out.paragraph).toContain("2 file reads");
  });

  it("picks the common scope for stale_edit_prevented", () => {
    const out = renderStoryParagraph(
      [
        makeEvent({
          event_type: "stale_edit_prevented",
          file_path: "src/foo.ts",
        }),
        makeEvent({
          event_type: "stale_edit_prevented",
          file_path: "src/foo.ts",
        }),
        makeEvent({
          event_type: "stale_edit_prevented",
          file_path: "src/bar.ts",
        }),
      ],
      "Today",
      "claude-code"
    );
    expect(out.paragraph).toContain("src/foo.ts");
  });

  it("features the highest-weight event", () => {
    const stale = makeEvent({
      event_type: "stale_edit_prevented",
      ts: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const cache = makeEvent({
      event_type: "cache_hit",
      ts: new Date(Date.now() - 60_000).toISOString(),
    });
    const out = renderStoryParagraph([stale, cache], "Today", "claude-code");
    expect(out.featured?.event_type).toBe("stale_edit_prevented");
  });
});

describe("sortByEmotionalWeight", () => {
  it("ranks stale_edit_prevented above cache_hit", () => {
    const sorted = sortByEmotionalWeight([
      makeEvent({ event_type: "cache_hit" }),
      makeEvent({ event_type: "stale_edit_prevented" }),
    ]);
    expect(sorted[0]!.event_type).toBe("stale_edit_prevented");
  });

  it("breaks ties by ts desc", () => {
    const older = makeEvent({
      event_type: "loop_broken",
      ts: new Date(Date.now() - 60_000).toISOString(),
    });
    const newer = makeEvent({
      event_type: "loop_broken",
      ts: new Date().toISOString(),
    });
    const sorted = sortByEmotionalWeight([older, newer]);
    expect(sorted[0]).toBe(newer);
  });
});

// ── Sprint 12 — Engagement telemetry ─────────────────────────────────

describe("followupLatency", () => {
  it("returns zeros on empty input", () => {
    const out = followupLatency([]);
    expect(out).toEqual({ samples: 0, median_ms: 0, p90_ms: 0 });
  });

  it("computes deltas per session and skips cross-session pairs", () => {
    const base = Date.now();
    const events: NamedEvent[] = [
      makeEvent({
        session_id: "s1",
        turn: 1,
        ts: new Date(base).toISOString(),
      }),
      makeEvent({
        session_id: "s1",
        turn: 2,
        ts: new Date(base + 1000).toISOString(),
      }),
      makeEvent({
        session_id: "s2",
        turn: 1,
        ts: new Date(base + 5000).toISOString(),
      }),
      makeEvent({
        session_id: "s2",
        turn: 2,
        ts: new Date(base + 7000).toISOString(),
      }),
    ];
    const out = followupLatency(events);
    expect(out.samples).toBe(2);
    expect(out.median_ms).toBeGreaterThan(0);
  });
});

describe("confirmationStats", () => {
  it("counts registered ambiguous captures and expired confirmations", () => {
    const out = confirmationStats([
      makeEvent({
        event_type: "fact_stored_user_fed",
        metadata: { ambiguity_flag: true },
      }),
      makeEvent({
        event_type: "fact_stored_user_fed",
        metadata: { ambiguity_flag: false },
      }),
      makeEvent({ event_type: "confirmation_expired" }),
    ]);
    expect(out.registered).toBe(1);
    expect(out.expired).toBe(1);
    expect(out.answer_rate).toBeGreaterThanOrEqual(0);
  });
});

describe("ambientFallback", () => {
  it("zero when no ambient events", () => {
    expect(ambientFallback([makeEvent()])).toEqual({
      total_turns: 1,
      ambient_turns: 0,
      fallback_rate: 0,
    });
  });

  it("computes rate from presence_ambient_marker events", () => {
    const out = ambientFallback([
      makeEvent({ event_type: "presence_ambient_marker", turn: 1 }),
      makeEvent({ event_type: "full_read_avoided", turn: 2 }),
    ]);
    expect(out.total_turns).toBe(2);
    expect(out.ambient_turns).toBe(1);
    expect(out.fallback_rate).toBe(0.5);
  });
});

describe("enforcementCorrelation", () => {
  it("counts agent follow-through on convention_applied", () => {
    const base = Date.now();
    const out = enforcementCorrelation([
      makeEvent({
        event_type: "convention_applied",
        session_id: "s1",
        turn: 1,
        ts: new Date(base).toISOString(),
      }),
      makeEvent({
        event_type: "fact_recalled",
        session_id: "s1",
        turn: 2,
        ts: new Date(base + 1000).toISOString(),
      }),
    ]);
    expect(out.enforced).toBe(1);
    expect(out.followed).toBe(1);
    expect(out.correlation).toBe(1);
  });

  it("returns zero correlation when no follow-through", () => {
    const out = enforcementCorrelation([
      makeEvent({ event_type: "convention_applied" }),
    ]);
    expect(out.enforced).toBe(1);
    expect(out.followed).toBe(0);
  });
});

describe("userFedRetention", () => {
  it("retention 1.0 when nothing disabled", () => {
    const out = userFedRetention([
      { disabled: false, effective_confidence: 0.9 },
      { disabled: false, effective_confidence: 0.6 },
    ]);
    expect(out.retention_rate).toBe(1);
  });

  it("drops the rate when facts are disabled", () => {
    const out = userFedRetention([
      { disabled: true, effective_confidence: 0.01 },
      { disabled: false, effective_confidence: 0.9 },
    ]);
    expect(out.retention_rate).toBe(0.5);
  });
});

describe("renderEngagementReport", () => {
  it("returns all five report sections", () => {
    const report = renderEngagementReport(
      [makeEvent()],
      [{ disabled: false, effective_confidence: 0.9 }]
    );
    expect(report.followup_latency).toBeDefined();
    expect(report.confirmation).toBeDefined();
    expect(report.ambient).toBeDefined();
    expect(report.enforcement).toBeDefined();
    expect(report.user_fed_retention).toBeDefined();
  });
});

// ── Sprint 12 — Parity helpers ───────────────────────────────────────

describe("parity helpers", () => {
  it("emptyReport starts matched", () => {
    expect(emptyReport()).toEqual({ matched: true, mismatches: [] });
  });

  it("namedEventsBehaviorParity flags missing projection", () => {
    const behavior: BehaviorEvent = {
      id: 1,
      pid: 1234,
      session_id: "s1",
      turn: 1,
      ts: "2026-01-01T00:00:00.000Z",
      type: "loop_broken",
      tool: null,
      entity_key: null,
      response_bytes: null,
      detail: {},
    };
    const named: NamedEvent[] = []; // empty — projection missing
    const report = namedEventsBehaviorParity([behavior], named);
    expect(report.matched).toBe(false);
    expect(report.mismatches.length).toBe(1);
  });

  it("namedEventsBehaviorParity passes when all rows projected", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const behavior: BehaviorEvent = {
      id: 2,
      pid: 1234,
      session_id: "s1",
      turn: 1,
      ts,
      type: "loop_broken",
      tool: null,
      entity_key: null,
      response_bytes: null,
      detail: {},
    };
    const named: NamedEvent[] = [
      makeEvent({
        event_type: "loop_broken",
        verb: "broke",
        object: "retry loop",
        session_id: "s1",
        turn: 1,
        ts,
      }),
    ];
    expect(namedEventsBehaviorParity([behavior], named).matched).toBe(true);
  });

  it("logbookCountersParity flags count mismatch", () => {
    const report = logbookCountersParity(
      { loop_broken: 1 },
      { loop_broken: 2 }
    );
    expect(report.matched).toBe(false);
  });

  it("logbookCountersParity passes on equal counts", () => {
    const report = logbookCountersParity(
      { loop_broken: 2 },
      { loop_broken: 2 }
    );
    expect(report.matched).toBe(true);
  });

  it("logbookCountersParity ignores tokenflow.* types", () => {
    const report = logbookCountersParity(
      { "tokenflow.file_read": 5 },
      {} // no tokenflow in behavior side
    );
    expect(report.matched).toBe(true);
  });

  it("sessionEconomyTokenFlowParity flags drift", () => {
    expect(sessionEconomyTokenFlowParity(100, 200).matched).toBe(false);
    expect(sessionEconomyTokenFlowParity(100, 100).matched).toBe(true);
  });

  it("sidekickFactsParity flags missing facts", () => {
    const report = sidekickFactsParity(new Set(["a"]), new Set(["a", "b"]));
    expect(report.matched).toBe(false);
    expect(report.mismatches[0]).toContain("b");
  });

  it("sidekickFactsParity allows superset", () => {
    const report = sidekickFactsParity(
      new Set(["a", "b", "c"]),
      new Set(["a", "b"])
    );
    expect(report.matched).toBe(true);
  });
});
