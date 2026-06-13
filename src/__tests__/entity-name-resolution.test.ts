/**
 * Regression: get_entity name resolution must prefer the class over its methods.
 *
 * `resolveKeyArg` resolves a bare name (e.g. "QueryRouter") to an entity key. A
 * class and its many `Class.method` entities all share the leading name token,
 * so the fuzzy search path can rank a method above the bare class. The exact-name
 * path exists to short-circuit that — but it regressed:
 *
 *   `*entities{name: $n, kind, is_test}` (name bound as a constant on the BASE
 *   relation) makes CozoDB's planner pick an index→base join via the
 *   `entities:by_name` index that SILENTLY returns [] for any column not covered
 *   by the index. Exact-match then yielded nothing, resolution fell through to
 *   fuzzy, and get_entity("QueryRouter") resolved to `QueryRouter.getTotalTokens`.
 *
 * The fix resolves name→key via the index relation explicitly, then reads the
 * base relation by primary key. This test seeds a class + sibling methods into a
 * real CozoDB (whose `initSchema` creates the `by_name` index, reproducing the
 * planner defect) and asserts the bare class name resolves to the class.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";

async function createMemDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const Ctor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (Ctor as new (engine: string, path: string) => CozoDb)("mem", "");
}

describe("get_entity name resolution (by_name index regression)", () => {
  let db: CozoDb;
  let store: CozoGraphStore;
  let router: QueryRouter;

  beforeEach(async () => {
    db = await createMemDb();
    await initSchema(db); // creates the entities:by_name index
    store = await CozoGraphStore.create(db);
    router = new QueryRouter(store);

    // A class plus several sibling methods that all share the "widget" token.
    await store.applyDelta({
      entities: {
        added: [
          {
            key: "k_class",
            kind: "class",
            name: "Widget",
            file_path: "src/widget.ts",
            start_line: 1,
          },
          {
            key: "k_render",
            kind: "method",
            name: "Widget.render",
            file_path: "src/widget.ts",
            start_line: 10,
          },
          {
            key: "k_mount",
            kind: "method",
            name: "Widget.mount",
            file_path: "src/widget.ts",
            start_line: 20,
          },
          {
            key: "k_total",
            kind: "method",
            name: "Widget.getTotalCount",
            file_path: "src/widget.ts",
            start_line: 30,
          },
        ],
        updated: [],
        deletedKeys: [],
      },
      edges: { added: [], removed: [] },
      justifications: { updated: [] },
    } as Parameters<typeof store.applyDelta>[0]);
  });

  afterEach(async () => {
    await db.close?.();
  });

  /** `router.execute` wraps the entity as `{ content: {...}, _meta, _context }`. */
  function contentOf(
    result: unknown
  ): { key?: string; kind?: string; name?: string } | null {
    return (
      (result as { content?: { key?: string; kind?: string; name?: string } })
        ?.content ?? null
    );
  }

  it("resolves a bare class name to the class, not one of its methods", async () => {
    const entity = contentOf(
      await router.execute("get_entity", { key: "Widget" })
    );
    expect(entity).toBeTruthy();
    expect(entity?.kind).toBe("class");
    expect(entity?.name).toBe("Widget");
    expect(entity?.key).toBe("k_class");
  });

  it("still resolves an exact method name to that method", async () => {
    const entity = contentOf(
      await router.execute("get_entity", { key: "Widget.render" })
    );
    expect(entity).toBeTruthy();
    expect(entity?.key).toBe("k_render");
    expect(entity?.name).toBe("Widget.render");
  });
});
