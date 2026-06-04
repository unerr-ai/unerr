import { beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initFactsSchema } from "../intelligence/facts-schema.js";
import {
  NOTES_SESSION_SAVE_CAP,
  NotesStore,
} from "../intelligence/notes-store.js";
import { recallNotes, remember } from "../tools/intelligence/notes-mcp.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  // biome-ignore lint/suspicious/noExplicitAny: cozo factory
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

const SESSION = "sess-test";

describe("NotesStore.upsertNote (B3a + B5 + B9)", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("creates a new note when no dedupe match exists", async () => {
    const result = await store.upsertNote({
      note: "rul|f:src/a.ts|+|use Promise.all here",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    expect(result.stored).toBe(true);
    expect(result.outcome).toBe("created");
    expect(result.note_id).toMatch(/^n-/);
  });

  it("reinforces on dedupe-key match instead of inserting a second row", async () => {
    const a = await store.upsertNote({
      note: "rul|f:src/a.ts|+|use Promise.all here",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const b = await store.upsertNote({
      note: "rul|f:src/a.ts|+|use Promise.all here",
      session_id: SESSION,
      prompt_hash: "p2",
    });
    expect(b.outcome).toBe("reinforced");
    expect(b.note_id).toBe(a.note_id);
  });

  it("flags conflict_group_id when an opposing-polarity note already exists", async () => {
    await store.upsertNote({
      note: "rul|f:src/a.ts|+|no intelligence imports",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const conflict = await store.upsertNote({
      note: "rul|f:src/a.ts|-|no intelligence imports allowed",
      session_id: SESSION,
      prompt_hash: "p2",
    });
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.conflict_group_id).toBeTruthy();
    const groups = await store.listConflicts();
    expect(groups.length).toBe(1);
    expect(groups[0]?.notes.length).toBe(2);
  });

  it("supersession flips the named row to inactive", async () => {
    const a = await store.upsertNote({
      note: "dec|e:TIMEOUT|+|use 5s",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const b = await store.upsertNote({
      note: "dec|e:TIMEOUT|+|use 15s avoids RTT",
      session_id: SESSION,
      prompt_hash: "p2",
      supersedes_note_id: a.note_id,
    });
    expect(b.stored).toBe(true);
    const anchored = await store.recallByAnchors({ anchors: ["e:TIMEOUT"] });
    const ids = anchored.notes.map((n) => n.note_id);
    expect(ids).toContain(b.note_id);
    expect(ids).not.toContain(a.note_id);
  });

  it("enforces the per-session save cap and returns reinforcement candidates", async () => {
    for (let i = 0; i < NOTES_SESSION_SAVE_CAP; i++) {
      await store.upsertNote({
        note: `fct|f:src/m${i}.ts|+|note number ${i} unique`,
        session_id: SESSION,
        prompt_hash: `p${i}`,
      });
    }
    const over = await store.upsertNote({
      note: "fct|f:src/over.ts|+|this should be rate-limited away",
      session_id: SESSION,
      prompt_hash: "p-over",
    });
    expect(over.stored).toBe(false);
    expect(over.outcome).toBe("rate_limited");
    expect(over.reinforcement_candidates).toBeDefined();
    expect(over.hint).toMatch(/session cap/);
  });
});

describe("NotesStore.recallByAnchors (B3a)", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("returns notes scoped to the requested anchors only", async () => {
    await store.upsertNote({
      note: "rul|f:src/a.ts|+|alpha rule",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    await store.upsertNote({
      note: "rul|f:src/b.ts|+|bravo rule",
      session_id: SESSION,
      prompt_hash: "p2",
    });
    const result = await store.recallByAnchors({ anchors: ["f:src/a.ts"] });
    expect(result.notes.length).toBe(1);
    expect(result.notes[0]?.anchor_value).toBe("src/a.ts");
  });

  it("returns empty for unknown anchors", async () => {
    const result = await store.recallByAnchors({
      anchors: ["f:src/missing.ts"],
    });
    expect(result.notes).toEqual([]);
  });

  it("excludes inactive (superseded) notes from results", async () => {
    const a = await store.upsertNote({
      note: "dec|e:X|+|old",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    await store.upsertNote({
      note: "dec|e:X|+|new replacement decision",
      session_id: SESSION,
      prompt_hash: "p2",
      supersedes_note_id: a.note_id,
    });
    const result = await store.recallByAnchors({ anchors: ["e:X"] });
    expect(result.notes.map((n) => n.note_id)).not.toContain(a.note_id);
  });
});

describe("NotesStore.recallByPrompt (B3a)", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("falls back to project-wide notes when no candidates supplied", async () => {
    await store.upsertNote({
      note: "cnv|p:|+|all CozoDB calls use await",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    await store.upsertNote({
      note: "rul|f:src/a.ts|+|file-scoped rule",
      session_id: SESSION,
      prompt_hash: "p2",
    });
    const result = await store.recallByPrompt({ prompt: "anything" });
    expect(result.notes.length).toBe(1);
    expect(result.notes[0]?.anchor_type).toBe("p");
  });

  it("uses candidate_anchors when provided", async () => {
    await store.upsertNote({
      note: "rul|f:src/router.ts|+|prefer detector",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const result = await store.recallByPrompt({
      prompt: "edit the router",
      candidate_anchors: ["f:src/router.ts"],
    });
    expect(result.notes.length).toBe(1);
  });

  // Regression (Moment-1/Moment-2 contract): recallByPrompt used to default
  // to ["p:"] when no candidate_anchors were passed — and no caller ever
  // passed any, so a note anchored to a file NAMED IN THE PROMPT never rode
  // along in the prompt-receipt hook or the unerr_context bundle.
  it("recalls an f:-anchored note when the prompt names the file", async () => {
    await store.upsertNote({
      note: "rul|f:src/proxy/bridge.ts|-|no intelligence imports",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const result = await store.recallByPrompt({
      prompt: "refactor the heartbeat handling in src/proxy/bridge.ts",
    });
    expect(result.notes.map((n) => n.anchor_value)).toContain(
      "src/proxy/bridge.ts"
    );
  });

  it("recalls an e:-anchored note when the prompt contains the identifier", async () => {
    await store.upsertNote({
      note: "dec|e:TURN_OPEN_GAP_MS|+|15s avoids RTT misclassification",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const result = await store.recallByPrompt({
      prompt: "should I change TURN_OPEN_GAP_MS to 20 seconds?",
    });
    expect(result.notes.map((n) => n.anchor_value)).toContain(
      "TURN_OPEN_GAP_MS"
    );
  });

  it("recalls a g:-anchored note when the prompt names a matching file", async () => {
    await store.upsertNote({
      note: "wrn|g:*.test.ts|-|don't mock cozo db",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const result = await store.recallByPrompt({
      prompt: "add a case to src/__tests__/notes-store.test.ts",
    });
    expect(result.notes.map((n) => n.anchor_value)).toContain("*.test.ts");
  });

  it("project-wide notes ride along with anchored ones", async () => {
    await store.upsertNote({
      note: "cnv|p:|+|all CozoDB calls use await",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    await store.upsertNote({
      note: "rul|f:src/proxy/bridge.ts|-|no intelligence imports",
      session_id: SESSION,
      prompt_hash: "p2",
    });
    const result = await store.recallByPrompt({
      prompt: "edit src/proxy/bridge.ts",
    });
    const types = result.notes.map((n) => n.anchor_type).sort();
    expect(types).toEqual(["f", "p"]);
  });

  it("does not duplicate a note matched by both exact anchor and glob", async () => {
    await store.upsertNote({
      note: "wrn|g:src/proxy/*.ts|-|stdout is MCP JSON-RPC only",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const result = await store.recallByPrompt({
      prompt: "edit src/proxy/bridge.ts and src/proxy/proxy.ts",
    });
    const ids = result.notes.map((n) => n.note_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.notes.map((n) => n.anchor_value)).toContain("src/proxy/*.ts");
  });
});

describe("NotesStore.upsertCoChange (B3a)", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("creates a group on first call and reinforces on second", async () => {
    const first = await store.upsertCoChange({
      anchors: ["f:src/a.ts", "f:src/b.ts"],
      content: "always edit together",
    });
    expect(first.outcome).toBe("created");

    const second = await store.upsertCoChange({
      anchors: ["f:src/b.ts", "f:src/a.ts"], // order-insensitive — sort()'d internally
      content: "always edit together",
    });
    expect(second.outcome).toBe("reinforced");
    expect(second.group_id).toBe(first.group_id);
    expect(second.reinforcement_count).toBe(1);
  });

  it("rejects single-anchor groups", async () => {
    await expect(
      store.upsertCoChange({
        anchors: ["f:src/a.ts"],
        content: "x",
      })
    ).rejects.toThrow(/at least two anchors/);
  });
});

describe("NotesStore.moveAnchor (B3a + C7 entry)", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("migrates every row anchored on old to point at new", async () => {
    await store.upsertNote({
      note: "rul|f:src/old.ts|+|alpha",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    await store.upsertNote({
      note: "wrn|f:src/old.ts|-|bravo",
      session_id: SESSION,
      prompt_hash: "p2",
    });
    const result = await store.moveAnchor({
      old_anchor: "f:src/old.ts",
      new_anchor: "f:src/new.ts",
    });
    expect(result.migrated).toBe(2);
    const oldRecall = await store.recallByAnchors({
      anchors: ["f:src/old.ts"],
    });
    expect(oldRecall.notes).toEqual([]);
    const newRecall = await store.recallByAnchors({
      anchors: ["f:src/new.ts"],
    });
    expect(newRecall.notes.length).toBe(2);
  });
});

describe("notes-mcp dispatch (B3a)", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("recallNotes infers action=for_prompt from input shape", async () => {
    const result = await recallNotes(store, { prompt: "anything" });
    expect(result.ok).toBe(true);
  });

  it("recallNotes infers action=for_anchors when anchors[] set", async () => {
    await store.upsertNote({
      note: "rul|f:src/x.ts|+|something",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const result = await recallNotes(store, { anchors: ["f:src/x.ts"] });
    expect(result.ok).toBe(true);
  });

  it("recallNotes returns error when neither prompt nor anchors supplied", async () => {
    const result = await recallNotes(store, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/prompt.*anchors/);
  });

  it("remember dispatches type=note → upsertNote", async () => {
    const result = await remember(store, {
      type: "note",
      note: "rul|f:src/a.ts|+|use Promise.all",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    expect(result.ok).toBe(true);
  });

  it("remember dispatches type=cochange → upsertCoChange", async () => {
    const result = await remember(store, {
      type: "cochange",
      anchors: ["f:src/a.ts", "f:src/b.ts"],
      content: "co-edit",
    });
    expect(result.ok).toBe(true);
  });

  it("remember dispatches type=move_anchor → moveAnchor", async () => {
    const result = await remember(store, {
      type: "move_anchor",
      old_anchor: "f:src/a.ts",
      new_anchor: "f:src/b.ts",
    });
    expect(result.ok).toBe(true);
  });

  it("remember rejects type=promote_to_claude_md when no writer injected", async () => {
    const result = await remember(store, {
      type: "promote_to_claude_md",
      note_ids: ["n-fake"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/promoteWriter not provided/);
  });

  it("remember invokes injected promoteWriter when present", async () => {
    let called = false;
    const result = await remember(
      store,
      { type: "promote_to_claude_md", note_ids: ["n-1", "n-2"] },
      async (ids) => {
        called = true;
        return { written: ids.length, path: "CLAUDE.md" };
      }
    );
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("remember requires session_id for type=note", async () => {
    const result = await remember(store, {
      type: "note",
      note: "rul|f:src/a.ts|+|x",
    });
    expect(result.ok).toBe(false);
  });

  it("remember defaults type to 'note' when omitted (legacy alias compat)", async () => {
    const result = await remember(store, {
      note: "rul|f:src/a.ts|+|legacy shape",
      session_id: SESSION,
    });
    expect(result.ok).toBe(true);
  });
});

// The standalone notes-family registration (B3a) retired with unerr_remember's
// catalog removal (2026-06) — the write path is hook-driven now (UserPromptSubmit
// capture + `unerr-save:` Stop-hook sentinel), dispatched by name over UDS.
// Family retirement is locked by src/__tests__/unerr-families.test.ts.
