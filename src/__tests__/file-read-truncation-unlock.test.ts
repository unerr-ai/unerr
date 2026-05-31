/**
 * A23 regression — the DISPATCH layer must flag a file read that withholds the
 * full file, so the follow-up `get_file` unlocks.
 *
 * Root cause (2026-05-31): `get_file`'s sole unlock condition is
 * FileReadTruncated, which `call-signals.ts` derived from `_meta.truncated`
 * ONLY. But a large `file_read` withholds content in shapes that never set
 * that flag:
 *   - gated outline (the common case): full file replaced by an outline.
 *     `_meta.gated:true`, but the small outline fits the budget so the
 *     budget-enforcer reports `truncated:false`.
 *   - wire-cap (`src/proxy/wire-cap.ts`): top-level `{status:"too_large"}` body.
 *   - entity gate (`file-read-protocol.ts`): top-level `{entity_overflow:true}`.
 * None of the three set `_meta.truncated`, so `get_file` never unlocked.
 *
 * The fix has two parts, both exercised here through the REAL router dispatch:
 *   1. the dispatch stamps `_meta.truncated` for the top-level body markers
 *      (`status:"too_large"` / `entity_overflow`);
 *   2. `call-signals.ts` also treats `_meta.gated` as "content withheld".
 *
 * The prior unit test in `tool-tiers.test.ts` STUBBED `meta.truncated=true`, so
 * it passed while the dispatch was broken — a test-reality gap. This drives
 * `QueryRouter.execute` against real files on disk instead.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "../intelligence/cozo-schema.js";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";
import { extractSignals } from "../proxy/call-signals.js";
import { SessionState } from "../proxy/session-state.js";
import { evaluateUnlocks } from "../proxy/unlock-evaluator.js";

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
function contentOf(result: unknown): unknown {
  return (result as { content?: unknown })?.content;
}

/** Push a real dispatch result through the unlock pipeline (no stubbing). */
function unlocksAfter(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown
): string[] {
  const s = new SessionState();
  const signals = extractSignals(toolName, {
    args,
    content: contentOf(result),
    meta: metaOf(result) as never,
  });
  s.recordCall(signals);
  return evaluateUnlocks(s).map((u) => u.toolName);
}

const BIG_FILE = Array.from(
  { length: 1200 },
  (_, i) => `export const symbol_${i} = ${i}; // padding line ${i}`
).join("\n");

describe("A23 dispatch regression: a large file_read unlocks get_file", () => {
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

  it("gated outline path: large whole-file read sets _meta.gated and unlocks get_file", async () => {
    const args = { file_path: "big.ts" };
    const result = await router.execute("file_read", args);

    // The whole-file read of a large file is gated to an outline.
    expect(metaOf(result).gated).toBe(true);

    const s = new SessionState();
    expect(s.isExposed("get_file")).toBe(false);
    expect(unlocksAfter("file_read", args, result)).toContain("get_file");
  });

  it("wire-cap path: an oversized offset/limit read sets _meta.truncated and unlocks get_file", async () => {
    // Explicit offset/limit bypasses outline gating and returns raw numbered
    // content (~60 KB) which overflows the 8192-byte wire cap → the dispatch
    // stamps _meta.truncated off the top-level `status:"too_large"` body.
    const args = { file_path: "big.ts", offset: 1, limit: 1200 };
    const result = await router.execute("file_read", args);

    expect(metaOf(result).truncated).toBe(true);
    expect(unlocksAfter("file_read", args, result)).toContain("get_file");
  });

  it("small file_read within the cap neither gates nor truncates → get_file stays locked", async () => {
    writeFileSync(join(root, "small.ts"), "export const a = 1;\n", "utf-8");
    const args = { file_path: "small.ts" };
    const result = await router.execute("file_read", args);

    const meta = metaOf(result);
    expect(meta.gated).not.toBe(true);
    expect(meta.truncated).not.toBe(true);
    expect(unlocksAfter("file_read", args, result)).not.toContain("get_file");
  });
});
