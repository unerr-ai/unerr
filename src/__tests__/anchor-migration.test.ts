import { beforeEach, describe, expect, it } from "vitest";
import {
  type GitRunner,
  RENAME_LOOKBACK_DEFAULT,
  RENAME_SIMILARITY_MIN_DEFAULT,
  detectGitRename,
  handleFileDeletion,
} from "../intelligence/anchor-migration.js";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initFactsSchema } from "../intelligence/facts-schema.js";
import { NotesStore } from "../intelligence/notes-store.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

const SESSION = "sess-anchor-mig";

function fakeGit(output: string): GitRunner {
  return () => output;
}

function fakeGitThrows(): GitRunner {
  return () => {
    throw new Error("not a git repo");
  };
}

describe("detectGitRename (C7 layer 2)", () => {
  it("returns new_path when similarity >= threshold", () => {
    const result = detectGitRename({
      repo_dir: "/fake",
      old_path: "src/old.ts",
      git: fakeGit("R087\tsrc/old.ts\tsrc/new.ts\n"),
    });
    expect(result.new_path).toBe("src/new.ts");
    expect(result.similarity).toBe(87);
  });

  it("returns below_threshold when similarity below min", () => {
    const result = detectGitRename({
      repo_dir: "/fake",
      old_path: "src/old.ts",
      similarity_min: 90,
      git: fakeGit("R087\tsrc/old.ts\tsrc/new.ts\n"),
    });
    expect(result.new_path).toBeUndefined();
    expect(result.reason).toBe("below_threshold");
    expect(result.similarity).toBe(87);
  });

  it("skips rename lines whose 'from' path doesn't match", () => {
    const result = detectGitRename({
      repo_dir: "/fake",
      old_path: "src/wanted.ts",
      git: fakeGit("R090\tsrc/other.ts\tsrc/elsewhere.ts\n"),
    });
    expect(result.new_path).toBeUndefined();
    expect(result.reason).toBe("no_match");
  });

  it("returns git_error when the runner throws", () => {
    const result = detectGitRename({
      repo_dir: "/fake",
      old_path: "src/old.ts",
      git: fakeGitThrows(),
    });
    expect(result.reason).toBe("git_error");
  });

  it("constants are stable", () => {
    expect(RENAME_LOOKBACK_DEFAULT).toBe(20);
    expect(RENAME_SIMILARITY_MIN_DEFAULT).toBe(80);
  });
});

describe("NotesStore.markAnchorMissing (C7 layer 3)", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("flags every note for the anchor and records since-time", async () => {
    await store.upsertNote({
      note: "rul|f:src/lost.ts|+|alpha",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    await store.upsertNote({
      note: "wrn|f:src/lost.ts|-|bravo",
      session_id: SESSION,
      prompt_hash: "p2",
    });
    const result = await store.markAnchorMissing("f:src/lost.ts", 5_000);
    expect(result.flagged).toBe(2);
    expect(result.anchor).toBe("f:src/lost.ts");
  });

  it("only flags rows that are not already flagged (idempotent)", async () => {
    await store.upsertNote({
      note: "rul|f:src/x.ts|+|alpha",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const first = await store.markAnchorMissing("f:src/x.ts");
    expect(first.flagged).toBe(1);
    const second = await store.markAnchorMissing("f:src/x.ts");
    expect(second.flagged).toBe(0);
  });

  it("returns flagged=0 when no notes exist for the anchor", async () => {
    const result = await store.markAnchorMissing("f:src/nothing.ts");
    expect(result.flagged).toBe(0);
  });
});

describe("handleFileDeletion (C7 orchestrator)", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("migrates notes when git rename is detected with sufficient similarity", async () => {
    await store.upsertNote({
      note: "rul|f:src/old.ts|+|carries over",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const result = await handleFileDeletion(store, {
      repo_dir: "/fake",
      deleted_path: "src/old.ts",
      git: fakeGit("R090\tsrc/old.ts\tsrc/new.ts\n"),
    });
    expect(result.outcome).toBe("migrated");
    expect(result.migrated).toBe(1);
    expect(result.new_path).toBe("src/new.ts");

    // Confirm the note now answers under the new anchor.
    const recall = await store.recallByAnchors({ anchors: ["f:src/new.ts"] });
    expect(recall.notes.length).toBe(1);
  });

  it("falls back to silent-decay flag when git finds no rename", async () => {
    await store.upsertNote({
      note: "rul|f:src/lost.ts|+|note",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const result = await handleFileDeletion(store, {
      repo_dir: "/fake",
      deleted_path: "src/lost.ts",
      git: fakeGit(""), // no rename rows
    });
    expect(result.outcome).toBe("flagged_missing");
    expect(result.flagged).toBe(1);
  });

  it("falls back to silent-decay when rename is below similarity threshold", async () => {
    await store.upsertNote({
      note: "rul|f:src/maybe.ts|+|note",
      session_id: SESSION,
      prompt_hash: "p1",
    });
    const result = await handleFileDeletion(store, {
      repo_dir: "/fake",
      deleted_path: "src/maybe.ts",
      git: fakeGit("R040\tsrc/maybe.ts\tsrc/probably_unrelated.ts\n"),
    });
    expect(result.outcome).toBe("flagged_missing");
  });

  it("returns no_anchored_notes when nothing referenced the path", async () => {
    const result = await handleFileDeletion(store, {
      repo_dir: "/fake",
      deleted_path: "src/never_anchored.ts",
      git: fakeGit(""),
    });
    expect(result.outcome).toBe("no_anchored_notes");
  });
});
