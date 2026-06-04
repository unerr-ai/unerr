import { describe, expect, it, vi } from "vitest";
import {
  type ReconRunner,
  composeRecon,
  defaultCountTokens,
  extractQueryTerms,
  pickTopEntity,
  rankFocusEntities,
  reconEntityCount,
  reconFileSpread,
  renderReconDigest,
  renderReconText,
  shrinkToBudget,
} from "../intelligence/recon.js";

describe("extractQueryTerms", () => {
  it("keeps quoted/backticked spans verbatim and first", () => {
    const terms = extractQueryTerms(
      "Find every place that writes to `events.jsonl` and confirm none go to stdout"
    );
    expect(terms[0]).toBe("events.jsonl");
    expect(terms).toContain("stdout");
  });

  it("strips filler verbs and short noise, keeps identifiers", () => {
    const terms = extractQueryTerms(
      "Add a getRecentTools accessor to the latency tracker in src/proxy/session-stats.ts and update its callers safely"
    );
    expect(terms).toContain("getRecentTools");
    expect(terms).toContain("src/proxy/session-stats.ts");
    // filler verbs dropped
    expect(terms).not.toContain("Add");
    expect(terms).not.toContain("update");
    expect(terms).not.toContain("safely");
  });

  it("caps the number of terms", () => {
    const terms = extractQueryTerms(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
      4
    );
    expect(terms.length).toBeLessThanOrEqual(4);
  });

  it("returns empty for empty input", () => {
    expect(extractQueryTerms("")).toEqual([]);
  });

  it("dedupes case-insensitively", () => {
    const terms = extractQueryTerms("Router router ROUTER classify");
    const routers = terms.filter((t) => t.toLowerCase() === "router");
    expect(routers.length).toBe(1);
  });
});

describe("pickTopEntity", () => {
  it("reads the raw array shape", () => {
    expect(
      pickTopEntity([
        { key: "abc", name: "fooBar", score: 9 },
        { key: "def", name: "baz", score: 3 },
      ])
    ).toEqual({ key: "abc", name: "fooBar" });
  });

  it("reads envelope shapes", () => {
    expect(pickTopEntity({ entities: [{ key: "k1", name: "n1" }] })).toEqual({
      key: "k1",
      name: "n1",
    });
  });

  it("returns null when empty or keyless", () => {
    expect(pickTopEntity([])).toBeNull();
    expect(pickTopEntity([{ name: "no-key" }])).toBeNull();
    expect(pickTopEntity(null)).toBeNull();
  });
});

