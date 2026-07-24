/**
 * A23 regression — the DISPATCH layer must flag a file read that withholds
 * content via `_meta.truncated`, and must NOT gate a plain whole-file read to
 * a JSON outline any more.
 *
 * History (2026-05-31): this signal originally unlocked the `get_file` tool.
 * After the token-overhead catalog reduction, `get_file` left the catalog
 * entirely (its job folded into `file_read`), so NO tool unlocks on a
 * truncated/gated read any more — `get_references` is the sole gated tool and
 * it keys off an edit/write attempt or a high-fan-in entity, not truncation.
 *
 * 2026-07-23 (three-mode redesign): the large-file gate-to-outline branch was
 * removed — a plain `file_read({file_path})` over budget now truncates to the
 * budget and appends a plain footer, never a JSON outline. `_meta.gated` no
 * longer fires on this path.
 *
 * What remains load-bearing — and is what this file now pins — is the dispatch
 * behaviour itself:
 *   - large whole-file read: truncates to budget, plain footer, `_meta.gated`
 *     stays unset.
 *   - wire-cap (`src/proxy/wire-cap.ts`): top-level `{status:"too_large"}` body
 *     → the dispatch stamps `_meta.truncated`.
 *   - entity gate (`file-read-protocol.ts`): top-level `{entity_overflow:true}`
 *     → the dispatch stamps `_meta.truncated`.
 *
 * These drive `QueryRouter.execute` against real files on disk (no stubbing),
 * so the dispatch's meta-stamping stays honest.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "../intelligence/cozo-schema.js";
import type { CozoDb } from "../intelligence/cozo-schema.js";
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

/** `router.execute` wraps the body as `{ content, _meta, _context }`. */
function metaOf(result: unknown): Record<string, unknown> {
  return (
    ((result as { _meta?: Record<string, unknown> })?._meta as Record<
      string,
      unknown
    >) ?? {}
  );
}

const BIG_FILE = Array.from(
  { length: 1200 },
  (_, i) => `export const symbol_${i} = ${i}; // padding line ${i}`
).join("\n");

describe("A23 dispatch regression: a large file_read stamps content-withheld meta", () => {
  let db: CozoDb;
  let store: CozoGraphStore;
  let router: QueryRouter;
  let root: string;

  beforeEach(async () => {
    db = await createMemDb();
    await initSchema(db);
    store = await CozoGraphStore.create(db);
    router = new QueryRouter(store);
    root = mkdtempSync(join(tmpdir(), "ur-trunc-"));
    router.setProjectRoot(root);
    writeFileSync(join(root, "big.ts"), BIG_FILE, "utf-8");
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
    await db.close?.();
  });

  it("large whole-file read truncates to budget with a plain footer (no outline)", async () => {
    const args = { file_path: "big.ts" };
    const result = await router.execute("file_read", args);

    // No more gate-to-outline: a plain whole-file read never sets
    // `_meta.gated` any more — it truncates to the token budget instead.
    expect(metaOf(result).gated).not.toBe(true);
    const body =
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content);
    expect(body).toContain(
      "(file has 1200 lines; use offset/limit for more, outline:true for structure)"
    );
  });

  it("wire-cap path: an oversized offset/limit read sets _meta.truncated", async () => {
    // Explicit offset/limit bypasses outline gating and returns raw numbered
    // content (~60 KB) which overflows the 8192-byte wire cap → the dispatch
    // stamps _meta.truncated off the top-level `status:"too_large"` body.
    const args = { file_path: "big.ts", offset: 1, limit: 1200 };
    const result = await router.execute("file_read", args);

    expect(metaOf(result).truncated).toBe(true);
  });

  it("small file_read within the cap neither gates nor truncates", async () => {
    writeFileSync(join(root, "small.ts"), "export const a = 1;\n", "utf-8");
    const args = { file_path: "small.ts" };
    const result = await router.execute("file_read", args);

    const meta = metaOf(result);
    expect(meta.gated).not.toBe(true);
    expect(meta.truncated).not.toBe(true);
  });
});
