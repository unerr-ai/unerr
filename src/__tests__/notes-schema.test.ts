import { beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initFactsSchema } from "../intelligence/facts-schema.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

describe("notes + co_change_groups schema (A1)", () => {
  let db: CozoDb;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
  });

  it("creates the notes relation with all documented columns", async () => {
    const relations = await db.run("::relations");
    const names = new Set(relations.rows.map((row) => row[0] as string));
    expect(names.has("notes")).toBe(true);

    const cols = await db.run("::columns notes");
    const colNames = new Set(cols.rows.map((row) => row[0] as string));
    for (const required of [
      "note_id",
      "kind",
      "anchor_type",
      "anchor_value",
      "polarity",
      "content",
      "dedupe_key",
      "reinforcement_count",
      "contradiction_count",
      "created_session_id",
      "created_prompt_hash",
      "created_at",
      "last_seen_at",
      "decay_score",
      "conflict_group_id",
      "supersedes_note_id",
      "inactive",
      "anchor_missing",
      "anchor_missing_since",
    ]) {
      expect(colNames.has(required)).toBe(true);
    }
  });

  it("creates the co_change_groups relation", async () => {
    const relations = await db.run("::relations");
    const names = new Set(relations.rows.map((row) => row[0] as string));
    expect(names.has("co_change_groups")).toBe(true);

    const cols = await db.run("::columns co_change_groups");
    const colNames = new Set(cols.rows.map((row) => row[0] as string));
    for (const required of [
      "group_id",
      "anchors",
      "content",
      "reinforcement_count",
      "created_at",
      "last_seen_at",
    ]) {
      expect(colNames.has(required)).toBe(true);
    }
  });

  it("accepts a representative note insert across all kinds and anchor types", async () => {
    const cases: Array<[string, string, string, string, string, string]> = [
      ["n1", "cnv", "p", "", "+", "all CozoDB calls use await"],
      ["n2", "rul", "f", "src/proxy/bridge.ts", "-", "no intelligence imports"],
      ["n3", "wrn", "g", "*.test.ts", "-", "do not mock cozo db"],
      ["n4", "dec", "e", "TURN_OPEN_GAP_MS", "+", "15s avoids RTT misclassification"],
      ["n5", "blk", "f", "src/proxy/proxy.ts", "~", "stdio + UDS sites must mirror"],
      ["n6", "fct", "f", "src/proxy/turn-state.ts", "+", "noteToolCall returns ToolCallNote"],
    ];

    for (const [id, kind, atype, aval, pol, content] of cases) {
      await db.run(
        `?[note_id, kind, anchor_type, anchor_value, polarity, content,
           dedupe_key, reinforcement_count, contradiction_count,
           created_session_id, created_prompt_hash, created_at, last_seen_at,
           decay_score, conflict_group_id, supersedes_note_id,
           inactive, anchor_missing, anchor_missing_since] <- [[
           $id, $kind, $atype, $aval, $pol, $content,
           $dk, 0, 0, 'sess-test', 'prompt-h', 1000.0, 1000.0,
           0.0, '', '', false, false, 0.0
         ]]
         :put notes`,
        {
          id,
          kind,
          atype,
          aval,
          pol,
          content,
          dk: `${kind}|${atype}:${aval}|${pol}|${content.split(" ").slice(0, 5).join(" ")}`,
        }
      );
    }

    const stored = await db.run(`?[note_id] := *notes{note_id}`);
    expect(stored.rows.length).toBe(cases.length);
  });

  it("accepts a co_change_groups insert with JSON-encoded anchor list", async () => {
    await db.run(
      `?[group_id, anchors, content, reinforcement_count, created_at, last_seen_at] <- [[
         'g1',
         '["f:src/a.ts","f:src/b.ts"]',
         'co-change confirmed across 3 sessions',
         3, 1000.0, 1000.0
       ]]
       :put co_change_groups`
    );
    const stored = await db.run(`?[group_id, anchors] := *co_change_groups{group_id, anchors}`);
    expect(stored.rows.length).toBe(1);
    const anchors = JSON.parse(stored.rows[0]?.[1] as string);
    expect(anchors).toEqual(["f:src/a.ts", "f:src/b.ts"]);
  });

  it("is idempotent — re-running initFactsSchema does not throw", async () => {
    await expect(initFactsSchema(db)).resolves.toBeUndefined();
    await expect(initFactsSchema(db)).resolves.toBeUndefined();
  });
});
