import { describe, expect, it } from "vitest";
import {
  type SessionResumePayload,
  formatSessionResumeBlock,
} from "../proxy/session-persistence.js";

function makePayload(
  overrides?: Partial<SessionResumePayload>,
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
});
