import { beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initFactsSchema } from "../intelligence/facts-schema.js";
import { NotesStore } from "../intelligence/notes-store.js";
import {
  _internal,
  inferDslFromLegacy,
  legacyRecallFacts,
  legacyRecordFact,
  legacyRemember,
} from "../tools/intelligence/notes-aliases.js";

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

describe("inferDslFromLegacy — kind inference", () => {
  it("maps 'convention' → cnv", () => {
    expect(_internal.inferKind("convention")).toBe("cnv");
  });
  it("maps 'rule' → rul", () => {
    expect(_internal.inferKind("rule")).toBe("rul");
  });
  it("maps warning aliases → wrn", () => {
    expect(_internal.inferKind("warning")).toBe("wrn");
    expect(_internal.inferKind("anti-pattern")).toBe("wrn");
    expect(_internal.inferKind("negative")).toBe("wrn");
  });
  it("maps 'decision' → dec, 'blocker' → blk", () => {
    expect(_internal.inferKind("decision")).toBe("dec");
    expect(_internal.inferKind("blocker")).toBe("blk");
  });
  it("defaults to fct for unknown / missing fact_type", () => {
    expect(_internal.inferKind(undefined)).toBe("fct");
    expect(_internal.inferKind("")).toBe("fct");
    expect(_internal.inferKind("random-thing")).toBe("fct");
  });
  it("is case-insensitive", () => {
    expect(_internal.inferKind("CONVENTION")).toBe("cnv");
    expect(_internal.inferKind("Anti-Pattern")).toBe("wrn");
  });
});

describe("inferDslFromLegacy — anchor inference", () => {
  it("defaults to p: (project) when subject missing", () => {
    expect(_internal.inferAnchor(undefined)).toBe("p:");
    expect(_internal.inferAnchor("")).toBe("p:");
  });
  it("treats paths with '/' as file anchors", () => {
    expect(_internal.inferAnchor("src/proxy/bridge.ts")).toBe(
      "f:src/proxy/bridge.ts",
    );
  });
  it("treats TS/JS extensions as file anchors even without a slash", () => {
    expect(_internal.inferAnchor("bridge.ts")).toBe("f:bridge.ts");
    expect(_internal.inferAnchor("util.tsx")).toBe("f:util.tsx");
    expect(_internal.inferAnchor("foo.mjs")).toBe("f:foo.mjs");
  });
  it("treats '*' as glob anchors when no file extension matches first", () => {
    // The heuristic order is: file-extension > slash > star > entity.
    // A bare '*.test.ts' has a .ts extension and is classified as a file anchor.
    // A pattern with no recognised extension and a star becomes a glob.
    expect(_internal.inferAnchor("packages/*")).toBe("f:packages/*"); // slash wins
    expect(_internal.inferAnchor("*-helper")).toBe("g:*-helper"); // no slash, no ext → glob
  });
  it("defaults to entity (e:) for plain identifiers", () => {
    expect(_internal.inferAnchor("fooBar")).toBe("e:fooBar");
    expect(_internal.inferAnchor("MyClass")).toBe("e:MyClass");
  });
});

describe("inferDslFromLegacy — polarity inference", () => {
  it("returns + for imperatives", () => {
    expect(_internal.inferPolarity("always do X")).toBe("+");
    expect(_internal.inferPolarity("use the helper")).toBe("+");
    expect(_internal.inferPolarity("do this thing")).toBe("+");
    expect(_internal.inferPolarity("must call init first")).toBe("+");
    expect(_internal.inferPolarity("prefer Promise.all")).toBe("+");
  });
  it("returns - for negative imperatives", () => {
    expect(_internal.inferPolarity("never mutate this")).toBe("-");
    expect(_internal.inferPolarity("don't import here")).toBe("-");
    expect(_internal.inferPolarity("dont break the API")).toBe("-");
    expect(_internal.inferPolarity("avoid synchronous reads")).toBe("-");
    expect(_internal.inferPolarity("no global state")).toBe("-");
    expect(_internal.inferPolarity("stop retrying")).toBe("-");
    expect(_internal.inferPolarity("skip the cache")).toBe("-");
  });
  it("returns ~ for ambiguous text", () => {
    expect(_internal.inferPolarity("the file holds two responsibilities")).toBe(
      "~",
    );
    expect(_internal.inferPolarity("anything goes here")).toBe("~");
  });
});

