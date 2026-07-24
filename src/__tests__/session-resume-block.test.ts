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
      incomplete_hint: "No specific continuity context",
      staleness: "fresh",
    },
    modified_files: [],
    ...overrides,
  };
}

describe("formatSessionResumeBlock", () => {
  it("returns empty string for null payload", () => {
    expect(formatSessionResumeBlock(null)).toBe("");
  });

  it("renders tool calls, duration and branch with no files modified", () => {
    const block = formatSessionResumeBlock(makePayload());
    expect(block).toBe("Last session: 15 tool calls over 5m 0s. Branch: main.");
  });

  it("renders up to 3 modified-file basenames", () => {
    const block = formatSessionResumeBlock(
      makePayload({
        modified_files: ["src/a/auth.ts", "src/b/api.ts", "src/c/util.ts"],
      })
    );
    expect(block).toBe(
      "Last session: 15 tool calls over 5m 0s. Modified 3 file(s): auth.ts, api.ts, util.ts. Branch: main."
    );
  });

  it("caps the file list at 3 basenames and adds a (+K more) suffix", () => {
    const block = formatSessionResumeBlock(
      makePayload({
        modified_files: [
          "src/a.ts",
          "src/b.ts",
          "src/c.ts",
          "src/d.ts",
          "src/e.ts",
        ],
      })
    );
    expect(block).toContain("Modified 5 file(s): a.ts, b.ts, c.ts (+2 more).");
  });

  it("omits the Modified clause when modified_files is empty", () => {
    const block = formatSessionResumeBlock(makePayload({ modified_files: [] }));
    expect(block).not.toContain("Modified");
  });

  it("omits the Modified clause when modified_files is undefined (degrades gracefully)", () => {
    const payload = makePayload();
    // biome-ignore lint/performance/noDelete: exercising the optional-field path
    delete (payload as { modified_files?: string[] }).modified_files;
    const block = formatSessionResumeBlock(payload);
    expect(block).not.toContain("Modified");
    expect(block).toBe("Last session: 15 tool calls over 5m 0s. Branch: main.");
  });

  it("formats duration in minutes and seconds", () => {
    const block = formatSessionResumeBlock(
      makePayload({
        previous_session: {
          ...makePayload().previous_session,
          duration_ms: 90_000,
        },
      })
    );
    expect(block).toContain("over 1m 30s");
  });

  it("truncates to 500 chars max", () => {
    const block = formatSessionResumeBlock(
      makePayload({
        modified_files: Array.from(
          { length: 3 },
          (_, i) => `src/very-long-descriptive-directory-name-${i}/file-${i}.ts`
        ),
      })
    );
    expect(block.length).toBeLessThanOrEqual(500);
  });

  it("appends the incomplete-work hint when it is not the default", () => {
    const block = formatSessionResumeBlock(
      makePayload({
        continuity: {
          hot_files: [],
          incomplete_hint: "Continuing work on src/auth.ts",
          staleness: "fresh",
        },
      })
    );
    expect(block).toContain("Continuing work on src/auth.ts");
  });

  it("omits the hint when it is the default 'No specific continuity context'", () => {
    const block = formatSessionResumeBlock(makePayload());
    expect(block).not.toContain("No specific continuity context");
  });

  it("renders broken_callers with singular/plural wording, capped at 2", () => {
    const block = formatSessionResumeBlock(
      makePayload({
        broken_callers: [
          { entity: "src/pay.ts::processPayment", callers: ["a", "b"] },
          { entity: "applyRefund", callers: ["c"] },
          { entity: "third", callers: ["d", "e", "f"] },
        ],
      })
    );
    expect(block).toContain(
      "Callers still to update: processPayment (2 callers), applyRefund (1 caller)"
    );
    expect(block).not.toContain("third");
  });

  it("omits the callers clause when broken_callers is empty", () => {
    const block = formatSessionResumeBlock(makePayload({ broken_callers: [] }));
    expect(block).not.toContain("Callers still to update");
  });
});
