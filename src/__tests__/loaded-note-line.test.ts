/**
 * Tests for `renderLoadedNoteLine` — the Surface 2 `loaded …` line
 * renderer shared by `context-preface.ts` (proxy ambient preface) and
 * `prompt-hooks.ts` (agent nudge mirror).
 *
 * Coverage matrix:
 *   - every NoteKind label translation (cnv/rul/wrn/dec/blk/fct)
 *   - every NoteAnchorType phrase (f / e / g / p)
 *   - every NotePolarity suffix (+ / - / ~) × kind interactions
 *   - reinforcement badge threshold (count ≥ 3)
 *   - anchor-missing annotation (f-anchor + e-anchor)
 *   - conflict_group_id tail
 *   - cold-start guided empty state
 *   - file-only no-note path
 *   - null-everything → null return
 *   - top-file deduplication against the note's own anchor
 *   - long-path collapse (shortPath)
 *   - long-content clip with word-boundary ellipsis
 */

import { describe, expect, it } from "vitest";

import {
  type LoadedNoteFields,
  isColdStartNote,
  isValidAnchorType,
  isValidKind,
  isValidPolarity,
  renderLoadedNoteLine,
} from "../proxy/loaded-note-line.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function baseNote(overrides: Partial<LoadedNoteFields> = {}): LoadedNoteFields {
  return {
    kind: "rul",
    anchor_type: "f",
    anchor_value: "src/proxy/bridge.ts",
    polarity: "+",
    content: "no intelligence imports",
    created_at: NOW - 2 * DAY,
    reinforcement_count: 0,
    anchor_missing: false,
    conflict_group_id: "",
    ...overrides,
  };
}

describe("renderLoadedNoteLine — kind translation", () => {
  it("renders rul → rule", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "rul" }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a rule");
  });

  it("renders cnv → convention (with 'a' article — c is consonant)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "cnv", content: "always await db.run" }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a convention");
  });

  it("renders wrn → warning (with 'a' article — w is consonant)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "wrn", content: "don't mock cozo db" }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a warning");
  });

  it("renders dec → decision", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "dec", content: "15s avoids RTT misclassification" }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a decision");
  });

  it("renders blk → blocker", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "blk", content: "scip-typescript missing on PATH" }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a blocker");
  });

  it("renders fct → fact", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        kind: "fct",
        anchor_type: "p",
        anchor_value: "",
        content: "Node20+ ESM throughout",
      }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a fact");
  });
});

describe("renderLoadedNoteLine — anchor phrases", () => {
  it("f anchor → for <path>", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ anchor_type: "f", anchor_value: "src/proxy/bridge.ts" }),
      nowMs: NOW,
    });
    expect(line).toContain("for src/proxy/bridge.ts");
  });

  it("e anchor → for `<entity>`", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        anchor_type: "e",
        anchor_value: "handleUnerrRecallNotesProxy",
      }),
      nowMs: NOW,
    });
    expect(line).toContain("for `handleUnerrRecallNotesProxy`");
  });

  it("g anchor → for files matching <glob>", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ anchor_type: "g", anchor_value: "*.test.ts" }),
      nowMs: NOW,
    });
    expect(line).toContain("for files matching *.test.ts");
  });

  it("p anchor → no 'for' phrase (omitted as filler)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        anchor_type: "p",
        anchor_value: "",
        kind: "rul",
        content: "always typecheck before commit",
      }),
      nowMs: NOW,
    });
    expect(line).not.toContain(" for ");
    expect(line).toContain('"always typecheck before commit"');
  });

  it("f anchor + anchor_missing → file no longer in repo", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        anchor_type: "f",
        anchor_value: "src/legacy/old.ts",
        anchor_missing: true,
      }),
      nowMs: NOW,
    });
    expect(line).toContain("for src/legacy/old.ts (file no longer in repo)");
  });

  it("e anchor + anchor_missing → entity not found", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        anchor_type: "e",
        anchor_value: "deletedFunc",
        anchor_missing: true,
      }),
      nowMs: NOW,
    });
    expect(line).toContain("for `deletedFunc` (entity not found)");
  });
});

describe("renderLoadedNoteLine — polarity suffix", () => {
  it("polarity + → no suffix", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "rul", polarity: "+" }),
      nowMs: NOW,
    });
    expect(line).not.toContain("(don't)");
    expect(line).not.toContain("(mixed)");
  });

  it("polarity - on rul → (don't)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "rul", polarity: "-" }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a rule (don't)");
  });

  it("polarity - on wrn → no (don't) suffix (warning is implicitly negative)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "wrn", polarity: "-" }),
      nowMs: NOW,
    });
    expect(line).not.toContain("(don't)");
    expect(line).toContain("loaded a warning");
  });

  it("polarity - on blk → no (don't) suffix (blocker is implicitly negative)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "blk", polarity: "-" }),
      nowMs: NOW,
    });
    expect(line).not.toContain("(don't)");
  });

  it("polarity ~ → (mixed) on any kind", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ kind: "dec", polarity: "~" }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a decision (mixed)");
  });
});