describe("inferDslFromLegacy — wire assembly", () => {
  it("composes all four fields when given full input", () => {
    const wire = inferDslFromLegacy({
      content: "never import intelligence here",
      subject: "src/proxy/bridge.ts",
      fact_type: "rule",
    });
    expect(wire).toBe(
      "rul|f:src/proxy/bridge.ts|-|never import intelligence here",
    );
  });
  it("falls back to source_quote when content is absent", () => {
    const wire = inferDslFromLegacy({
      source_quote: "always use Promise.all here",
      subject: "fooBar",
    });
    expect(wire).toBe("fct|e:fooBar|+|always use Promise.all here");
  });
  it("collapses internal whitespace to single spaces in the content field", () => {
    // Polarity defaults to ~ because the head 'do ' regex needs a word boundary
    // immediately after the single space — double-space breaks that match.
    // We assert the whitespace-collapse on content, not the polarity inference.
    const wire = inferDslFromLegacy({
      content: "always  do   this   thing   now",
    });
    expect(wire).toBe("fct|p:|+|always do this thing now");
  });
  it("throws when neither content nor source_quote is provided", () => {
    expect(() => inferDslFromLegacy({})).toThrow(/source_quote OR content/);
  });
});

describe("legacyRemember — routes into NotesStore.upsertNote", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("rejects low-confidence captures (< 0.5) without writing", async () => {
    const result = await legacyRemember(store, {
      source_quote: "maybe avoid imports here",
      subject: "src/proxy/bridge.ts",
      confidence: 0.3,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/confidence/);
  });

  it("persists high-confidence captures via the new path", async () => {
    const result = await legacyRemember(store, {
      source_quote: "never import intelligence in bridge.ts",
      content: "never import intelligence in bridge.ts",
      subject: "src/proxy/bridge.ts",
      fact_type: "rule",
      confidence: 0.9,
      session_id: "sess-legacy",
      prompt_hash: "p-1",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { stored: boolean; note_id: string };
    expect(data.stored).toBe(true);
    expect(data.note_id).toMatch(/^n-/);
  });

  it("treats missing confidence as 1.0 (accept)", async () => {
    const result = await legacyRemember(store, {
      content: "always batch writes",
      subject: "e:writeBatch",
      session_id: "sess-legacy",
    });
    expect(result.ok).toBe(true);
  });
});

describe("legacyRecordFact — agent-detected facts", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
  });

  it("routes scope as the anchor subject", async () => {
    const result = await legacyRecordFact(store, {
      scope: "src/intelligence/notes-store.ts",
      fact_type: "convention",
      content: "always use named-key relations for 4+ column tables",
      session_id: "sess-legacy",
    });
    expect(result.ok).toBe(true);
    const recalled = await store.recallByAnchors({
      anchors: ["f:src/intelligence/notes-store.ts"],
    });
    expect(recalled.notes.length).toBe(1);
    expect(recalled.notes[0]?.kind).toBe("cnv");
  });

  it("prefers explicit subject over scope when both supplied", async () => {
    const result = await legacyRecordFact(store, {
      scope: "ignore-this",
      subject: "src/a.ts",
      content: "use this approach",
    });
    expect(result.ok).toBe(true);
    const recalled = await store.recallByAnchors({ anchors: ["f:src/a.ts"] });
    expect(recalled.notes.length).toBe(1);
  });
});

describe("legacyRecallFacts — scope→anchor", () => {
  let db: CozoDb;
  let store: NotesStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = new NotesStore(db);
    await store.upsertNote({
      note: "cnv|f:src/a.ts|+|alpha note",
      session_id: "seed",
      prompt_hash: "",
    });
    await store.upsertNote({
      note: "fct|p:|~|project-wide bravo",
      session_id: "seed",
      prompt_hash: "",
    });
  });

  it("scopes to a file when scope looks like a path", async () => {
    const result = await legacyRecallFacts(store, { scope: "src/a.ts" });
    expect(result.ok).toBe(true);
    const data = result.data as { notes: { content: string }[] };
    expect(data.notes.length).toBe(1);
    expect(data.notes[0]?.content).toBe("alpha note");
  });

  it("falls back to project-wide when no scope", async () => {
    const result = await legacyRecallFacts(store, {});
    expect(result.ok).toBe(true);
    const data = result.data as { notes: { content: string }[] };
    expect(data.notes.some((n) => n.content === "project-wide bravo")).toBe(
      true,
    );
  });
});
