import { describe, expect, it } from "vitest";
import {
  type ImportanceInput,
  byImportanceDesc,
  importanceScore,
} from "../intelligence/importance.js";

/** Identity getter for tests that hold the entity shape directly. */
const id = (e: ImportanceInput): ImportanceInput => e;

describe("importanceScore", () => {
  it("scores higher fan_in higher", () => {
    const low = importanceScore({ fan_in: 1 });
    const high = importanceScore({ fan_in: 10 });
    expect(high).toBeGreaterThan(low);
  });

  it("scores higher risk_level higher", () => {
    const normal = importanceScore({ risk_level: "normal" });
    const medium = importanceScore({ risk_level: "medium" });
    const high = importanceScore({ risk_level: "high" });
    const critical = importanceScore({ risk_level: "critical" });
    expect(medium).toBeGreaterThan(normal);
    expect(high).toBeGreaterThan(medium);
    expect(critical).toBeGreaterThan(high);
  });

  it("treats low and normal risk as the same lowest rank", () => {
    expect(importanceScore({ risk_level: "low" })).toBe(
      importanceScore({ risk_level: "normal" })
    );
  });

  it("is case-insensitive on risk_level", () => {
    expect(importanceScore({ risk_level: "HIGH" })).toBe(
      importanceScore({ risk_level: "high" })
    );
  });

  it("defaults missing columns to the lowest score (0)", () => {
    expect(importanceScore({})).toBe(0);
    expect(importanceScore({ fan_in: undefined, risk_level: undefined })).toBe(
      0
    );
  });

  it("treats invalid/negative/NaN counts as 0, never throwing", () => {
    expect(importanceScore({ fan_in: -5 })).toBe(0);
    expect(importanceScore({ fan_in: Number.NaN })).toBe(0);
    expect(importanceScore({ fan_out: Number.POSITIVE_INFINITY })).toBe(0);
  });

  it("treats unknown risk_level strings as the lowest rank", () => {
    expect(importanceScore({ risk_level: "totally-unknown" })).toBe(0);
    expect(importanceScore({ risk_level: "" })).toBe(0);
  });

  it("is deterministic: same input → same score", () => {
    const e: ImportanceInput = { fan_in: 7, fan_out: 3, risk_level: "high" };
    expect(importanceScore(e)).toBe(importanceScore(e));
    expect(importanceScore({ ...e })).toBe(importanceScore({ ...e }));
  });

  it("combines fan_in, fan_out, and risk per the documented formula", () => {
    // 3*fan_in + 1*fan_out + 4*rank(high=2) = 3*5 + 3 + 8 = 26
    expect(importanceScore({ fan_in: 5, fan_out: 3, risk_level: "high" })).toBe(
      26
    );
  });
});

describe("byImportanceDesc", () => {
  it("orders highest-importance first", () => {
    const items: ImportanceInput[] = [
      { key: "leaf", fan_in: 0 },
      { key: "hub", fan_in: 20, risk_level: "high" },
      { key: "mid", fan_in: 5 },
    ];
    const ordered = byImportanceDesc(items, id).map((e) => e.key);
    expect(ordered).toEqual(["hub", "mid", "leaf"]);
  });

  it("does not mutate the input array", () => {
    const items: ImportanceInput[] = [
      { key: "a", fan_in: 1 },
      { key: "b", fan_in: 9 },
    ];
    const before = [...items];
    byImportanceDesc(items, id);
    expect(items).toEqual(before);
  });

  it("breaks ties by key, not by input order", () => {
    // All three have identical score (fan_in:5) — order must be by key.
    const forward: ImportanceInput[] = [
      { key: "c", fan_in: 5 },
      { key: "a", fan_in: 5 },
      { key: "b", fan_in: 5 },
    ];
    const reversed: ImportanceInput[] = [...forward].reverse();
    expect(byImportanceDesc(forward, id).map((e) => e.key)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // Different input order → identical output order (key tiebreak, not input).
    expect(byImportanceDesc(reversed, id).map((e) => e.key)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is deterministic: same input → identical order across calls", () => {
    const items: ImportanceInput[] = [
      { key: "x", fan_in: 3, risk_level: "medium" },
      { key: "y", fan_in: 3, risk_level: "medium" },
      { key: "z", fan_in: 8, risk_level: "high" },
    ];
    const first = byImportanceDesc(items, id).map((e) => e.key);
    const second = byImportanceDesc(items, id).map((e) => e.key);
    expect(first).toEqual(second);
  });

  it("sorts entities missing columns to the bottom (treated as 0)", () => {
    const items: ImportanceInput[] = [
      { key: "empty" },
      { key: "loaded", fan_in: 4, risk_level: "critical" },
    ];
    expect(byImportanceDesc(items, id).map((e) => e.key)).toEqual([
      "loaded",
      "empty",
    ]);
  });

  it("works through a wrapper getter", () => {
    interface Wrapper {
      name: string;
      entity: ImportanceInput;
    }
    const wrapped: Wrapper[] = [
      { name: "small", entity: { key: "small", fan_in: 1 } },
      { name: "big", entity: { key: "big", fan_in: 30 } },
    ];
    const ordered = byImportanceDesc(wrapped, (w) => w.entity).map(
      (w) => w.name
    );
    expect(ordered).toEqual(["big", "small"]);
  });
});
