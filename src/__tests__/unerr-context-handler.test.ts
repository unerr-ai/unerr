import { describe, expect, it, vi } from "vitest";
import type { ReconRunner } from "../intelligence/recon.js";
import {
  type UnerrContextDeps,
  handleUnerrContextProxy,
} from "../proxy/unerr-context-handler.js";

/**
 * Fake graph runner returning the raw structured shapes `composeRecon` expects —
 * the same shapes `QueryRouter.executeRaw` produces (entity array, {references},
 * {naming,…}). Lets us exercise the warm `unerr_context` orchestration with no
 * proxy, no CozoDB.
 */
function fakeRunRaw(opts?: {
  entities?: Array<Record<string, unknown>>;
  references?: unknown;
  conventions?: unknown;
}): ReconRunner {
  const entities = opts?.entities ?? [
    {
      key: "e:fetchUser",
      name: "fetchUser",
      kind: "function",
      file_path: "src/api/user.ts",
      score: 9,
    },
  ];
  return async (tool) => {
    switch (tool) {
      case "search_code":
        return entities;
      case "get_references":
        return (
          opts?.references ?? {
            references: [
              { key: "e:loadProfile", name: "loadProfile", kind: "function" },
            ],
            direction: "callers",
            total: 1,
            truncated: false,
          }
        );
      case "get_conventions":
        return (
          opts?.conventions ?? {
            naming: [],
            import_direction: [],
            structure: [],
          }
        );
      default:
        return undefined;
    }
  };
}

const baseDeps = (over?: Partial<UnerrContextDeps>): UnerrContextDeps => ({
  runRaw: fakeRunRaw(),
  recallNotes: async () => ({ notes: [] }),
  repoCwd: "/tmp/does-not-matter-vitest-guarded",
  ...over,
});

