import { describe, expect, it } from "vitest";
import {
  type PromptForTurn,
  matchPromptsToTurns,
} from "../tracking/prompt-trace.js";

// §5 bridge: the captured prompt is keyed by an integer turn, timeline turns
// by a hex turn_id with only started_at/ended_at. matchPromptsToTurns joins
// them by time — a prompt initiates the turn it arrived just before.

function mkPrompt(ms: number, prompt: string | null): PromptForTurn {
  return {
    session_id: "s1",
    turn: 0,
    prompt,
    length: prompt?.length ?? 0,
    classified_as: null,
    ts: new Date(ms).toISOString(),
  };
}

const turns = [
  { turn_id: "t1", started_at: 1000, ended_at: 2000 },
  { turn_id: "t2", started_at: 3000, ended_at: 4000 },
];

describe("matchPromptsToTurns", () => {
  it("assigns a prompt that arrived just before a turn to that turn", () => {
    const m = matchPromptsToTurns(turns, [
      mkPrompt(900, "kick off t1"),
      mkPrompt(2500, "kick off t2"),
    ]);
    expect(m.get("t1")?.prompt).toBe("kick off t1");
    expect(m.get("t2")?.prompt).toBe("kick off t2");
  });

  it("assigns a prompt inside a turn's window to that turn", () => {
    const m = matchPromptsToTurns(turns, [mkPrompt(1500, "during t1")]);
    expect(m.get("t1")?.prompt).toBe("during t1");
    expect(m.has("t2")).toBe(false);
  });

  it("picks the earliest (initiating) prompt when several fall in one window", () => {
    const m = matchPromptsToTurns(turns, [
      mkPrompt(950, "the ask"),
      mkPrompt(1500, "a follow-up mid-turn"),
    ]);
    expect(m.get("t1")?.prompt).toBe("the ask");
  });

  it("does not steal a later turn's prompt for an earlier turn", () => {
    // Only one prompt, in t2's gap — t1 must stay unmatched.
    const m = matchPromptsToTurns(turns, [mkPrompt(2500, "only t2")]);
    expect(m.has("t1")).toBe(false);
    expect(m.get("t2")?.prompt).toBe("only t2");
  });

  it("passes through capture-off rows (null prompt) so the UI can hint", () => {
    const m = matchPromptsToTurns(turns, [mkPrompt(900, null)]);
    expect(m.has("t1")).toBe(true);
    expect(m.get("t1")?.prompt).toBeNull();
  });

  it("ignores prompts after every turn and unparseable timestamps", () => {
    const bad = { ...mkPrompt(0, "bad ts"), ts: "not-a-date" };
    const m = matchPromptsToTurns(turns, [mkPrompt(9000, "too late"), bad]);
    expect(m.size).toBe(0);
  });
});
