import { describe, expect, it } from "vitest";
import {
  type SessionResumePayload,
  formatSessionResumeBlock,
} from "../proxy/session-persistence.js";

function makePayload(
  overrides?: Partial<SessionResumePayload>
): SessionResumePayload {
  return {
    session_resumed: true,
    previous_session: {
      session_id: "test-sess",
      duration_ms: 300000,
      tool_calls: 15,
      chains: 3,
      files_modified: ["src/auth.ts", "src/api.ts"],
      entities_touched: ["login", "register"],
      tools_used: { file_read: 8, get_function: 5 },
      feature_areas: ["auth"],
      revert_count: 0,
      facts_recorded: 2,
      branch: "main",
      ended_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
    continuity: {
      hot_files: ["src/auth.ts", "src/api.ts"],
      incomplete_hint: "Continuing work on src/auth.ts, src/api.ts",
      staleness: "fresh",
    },
    recalled_facts: [
      {
        fact_id: "f1",
        type: "negative",
        content: "Never store passwords in plain text",
        confidence: 0.95,
        source: "negative_knowledge",
      },
      {
        fact_id: "f2",
        type: "semantic",
        content: "Auth uses bcrypt for hashing",
        confidence: 0.8,
        source: "agent_explicit",
      },
    ],
    decayed_since_last_session: [],
    open_blockers: [],
    last_intents: [],
    ...overrides,
  };
}

describe("formatSessionResumeBlock", () => {
  it("formats a complete resume block with elapsed time and facts", () => {
    const block = formatSessionResumeBlock(makePayload());
    expect(block).toContain("[unerr:session-resume]");
    expect(block).toContain("2h ago");
    expect(block).toContain("src/auth.ts");
    expect(block).toContain("Never store passwords in plain text");
    expect(block).toContain("95%");
  });

  it("returns empty string for null payload", () => {
    expect(formatSessionResumeBlock(null)).toBe("");
  });

  it("filters out low-confidence facts", () => {
    const payload = makePayload({
      recalled_facts: [
        {
          fact_id: "f1",
          type: "semantic",
          content: "Low confidence fact",
          confidence: 0.3,
          source: "session_analysis",
        },
      ],
    });
    const block = formatSessionResumeBlock(payload);
    expect(block).not.toContain("Low confidence fact");
  });

  it("truncates to 500 chars max", () => {
    const payload = makePayload({
      recalled_facts: Array.from({ length: 20 }, (_, i) => ({
        fact_id: `f${i}`,
        type: "semantic",
        content: `Very long fact number ${i} with lots of extra detail that pads the content significantly`,
        confidence: 0.95,
        source: "agent_explicit",
      })),
    });
    const block = formatSessionResumeBlock(payload);
    expect(block.length).toBeLessThanOrEqual(500);
  });

  it("includes incomplete hint when meaningful", () => {
    const payload = makePayload({
      continuity: {
        hot_files: ["src/auth.ts"],
        incomplete_hint:
          "2 revert(s) in last session — approach may need rethinking",
        staleness: "fresh",
      },
    });
    const block = formatSessionResumeBlock(payload);
    expect(block).toContain("revert(s)");
  });

  it("skips generic incomplete hint", () => {
    const payload = makePayload({
      continuity: {
        hot_files: ["src/auth.ts"],
        incomplete_hint: "No specific continuity context",
        staleness: "fresh",
      },
    });
    const block = formatSessionResumeBlock(payload);
    expect(block).not.toContain("No specific continuity context");
  });

  // ── Fix K — open blockers + last intents ────────────────────────────

  it("renders the last intent above blockers when present", () => {
    const payload = makePayload({
      last_intents: [
        {
          marker_id: "i1",
          text: "wire fact-store recall into resume strip",
          ts: Date.now(),
        },
      ],
    });
    const block = formatSessionResumeBlock(payload);
    expect(block).toContain("last intent: wire fact-store recall");
  });

  it("renders open blockers with file anchor when present", () => {
    const payload = makePayload({
      open_blockers: [
        {
          marker_id: "b1",
          text: "PaymentGateway has 8 callers — refactor blocked",
          file_path: "src/payment/gateway.ts",
          ts: Date.now(),
        },
      ],
    });
    const block = formatSessionResumeBlock(payload);
    expect(block).toContain("unresolved blocker: PaymentGateway has 8 callers");
    expect(block).toContain("[src/payment/gateway.ts]");
  });

  it("renders blockers without anchor when file_path is empty", () => {
    const payload = makePayload({
      open_blockers: [
        {
          marker_id: "b2",
          text: "session_id collision across IDEs",
          file_path: "",
          ts: Date.now(),
        },
      ],
    });
    const block = formatSessionResumeBlock(payload);
    expect(block).toContain("unresolved blocker: session_id collision");
    expect(block).not.toContain("[]");
  });

  it("caps open blockers at 3 even when more are present", () => {
    const payload = makePayload({
      open_blockers: Array.from({ length: 6 }, (_, i) => ({
        marker_id: `b${i}`,
        text: `blocker number ${i}`,
        file_path: `src/file-${i}.ts`,
        ts: Date.now() - i * 1000,
      })),
    });
    const block = formatSessionResumeBlock(payload);
    const matches = block.match(/unresolved blocker:/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  it("orders intent line BEFORE blocker lines (narrative arc)", () => {
    const payload = makePayload({
      last_intents: [
        {
          marker_id: "i1",
          text: "ship Fix K",
          ts: Date.now(),
        },
      ],
      open_blockers: [
        {
          marker_id: "b1",
          text: "tests failing on edge case",
          file_path: "src/a.ts",
          ts: Date.now(),
        },
      ],
    });
    const block = formatSessionResumeBlock(payload);
    const intentIdx = block.indexOf("last intent");
    const blockerIdx = block.indexOf("unresolved blocker");
    expect(intentIdx).toBeGreaterThan(-1);
    expect(blockerIdx).toBeGreaterThan(intentIdx);
  });

  it("omits both lines when neither field is populated", () => {
    const block = formatSessionResumeBlock(makePayload());
    expect(block).not.toContain("last intent");
    expect(block).not.toContain("unresolved blocker");
  });

  // ── P2.2 — broken callers surfaced from incomplete-work.json ─────────

  it("renders broken callers with the get_references action when present", () => {
    const payload = makePayload({
      broken_callers: [
        {
          entity: "pay",
          callers: ["src/checkout.ts:checkout", "src/refund.ts:refund"],
        },
      ],
    });
    const block = formatSessionResumeBlock(payload);
    expect(block).toContain("unfinished: changed pay");
    expect(block).toContain("src/checkout.ts:checkout");
    expect(block).toContain("src/refund.ts:refund");
    // Names the concrete next call, pasteable verbatim.
    expect(block).toContain("get_references({direction:'callers'}) on pay");
  });

  it("omits the broken-callers line when none are present", () => {
    const block = formatSessionResumeBlock(makePayload());
    expect(block).not.toContain("unfinished: changed");
  });

  it("caps broken-callers entities at 3 and per-entity caller list at 3", () => {
    const payload = makePayload({
      // Strip facts so the long broken-caller lines are not truncated away.
      recalled_facts: [],
      broken_callers: Array.from({ length: 5 }, (_, i) => ({
        entity: `fn${i}`,
        callers: Array.from({ length: 5 }, (_, j) => `src/c${j}.ts:caller${j}`),
      })),
    });
    const block = formatSessionResumeBlock(payload);
    const entityMatches = block.match(/unfinished: changed/g) ?? [];
    expect(entityMatches.length).toBeLessThanOrEqual(3);
    // Per-entity overflow is summarised, not dumped.
    expect(block).toContain("more)");
  });
});
