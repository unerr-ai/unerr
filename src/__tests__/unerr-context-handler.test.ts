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

  it("collapses the discovery fan-out into one rendered bundle", async () => {
    const res = await handleUnerrContextProxy(
      { prompt: "add a retry to fetchUser" },
      baseDeps()
    );
    expect(res.isError).toBeUndefined();
    const text = res.content[0]!.text;
    // Header + the focus entity + the callers section all in ONE response.
    expect(text).toContain("unerr recon —");
    expect(text).toContain("fetchUser");
    expect(text).toContain("## Callers of");
    expect(text).toContain("## Entities");
  });

  it("includes anchored notes (priority 0) — the warm path's edge over the CLI", async () => {
    const recallNotes = vi.fn(async () => ({
      notes: [
        { kind: "rul", anchor: "f:src/api/user.ts", content: "no raw fetch" },
      ],
    }));
    const res = await handleUnerrContextProxy(
      { prompt: "edit fetchUser in src/api/user.ts" },
      baseDeps({ recallNotes })
    );
    expect(recallNotes).toHaveBeenCalledOnce();
    const text = res.content[0]!.text;
    expect(text).toContain("## Anchored notes");
    expect(text).toContain("no raw fetch");
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

  it("routes recall_notes to recallNotes and graph tools to runRaw", async () => {
    const recallNotes = vi.fn(async () => ({ notes: [] }));
    const runRaw = vi.fn(fakeRunRaw());
    await handleUnerrContextProxy(
      { prompt: "inspect fetchUser callers" },
      baseDeps({ recallNotes, runRaw })
    );
    expect(recallNotes).toHaveBeenCalledOnce();
    const toolsCalled = runRaw.mock.calls.map((c) => c[0]);
    expect(toolsCalled).toContain("search_code");
    expect(toolsCalled).toContain("get_conventions");
    expect(toolsCalled).toContain("get_references");
    // recall_notes must NOT reach runRaw — it has its own warm path.
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