describe("handleUnerrContextProxy", () => {
  it("rejects a missing/blank prompt with an isError result", async () => {
    const res = await handleUnerrContextProxy({}, baseDeps());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("requires a `prompt`");

    const blank = await handleUnerrContextProxy({ prompt: "   " }, baseDeps());
    expect(blank.isError).toBe(true);
  });

  it("lean default: a query with no inlinable body collapses the fan-out into ONE index (digest)", async () => {
    const res = await handleUnerrContextProxy(
      { prompt: "add a retry to fetchUser" },
      baseDeps()
    );
    expect(res.isError).toBeUndefined();
    const text = res.content[0]!.text;
    // Lean default renders the index digest (not the verbatim-body bundle) and
    // names the drill step. Notes/focus/callers/entities still arrive in ONE call.
    expect(text).toContain("unerr recon digest");
    expect(text).toContain("ur|act file_read({entity:'fetchUser'})");
    expect(text).toContain("fetchUser");
    expect(text).toContain("Callers of");
    expect(text.toLowerCase()).toContain("## entities");
  });

  // A focused single-entity edit (≤ FOCUSED_FILE_SPREAD_MAX files) whose bodies
  // are available: the lean default inlines EXACTLY the top body; the rest stay
  // index rows. include_body:true opts into the full focus-body set.
  const twoBodyDefs = [
    { n: "fetchUser", line: 10, score: 9 },
    { n: "fetchAccount", line: 30, score: 5 },
  ];
  const twoBodyRunner: ReconRunner = async (tool, args) => {
    if (tool === "search_code") {
      // Body fetch targets ONE entity by key (query = `e:<name>`, include_body).
      if (args.include_body === true) {
        const def =
          twoBodyDefs.find((d) => args.query === `e:${d.n}`) ?? twoBodyDefs[0]!;
        return [
          {
            key: `e:${def.n}`,
            name: def.n,
            kind: "function",
            file_path: "src/api/user.ts",
            score: def.score,
            body: `export function ${def.n}() { /* BODY_${def.n} */ }`,
            start_line: def.line,
            end_line: def.line + 5,
          },
        ];
      }
      // Initial index search — both entities as rows, no body.
      return twoBodyDefs.map((d) => ({
        key: `e:${d.n}`,
        name: d.n,
        kind: "function",
        file_path: "src/api/user.ts",
        score: d.score,
      }));
    }
    if (tool === "get_references") {
      return { references: [], direction: "callers", total: 0 };
    }
    return { naming: [], import_direction: [], structure: [] };
  };

  it("lean default: a focused single-entity edit inlines exactly ONE body, not the full set", async () => {
    const res = await handleUnerrContextProxy(
      { prompt: "add a retry to fetchUser" },
      baseDeps({ runRaw: twoBodyRunner })
    );
    const text = res.content[0]!.text;
    expect(text).toContain("unerr recon —");
    expect(text).not.toContain("unerr recon digest");
    expect(text).toContain("BODY_fetchUser");
    expect(text).not.toContain("BODY_fetchAccount");
  });

  it("include_body:true opts into the full focus-body set (detailed tier)", async () => {
    const res = await handleUnerrContextProxy(
      { prompt: "add a retry to fetchUser", include_body: true },
      baseDeps({ runRaw: twoBodyRunner })
    );
    const text = res.content[0]!.text;
    expect(text).toContain("BODY_fetchUser");
    expect(text).toContain("BODY_fetchAccount");
  });

  it("anchored notes are NOT in the recon bundle — they arrive via per-turn prompt injection, not composeRecon", async () => {
    const recallNotes = vi.fn(async () => ({
      notes: [
        { kind: "rul", anchor: "f:src/api/user.ts", content: "no raw fetch" },
      ],
    }));
    const res = await handleUnerrContextProxy(
      { prompt: "edit fetchUser in src/api/user.ts" },
      baseDeps({ recallNotes })
    );
    // composeRecon no longer fetches unerr_recall_notes inline — notes arrive via
    // prompt injection (per-turn hook), not the bundle.
    expect(recallNotes).not.toHaveBeenCalled();
    const text = res.content[0]!.text;
    expect(text).not.toContain("## Anchored notes");
    expect(text).not.toContain("no raw fetch");
  });

  it("unwraps the recall {ok,data,hint} envelope so notes are not double-wrapped", async () => {
    // The proxy passes the recall handler's `.data` through; a non-{notes}
    // shape (e.g. the full envelope) would make composeRecon treat it as a
    // non-empty opaque section. Verify the bare {notes:[]} path stays empty.
    const res = await handleUnerrContextProxy(
      { prompt: "touch fetchUser" },
      baseDeps({ recallNotes: async () => ({ notes: [] }) })
    );
    expect(res.content[0]!.text).not.toContain("## Anchored notes");
  });

  it("token_budget wins over budget when both are present; small token_budget shrinks the bundle", async () => {
    // token_budget:50 wins — small budget applies even though budget:9999 is wide.
    const small = await handleUnerrContextProxy(
      { prompt: "add a retry to fetchUser", token_budget: 50, budget: 9999 },
      baseDeps()
    );
    // token_budget:9999 wins — wide budget applies even though budget:50 would truncate.
    const large = await handleUnerrContextProxy(
      { prompt: "add a retry to fetchUser", token_budget: 9999, budget: 50 },
      baseDeps()
    );
    expect(small.isError).toBeUndefined();
    expect(large.isError).toBeUndefined();
    // The small-budget run produces a shorter/more-truncated bundle.
    expect(small.content[0]!.text.length).toBeLessThan(
      large.content[0]!.text.length
    );
  });

  it("renders the flat digest when digest:true is passed", async () => {
    const res = await handleUnerrContextProxy(
      { prompt: "look at fetchUser", digest: true },
      baseDeps()
    );
    // The digest header differs from the verbose renderer.
    expect(res.content[0]!.text).toContain("unerr recon digest");
  });

  it("auto-selects the digest for a large-sweep prompt", async () => {
    // Many entities across many files → large_sweep verdict → digest render.
    const entities = Array.from({ length: 24 }, (_, i) => ({
      key: `e:handler${i}`,
      name: `handler${i}`,
      kind: "function",
      file_path: `src/handlers/h${i}.ts`,
      score: 5,
    }));
    const res = await handleUnerrContextProxy(
      { prompt: "rename logger to log everywhere across the codebase" },
      baseDeps({ runRaw: fakeRunRaw({ entities }) })
    );
    expect(res.content[0]!.text).toContain("unerr recon digest");
  });

  it("W4: a focused edit misclassified as a sweep (breadth phrase, narrow footprint) renders verbatim bodies, not a digest", async () => {
    // "across the" trips the breadth signal → prompt-only verdict is large_sweep
    // → responseFormat 'concise'. But recon realizes ONE entity in ONE file —
    // a focused edit. The focus body must be inlined and the bundle rendered
    // verbatim (renderReconText), NOT collapsed to a body-less digest that would
    // force the agent to re-read startProxy.
    const runRaw: ReconRunner = async (tool, args) => {
      if (tool === "search_code") {
        const entity: Record<string, unknown> = {
          key: "e:startProxy",
          name: "startProxy",
          kind: "function",
          file_path: "src/proxy/proxy.ts",
          score: 9,
        };
        // The focus-body fetch asks for include_body — only then carry source.
        if (args.include_body === true) {
          entity.body = "export function startProxy() { /* BODY_SENTINEL */ }";
          entity.start_line = 10;
          entity.end_line = 20;
        }
        return [entity];
      }
      if (tool === "get_references") {
        return { references: [], direction: "callers", total: 0 };
      }
      return { naming: [], import_direction: [], structure: [] };
    };
    const res = await handleUnerrContextProxy(
      { prompt: "fix the retry across the boot path in startProxy" },
      baseDeps({ runRaw })
    );
    const text = res.content[0]!.text;
    expect(text).toContain("unerr recon —");
    expect(text).not.toContain("unerr recon digest");
    expect(text).toContain("## Focus source");
    expect(text).toContain("BODY_SENTINEL");
  });

  it("W4: a genuine large sweep stays a body-less digest", async () => {
    // Many entities across many files → no focused footprint → no bodies → flat
    // digest, even though the focus-body fetch would have a body to offer.
    const entities = Array.from({ length: 24 }, (_, i) => ({
      key: `e:handler${i}`,
      name: `handler${i}`,
      kind: "function",
      file_path: `src/handlers/h${i}.ts`,
      score: 5,
      body: "/* present but must NOT be inlined for a real sweep */",
    }));
    const res = await handleUnerrContextProxy(
      { prompt: "rename logger to log everywhere across the codebase" },
      baseDeps({ runRaw: fakeRunRaw({ entities }) })
    );
    const text = res.content[0]!.text;
    expect(text).toContain("unerr recon digest");
    expect(text).not.toContain("## Focus source");
  });

  it("W5: anchored notes are absent from the bundle — composeRecon no longer fetches them", async () => {
    // composeRecon stopped fetching unerr_recall_notes — notes are delivered via
    // the per-turn prompt injection hook, never inline in the recon bundle.
    const recallNotes = vi.fn(async () => ({
      notes: [
        { kind: "fct", anchor: "p:", polarity: "~", content: "WEAK_NOTE" },
        {
          kind: "rul",
          anchor: "f:src/api/user.ts",
          polarity: "-",
          content: "STRONG_RULE",
        },
      ],
    }));
    const res = await handleUnerrContextProxy(
      { prompt: "edit fetchUser in src/api/user.ts" },
      baseDeps({ recallNotes })
    );
    const text = res.content[0]!.text;
    // Neither note should appear — absent from the bundle.
    expect(text).not.toContain("STRONG_RULE");
    expect(text).not.toContain("WEAK_NOTE");
    expect(recallNotes).not.toHaveBeenCalled();
  });

  it("recallNotes is not called — composeRecon no longer fetches notes inline", async () => {
    const recallNotes = vi.fn(async () => ({ notes: [] }));
    const runRaw = vi.fn(fakeRunRaw());
    await handleUnerrContextProxy(
      { prompt: "inspect fetchUser callers" },
      baseDeps({ recallNotes, runRaw })
    );
    // composeRecon stopped fetching unerr_recall_notes — recallNotes is a no-op dep.
    expect(recallNotes).not.toHaveBeenCalled();
    const toolsCalled = runRaw.mock.calls.map((c) => c[0]);
    expect(toolsCalled).toContain("search_code");
    expect(toolsCalled).toContain("get_conventions");
    expect(toolsCalled).toContain("get_references");
    // recall_notes must NOT reach runRaw — the handler still routes unerr_recall_notes
    // to recallNotes, so any accidental composeRecon call would not pollute runRaw.
    expect(toolsCalled).not.toContain("unerr_recall_notes");
  });

  it("hands the E4 Layer-A model (with the Layer-B manifest) to recordBundleSavings", async () => {
    const recordBundleSavings = vi.fn();
    await handleUnerrContextProxy(
      { prompt: "edit fetchUser in src/api/user.ts" },
      baseDeps({ recordBundleSavings })
    );
    expect(recordBundleSavings).toHaveBeenCalledOnce();
    const model = recordBundleSavings.mock.calls[0]?.[0];
    // modeled fields present
    expect(model.sources_collapsed).toBeGreaterThan(0);
    expect(model.round_trips_modeled).toBe(model.sources_collapsed - 1);
    expect(model.delivered_tokens).toBeGreaterThan(0);
    // Layer-B manifest carried for post-hoc reconciliation
    expect(Array.isArray(model.delivered_entity_keys)).toBe(true);
    expect(Array.isArray(model.delivered_files)).toBe(true);
    expect(Array.isArray(model.expand_keys)).toBe(true);
  });

  it("swallows a throwing recordBundleSavings — telemetry is never load-bearing", async () => {
    const recordBundleSavings = vi.fn(() => {
      throw new Error("sink down");
    });
    const res = await handleUnerrContextProxy(
      { prompt: "edit fetchUser" },
      baseDeps({ recordBundleSavings })
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain("unerr recon");
  });
});