describe("rankFocusEntities", () => {
  it("ranks an entity whose file is named in the prompt first", () => {
    const ranked = rankFocusEntities(
      [
        { key: "k1", name: "helperA", file_path: "src/other.ts" },
        { key: "k2", name: "handleX", file_path: "src/proxy/proxy.ts" },
      ],
      "fix the dispatch path in src/proxy/proxy.ts"
    );
    expect(ranked[0]?.key).toBe("k2");
  });

  it("sinks test-scaffolding entities below production ones", () => {
    const ranked = rankFocusEntities(
      [
        {
          key: "t1",
          name: "testBlock",
          file_path: "src/__tests__/foo.test.ts",
        },
        { key: "p1", name: "realFn", file_path: "src/foo.ts" },
      ],
      "update realFn"
    );
    expect(ranked[0]?.key).toBe("p1");
    expect(ranked[1]?.key).toBe("t1");
  });

  it("keeps search order on ties (stable sort)", () => {
    const ranked = rankFocusEntities(
      [
        { key: "a", name: "one", file_path: "src/a.ts" },
        { key: "b", name: "two", file_path: "src/b.ts" },
      ],
      "no file named here"
    );
    expect(ranked.map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("skips keyless rows and returns [] for non-arrays", () => {
    expect(rankFocusEntities([{ name: "no-key" }], "p")).toEqual([]);
    expect(rankFocusEntities(null, "p")).toEqual([]);
  });
});

describe("shrinkToBudget", () => {
  const count = defaultCountTokens;

  it("is a no-op when already under budget", () => {
    const data = { references: [{ a: 1 }] };
    const r = shrinkToBudget(data, 10_000, count);
    expect(r.shrunk).toBe(false);
    expect(r.data).toBe(data);
  });

  it("slices the longest array down until it fits", () => {
    const data = {
      references: Array.from({ length: 200 }, (_, i) => ({
        key: `k${i}`,
        name: `entity_${i}`,
        file_path: `src/file_${i}.ts`,
      })),
    };
    const before = count(data);
    const r = shrinkToBudget(data, 200, count);
    expect(r.shrunk).toBe(true);
    expect(count(r.data)).toBeLessThanOrEqual(200);
    expect(count(r.data)).toBeLessThan(before);
    // original is untouched
    expect((data.references as unknown[]).length).toBe(200);
  });

  it("does not mutate the input", () => {
    const data = { items: Array.from({ length: 100 }, (_, i) => i) };
    shrinkToBudget(data, 5, count);
    expect(data.items.length).toBe(100);
  });
});

/** Build a runner from a map of tool → result (or a thrower). */
function makeRunner(
  table: Record<string, unknown | (() => unknown)>
): ReconRunner {
  return vi.fn(async (tool: string) => {
    const v = table[tool];
    if (typeof v === "function") return (v as () => unknown)();
    if (v === undefined) return undefined;
    return v;
  });
}

const SEARCH_HIT = [
  { key: "ent1", name: "fooBar", file_path: "src/foo.ts", kind: "function" },
];
const REFERENCES = {
  references: [
    { key: "c1", name: "callerOne", file_path: "src/a.ts" },
    { key: "c2", name: "callerTwo", file_path: "src/b.ts" },
  ],
  direction: "callers",
  total: 2,
  truncated: false,
};
const NOTES = {
  notes: [{ kind: "rul", anchor: "f:src/foo.ts", content: "no X" }],
};
const CONVENTIONS = {
  naming: [{ name: "camelCase", adherence_rate: 0.9 }],
  import_direction: [],
  structure: [],
};

describe("composeRecon", () => {
  it("collapses the discovery sequence into one bundle", async () => {
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: CONVENTIONS,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });

    const bundle = await composeRecon({
      prompt: "update fooBar in src/foo.ts and check callers",
      runner,
      budget: 5000,
    });

    expect(bundle.focusKey).toBe("ent1");
    expect(bundle.focusName).toBe("fooBar");
    const tools = bundle.sections.map((s) => s.tool);
    expect(tools).toContain("unerr_recall_notes");
    expect(tools).toContain("get_references");
    expect(tools).toContain("search_code");
    expect(tools).toContain("get_conventions");
    expect(bundle.truncated).toBe(false);
  });

  it("makes exactly one call per underlying tool (no fan-out)", async () => {
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: CONVENTIONS,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    await composeRecon({ prompt: "edit fooBar", runner, budget: 5000 });
    // notes + conventions + search + references = 4 underlying calls, total
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it("ranks anchored notes first, callers second", async () => {
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: CONVENTIONS,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
    });
    expect(bundle.sections[0]?.tool).toBe("unerr_recall_notes");
    expect(bundle.sections[1]?.tool).toBe("get_references");
  });

  it("skips references when search finds no entity", async () => {
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: CONVENTIONS,
      search_code: [],
      get_references: REFERENCES, // present but must not be called
    });
    const bundle = await composeRecon({
      prompt: "something with no entity match",
      runner,
      budget: 5000,
    });
    expect(bundle.focusKey).toBeNull();
    expect(bundle.sections.map((s) => s.tool)).not.toContain("get_references");
    // get_references must not have been invoked at all
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0]
    );
    expect(calls).not.toContain("get_references");
  });

  it("degrades gracefully when a runner throws", async () => {
    const runner = makeRunner({
      unerr_recall_notes: () => {
        throw new Error("notes store offline");
      },
      get_conventions: CONVENTIONS,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
    });
    // notes errored → recorded in dropped, bundle still has the rest
    expect(bundle.dropped.some((d) => d.tool === "unerr_recall_notes")).toBe(
      true
    );
    expect(bundle.sections.map((s) => s.tool)).toContain("get_references");
  });

  it("drops empty sections quietly (no empty-conventions section)", async () => {
    const runner = makeRunner({
      unerr_recall_notes: { notes: [] },
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
    });
    const tools = bundle.sections.map((s) => s.tool);
    expect(tools).not.toContain("unerr_recall_notes");
    expect(tools).not.toContain("get_conventions");
    expect(tools).toContain("get_references");
  });

  it("enforces the token budget by dropping low-priority sections", async () => {
    const bigConventions = {
      naming: Array.from({ length: 500 }, (_, i) => ({
        name: `convention_${i}`,
        adherence_rate: 0.5,
        description: "x".repeat(40),
      })),
      import_direction: [],
      structure: [],
    };
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: bigConventions,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 120, // tight: notes + references fit, big conventions must not
    });
    expect(bundle.totalTokens).toBeLessThanOrEqual(120);
    expect(bundle.truncated).toBe(true);
    // notes (priority 0) always survives a tight budget
    expect(bundle.sections.map((s) => s.tool)).toContain("unerr_recall_notes");
  });

  it("shrinks a straddling section rather than dropping it whole", async () => {
    const manyRefs = {
      references: Array.from({ length: 300 }, (_, i) => ({
        key: `c${i}`,
        name: `caller_${i}`,
        file_path: `src/f_${i}.ts`,
      })),
      direction: "callers",
      total: 300,
      truncated: true,
    };
    const runner = makeRunner({
      unerr_recall_notes: { notes: [] },
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SEARCH_HIT,
      get_references: manyRefs,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 300,
    });
    const refSection = bundle.sections.find((s) => s.tool === "get_references");
    expect(refSection).toBeDefined();
    expect(refSection?.shrunk).toBe(true);
    expect(bundle.totalTokens).toBeLessThanOrEqual(300);
  });

  it("probes past a zero-caller top hit to a candidate with callers", async () => {
    // Regression: pickTopEntity took search row 0 blindly — under flat
    // relevance scores that row was a test block with zero callers, so the
    // callers (blast-radius) section silently vanished from every bundle.
    const hits = [
      { key: "dead", name: "noCallers", file_path: "src/a.ts" },
      { key: "live", name: "hasCallers", file_path: "src/b.ts" },
    ];
    const runner: ReconRunner = vi.fn(async (tool: string, args) => {
      if (tool === "unerr_recall_notes") return { notes: [] };
      if (tool === "get_conventions")
        return { naming: [], import_direction: [], structure: [] };
      if (tool === "search_code") return hits;
      if (tool === "get_references") {
        const key = (args as { key?: string }).key;
        return key === "live"
          ? REFERENCES
          : {
              references: [],
              direction: "callers",
              total: 0,
              truncated: false,
            };
      }
      return undefined;
    });
    const bundle = await composeRecon({
      prompt: "edit noCallers and hasCallers",
      runner,
      budget: 5000,
    });
    expect(bundle.focusKey).toBe("live");
    expect(bundle.focusName).toBe("hasCallers");
    const refSection = bundle.sections.find((s) => s.tool === "get_references");
    expect(refSection).toBeDefined();
    expect(refSection?.title).toBe("Callers of hasCallers");
  });

  it("keeps the top-ranked candidate as nominal focus when nothing has callers", async () => {
    const emptyRefs = {
      references: [],
      direction: "callers",
      total: 0,
      truncated: false,
    };
    const runner = makeRunner({
      unerr_recall_notes: { notes: [] },
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SEARCH_HIT,
      get_references: emptyRefs,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
    });
    expect(bundle.focusKey).toBe("ent1");
    expect(bundle.sections.map((s) => s.tool)).not.toContain("get_references");
  });

  it("skips search entirely when the prompt has no salient terms", async () => {
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: CONVENTIONS,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    await composeRecon({ prompt: "do it", runner, budget: 5000 });
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0]
    );
    expect(calls).not.toContain("search_code");
  });
});

