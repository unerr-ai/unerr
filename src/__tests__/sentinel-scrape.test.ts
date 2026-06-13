/**
 * `unerr-save:` sentinel scrape guard (Phase-2 Sprint 7, T7.9).
 *
 * The Stop hook scrapes these from the agent's closing message and persists
 * them fire-and-forget — replacing the round-trip a Moment-4 `unerr_remember` /
 * `mark_*` tool call would cost. Locks: (1) only well-formed sentinels parse;
 * (2) note wires validate kind/anchor/polarity; (3) content may contain `|`;
 * (4) markers carry free text; (5) persist + transcript-read degrade safely.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  persistSentinels,
  readClosingMessageFromTranscript,
} from "../hooks/sentinel-persist.js";
import {
  parseSentinelBody,
  scrapeSentinels,
} from "../hooks/sentinel-scrape.js";

describe("scrapeSentinels — note form", () => {
  it("parses a well-formed note wire", () => {
    const msg = [
      "Done. Here's what I changed.",
      "unerr-save: note rul|f:src/proxy/bridge.ts|-|no intelligence imports",
      "Cheers.",
    ].join("\n");
    expect(scrapeSentinels(msg)).toEqual([
      {
        kind: "note",
        wire: "rul|f:src/proxy/bridge.ts|-|no intelligence imports",
      },
    ]);
  });

  it("keeps `|` inside content (only first 3 bars are separators)", () => {
    const save = parseSentinelBody("note fct|e:dispatch|~|routes a|b|c by op");
    expect(save).toEqual({
      kind: "note",
      wire: "fct|e:dispatch|~|routes a|b|c by op",
    });
  });

  it("survives a leading list marker", () => {
    const msg = "- unerr-save: dec|e:TURN_GAP|+|15s avoids RTT misclass";
    expect(scrapeSentinels(msg)).toHaveLength(1);
  });

  it.each([
    "note bad|f:x.ts|-|content", // invalid kind
    "note rul|x.ts|-|content", //   anchor missing sigil
    "note rul|f:x.ts|?|content", //  invalid polarity
    "note rul|f:x.ts|-|", //         empty content
    "note rul|f:x.ts", //            too few fields
  ])("drops malformed note: %s", (body) => {
    expect(parseSentinelBody(body)).toBeNull();
  });
});

describe("scrapeSentinels — marker forms", () => {
  it("parses each of the four markers", () => {
    const msg = [
      "unerr-save: intent reduce per-turn round-trips",
      "unerr-save: decision UDS tools/call over a new control method",
      "unerr-save: blocker proxy busy indexing during test",
      "unerr-save: resolution pinned vitest pool to forks",
    ].join("\n");
    expect(scrapeSentinels(msg)).toEqual([
      { kind: "marker", op: "intent", text: "reduce per-turn round-trips" },
      {
        kind: "marker",
        op: "decision",
        text: "UDS tools/call over a new control method",
      },
      {
        kind: "marker",
        op: "blocker",
        text: "proxy busy indexing during test",
      },
      { kind: "marker", op: "resolution", text: "pinned vitest pool to forks" },
    ]);
  });

  it("drops an unknown head token", () => {
    expect(parseSentinelBody("ponder something")).toBeNull();
  });

  it("drops an empty body", () => {
    expect(scrapeSentinels("unerr-save:")).toEqual([]);
  });

  it("returns [] for a message with no sentinels", () => {
    expect(scrapeSentinels("just a normal closing message")).toEqual([]);
    expect(scrapeSentinels("")).toEqual([]);
  });
});

describe("readClosingMessageFromTranscript", () => {
  it("returns the last assistant text from a JSONL transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "unerr-transcript-"));
    const path = join(dir, "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hi" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "unerr-save: intent ship it" }],
          },
        }),
      ].join("\n")
    );
    expect(readClosingMessageFromTranscript(path)).toBe(
      "unerr-save: intent ship it"
    );
  });

  it("returns '' for a missing / undefined path", () => {
    expect(readClosingMessageFromTranscript(undefined)).toBe("");
    expect(readClosingMessageFromTranscript("/tmp/unerr-nope.jsonl")).toBe("");
  });
});

describe("persistSentinels — degradation", () => {
  it("returns 0 with no proxy socket", async () => {
    const out = await persistSentinels(
      [{ kind: "marker", op: "intent", text: "x" }],
      { sockPath: "/tmp/unerr-no-such.sock", timeoutMs: 50 }
    );
    expect(out).toBe(0);
  });

  it("returns 0 for an empty save list", async () => {
    expect(await persistSentinels([])).toBe(0);
  });
});

describe("scrape→persist end-to-end shape (proxy-down)", () => {
  it("a closing message with mixed saves yields the parsed set", () => {
    const closing = [
      "Summary of work.",
      "unerr-save: note wrn|g:*.test.ts|-|don't mock cozo db",
      "unerr-save: decision demote writes to hooks",
      "garbage unerr-save: note bad", // dropped
    ].join("\n");
    const saves = scrapeSentinels(closing);
    expect(saves).toHaveLength(2);
    expect(existsSync("/definitely/not/a/sock")).toBe(false);
  });
});