describe("renderLoadedNoteLine — reinforcement badge", () => {
  it("count 0 → no badge", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ reinforcement_count: 0 }),
      nowMs: NOW,
    });
    expect(line).not.toContain("reinforced");
  });

  it("count 2 → no badge (under threshold)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ reinforcement_count: 2 }),
      nowMs: NOW,
    });
    expect(line).not.toContain("reinforced");
  });

  it("count 3 → (reinforced 3×)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ reinforcement_count: 3 }),
      nowMs: NOW,
    });
    expect(line).toContain("(reinforced 3×)");
  });

  it("count 10 → (reinforced 10×)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ reinforcement_count: 10 }),
      nowMs: NOW,
    });
    expect(line).toContain("(reinforced 10×)");
  });
});

describe("renderLoadedNoteLine — conflict tail", () => {
  it("non-empty conflict_group_id → appends conflict marker", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ conflict_group_id: "conflict-abc-123" }),
      nowMs: NOW,
    });
    expect(line).toContain("· ⚠ conflicting note exists");
  });

  it("empty conflict_group_id → no marker", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ conflict_group_id: "" }),
      nowMs: NOW,
    });
    expect(line).not.toContain("conflicting");
  });
});

describe("renderLoadedNoteLine — top file dedup", () => {
  it("appends 'also primed <file>' when topFile differs from anchor", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        anchor_type: "f",
        anchor_value: "src/proxy/bridge.ts",
      }),
      topFile: "src/proxy/router-gateway.ts",
      nowMs: NOW,
    });
    expect(line).toContain("· also primed src/proxy/router-gateway.ts");
  });

  it("omits 'also primed' when topFile matches the note's f-anchor", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        anchor_type: "f",
        anchor_value: "src/proxy/bridge.ts",
      }),
      topFile: "src/proxy/bridge.ts",
      nowMs: NOW,
    });
    expect(line).not.toContain("also primed");
  });

  it("includes 'also primed' when the anchor is an entity (no path overlap)", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        anchor_type: "e",
        anchor_value: "fooBar",
      }),
      topFile: "src/proxy/handler.ts",
      nowMs: NOW,
    });
    expect(line).toContain("· also primed src/proxy/handler.ts");
  });
});

describe("renderLoadedNoteLine — cold-start", () => {
  it("p-anchored fct + smoke-test signature + 0 reinforcement → guided empty", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        kind: "fct",
        anchor_type: "p",
        anchor_value: "",
        reinforcement_count: 0,
        content: "smoke-test note for verification",
      }),
      nowMs: NOW,
    });
    expect(line).toBe(
      'nothing project-specific stored yet — say "remember <rule>" to teach unerr your rules'
    );
  });

  it("legitimate p-anchored fct (no signature, no reinforcement) → renders normally", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        kind: "fct",
        anchor_type: "p",
        anchor_value: "",
        reinforcement_count: 0,
        content: "Node20+ ESM throughout the codebase",
      }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a fact");
    expect(line).not.toContain("nothing project-specific stored");
  });

  it("smoke-test signature but reinforced ≥ 1 → not cold-start (user-touched)", () => {
    const note = baseNote({
      kind: "fct",
      anchor_type: "p",
      anchor_value: "",
      reinforcement_count: 1,
      content: "verification smoke-test entry",
    });
    expect(isColdStartNote(note)).toBe(false);
  });

  it("smoke-test signature on file anchor → not cold-start (anchored, not generic)", () => {
    const note = baseNote({
      kind: "fct",
      anchor_type: "f",
      anchor_value: "src/x.ts",
      reinforcement_count: 0,
      content: "smoke-test note",
    });
    expect(isColdStartNote(note)).toBe(false);
  });

  it("isColdStartNote false for rul/cnv/wrn/dec/blk regardless of content", () => {
    for (const kind of ["rul", "cnv", "wrn", "dec", "blk"] as const) {
      const note = baseNote({
        kind,
        anchor_type: "p",
        anchor_value: "",
        reinforcement_count: 0,
        content: "smoke-test verification",
      });
      expect(isColdStartNote(note)).toBe(false);
    }
  });
});