describe("renderReconText", () => {
  it("renders a deterministic labeled block per section", async () => {
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: CONVENTIONS,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
    });
    const text = renderReconText(bundle);
    expect(text).toContain("unerr recon");
    expect(text).toContain("focus: fooBar");
    expect(text).toContain("## Anchored notes");
    expect(text).toContain("## Callers of fooBar");
  });

  it("notes omitted sections for the agent", () => {
    const text = renderReconText({
      prompt: "p",
      terms: ["x"],
      focusKey: null,
      focusName: null,
      sections: [],
      dropped: [
        { tool: "get_conventions", title: "Conventions", reason: "budget" },
      ],
      totalTokens: 0,
      budget: 10,
      truncated: true,
    });
    expect(text).toContain("omitted for budget");
    expect(text).toContain("Conventions");
  });
});

// ── Sprint 4 (R6): large-sweep digest + cardinality helpers ──────────

const SWEEP_HITS = [
  { key: "e1", name: "fooBar", file_path: "src/a.ts", kind: "function" },
  { key: "e2", name: "fooBaz", file_path: "src/a.ts", kind: "method" },
  { key: "e3", name: "fooQux", file_path: "src/b.ts", kind: "function" },
  { key: "e4", name: "fooZap", file_path: "src/c.ts", kind: "class" },
];

