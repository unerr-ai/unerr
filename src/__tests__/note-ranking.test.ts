/**
 * Load-bearing note ranking (W5). Locks the deterministic ordering both
 * note-delivery surfaces share — recall (prompt-hooks) and the unerr_context
 * bundle — so the per-turn injected slice carries the highest-value notes and
 * stays byte-stable for a given set.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECALL_MAX,
  type RankableNote,
  loadBearingScore,
  rankLoadBearing,
  selectLoadBearing,
} from "../intelligence/note-ranking.js";

const note = (over: Partial<RankableNote>): RankableNote => ({
  kind: "fct",
  anchor: "p:",
  polarity: "~",
  content: "some context",
  ...over,
});

describe("loadBearingScore", () => {
  it("ranks a file-anchored rule above a project-anchored fact", () => {
    const rule = note({ kind: "rul", anchor: "f:src/x.ts", polarity: "-" });
    const fact = note({ kind: "fct", anchor: "p:", polarity: "~" });
    expect(loadBearingScore(rule)).toBeGreaterThan(loadBearingScore(fact));
  });

  it("rewards explicit do/don't polarity over ambiguous", () => {
    const directive = note({ polarity: "-" });
    const ambiguous = note({ polarity: "~" });
    expect(loadBearingScore(directive)).toBeGreaterThan(
      loadBearingScore(ambiguous)
    );
  });

  it("rewards lexical overlap with the prompt", () => {
    const tokens = new Set(["retry", "proxy", "bind"]);
    const onTopic = note({ content: "the proxy bind needs a retry loop" });
    const offTopic = note({ content: "unrelated dashboard styling concern" });
    expect(loadBearingScore(onTopic, tokens)).toBeGreaterThan(
      loadBearingScore(offTopic, tokens)
    );
  });

  it("treats an unknown kind as a weak fact, not zero", () => {
    expect(loadBearingScore(note({ kind: "mystery" }))).toBeGreaterThan(0);
  });
});

describe("rankLoadBearing", () => {
  it("orders highest score first and is stable on ties", () => {
    const a = note({ kind: "cnv", anchor: "g:*.ts", content: "alpha tie" });
    const b = note({ kind: "cnv", anchor: "g:*.ts", content: "beta tie" });
    const strong = note({ kind: "rul", anchor: "e:foo", polarity: "+" });
    const ranked = rankLoadBearing([a, b, strong]);
    expect(ranked[0]).toBe(strong);
    // a and b score equal → input order preserved.
    expect(ranked.indexOf(a)).toBeLessThan(ranked.indexOf(b));
  });

  it("is a pure reordering — same set in, same set out", () => {
    const notes = [
      note({ kind: "wrn", anchor: "f:a.ts" }),
      note({ kind: "fct" }),
      note({ kind: "dec", anchor: "e:bar" }),
    ];
    const ranked = rankLoadBearing(notes);
    expect(ranked).toHaveLength(notes.length);
    // Same membership, regardless of order (object identity).
    for (const n of notes) expect(ranked).toContain(n);
  });

  it("byte-stable across two calls for the same input", () => {
    const notes = [
      note({ kind: "rul", anchor: "f:a.ts", content: "one" }),
      note({ kind: "fct", anchor: "p:", content: "two" }),
    ];
    expect(rankLoadBearing(notes, "edit a.ts")).toEqual(
      rankLoadBearing(notes, "edit a.ts")
    );
  });
});

describe("selectLoadBearing", () => {
  it("keeps the top DEFAULT_RECALL_MAX by default", () => {
    const notes = Array.from({ length: DEFAULT_RECALL_MAX + 3 }, (_, i) =>
      note({ content: `note ${i}` })
    );
    expect(selectLoadBearing(notes)).toHaveLength(DEFAULT_RECALL_MAX);
  });

  it("honours an explicit max", () => {
    const notes = [note({}), note({}), note({})];
    expect(selectLoadBearing(notes, { max: 2 })).toHaveLength(2);
  });

  it("returns the full ranked list when max is negative", () => {
    const notes = [note({ kind: "rul" }), note({ kind: "fct" })];
    expect(selectLoadBearing(notes, { max: -1 })).toHaveLength(2);
  });

  it("drops the lowest-value notes, keeps the load-bearing ones", () => {
    const strong = note({ kind: "rul", anchor: "f:x.ts", polarity: "-" });
    const weak1 = note({ kind: "fct", anchor: "p:", content: "weak one" });
    const weak2 = note({ kind: "fct", anchor: "w:", content: "weak two" });
    const kept = selectLoadBearing([weak1, strong, weak2], { max: 1 });
    expect(kept).toEqual([strong]);
  });
});