describe("renderLoadedNoteLine — file-only / null paths", () => {
  it("null note + topFile → 'primed <file>'", () => {
    const line = renderLoadedNoteLine({
      note: null,
      topFile: "src/proxy/handler.ts",
    });
    expect(line).toBe("primed src/proxy/handler.ts");
  });

  it("null note + null topFile → returns null", () => {
    const line = renderLoadedNoteLine({ note: null });
    expect(line).toBeNull();
  });

  it("null note + empty topFile string → returns null", () => {
    const line = renderLoadedNoteLine({ note: null, topFile: "" });
    expect(line).toBeNull();
  });
});

describe("renderLoadedNoteLine — long content / path clipping", () => {
  it("collapses long file paths to …/parent/basename", () => {
    const longPath =
      "src/foo/bar/baz/qux/very/deeply/nested/component/handler.ts";
    const line = renderLoadedNoteLine({
      note: baseNote({ anchor_type: "f", anchor_value: longPath }),
      nowMs: NOW,
    });
    expect(line).toContain("…/component/handler.ts");
    expect(line).not.toContain("src/foo/bar/baz/qux");
  });

  it("clips long content at word boundary with ellipsis", () => {
    const long =
      "this is a very long note content that exceeds the 100 character clip threshold and should be cut off at the last word boundary before the limit";
    const line = renderLoadedNoteLine({
      note: baseNote({ content: long }),
      nowMs: NOW,
    });
    expect(line).toContain("…");
    expect((line ?? "").length).toBeLessThan(long.length + 100);
  });

  it("short content not clipped", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ content: "short" }),
      nowMs: NOW,
    });
    expect(line).toContain('"short"');
    expect(line).not.toContain("…");
  });
});

describe("renderLoadedNoteLine — full canonical examples", () => {
  it("populated rule with file anchor, recent age, plain polarity", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        kind: "rul",
        anchor_type: "f",
        anchor_value: "src/proxy/bridge.ts",
        polarity: "+",
        content: "no intelligence imports",
        created_at: NOW - 2 * DAY,
        reinforcement_count: 0,
        anchor_missing: false,
        conflict_group_id: "",
      }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a rule");
    expect(line).toContain("you wrote 2d ago");
    expect(line).toContain("for src/proxy/bridge.ts");
    expect(line).toContain('"no intelligence imports"');
  });

  it("populated convention with reinforcement + top file", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        kind: "cnv",
        anchor_type: "f",
        anchor_value: "src/proxy/proxy.ts",
        polarity: "+",
        content: "always await db.run",
        created_at: NOW - 30 * DAY,
        reinforcement_count: 4,
      }),
      topFile: "src/proxy/router-gateway.ts",
      nowMs: NOW,
    });
    expect(line).toContain("loaded a convention");
    expect(line).toContain("(reinforced 4×)");
    expect(line).toContain('"always await db.run"');
    expect(line).toContain("· also primed src/proxy/router-gateway.ts");
  });

  it("warning with anchor_missing + conflict tail", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({
        kind: "wrn",
        anchor_type: "f",
        anchor_value: "src/legacy/old.ts",
        polarity: "-",
        content: "no callers expected",
        created_at: NOW - 5 * DAY,
        anchor_missing: true,
        conflict_group_id: "grp-X",
      }),
      nowMs: NOW,
    });
    expect(line).toContain("loaded a warning");
    expect(line).toContain("(file no longer in repo)");
    expect(line).toContain('"no callers expected"');
    expect(line).toContain("· ⚠ conflicting note exists");
  });
});

describe("runtime guards", () => {
  it("isValidKind accepts every DSL kind code", () => {
    for (const k of ["cnv", "rul", "wrn", "dec", "blk", "fct"]) {
      expect(isValidKind(k)).toBe(true);
    }
    expect(isValidKind("xxx")).toBe(false);
    expect(isValidKind(null)).toBe(false);
    expect(isValidKind(undefined)).toBe(false);
    expect(isValidKind(0)).toBe(false);
  });

  it("isValidAnchorType accepts every DSL anchor type", () => {
    for (const a of ["f", "e", "g", "p"]) {
      expect(isValidAnchorType(a)).toBe(true);
    }
    expect(isValidAnchorType("x")).toBe(false);
    expect(isValidAnchorType(null)).toBe(false);
  });

  it("isValidPolarity accepts +/-/~", () => {
    for (const p of ["+", "-", "~"]) {
      expect(isValidPolarity(p)).toBe(true);
    }
    expect(isValidPolarity("?")).toBe(false);
    expect(isValidPolarity(null)).toBe(false);
  });
});