describe("reconEntityCount / reconFileSpread", () => {
  it("counts entities and distinct files across search + references", async () => {
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: CONVENTIONS,
      search_code: SWEEP_HITS,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "rename fooBar everywhere",
      runner,
      budget: 5000,
    });
    expect(reconEntityCount(bundle)).toBe(4);
    // search files: a, b, c; reference files: a.ts, b.ts (REFERENCES) → src/a.ts, src/b.ts, src/c.ts
    const files = reconFileSpread(bundle);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
    expect(files).toContain("src/c.ts");
  });

  it("returns 0 entities when no search section is present", () => {
    expect(
      reconEntityCount({
        prompt: "p",
        terms: [],
        focusKey: null,
        focusName: null,
        sections: [],
        dropped: [],
        totalTokens: 0,
        budget: 10,
        truncated: false,
      })
    ).toBe(0);
  });
});

describe("renderReconDigest", () => {
  it("groups entities by file and collapses references to a count", async () => {
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: CONVENTIONS,
      search_code: SWEEP_HITS,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "rename fooBar everywhere",
      runner,
      budget: 5000,
    });
    const digest = renderReconDigest(bundle);
    expect(digest).toContain("unerr recon digest");
    // entities grouped by file, name + kind, no JSON bodies/scores
    expect(digest).toContain("src/a.ts: fooBar (function), fooBaz (method)");
    expect(digest).toContain("src/b.ts: fooQux (function)");
    // references collapsed to a one-line caller count + file spread
    expect(digest).toMatch(/2 callers across 2 files/);
    // conventions collapsed to one line
    expect(digest).toContain("naming: camelCase");
    // no raw search JSON leaked
    expect(digest).not.toContain('"score"');
  });

  it("keeps anchored notes verbatim (load-bearing rules never collapse)", async () => {
    const runner = makeRunner({
      unerr_recall_notes: NOTES,
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SWEEP_HITS,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "rename fooBar everywhere",
      runner,
      budget: 5000,
    });
    const digest = renderReconDigest(bundle);
    expect(digest).toContain("## Anchored notes");
    expect(digest).toContain("no X");
  });

  it("stays flat in size as files scanned grows", async () => {
    const small = [
      { key: "s1", name: "a", file_path: "src/1.ts", kind: "function" },
    ];
    const large = Array.from({ length: 60 }, (_, i) => ({
      key: `k${i}`,
      name: `fn${i}`,
      file_path: `src/file_${i}.ts`,
      kind: "function",
    }));
    const mk = (hits: unknown) =>
      makeRunner({
        unerr_recall_notes: { notes: [] },
        get_conventions: { naming: [], import_direction: [], structure: [] },
        search_code: hits,
        get_references: {
          references: [],
          direction: "callers",
          total: 0,
          truncated: false,
        },
      });
    const smallBundle = await composeRecon({
      prompt: "rename a everywhere",
      runner: mk(small),
      budget: 5000,
    });
    const largeBundle = await composeRecon({
      prompt: "rename fn everywhere",
      runner: mk(large),
      budget: 5000,
    });
    // The digest of 60 files is a per-file line list — bounded, not the raw
    // JSON blob renderReconText would emit. One line per file, not per field.
    const smallLines = renderReconDigest(smallBundle).split("\n").length;
    const largeLines = renderReconDigest(largeBundle).split("\n").length;
    // 60 files ≈ 60 lines + header — linear in files, not in JSON field count.
    expect(largeLines - smallLines).toBeLessThanOrEqual(62);
  });
});
