import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFIX_TOKENS,
  type ReconBundle,
  type ReconRunner,
  SWEEP_SEARCH_LIMIT,
  composeRecon,
  defaultCountTokens,
  extractQueryTerms,
  modelBundleSavings,
  pickTopEntity,
  rankFocusEntities,
  reconEntityCount,
  reconFileSpread,
  reconRealizedBodyCount,
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
    // notes/domain/vocab delivered out-of-band (prompt injection + recall) — never in the bundle
    expect(tools).not.toContain("unerr_recall_notes");
    expect(tools).not.toContain("domain_tags");
    expect(tools).not.toContain("vocab_nudges");
    expect(tools).toContain("get_references");
    expect(tools).toContain("search_code");
    expect(tools).toContain("get_conventions");
    expect(bundle.truncated).toBe(false);
  });

  it("makes exactly one call per underlying tool (no fan-out)", async () => {
    const runner = makeRunner({
      get_conventions: CONVENTIONS,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    await composeRecon({ prompt: "edit fooBar", runner, budget: 5000 });
    // conventions + search(list) + references + 1 focus-body fetch
    // (search_code detail for the single hit) = 4 calls.
    // notes/domain/vocab are out-of-band and never fetched inline.
    // The "no fan-out" guarantee is about AGENT round-trips — one recon
    // call replaces separate per-source calls.
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  // ── Phase 1: focus bodies (collapse the read fan-out) ──────────────────────
  /**
   * Runner that returns a verbatim body for `search_code` detail calls
   * (include_body:true), keyed by the entity `query`. List-mode search_code and
   * the other tools come from `table`. Mirrors QueryRouter.executeRaw's detail
   * shape: an entity object with body + file_path + start/end lines.
   */
  function bodyAwareRunner(
    table: Record<string, unknown>,
    bodies: Record<
      string,
      {
        body: string;
        file?: string;
        start?: number;
        end?: number;
        truncated?: boolean;
      }
    >
  ): ReconRunner {
    return vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "search_code" && args?.include_body === true) {
        const key = String(args.query);
        const b = bodies[key];
        if (!b) return { matched: false, query: key };
        return {
          key,
          name: key,
          file_path: b.file ?? `src/${key}.ts`,
          start_line: b.start ?? 1,
          end_line: b.end ?? 1,
          body: b.body,
          ...(b.truncated ? { _truncated: { total_lines: 999 } } : {}),
        };
      }
      const v = table[tool];
      return typeof v === "function" ? (v as () => unknown)() : v;
    });
  }

  it("inlines the verbatim focus-entity body when detail returns one", async () => {
    const runner = bodyAwareRunner(
      {
        unerr_recall_notes: NOTES,
        get_conventions: CONVENTIONS,
        search_code: SEARCH_HIT,
        get_references: REFERENCES,
      },
      {
        ent1: {
          body: "function fooBar() {\n  return retry(3);\n}",
          file: "src/foo.ts",
          start: 40,
          end: 42,
        },
      }
    );
    const bundle = await composeRecon({
      prompt: "add a retry to fooBar in src/foo.ts",
      runner,
      budget: 5000,
    });
    const body = bundle.sections.find((s) => s.tool === "focus_bodies");
    expect(body).toBeDefined();
    const text = renderReconText(bundle);
    // verbatim source present, with the file:line header (primacy slot)
    expect(text).toContain("function fooBar()");
    expect(text).toContain("src/foo.ts:40-42");
    // D5 read-suppression manifest at the bottom names the inlined range
    expect(text).toContain("do NOT call file_read/Read on: src/foo.ts:40-42");
  });

  it("renders focus bodies FIRST (U-curve primacy slot) and no anchored-notes section", async () => {
    const runner = bodyAwareRunner(
      {
        get_conventions: CONVENTIONS,
        search_code: SEARCH_HIT,
        get_references: REFERENCES,
      },
      {
        ent1: {
          body: "function fooBar() { return 1; }",
          file: "src/foo.ts",
          start: 1,
          end: 1,
        },
      }
    );
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
    });
    const text = renderReconText(bundle);
    // Focus source occupies the primacy (top) slot per the U-curve.
    const bodyPos = text.indexOf("Focus source");
    const refPos = text.indexOf("Callers of fooBar");
    expect(bodyPos).toBeGreaterThanOrEqual(0);
    expect(refPos).toBeGreaterThan(bodyPos); // callers rendered after bodies
    // notes are out-of-band — no "Anchored notes" section in the rendered output
    expect(text).not.toContain("Anchored notes");
  });

  it("caps inlined bodies to at most MAX_FOCUS_BODIES (4) entities", async () => {
    const hits = Array.from({ length: 6 }, (_, i) => ({
      key: `e${i}`,
      name: `fn${i}`,
      file_path: `src/f${i}.ts`,
      kind: "function",
    }));
    const bodies: Record<string, { body: string }> = {};
    for (let i = 0; i < 6; i++)
      bodies[`e${i}`] = { body: `function fn${i}(){}` };
    const runner = bodyAwareRunner(
      {
        unerr_recall_notes: { notes: [] },
        get_conventions: { naming: [], import_direction: [], structure: [] },
        search_code: hits,
        get_references: REFERENCES,
      },
      bodies
    );
    await composeRecon({
      prompt: "touch fn0 fn1 fn2 fn3 fn4 fn5",
      runner,
      budget: 8000,
    });
    const bodyFetches = (runner as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) =>
        c[0] === "search_code" &&
        (c[1] as Record<string, unknown>)?.include_body === true
    );
    expect(bodyFetches.length).toBeLessThanOrEqual(4);
  });

  it("excludes truncated bodies from the do-not-re-read manifest", async () => {
    const runner = bodyAwareRunner(
      {
        unerr_recall_notes: { notes: [] },
        get_conventions: { naming: [], import_direction: [], structure: [] },
        search_code: SEARCH_HIT,
        get_references: REFERENCES,
      },
      {
        ent1: {
          body: "function fooBar() { /* partial */ }",
          file: "src/foo.ts",
          start: 40,
          end: 90,
          truncated: true,
        },
      }
    );
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
    });
    const text = renderReconText(bundle);
    // body still inlined…
    expect(text).toContain("function fooBar()");
    // …but the manifest must NOT claim a truncated slice is fully delivered
    expect(text).not.toContain(
      "do NOT call file_read/Read on: src/foo.ts:40-90"
    );
    // and it offers the full-source escape hatch
    expect(text).toContain("body truncated");
  });

  it("inlines the top body even in 'concise' mode when the bundle is thin (D6 floor)", async () => {
    // Sparse repo — empty notes, tiny callers/entities/conventions, all under the
    // 300-token floor. 'concise' would normally skip bodies, but the floor forces
    // the single top body so the call never returns a near-empty bundle.
    const runner = bodyAwareRunner(
      {
        unerr_recall_notes: { notes: [] },
        get_conventions: { naming: [], import_direction: [], structure: [] },
        search_code: SEARCH_HIT,
        get_references: REFERENCES,
      },
      {
        ent1: {
          body: "function fooBar() { return retry(3); }",
          file: "src/foo.ts",
          start: 5,
          end: 7,
        },
      }
    );
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
      responseFormat: "concise",
    });
    expect(
      bundle.sections.find((s) => s.tool === "focus_bodies")
    ).toBeDefined();
    const fetches = (runner as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) =>
        c[0] === "search_code" &&
        (c[1] as Record<string, unknown>)?.include_body === true
    );
    expect(fetches).toHaveLength(1); // floor inlines exactly the top body, no more
  });

  it("skips bodies in 'concise' mode for a large sweep (searchLimit >= SWEEP_SEARCH_LIMIT)", async () => {
    // A sweep query (searchLimit ≥ 25) wants the navigation map, not source —
    // 0 bodies are fetched even in the default concise mode.
    const manyHits = Array.from({ length: 60 }, (_, i) => ({
      key: `ent${i}`,
      name: `handlerNumber${i}`,
      file_path: `src/handlers/module-${i}/handler-${i}.ts`,
      kind: "function",
    }));
    const runner = bodyAwareRunner(
      {
        get_conventions: { naming: [], import_direction: [], structure: [] },
        search_code: manyHits,
        get_references: REFERENCES,
      },
      { ent0: { body: "function handlerNumber0() {}" } }
    );
    const bundle = await composeRecon({
      prompt: "rename handlerNumber everywhere",
      runner,
      budget: 5000,
      searchLimit: SWEEP_SEARCH_LIMIT, // triggers sweep mode
      responseFormat: "concise",
    });
    expect(
      bundle.sections.find((s) => s.tool === "focus_bodies")
    ).toBeUndefined();
    const fetches = (runner as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) =>
        c[0] === "search_code" &&
        (c[1] as Record<string, unknown>)?.include_body === true
    );
    expect(fetches).toHaveLength(0); // sweep ⇒ no body fetch in concise mode
  });

  it("folds `want` sources in as the lowest-priority sections when a gateway is injected (S3)", async () => {
    const runner = bodyAwareRunner(
      {
        unerr_recall_notes: NOTES,
        get_conventions: CONVENTIONS,
        search_code: SEARCH_HIT,
        get_references: REFERENCES,
      },
      {
        ent1: {
          body: "function fooBar(){}",
          file: "src/foo.ts",
          start: 1,
          end: 1,
        },
      }
    );
    const gateway = vi.fn(async (server: string, op: string) => ({
      server,
      op,
      rows: 3,
    }));
    const bundle = await composeRecon({
      prompt: "edit fooBar using the orders table",
      runner,
      budget: 8000,
      want: ["postgres:orders", "github:pr/45"],
      mcpSources: { runner: gateway, timeoutMs: 1000 },
    });
    const ext = bundle.sections.filter((s) => s.tool.includes("::"));
    // declared order preserved, planned to the right downstream op
    expect(ext.map((s) => s.tool)).toEqual([
      "postgres::get_schema",
      "github::get_issue",
    ]);
    // every external source ranks below the code rings (>= 7)
    for (const s of ext) expect(s.priority).toBeGreaterThanOrEqual(7);
    // rendered with human-readable titles, after the code rings
    const text = renderReconText(bundle);
    expect(text).toContain("postgres:orders");
    expect(text).toContain("github:pr/45");
  });

  it("silently skips the `want` fan-out when no downstream gateway is injected (no toggle)", async () => {
    const runner = bodyAwareRunner(
      {
        unerr_recall_notes: NOTES,
        get_conventions: CONVENTIONS,
        search_code: SEARCH_HIT,
        get_references: REFERENCES,
      },
      { ent1: { body: "function fooBar(){}" } }
    );
    // `want` is declared but NO `mcpSources` gateway is present — capability is
    // absent, so the fan-out is not walked at all. No "disabled" noise, no drop.
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 8000,
      want: ["postgres:orders"],
    });
    expect(bundle.sections.some((s) => s.tool.includes("::"))).toBe(false);
    expect(bundle.dropped.some((d) => d.tool === "want_source")).toBe(false);
  });

  it("ignores the 'code' want kind — served by the local rings (S3)", async () => {
    const runner = bodyAwareRunner(
      {
        unerr_recall_notes: NOTES,
        get_conventions: CONVENTIONS,
        search_code: SEARCH_HIT,
        get_references: REFERENCES,
      },
      { ent1: { body: "function fooBar(){}" } }
    );
    const gateway = vi.fn(async (server: string, op: string) => ({
      server,
      op,
    }));
    await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 8000,
      want: ["code", "postgres:orders"],
      mcpSources: { runner: gateway, timeoutMs: 1000 },
    });
    // only the postgres source reaches the gateway; 'code' is never planned
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(gateway).toHaveBeenCalledWith("postgres", "get_schema", {
      table: "orders",
    });
  });

  it("ranks callers first, entities second (no notes section in bundle)", async () => {
    const runner = makeRunner({
      get_conventions: CONVENTIONS,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
    });
    // notes are out-of-band — callers (blast radius) are now the highest-priority section
    expect(bundle.sections[0]?.tool).toBe("get_references");
    expect(bundle.sections[1]?.tool).toBe("search_code");
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
      get_conventions: () => {
        throw new Error("conventions store offline");
      },
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
    });
    // conventions errored → recorded in dropped, bundle still has the rest
    expect(bundle.dropped.some((d) => d.tool === "get_conventions")).toBe(true);
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
      get_conventions: bigConventions,
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 120, // tight: callers + entities fit, big conventions must not
    });
    expect(bundle.totalTokens).toBeLessThanOrEqual(120);
    expect(bundle.truncated).toBe(true);
    // callers (priority 2) always survive a tight budget
    expect(bundle.sections.map((s) => s.tool)).toContain("get_references");
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

  it("concise single-entity query inlines exactly 1 focus body and emits no notes/domain/vocab section", async () => {
    const runner = bodyAwareRunner(
      {
        get_conventions: CONVENTIONS,
        search_code: SEARCH_HIT,
        get_references: REFERENCES,
      },
      {
        ent1: {
          body: "function fooBar() { return 42; }",
          file: "src/foo.ts",
          start: 10,
          end: 12,
        },
      }
    );
    const bundle = await composeRecon({
      prompt: "edit fooBar in src/foo.ts",
      runner,
      budget: 5000,
      responseFormat: "concise",
    });
    // Exactly 1 focus body inlined (lean default for concise non-sweep).
    const bodySection = bundle.sections.find((s) => s.tool === "focus_bodies");
    expect(bodySection).toBeDefined();
    expect(Array.isArray(bodySection?.data)).toBe(true);
    expect((bodySection?.data as unknown[]).length).toBe(1);
    // notes/domain/vocab are never in the bundle regardless of mode.
    const tools = bundle.sections.map((s) => s.tool);
    expect(tools).not.toContain("unerr_recall_notes");
    expect(tools).not.toContain("domain_tags");
    expect(tools).not.toContain("vocab_nudges");
    // Body content is rendered.
    const text = renderReconText(bundle);
    expect(text).toContain("function fooBar()");
    expect(text).not.toContain("Anchored notes");
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
    // notes are out-of-band — no "Anchored notes" header in rendered text
    expect(text).not.toContain("## Anchored notes");
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

  it("surfaces the domain annotation on an entity line, leaves un-annotated lines bare (SC-B.3)", async () => {
    const annotatedHits = [
      {
        key: "e:validateToken",
        name: "validateToken",
        file_path: "src/auth/token.ts",
        kind: "function",
        domain: "auth",
        role: "gateway",
        summary: "Validates a session token against the active key set",
      },
      {
        key: "e:plainHelper",
        name: "plainHelper",
        file_path: "src/auth/token.ts",
        kind: "function",
      },
    ];
    const runner = makeRunner({
      unerr_recall_notes: { notes: [] },
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: annotatedHits,
      get_references: {
        references: [],
        direction: "callers",
        total: 0,
        truncated: false,
      },
    });
    const bundle = await composeRecon({
      prompt: "edit validateToken auth flow",
      runner,
      budget: 5000,
    });
    const digest = renderReconDigest(bundle);
    expect(digest).toContain(
      'validateToken (function) [auth/gateway — "Validates a session token against the active key set"]'
    );
    // The un-annotated sibling on the same file stays bare — identical to today.
    expect(digest).toContain("plainHelper (function)");
    expect(digest).not.toContain("plainHelper (function) [");
  });

  it("does not inline domain-tag vocabulary (SC-B.4 — delivered out-of-band)", async () => {
    const runner = makeRunner({
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SEARCH_HIT,
      get_references: {
        references: [],
        direction: "callers",
        total: 0,
        truncated: false,
      },
      domain_tags: {
        tags: [
          { domain: "auth", count: 12 },
          { domain: "payments", count: 8 },
        ],
      },
    });
    const bundle = await composeRecon({
      prompt: "add a new exported helper to the auth flow",
      runner,
      budget: 5000,
    });
    // domain_tags is never fetched inline — it is delivered via prompt injection.
    expect(bundle.sections.map((s) => s.tool)).not.toContain("domain_tags");
    const digest = renderReconDigest(bundle);
    expect(digest).not.toContain("## domain tags");
    // domain_tags tool was not called at all
    expect(
      (runner as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    ).not.toContain("domain_tags");
  });

  it("drops the domain-tags section quietly when the vocabulary is empty (SC-B.4)", async () => {
    const runner = makeRunner({
      unerr_recall_notes: { notes: [] },
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SEARCH_HIT,
      get_references: {
        references: [],
        direction: "callers",
        total: 0,
        truncated: false,
      },
      domain_tags: { tags: [] },
    });
    const bundle = await composeRecon({
      prompt: "add a helper",
      runner,
      budget: 5000,
    });
    expect(bundle.sections.map((s) => s.tool)).not.toContain("domain_tags");
    expect(renderReconDigest(bundle)).not.toContain("domain tags");
  });

  it("does not inline vocabulary nudges (SC-C.4 — delivered out-of-band)", async () => {
    const runner = makeRunner({
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SEARCH_HIT,
      get_references: {
        references: [],
        direction: "callers",
        total: 0,
        truncated: false,
      },
      vocab_nudges: {
        canonical: [{ domain: "authentication", count: 5 }],
        provisional: [{ domain: "draft", count: 1 }],
        merge: [
          { from: "authn", fromCount: 2, into: "authentication", intoCount: 5 },
        ],
      },
    });
    const bundle = await composeRecon({
      prompt: "add an auth helper",
      runner,
      budget: 5000,
    });
    // vocab_nudges is never fetched inline — it is delivered via prompt injection.
    expect(bundle.sections.map((s) => s.tool)).not.toContain("vocab_nudges");
    const digest = renderReconDigest(bundle);
    expect(digest).not.toContain("## vocabulary");
    // vocab_nudges tool was not called at all
    expect(
      (runner as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    ).not.toContain("vocab_nudges");
  });

  it("drops the vocabulary section quietly when there is nothing to nudge (SC-C.4)", async () => {
    const runner = makeRunner({
      unerr_recall_notes: { notes: [] },
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SEARCH_HIT,
      get_references: {
        references: [],
        direction: "callers",
        total: 0,
        truncated: false,
      },
      vocab_nudges: { canonical: [], provisional: [], merge: [] },
    });
    const bundle = await composeRecon({
      prompt: "add a helper",
      runner,
      budget: 5000,
    });
    expect(bundle.sections.map((s) => s.tool)).not.toContain("vocab_nudges");
    expect(renderReconDigest(bundle)).not.toContain("## vocabulary");
  });

  it("does not include anchored notes in digest (delivered out-of-band via prompt injection)", async () => {
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
    // Notes are delivered via prompt injection — never appear in the inline bundle.
    expect(digest).not.toContain("## Anchored notes");
    expect(digest).not.toContain("no X");
    // unerr_recall_notes was never called
    expect(
      (runner as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    ).not.toContain("unerr_recall_notes");
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

// ── A2 (E3): precision — dedup focus bodies from the entity list + actionable
// coverage footer naming the exact follow-up call for budget-dropped sections.
describe("recon precision (A2)", () => {
  function bodyRunner(
    table: Record<string, unknown>,
    bodies: Record<string, { body: string; file: string }>
  ): ReconRunner {
    return vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "search_code" && args?.include_body === true) {
        const key = String(args.query);
        const b = bodies[key];
        if (!b) return { matched: false, query: key };
        return {
          key,
          name: key,
          file_path: b.file,
          start_line: 1,
          end_line: 1,
          body: b.body,
        };
      }
      const v = table[tool];
      return typeof v === "function" ? (v as () => unknown)() : v;
    });
  }

  it("drops an entity from the Entities list once it is inlined as a focus body", async () => {
    const runner = bodyRunner(
      {
        unerr_recall_notes: { notes: [] },
        get_conventions: { naming: [], import_direction: [], structure: [] },
        search_code: [
          {
            key: "ent1",
            name: "fooBar",
            file_path: "src/foo.ts",
            kind: "function",
          },
          {
            key: "ent2",
            name: "otherFn",
            file_path: "src/other.ts",
            kind: "function",
          },
        ],
        get_references: {
          references: [],
          direction: "callers",
          total: 0,
          truncated: false,
        },
      },
      // only ent1 has a fetchable body → ent1 becomes a focus body, ent2 does not
      { ent1: { body: "function fooBar() { return 1; }", file: "src/foo.ts" } }
    );
    const bundle = await composeRecon({
      prompt: "edit fooBar in src/foo.ts",
      runner,
      budget: 5000,
    });
    const entities = bundle.sections.find((s) => s.tool === "search_code");
    expect(entities).toBeDefined();
    const blob = JSON.stringify(entities?.data);
    // ent1 is inlined verbatim as a focus body → removed from the list
    expect(blob).not.toContain('"ent1"');
    // ent2 has no body → stays in the overview
    expect(blob).toContain('"ent2"');
  });

  it("coverage footer names the exact follow-up call for each budget-dropped section", () => {
    // Construct the bundle directly — the renderer + followUpFor are the unit
    // under test; budget-tuning composeRecon to force a specific drop is fragile.
    const bundle: ReconBundle = {
      prompt: "edit fooBar in src/foo.ts",
      terms: ["fooBar", "src/foo.ts"],
      focusKey: "ent1",
      focusName: "fooBar",
      sections: [],
      dropped: [
        {
          tool: "get_references",
          title: "Callers of fooBar",
          reason: "budget",
        },
        { tool: "search_code", title: "Entities", reason: "budget" },
        { tool: "get_conventions", title: "Conventions", reason: "budget" },
        // recall-only ring: no direct re-fetch, only a wider budget helps
        { tool: "domain_tags", title: "Active domain tags", reason: "budget" },
        // a non-budget drop must NOT appear in the footer
        { tool: "search_code", title: "errored", reason: "error" },
      ],
      totalTokens: 0,
      budget: 4000,
      truncated: true,
    };
    const text = renderReconText(bundle);
    // concrete number (2× budget), never a :N placeholder
    expect(text).toContain(
      "omitted for budget — re-run with budget:8000 to include, or fetch directly:"
    );
    // paste-ready follow-up per dropped ring, with real args interpolated
    expect(text).toContain(
      "Callers of fooBar → get_references({key:'ent1', direction:'callers'})"
    );
    expect(text).toContain(
      "Entities → search_code({query:'fooBar src/foo.ts'})"
    );
    expect(text).toContain(
      "Conventions → file_read on the file you will edit (conventions auto-inject)"
    );
    // recall-only ring: listed without a call (only a wider budget helps)
    expect(text).toContain("  - Active domain tags");
    expect(text).not.toContain("Active domain tags →");
    // error-reason drops are not budget drops — kept out of this footer
    expect(text).not.toContain("errored");
  });
});

// ── A3 (E2): speculative expand ring — pre-inline the top callers' verbatim
// bodies (the sites the blast-radius gate forces the agent to edit next).
describe("recon expand ring (A3)", () => {
  function expandRunner(
    bodies: Record<string, { body: string; file: string }>
  ): ReconRunner {
    const refs = {
      references: [
        { key: "c1", name: "callerOne", file_path: "src/a.ts" },
        { key: "c2", name: "callerTwo", file_path: "src/b.ts" },
      ],
      direction: "callers",
      total: 2,
      truncated: false,
    };
    return vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "search_code" && args?.include_body === true) {
        const key = String(args.query);
        const b = bodies[key];
        if (!b) return { matched: false, query: key };
        return {
          key,
          name: key,
          file_path: b.file,
          start_line: 10,
          end_line: 12,
          body: b.body,
        };
      }
      if (tool === "search_code") {
        return [
          {
            key: "ent1",
            name: "fooBar",
            file_path: "src/foo.ts",
            kind: "function",
          },
        ];
      }
      if (tool === "get_references") return refs;
      if (tool === "unerr_recall_notes") return { notes: [] };
      if (tool === "get_conventions")
        return { naming: [], import_direction: [], structure: [] };
      return undefined;
    });
  }

  it("pre-inlines top caller bodies as a section only when expand:true", async () => {
    const bodies = {
      ent1: { body: "function fooBar() { return 1; }", file: "src/foo.ts" },
      c1: { body: "function callerOne() { fooBar(); }", file: "src/a.ts" },
      c2: { body: "function callerTwo() { fooBar(); }", file: "src/b.ts" },
    };
    const off = await composeRecon({
      prompt: "change fooBar signature in src/foo.ts",
      runner: expandRunner(bodies),
      budget: 5000,
    });
    expect(off.sections.some((s) => s.tool === "expand_callers")).toBe(false);

    const on = await composeRecon({
      prompt: "change fooBar signature in src/foo.ts",
      runner: expandRunner(bodies),
      budget: 5000,
      expand: true,
    });
    const ring = on.sections.find((s) => s.tool === "expand_callers");
    expect(ring).toBeDefined();
    const text = renderReconText(on);
    // caller bodies inlined verbatim with file:line headers
    expect(text).toContain("function callerOne()");
    expect(text).toContain("src/a.ts:10-12");
    // and named in the do-not-re-read manifest
    expect(text).toContain(
      "do NOT call file_read/Read on: src/foo.ts:10-12, src/a.ts:10-12, src/b.ts:10-12"
    );
  });

  it("does not re-inline a caller already carried as a focus body", async () => {
    // ent1's body is fetched as the focus body; if a caller key collided it
    // must not be double-fetched. Here callers are c1/c2 (distinct), so both
    // appear once; assert no duplicate file:line in the manifest.
    const bodies = {
      ent1: { body: "function fooBar() { return 1; }", file: "src/foo.ts" },
      c1: { body: "function callerOne() {}", file: "src/a.ts" },
      c2: { body: "function callerTwo() {}", file: "src/b.ts" },
    };
    const bundle = await composeRecon({
      prompt: "edit fooBar in src/foo.ts",
      runner: expandRunner(bodies),
      budget: 5000,
      expand: true,
    });
    const ring = bundle.sections.find((s) => s.tool === "expand_callers");
    const keys = (ring?.data as Array<{ key: string }>).map((b) => b.key);
    expect(keys).toEqual(["c1", "c2"]);
  });

  it("is a no-op when expand is off and no caller fetch happens", async () => {
    const runner = expandRunner({
      ent1: { body: "function fooBar() {}", file: "src/foo.ts" },
      c1: { body: "x", file: "src/a.ts" },
      c2: { body: "y", file: "src/b.ts" },
    });
    await composeRecon({
      prompt: "edit fooBar in src/foo.ts",
      runner,
      budget: 5000,
    });
    const calls = (runner as ReturnType<typeof vi.fn>).mock.calls;
    // no include_body fetch was issued for a caller key (c1/c2)
    const callerFetches = calls.filter(
      (c) =>
        c[0] === "search_code" &&
        (c[1] as Record<string, unknown>)?.include_body === true &&
        ["c1", "c2"].includes(String((c[1] as Record<string, unknown>)?.query))
    );
    expect(callerFetches.length).toBe(0);
  });
});

// ── A3 (E2): read-only shell `want` kind folded into the bundle ──────────────
describe("recon shell sources (A3)", () => {
  it("folds an allowlisted shell:git command in only when a runner is injected", async () => {
    const runner = makeRunner({
      unerr_recall_notes: { notes: [] },
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const shellRunner = vi.fn(async (argv: string[]) => ({
      stdout: `abc123 recent change\n${argv.join(" ")}`,
      truncated: false,
    }));

    // no shellSources injected → the shell want is silently skipped
    const off = await composeRecon({
      prompt: "edit fooBar in src/foo.ts",
      runner,
      budget: 5000,
      want: ["shell:git log -n3 -- src/foo.ts"],
    });
    expect(off.sections.some((s) => s.tool.startsWith("shell::"))).toBe(false);
    expect(shellRunner).not.toHaveBeenCalled();

    // runner injected → the command runs and its output is a section
    const on = await composeRecon({
      prompt: "edit fooBar in src/foo.ts",
      runner,
      budget: 5000,
      want: ["shell:git log -n3 -- src/foo.ts"],
      shellSources: { runner: shellRunner },
    });
    const section = on.sections.find((s) => s.tool === "shell::git-log");
    expect(section).toBeDefined();
    expect(String(section?.data)).toContain("recent change");
  });

  it("drops a disallowed shell command without running it", async () => {
    const runner = makeRunner({
      unerr_recall_notes: { notes: [] },
      get_conventions: { naming: [], import_direction: [], structure: [] },
      search_code: SEARCH_HIT,
      get_references: REFERENCES,
    });
    const shellRunner = vi.fn(async () => ({ stdout: "", truncated: false }));
    const bundle = await composeRecon({
      prompt: "edit fooBar",
      runner,
      budget: 5000,
      want: ["shell:rm -rf /"],
      shellSources: { runner: shellRunner },
    });
    expect(shellRunner).not.toHaveBeenCalled();
    expect(
      bundle.dropped.some(
        (d) => d.tool === "shell_source" && d.reason === "not_allowed"
      )
    ).toBe(true);
  });
});

// ── A4 (E4): emit-time MODELED savings — the Layer-A upper bound + the
// Layer-B manifest the post-hoc reconciliation reads.
describe("modelBundleSavings (A4)", () => {
  function bundleWith(
    sections: ReconBundle["sections"],
    totalTokens: number
  ): ReconBundle {
    return {
      prompt: "edit fooBar",
      terms: ["fooBar"],
      focusKey: "ent1",
      focusName: "fooBar",
      sections,
      dropped: [],
      totalTokens,
      budget: 4000,
      truncated: false,
    };
  }

  function section(
    tool: string,
    data: unknown,
    tokens = 100
  ): ReconBundle["sections"][number] {
    return { tool, title: tool, data, tokens, priority: 1, shrunk: false };
  }

  it("models round-trips and re-paid prefix from a multi-source bundle", () => {
    const bundle = bundleWith(
      [
        section("search_code", [
          { key: "ent1", name: "fooBar", file_path: "src/foo.ts" },
          { key: "ent2", name: "bar", file_path: "src/bar.ts" },
        ]),
        section("get_references", { references: [], direction: "callers" }),
        section("get_conventions", { naming: [] }),
      ],
      900
    );
    const m = modelBundleSavings(bundle);
    // 3 folded rings = 3 sources, replacing the call → 2 avoided round-trips.
    expect(m.sources_collapsed).toBe(3);
    expect(m.round_trips_modeled).toBe(2);
    expect(m.delivered_tokens).toBe(900);
    expect(m.rerequest_saved_tokens).toBe(2 * DEFAULT_PREFIX_TOKENS);
    expect(m.original_tokens).toBe(900 + 2 * DEFAULT_PREFIX_TOKENS);
    // entity keys from the search section feed the Layer-B re-fetch check.
    expect(m.delivered_entity_keys).toEqual(["ent1", "ent2"]);
    expect(m.delivered_files).toContain("src/foo.ts");
  });

  it("honors an injected prefix estimate over the default", () => {
    const bundle = bundleWith(
      [section("search_code", []), section("get_references", {})],
      200
    );
    const m = modelBundleSavings(bundle, { prefixTokens: 10_000 });
    expect(m.round_trips_modeled).toBe(1);
    expect(m.rerequest_saved_tokens).toBe(10_000);
  });

  it("counts only non-truncated focus bodies as manifest items, and expand bodies as expand items", () => {
    const bundle = bundleWith(
      [
        section("focus_bodies", [
          { key: "ent1", file: "src/foo.ts", body: "…", truncated: false },
          // truncated slice may legitimately be re-read → not manifest-counted
          { key: "ent2", file: "src/bar.ts", body: "…", truncated: true },
        ]),
        section("expand_callers", [
          { key: "c1", file: "src/a.ts", body: "…", truncated: false },
        ]),
      ],
      500
    );
    const m = modelBundleSavings(bundle);
    expect(m.manifest_items).toBe(1);
    expect(m.expand_items).toBe(1);
    expect(m.expand_keys).toEqual(["c1"]);
    // focus-body keys join the delivered set (deduped) for Layer B.
    expect(m.delivered_entity_keys).toContain("ent1");
  });

  it("models zero savings for a single-source bundle (nothing to collapse)", () => {
    const bundle = bundleWith([section("search_code", [])], 100);
    const m = modelBundleSavings(bundle);
    expect(m.sources_collapsed).toBe(1);
    expect(m.round_trips_modeled).toBe(0);
    expect(m.rerequest_saved_tokens).toBe(0);
    expect(m.original_tokens).toBe(100);
  });

  // ── Lever 6: index_only no-op flag — never changes the modeled numbers above.
  it("flags index_only when no focus body is inlined and at most one entity is delivered", () => {
    const bundle = bundleWith(
      [section("search_code", [{ key: "ent1", name: "fooBar" }])],
      100
    );
    const m = modelBundleSavings(bundle);
    expect(m.index_only).toBe(true);
  });

  it("flags index_only when no focus body is inlined and zero entities are delivered", () => {
    const bundle = bundleWith([section("get_conventions", { naming: [] })], 50);
    const m = modelBundleSavings(bundle);
    expect(m.index_only).toBe(true);
  });

  it("clears index_only when a focus body is inlined, even with a single entity", () => {
    const bundle = bundleWith(
      [
        section("focus_bodies", [
          { key: "ent1", file: "src/foo.ts", body: "…", truncated: false },
        ]),
      ],
      200
    );
    const m = modelBundleSavings(bundle);
    expect(m.index_only).toBe(false);
  });

  it("clears index_only when no focus body is inlined but more than one entity is delivered", () => {
    const bundle = bundleWith(
      [
        section("search_code", [
          { key: "ent1", name: "fooBar" },
          { key: "ent2", name: "bar" },
        ]),
      ],
      100
    );
    const m = modelBundleSavings(bundle);
    expect(m.index_only).toBe(false);
  });
});

// ── Lever 6: bundle_realized_bodies — focus bodies actually inlined in the
// delivered (post-budget) bundle. 0 ⇒ index-only, no read was replaced.
describe("reconRealizedBodyCount (Lever 6)", () => {
  function bundleWith(sections: ReconBundle["sections"]): ReconBundle {
    return {
      prompt: "edit fooBar",
      terms: ["fooBar"],
      focusKey: "ent1",
      focusName: "fooBar",
      sections,
      dropped: [],
      totalTokens: 100,
      budget: 4000,
      truncated: false,
    };
  }
  function section(
    tool: string,
    data: unknown
  ): ReconBundle["sections"][number] {
    return { tool, title: tool, data, tokens: 10, priority: 1, shrunk: false };
  }

  it("is 0 for a digest-mode bundle (no focus_bodies section)", () => {
    const bundle = bundleWith([
      section("search_code", [{ key: "ent1", name: "fooBar" }]),
    ]);
    expect(reconRealizedBodyCount(bundle)).toBe(0);
  });

  it("is >0 when a focus body is inlined", () => {
    const bundle = bundleWith([
      section("focus_bodies", [
        { key: "ent1", file: "src/foo.ts", body: "…", truncated: false },
      ]),
    ]);
    expect(reconRealizedBodyCount(bundle)).toBe(1);
  });

  it("counts every inlined focus body, not just the first", () => {
    const bundle = bundleWith([
      section("focus_bodies", [
        { key: "ent1", file: "src/foo.ts", body: "…", truncated: false },
        { key: "ent2", file: "src/bar.ts", body: "…", truncated: false },
      ]),
    ]);
    expect(reconRealizedBodyCount(bundle)).toBe(2);
  });

  it("does not count expand-ring caller bodies as focus bodies", () => {
    const bundle = bundleWith([
      section("expand_callers", [
        { key: "c1", file: "src/a.ts", body: "…", truncated: false },
      ]),
    ]);
    expect(reconRealizedBodyCount(bundle)).toBe(0);
  });
});

// ── Relaxed per-term retry: a joined multi-term search that matches nothing
// falls back to one search per term (max RELAXED_RETRY_MAX_TERMS), merged by
// entity key, best score first, and labeled so the agent knows the phrase
// itself missed.
describe("recon relaxed per-term retry", () => {
  it("retries per term and merges/dedupes by key, score-desc, when the joined query returns nothing", async () => {
    const prompt = "lookupWidget validateGizmo";
    const perTerm: Record<string, unknown> = {
      lookupWidget: [
        {
          key: "wid1",
          name: "lookupWidget",
          file_path: "src/widget.ts",
          score: 5,
        },
        {
          key: "shared1",
          name: "sharedThing",
          file_path: "src/shared.ts",
          score: 1,
        },
      ],
      validateGizmo: [
        {
          key: "giz1",
          name: "validateGizmo",
          file_path: "src/gizmo.ts",
          score: 9,
        },
        {
          key: "shared1",
          name: "sharedThing",
          file_path: "src/shared.ts",
          score: 1,
        },
      ],
    };
    const runner: ReconRunner = vi.fn(
      async (tool: string, args: Record<string, unknown>) => {
        if (tool === "get_conventions")
          return { naming: [], import_direction: [], structure: [] };
        if (tool === "get_references") return { references: [] };
        if (tool === "search_code") {
          const query = args.query as string;
          if (query === prompt) return []; // joined phrase: no hits
          if (query in perTerm) return perTerm[query];
          return []; // e.g. a focus-body detail fetch for a merged key
        }
        return undefined;
      }
    );

    const bundle = await composeRecon({ prompt, runner, budget: 5000 });

    const searchSection = bundle.sections.find((s) => s.tool === "search_code");
    expect(searchSection?.title).toBe("Entities (relaxed term match)");
    const rows = (
      searchSection?.data as { entities: Array<Record<string, unknown>> }
    ).entities;
    // deduped by key (shared1 kept once, first occurrence) and sorted
    // score-desc: giz1=9, wid1=5, shared1=1.
    expect(rows.map((r) => r.key)).toEqual(["giz1", "wid1", "shared1"]);
  });

  it("does not retry when the joined query already returns entities", async () => {
    const prompt = "lookupWidget validateGizmo";
    const runner: ReconRunner = vi.fn(
      async (tool: string, args: Record<string, unknown>) => {
        if (tool === "get_conventions")
          return { naming: [], import_direction: [], structure: [] };
        if (tool === "get_references") return { references: [] };
        if (tool === "search_code") {
          const query = args.query as string;
          if (query === prompt) return SEARCH_HIT;
          return []; // e.g. a focus-body detail fetch, must not be a retry
        }
        return undefined;
      }
    );

    const bundle = await composeRecon({ prompt, runner, budget: 5000 });

    const searchSection = bundle.sections.find((s) => s.tool === "search_code");
    expect(searchSection?.title).toBe("Entities");
    // No per-term retry: exactly one LIST-mode search_code call (the joined
    // one) — a focus-body detail fetch (`detail:true`) is a separate call and
    // excluded from this count.
    const listCalls = (runner as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) =>
        c[0] === "search_code" && !(c[1] as Record<string, unknown>)?.detail
    );
    expect(listCalls.length).toBe(1);
  });

  it("does not retry a single-term prompt even when the result is empty", async () => {
    const prompt = "lookupWidget"; // exactly one salient term
    const runner: ReconRunner = vi.fn(async (tool: string) => {
      if (tool === "get_conventions")
        return { naming: [], import_direction: [], structure: [] };
      if (tool === "get_references") return { references: [] };
      if (tool === "search_code") return [];
      return undefined;
    });

    const bundle = await composeRecon({ prompt, runner, budget: 5000 });

    expect(bundle.sections.map((s) => s.tool)).not.toContain("search_code");
    const searchCalls = (runner as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "search_code"
    );
    expect(searchCalls.length).toBe(1);
  });
});
