import { describe, expect, it } from "vitest";
import {
  type OrderableConvention,
  type OrderableNote,
  type OrderableTag,
  type PrefixBlock,
  orderConventions,
  orderNotes,
  orderTags,
  splitStableVolatile,
} from "../proxy/prefix-order.js";

/** Deterministic Fisher–Yates shuffle (seeded LCG) — no Math.random so the
 *  test itself is reproducible while still exercising "input order varies". */
function shuffle<T>(input: readonly T[], seed: number): T[] {
  const arr = [...input];
  let state = seed >>> 0;
  const next = (): number => {
    // Numerical Recipes LCG.
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

describe("orderNotes", () => {
  const notes: OrderableNote[] = [
    { anchor: "f:src/b.ts", kind: "rul", id: "n3", content: "z rule" },
    { anchor: "f:src/a.ts", kind: "wrn", id: "n2", content: "a warn" },
    { anchor: "f:src/a.ts", kind: "cnv", id: "n1", content: "a conv" },
    { anchor: "e:Foo", kind: "dec", id: "n0", content: "foo decision" },
    { anchor: "f:src/a.ts", kind: "cnv", id: "n4", content: "a conv 2" },
  ];

  it("orders by anchor → kind → id", () => {
    const out = orderNotes(notes).map((n) => n.id);
    // e:Foo < f:src/a.ts < f:src/b.ts (byte-wise). Within f:src/a.ts: cnv < wrn,
    // and the two cnv break by id n1 < n4.
    expect(out).toEqual(["n0", "n1", "n4", "n2", "n3"]);
  });

  it("is deterministic: same input twice → identical order", () => {
    expect(orderNotes(notes)).toEqual(orderNotes(notes));
  });

  it("is canonical: any shuffle → the same order", () => {
    const canonical = orderNotes(notes).map((n) => n.id);
    for (let seed = 1; seed <= 20; seed++) {
      expect(orderNotes(shuffle(notes, seed)).map((n) => n.id)).toEqual(
        canonical
      );
    }
  });

  it("falls back to content when id is absent", () => {
    const noId: OrderableNote[] = [
      { anchor: "f:x.ts", kind: "fct", content: "zebra" },
      { anchor: "f:x.ts", kind: "fct", content: "apple" },
    ];
    expect(orderNotes(noId).map((n) => n.content)).toEqual(["apple", "zebra"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...notes];
    orderNotes(notes);
    expect(notes).toEqual(copy);
  });
});

describe("orderTags", () => {
  const tags: OrderableTag[] = [
    { tag: "fct", body: "a fact" },
    { tag: "act", body: "do it now" },
    { tag: "rsk", body: "blast radius" },
    { tag: "ctx", body: "state changed" },
    { tag: "weird", body: "unknown tag" },
    { tag: "act", body: "another action" },
  ];

  it("orders by fixed priority bucket act → ctx → rsk → fct → other", () => {
    const out = orderTags(tags).map((t) => t.tag);
    // The two act lines come first (ties broken by body: "another" < "do it").
    expect(out).toEqual(["act", "act", "ctx", "rsk", "fct", "weird"]);
  });

  it("breaks ties within a bucket by body text", () => {
    const out = orderTags(tags)
      .filter((t) => t.tag === "act")
      .map((t) => t.body);
    expect(out).toEqual(["another action", "do it now"]);
  });

  it("matches the documented priority spec (act before fct)", () => {
    const out = orderTags(tags);
    const firstAct = out.findIndex((t) => t.tag === "act");
    const firstFct = out.findIndex((t) => t.tag === "fct");
    expect(firstAct).toBeLessThan(firstFct);
  });

  it("is deterministic and canonical under shuffle", () => {
    const canonical = orderTags(tags).map((t) => `${t.tag}:${t.body}`);
    for (let seed = 1; seed <= 20; seed++) {
      expect(
        orderTags(shuffle(tags, seed)).map((t) => `${t.tag}:${t.body}`)
      ).toEqual(canonical);
    }
  });

  it("does not mutate the input array", () => {
    const copy = [...tags];
    orderTags(tags);
    expect(tags).toEqual(copy);
  });
});

describe("orderConventions", () => {
  const convs: (OrderableConvention & { adherence_rate: number })[] = [
    { name: "z-style", file_path: "src/b.ts", adherence_rate: 0.99 },
    { name: "a-style", file_path: "src/a.ts", adherence_rate: 0.10 },
    { name: "b-style", file_path: "src/a.ts", adherence_rate: 0.50 },
  ];

  it("orders by file path → name, NOT by adherence_rate", () => {
    const out = orderConventions(convs).map((c) => c.name);
    // Pure path order: a.ts (a-style, b-style) then b.ts (z-style). If it had
    // sorted by adherence the highest (0.99, z-style) would lead — it must not.
    expect(out).toEqual(["a-style", "b-style", "z-style"]);
  });

  it("supports the `path` field as the structural key", () => {
    const viaPath: OrderableConvention[] = [
      { name: "two", path: "src/q.ts" },
      { name: "one", path: "src/p.ts" },
    ];
    expect(orderConventions(viaPath).map((c) => c.name)).toEqual([
      "one",
      "two",
    ]);
  });

  it("is deterministic and canonical under shuffle", () => {
    const canonical = orderConventions(convs).map((c) => c.name);
    for (let seed = 1; seed <= 20; seed++) {
      expect(orderConventions(shuffle(convs, seed)).map((c) => c.name)).toEqual(
        canonical
      );
    }
  });

  it("does not mutate the input array", () => {
    const copy = [...convs];
    orderConventions(convs);
    expect(convs).toEqual(copy);
  });
});

describe("splitStableVolatile", () => {
  const blocks: PrefixBlock[] = [
    { kind: "legend", text: "LEGEND" },
    { kind: "conventions", text: "CONVS" },
    { kind: "notes", text: "NOTES" }, // per-turn kind → volatile
    { kind: "preamble", text: "PREAMBLE", volatile: false },
    { kind: "telemetry", text: "TELEM" }, // per-turn kind → volatile
    {
      kind: "custom",
      text: "HAS_CLOCK",
      fields: { latency_ms: 3 }, // clock field → volatile
    },
    {
      kind: "custom2",
      text: "HAS_COUNT",
      fields: { count: 5 }, // count field → volatile
    },
    { kind: "marked", text: "EXPLICIT", volatile: true },
  ];

  it("puts stable blocks first, volatile after", () => {
    const { stable, volatile } = splitStableVolatile(blocks);
    const stableKinds = stable.map((b) => b.kind);
    const volatileKinds = volatile.map((b) => b.kind);
    expect(stableKinds).toEqual(["legend", "conventions", "preamble"]);
    expect(volatileKinds).toEqual([
      "notes",
      "telemetry",
      "custom",
      "custom2",
      "marked",
    ]);
  });

  it("never leaks a clock/count/run/random field into the stable partition", () => {
    const { stable } = splitStableVolatile(blocks);
    const clockish = [
      "timestamp",
      "latency_ms",
      "latency",
      "runid",
      "run_id",
      "count",
      "ts",
      "now",
      "random",
    ];
    for (const b of stable) {
      for (const key of Object.keys(b.fields ?? {})) {
        expect(clockish).not.toContain(key.toLowerCase());
      }
      expect(b.volatile === true).toBe(false);
      expect(["notes", "counts", "telemetry"]).not.toContain(b.kind);
    }
  });

  it("treats clock fields case-insensitively", () => {
    const cased: PrefixBlock[] = [
      { kind: "x", text: "X", fields: { Timestamp: 1 } },
      { kind: "y", text: "Y", fields: { RunId: "abc" } },
    ];
    const { stable, volatile } = splitStableVolatile(cased);
    expect(stable).toHaveLength(0);
    expect(volatile).toHaveLength(2);
  });

  it("is deterministic and preserves within-side relative order", () => {
    const a = splitStableVolatile(blocks);
    const b = splitStableVolatile(blocks);
    expect(a).toEqual(b);
  });

  it("does not mutate the input array", () => {
    const copy = [...blocks];
    splitStableVolatile(blocks);
    expect(blocks).toEqual(copy);
  });
});

describe("module purity", () => {
  it("source contains no clock / random / Date references", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(
      new URL("../proxy/prefix-order.ts", import.meta.url)
    );
    const src = readFileSync(path, "utf8");
    // Strip comments first — the doc comment legitimately NAMES the banned APIs
    // when promising it doesn't use them. We assert the executable code is clean.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Date\.now|new Date|Math\.random/);
  });
});
