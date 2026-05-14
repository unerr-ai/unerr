/**
 * Sprint 7.4: Entity-level rewind tests.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CozoGraphStore,
  DriftEntity,
} from "../intelligence/local-graph.js";
import { revertEntity } from "../tracking/entity-rewind.js";

/** Minimal mock CozoGraphStore with drift overlay backed by a Map. */
function createMockGraph(
  driftEntities: DriftEntity[] = [],
): CozoGraphStore & { removed: string[] } {
  const overlay = new Map<string, DriftEntity>();
  for (const e of driftEntities) {
    overlay.set(e.key, e);
  }
  const removed: string[] = [];

  return {
    removed,
    db: {
      run: async (query: string, params?: Record<string, unknown>) => {
        // Simulate drift_overlay lookup by name (+ optional file_path filter)
        const name = params?.name as string | undefined;
        const fp = params?.fp as string | undefined;

        const matches: DriftEntity[] = [];
        for (const [, e] of overlay) {
          if (name && e.name !== name) continue;
          if (fp && e.file_path !== fp) continue;
          matches.push(e);
        }

        return {
          rows: matches.map((e) => [
            e.key,
            e.name,
            e.kind,
            e.signature,
            e.body,
            e.file_path,
            e.line_start,
            e.line_end,
            e.content_hash,
            e.drift_status,
            e.intent_id,
            e.modified_at,
            e.origin,
            e.previous_body,
            e.previous_signature,
          ]),
        };
      },
    },
    removeDriftEntity: (key: string) => {
      overlay.delete(key);
      removed.push(key);
    },
  } as unknown as CozoGraphStore & { removed: string[] };
}

function makeDrift(
  overrides: Partial<DriftEntity> & { key: string; name: string },
): DriftEntity {
  return {
    kind: "function",
    signature: "()",
    body: "",
    file_path: "src/test.ts",
    line_start: 1,
    line_end: 3,
    content_hash: "abc",
    drift_status: "modified",
    intent_id: "",
    modified_at: new Date().toISOString(),
    origin: "human",
    previous_body: "",
    previous_signature: "",
    ...overrides,
  };
}

