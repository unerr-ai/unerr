import { describe, expect, it } from "vitest";
import {
  NoteDslError,
  type ParsedNote,
  dedupeKey,
  parseNote,
  serializeNote,
} from "../intelligence/note-dsl.js";

describe("note-dsl parser (A2)", () => {
  it("parses all six kinds and four anchor types", () => {
    const cases: Array<[string, ParsedNote]> = [
      [
        "cnv|p:|+|all CozoDB calls use await",
        {
          kind: "cnv",
          anchor_type: "p",
          anchor_value: "",
          polarity: "+",
          content: "all CozoDB calls use await",
        },
      ],
      [
        "rul|f:src/proxy/bridge.ts|-|no intelligence imports",
        {
          kind: "rul",
          anchor_type: "f",
          anchor_value: "src/proxy/bridge.ts",
          polarity: "-",
          content: "no intelligence imports",
        },
      ],
      [
        "wrn|g:*.test.ts|-|don't mock cozo db",
        {
          kind: "wrn",
          anchor_type: "g",
          anchor_value: "*.test.ts",
          polarity: "-",
          content: "don't mock cozo db",
        },
      ],
      [
        "dec|e:TURN_OPEN_GAP_MS|+|15s avoids RTT misclassification",
        {
          kind: "dec",
          anchor_type: "e",
          anchor_value: "TURN_OPEN_GAP_MS",
          polarity: "+",
          content: "15s avoids RTT misclassification",
        },
      ],
      [
        "blk|f:src/proxy/proxy.ts|~|stdio + UDS sites must mirror",
        {
          kind: "blk",
          anchor_type: "f",
          anchor_value: "src/proxy/proxy.ts",
          polarity: "~",
          content: "stdio + UDS sites must mirror",
        },
      ],
      [
        "fct|f:src/proxy/turn-state.ts|+|noteToolCall returns ToolCallNote",
        {
          kind: "fct",
          anchor_type: "f",
          anchor_value: "src/proxy/turn-state.ts",
          polarity: "+",
          content: "noteToolCall returns ToolCallNote",
        },
      ],
    ];

    for (const [wire, expected] of cases) {
      expect(parseNote(wire)).toEqual(expected);
    }
  });

  it("preserves '|' characters inside content (split-3 contract)", () => {
    const wire = "rul|p:|+|use a|b|c pattern in args";
    const parsed = parseNote(wire);
    expect(parsed.content).toBe("use a|b|c pattern in args");
  });

  it("rejects missing anchor value for non-project kinds", () => {
    expect(() => parseNote("rul|f:|+|something")).toThrow(NoteDslError);
    expect(() => parseNote("rul|e:|+|something")).toThrow(NoteDslError);
    expect(() => parseNote("rul|g:|+|something")).toThrow(NoteDslError);
  });

  it("accepts empty value for project-wide anchor", () => {
    const parsed = parseNote("cnv|p:|+|project-wide rule");
    expect(parsed.anchor_type).toBe("p");
    expect(parsed.anchor_value).toBe("");
  });

  it("rejects invalid kind, anchor_type, and polarity", () => {
    expect(() => parseNote("xxx|f:src/a.ts|+|content")).toThrow(/invalid kind/);
    expect(() => parseNote("rul|x:foo|+|content")).toThrow(
      /invalid anchor_type/,
    );
    expect(() => parseNote("rul|f:src/a.ts|*|content")).toThrow(
      /invalid polarity/,
    );
  });

  it("rejects empty or whitespace-only content", () => {
    expect(() => parseNote("rul|f:src/a.ts|+|")).toThrow(/content required/);
    expect(() => parseNote("rul|f:src/a.ts|+|   ")).toThrow(/content required/);
  });

  it("rejects malformed input shapes", () => {
    expect(() => parseNote("")).toThrow(NoteDslError);
    expect(() => parseNote("rul|f:src/a.ts")).toThrow(/expected 4 fields/);
    expect(() => parseNote("rul|fsrc/a.ts|+|content")).toThrow(/anchor/);
  });
});

describe("note-dsl serializer (A2)", () => {
  it("round-trips parse → serialize for typical inputs", () => {
    const wires = [
      "cnv|p:|+|all CozoDB calls use await",
      "rul|f:src/proxy/bridge.ts|-|no intelligence imports",
      "blk|f:src/proxy/proxy.ts|~|stdio + UDS sites must mirror",
      "wrn|g:*.test.ts|-|don't mock cozo db",
    ];
    for (const wire of wires) {
      expect(serializeNote(parseNote(wire))).toBe(wire);
    }
  });

  it("rejects invalid inputs at serialize time", () => {
    expect(() =>
      serializeNote({
        kind: "xxx" as never,
        anchor_type: "f",
        anchor_value: "a.ts",
        polarity: "+",
        content: "x",
      }),
    ).toThrow(/invalid kind/);

    expect(() =>
      serializeNote({
        kind: "rul",
        anchor_type: "f",
        anchor_value: "",
        polarity: "+",
        content: "x",
      }),
    ).toThrow(/anchor required/);
  });
});

describe("note-dsl dedupe key (A2)", () => {
  it("identical notes produce identical keys", () => {
    const a = parseNote("rul|f:src/a.ts|+|use Promise.all here");
    const b = parseNote("rul|f:src/a.ts|+|use Promise.all here");
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it("whitespace and case variations collapse to same key", () => {
    const a = parseNote("rul|f:src/a.ts|+|use Promise.all here always");
    const b = parseNote("rul|f:src/a.ts|+|USE   Promise.all   HERE always");
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it("first-5-words is the boundary — beyond word 5 doesn't affect key", () => {
    const a = parseNote("cnv|p:|+|one two three four five six seven");
    const b = parseNote("cnv|p:|+|one two three four five DIFFERENT TAIL");
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it("first-5-words distinguishes when leading words differ", () => {
    const a = parseNote("cnv|p:|+|alpha beta gamma delta epsilon");
    const b = parseNote("cnv|p:|+|alpha beta gamma delta ZETA");
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  });

  it("different kind / anchor / polarity → different key", () => {
    const base = parseNote("rul|f:src/a.ts|+|content here");
    expect(dedupeKey({ ...base, kind: "wrn" })).not.toBe(dedupeKey(base));
    expect(dedupeKey({ ...base, anchor_value: "src/b.ts" })).not.toBe(
      dedupeKey(base),
    );
    expect(dedupeKey({ ...base, polarity: "-" })).not.toBe(dedupeKey(base));
  });
});
