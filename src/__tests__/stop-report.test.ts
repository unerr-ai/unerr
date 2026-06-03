/**
 * Plain-English Stop close-out report (`formatStopReport`).
 *
 * The Stop hook surfaces this as a user-facing `systemMessage` (Claude Code
 * labels it "Stop says: …"). It must (a) lead with the "unerr reports" brand
 * and (b) speak plain English — no unerr-internal framing ("session:",
 * "this turn:", "chat room earned"), no raw tool/event-type identifiers.
 */

import { describe, expect, it } from "vitest";

import { formatStopReport } from "../proxy/turn-footer.js";

const NONE = {
  turnTokensSaved: 0,
  sessionTokensSaved: 0,
  sessionHeadroom: 0,
  turnHighlights: [],
  sessionHighlights: [],
};

/** Internal jargon that must never reach this user-facing line. */
const BANNED = [
  /\bsession:/i,
  /\bthis turn:/i,
  /chat room/i,
  /\bSurface\s*[1-4]\b/i,
  /\bSTEP-\s*[0-9N]\b/i,
  /headroom/i,
  /\bunerr_[a-z_]+\b/,
];

function assertClean(line: string): void {
  for (const pat of BANNED) {
    expect(line, `banned jargon ${pat} in: ${line}`).not.toMatch(pat);
  }
}

describe("formatStopReport — branding + plain English", () => {
  it("leads with 'unerr reports' on a productive turn", () => {
    const line = formatStopReport({
      ...NONE,
      turnTokensSaved: 12_345,
      sessionTokensSaved: 25_000,
      sessionHeadroom: 3,
      turnHighlights: [
        { event_type: "shell_compressed", count: 12, phrasing: "trimmed shell outputs" },
        { event_type: "review_finding", count: 6, phrasing: "review findings" },
      ],
    });
    expect(line.startsWith("unerr reports — ")).toBe(true);
    expect(line).toContain("saved 12,345 tokens this turn");
    expect(line).toContain("12 trimmed shell outputs, 6 review findings");
    expect(line).toContain("25k tokens saved in total");
    expect(line).toContain("3 more turns of room before this chat fills up");
    assertClean(line);
  });

  it("uses the exact integer for the per-turn count, rounds the session total", () => {
    const line = formatStopReport({
      ...NONE,
      turnTokensSaved: 1_234,
      sessionTokensSaved: 100_175,
    });
    expect(line).toContain("saved 1,234 tokens this turn");
    expect(line).toContain("100k tokens saved in total");
  });

  it("on a quiet turn (no per-turn savings) names concrete session activity", () => {
    const line = formatStopReport({
      ...NONE,
      sessionTokensSaved: 25_000,
      sessionHighlights: [
        { event_type: "graph_lookup", count: 12, phrasing: "code lookups" },
        { event_type: "compact_read", count: 8, phrasing: "compact file reads" },
        { event_type: "fact_recalled", count: 4, phrasing: "remembered notes" },
      ],
    });
    expect(line.startsWith("unerr reports — ")).toBe(true);
    expect(line).toContain(
      "12 code lookups, 8 compact file reads, 4 remembered notes so far this session"
    );
    expect(line).not.toContain("this turn");
    assertClean(line);
  });

  it("singular headroom reads 'turn', not 'turns'", () => {
    const line = formatStopReport({ ...NONE, sessionHeadroom: 1 });
    expect(line).toContain("1 more turn of room before this chat fills up");
  });

  it("excludes the prompt-boundary event from the spoken activity", () => {
    const line = formatStopReport({
      ...NONE,
      sessionTokensSaved: 1_000,
      sessionHighlights: [
        { event_type: "user_prompt_received", count: 9, phrasing: "prompts" },
        { event_type: "graph_lookup", count: 2, phrasing: "code lookups" },
      ],
    });
    expect(line).not.toContain("prompts");
    expect(line).toContain("2 code lookups");
  });

  it("returns empty string when there is nothing to report", () => {
    expect(formatStopReport(NONE)).toBe("");
  });

  it("caps per-turn highlights at 2 and session highlights at 3", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      event_type: `e${i}`,
      count: 10 - i,
      phrasing: `thing${i}`,
    }));
    const turn = formatStopReport({ ...NONE, turnTokensSaved: 5, turnHighlights: many });
    expect(turn).toContain("(10 thing0, 9 thing1)");
    expect(turn).not.toContain("thing2");

    const quiet = formatStopReport({ ...NONE, sessionTokensSaved: 5, sessionHighlights: many });
    expect(quiet).toContain("thing0, 9 thing1, 8 thing2 so far");
    expect(quiet).not.toContain("thing3");
  });
});