describe("Entity-level rewind", () => {
  it("returns error when entity not found in drift overlay", async () => {
    const graph = createMockGraph();
    const result = await revertEntity("nonExistent", graph, "/tmp");
    expect(result.reverted).toBe(false);
    expect(result.error).toContain("No drifted entity found");
  });

  it("reverts a MODIFIED entity by restoring previous_body", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "rewind-"));
    const srcDir = join(projectRoot, "src");
    mkdirSync(srcDir, { recursive: true });

    // Write the current (modified) file
    const fileContent = [
      "// header",
      "function doStuff() {",
      "  return 'modified';",
      "}",
      "// footer",
    ].join("\n");
    writeFileSync(join(srcDir, "test.ts"), fileContent);

    const graph = createMockGraph([
      makeDrift({
        key: "k1",
        name: "doStuff",
        file_path: "src/test.ts",
        body: "function doStuff() {\n  return 'modified';\n}",
        line_start: 2,
        line_end: 4,
        drift_status: "modified",
        previous_body: "function doStuff() {\n  return 'original';\n}",
      }),
    ]);

    const result = await revertEntity("doStuff", graph, projectRoot);
    expect(result.reverted).toBe(true);
    expect(result.file).toBe("src/test.ts");
    expect(result.drift_status).toBe("modified");
    expect(graph.removed).toContain("k1");

    // Verify file content was restored
    const restored = readFileSync(join(srcDir, "test.ts"), "utf-8");
    expect(restored).toContain("return 'original'");
    expect(restored).not.toContain("return 'modified'");
    expect(restored).toContain("// header");
    expect(restored).toContain("// footer");
  });

  it("reverts an ADDED entity by removing its lines", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "rewind-"));
    const srcDir = join(projectRoot, "src");
    mkdirSync(srcDir, { recursive: true });

    const fileContent = [
      "// existing code",
      "function newFn() {",
      "  return 42;",
      "}",
      "// more code",
    ].join("\n");
    writeFileSync(join(srcDir, "test.ts"), fileContent);

    const graph = createMockGraph([
      makeDrift({
        key: "k2",
        name: "newFn",
        file_path: "src/test.ts",
        body: "function newFn() {\n  return 42;\n}",
        line_start: 2,
        line_end: 4,
        drift_status: "added",
        previous_body: "",
      }),
    ]);

    const result = await revertEntity("newFn", graph, projectRoot);
    expect(result.reverted).toBe(true);
    expect(result.drift_status).toBe("added");
    expect(graph.removed).toContain("k2");

    const restored = readFileSync(join(srcDir, "test.ts"), "utf-8");
    expect(restored).not.toContain("newFn");
    expect(restored).toContain("// existing code");
    expect(restored).toContain("// more code");
  });

  it("reverts a DELETED entity by inserting previous_body", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "rewind-"));
    const srcDir = join(projectRoot, "src");
    mkdirSync(srcDir, { recursive: true });

    // File after deletion — the entity is missing
    const fileContent = ["// header", "// footer"].join("\n");
    writeFileSync(join(srcDir, "test.ts"), fileContent);

    const graph = createMockGraph([
      makeDrift({
        key: "k3",
        name: "removedFn",
        file_path: "src/test.ts",
        body: "",
        line_start: 2,
        line_end: 2,
        drift_status: "deleted",
        previous_body: "function removedFn() {\n  return 'was here';\n}",
      }),
    ]);

    const result = await revertEntity("removedFn", graph, projectRoot);
    expect(result.reverted).toBe(true);
    expect(result.drift_status).toBe("deleted");
    expect(graph.removed).toContain("k3");

    const restored = readFileSync(join(srcDir, "test.ts"), "utf-8");
    expect(restored).toContain("removedFn");
    expect(restored).toContain("was here");
  });

  it("reverts dependency_changed by just removing overlay entry", async () => {
    const graph = createMockGraph([
      makeDrift({
        key: "k4",
        name: "callerFn",
        drift_status: "dependency_changed",
      }),
    ]);

    const result = await revertEntity("callerFn", graph, "/tmp");
    expect(result.reverted).toBe(true);
    expect(result.drift_status).toBe("dependency_changed");
    expect(graph.removed).toContain("k4");
  });

  it("filters by file_path when provided", async () => {
    const graph = createMockGraph([
      makeDrift({
        key: "k5a",
        name: "shared",
        file_path: "src/a.ts",
        drift_status: "modified",
      }),
      makeDrift({
        key: "k5b",
        name: "shared",
        file_path: "src/b.ts",
        drift_status: "modified",
        previous_body: "function shared() { return 'b'; }",
      }),
    ]);

    const projectRoot = mkdtempSync(join(tmpdir(), "rewind-"));
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(
      join(projectRoot, "src", "b.ts"),
      "function shared() { return 'modified'; }",
    );

    const result = await revertEntity("shared", graph, projectRoot, "src/b.ts");
    expect(result.reverted).toBe(true);
    expect(result.file).toBe("src/b.ts");
    expect(graph.removed).toContain("k5b");
    expect(graph.removed).not.toContain("k5a");
  });

  it("returns error when modified entity has no previous_body", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "rewind-"));
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "test.ts"), "some content");

    const graph = createMockGraph([
      makeDrift({
        key: "k6",
        name: "noHistory",
        file_path: "src/test.ts",
        drift_status: "modified",
        previous_body: "",
      }),
    ]);

    const result = await revertEntity("noHistory", graph, projectRoot);
    expect(result.reverted).toBe(false);
    expect(result.error).toContain("No previous body");
  });

  it("stores previous_body in drift overlay when entity is modified", () => {
    // This test verifies the DriftTracker integration —
    // modified entities should preserve the base body for rewind
    const drift = makeDrift({
      key: "k7",
      name: "fn",
      drift_status: "modified",
      previous_body: "function fn() { return 1; }",
      previous_signature: "()",
    });

    expect(drift.previous_body).toBe("function fn() { return 1; }");
    expect(drift.previous_signature).toBe("()");
  });
});
