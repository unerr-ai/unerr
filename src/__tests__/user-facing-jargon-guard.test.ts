/**
 * User-facing de-jargon guard (Sprint 11, T11.4).
 *
 * The user reads the `unerr » …` block (USER_BLOCK_PREFIX channel). It must
 * speak plain, branded English — never internal jargon ("Surface 1/2/3/4",
 * "STEP-0/1/2/N", "Moment 1–4", "Layer A/B") and never a raw MCP tool name the
 * user can't act on. The MACHINE-facing `ur|<tag>` pipe channel is exempt — it
 * is documented protocol the agent consumes (CLAUDE.md), not user prose.
 *
 * This guard renders the user-facing producers across their branches and
 * asserts every emitted line is jargon-free. A regression (re-introducing
 * "Surface 2" or a leaked tool name into a user line) fails here.
 */

import { describe, expect, it } from "vitest";

import {
  type ContextPrefaceInputs,
  renderContextPreface,
} from "../proxy/context-preface.js";
import {
  type LoadedNoteFields,
  renderLoadedNoteLine,
} from "../proxy/loaded-note-line.js";
import { USER_BLOCK_PREFIX } from "../proxy/response-envelope.js";

/** Tokens that must never appear in a user-facing line. */
const BANNED_JARGON: RegExp[] = [
  /\bSurface\s*[1-4]\b/i,
  /\bSTEP-\s*[0-9N]\b/i,
  /\bMoment\s*[1-4]\b/i,
  /\bLayer\s*[AB]\b/,
  /\bur\|[a-z]{2,4}\b/, // the machine channel must not leak into user prose
];

/** A raw MCP tool name the user is told to "call" is a leak — the user can't
 *  call tools. (We match snake_case unerr_* / get_* / mark_* / record_* /
 *  recall_* tool identifiers, which only belong in agent/machine channels.) */
const TOOL_NAME_LEAK =
  /\b(unerr_[a-z_]+|get_[a-z_]+|mark_[a-z_]+|record_facts?|recall_facts|file_outline|file_read|search_code|review_changes)\b/;

function assertClean(line: string): void {
  for (const pat of BANNED_JARGON) {
    expect(line, `banned jargon ${pat} in user line: ${line}`).not.toMatch(pat);
  }
  expect(line, `leaked tool name in user line: ${line}`).not.toMatch(
    TOOL_NAME_LEAK
  );
}

const NOW = 1_700_000_000_000;

function baseNote(over: Partial<LoadedNoteFields> = {}): LoadedNoteFields {
  return {
    kind: "rul",
    anchor_type: "f",
    anchor_value: "src/proxy/bridge.ts",
    polarity: "+",
    content: "the bridge imports nothing from src/intelligence",
    created_at: NOW - 86_400_000,
    reinforcement_count: 3,
    anchor_missing: false,
    conflict_group_id: "",
    ...over,
  };
}

describe("renderContextPreface — every branch is jargon-free", () => {
  const branches: Array<{ name: string; inputs: ContextPrefaceInputs }> = [
    {
      name: "topic shift",
      inputs: {
        turnIndex: 2,
        events: [],
        topicShift: { flag: true, overlap: 0.25 },
        nowMs: NOW,
      },
    },
    {
      name: "rich recalled note",
      inputs: {
        turnIndex: 1,
        events: [],
        topNote: baseNote(),
        topFile: "src/proxy/proxy.ts",
        nowMs: NOW,
      },
    },
    {
      name: "legacy content note",
      inputs: {
        turnIndex: 1,
        events: [],
        topNoteContent: "always await CozoDB calls",
        topNoteCreatedAt: NOW - 3_600_000,
        nowMs: NOW,
      },
    },
    {
      name: "fresh session",
      inputs: { turnIndex: 0, events: [], isFreshSession: true, nowMs: NOW },
    },
    {
      name: "steering reminder",
      inputs: {
        turnIndex: 1,
        events: [],
        steering: "callers of this export need updating",
        nowMs: NOW,
      },
    },
    {
      name: "empty",
      inputs: { turnIndex: 3, events: [], nowMs: NOW },
    },
  ];

  it.each(branches)("$name", ({ inputs }) => {
    const lines = renderContextPreface(inputs);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) assertClean(line);
  });
});

describe("renderLoadedNoteLine — every kind/state is jargon-free", () => {
  const KINDS: LoadedNoteFields["kind"][] = [
    "rul",
    "cnv",
    "wrn",
    "dec",
    "blk",
    "fct",
  ];

  it.each(KINDS)("kind=%s", (kind) => {
    const line = renderLoadedNoteLine({ note: baseNote({ kind }), nowMs: NOW });
    expect(line).not.toBeNull();
    assertClean(line!);
  });

  it("conflict marker line is clean", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ conflict_group_id: "cg_1" }),
      nowMs: NOW,
    });
    assertClean(line!);
  });

  it("anchor-missing line is clean", () => {
    const line = renderLoadedNoteLine({
      note: baseNote({ anchor_missing: true }),
      nowMs: NOW,
    });
    assertClean(line!);
  });

  it("primed-file-only line is clean", () => {
    const line = renderLoadedNoteLine({
      note: null,
      topFile: "src/intelligence/query-router.ts",
      nowMs: NOW,
    });
    assertClean(line!);
  });
});

describe("user block channel leads with the brand", () => {
  it("USER_BLOCK_PREFIX leads with 'unerr'", () => {
    expect(USER_BLOCK_PREFIX.trimStart().startsWith("unerr")).toBe(true);
  });
});
