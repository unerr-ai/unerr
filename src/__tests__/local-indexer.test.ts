/**
 * Sprint L2 Tests: Local indexing pipeline, snapshot persistence, edge extraction.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── index-yield mock (hoisted so vi.mock factory can reference it) ──────────
const { mockMaybeYield, mockCreateYieldGate } = vi.hoisted(() => ({
  mockMaybeYield: vi.fn().mockResolvedValue(true),
  mockCreateYieldGate: vi.fn().mockReturnValue({ last: 0, budgetMs: 50 }),
}));

vi.mock("../utils/index-yield.js", () => ({
  DEFAULT_YIELD_BUDGET_MS: 50,
  YIELD_CHECK_STRIDE: 4096,
  createYieldGate: mockCreateYieldGate,
  maybeYield: mockMaybeYield,
}));

// ── Fixture project factory ─────────────────────────────────────

function createFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "unerr-l2-test-"));

  // Create a minimal multi-file TypeScript project
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "src", "utils"), { recursive: true });

  writeFileSync(
    join(dir, "src", "index.ts"),
    `
import { greet } from "./utils/greet.js";

export function main(): void {
  const message = greet("world");
  console.log(message);
}

export class App {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  run(): void {
    main();
  }
}
`
  );

  writeFileSync(
    join(dir, "src", "utils", "greet.ts"),
    `
export function greet(name: string): string {
  return formatMessage(\`Hello, \${name}!\`);
}

export function formatMessage(msg: string): string {
  return msg.trim();
}

export interface Greeting {
  name: string;
  message: string;
}
`
  );

  writeFileSync(
    join(dir, "src", "service.ts"),
    `
import { greet } from "./utils/greet.js";

export class UserService {
  getGreeting(userId: string): string {
    return greet(userId);
  }
}

export interface UserConfig {
  timeout: number;
  retries: number;
}
`
  );

  return dir;
}

// ── Tests ───────────────────────────────────────────────────────

describe("discoverSourceFiles", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createFixtureProject();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("discovers .ts files and skips node_modules", async () => {
    const { discoverSourceFiles } = await import(
      "../intelligence/local-indexer.js"
    );

    // Add a node_modules dir that should be excluded
    mkdirSync(join(projectDir, "node_modules", "fake-pkg"), {
      recursive: true,
    });
    writeFileSync(
      join(projectDir, "node_modules", "fake-pkg", "index.ts"),
      "export const x = 1;"
    );

    const files = discoverSourceFiles(projectDir);
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
    expect(files.some((f) => f.endsWith("index.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("greet.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("service.ts"))).toBe(true);
  });

  it("skips files exceeding 1MB", async () => {
    const { discoverSourceFiles } = await import(
      "../intelligence/local-indexer.js"
    );

    // Create a huge file
    writeFileSync(join(projectDir, "src", "huge.ts"), "x".repeat(2_000_000));

    const files = discoverSourceFiles(projectDir);
    expect(files.every((f) => !f.endsWith("huge.ts"))).toBe(true);
  });
});

describe("extractEdgesAsync", () => {
  it("extracts import edges from TypeScript", async () => {
    const { extractEdgesAsync, extractEntities } = await import(
      "../intelligence/ast-extractor.js"
    );

    const content = `
import { greet } from "./utils/greet.js";
import { App } from "./app.js";

export function main() {
  const msg = greet("world");
  const app = new App("test");
  app.run();
}
`;
    const entities = extractEntities(content, "src/index.ts");
    const edges = await extractEdgesAsync(content, "src/index.ts", entities);

    // Should have import edges
    const importEdges = edges.filter((e) => e.type === "imports");
    expect(importEdges.length).toBeGreaterThanOrEqual(1);

    // Should detect greet import
    const greetImport = importEdges.find((e) => e.to_name === "greet");
    expect(greetImport).toBeDefined();
  });

  it("extracts call edges from TypeScript", async () => {
    const { extractEdgesAsync, extractEntities } = await import(
      "../intelligence/ast-extractor.js"
    );

    const content = `
export function main() {
  const result = helper();
  process(result);
}

function helper(): number {
  return 42;
}

function process(n: number): void {
  console.log(n);
}
`;
    const entities = extractEntities(content, "src/index.ts");
    const edges = await extractEdgesAsync(content, "src/index.ts", entities);

    const callEdges = edges.filter((e) => e.type === "calls");
    // main calls helper and process
    expect(callEdges.some((e) => e.to_name === "helper")).toBe(true);
    expect(callEdges.some((e) => e.to_name === "process")).toBe(true);
  });

  it("extracts extends/implements edges from classes", async () => {
    const { extractEdgesAsync, extractEntities } = await import(
      "../intelligence/ast-extractor.js"
    );

    const content = `
interface Runnable {
  run(): void;
}

class Base {
  start(): void {}
}

export class App extends Base implements Runnable {
  run(): void {}
}
`;
    const entities = extractEntities(content, "src/app.ts");
    const edges = await extractEdgesAsync(content, "src/app.ts", entities);

    const extendsEdges = edges.filter((e) => e.type === "extends");
    const implementsEdges = edges.filter((e) => e.type === "implements");

    expect(extendsEdges.some((e) => e.to_name === "Base")).toBe(true);
    expect(implementsEdges.some((e) => e.to_name === "Runnable")).toBe(true);
  });
});

describe("local-snapshot", () => {
  it("snapshotPath returns consistent path for same root", async () => {
    const { snapshotPath } = await import("../intelligence/local-snapshot.js");
    const path1 = snapshotPath("/tmp/my-project");
    const path2 = snapshotPath("/tmp/my-project");
    expect(path1).toBe(path2);
    expect(path1).toContain(".unerr/snapshots/");
    expect(path1).toMatch(/\.msgpack\.gz$/);
  });

  it("snapshotPath is within the project root", async () => {
    const { snapshotPath } = await import("../intelligence/local-snapshot.js");
    const path1 = snapshotPath("/tmp/project-a");
    const path2 = snapshotPath("/tmp/project-b");
    expect(path1).toContain("/tmp/project-a/.unerr/");
    expect(path2).toContain("/tmp/project-b/.unerr/");
    expect(path1).not.toBe(path2);
  });

  it("shouldReindex returns true when no snapshot exists", async () => {
    const { shouldReindex } = await import("../intelligence/local-snapshot.js");
    // Non-existent project — no snapshot can exist
    const result = shouldReindex(`/tmp/nonexistent-project-${Date.now()}`);
    expect(result).toBe(true);
  });

  it("getSnapshotMeta reports non-existent snapshot", async () => {
    const { getSnapshotMeta } = await import(
      "../intelligence/local-snapshot.js"
    );
    const meta = getSnapshotMeta(`/tmp/nonexistent-project-${Date.now()}`);
    expect(meta.exists).toBe(false);
    expect(meta.path).toContain(".unerr/snapshots/");
  });
});

describe("DriftTracker local reindex hook", () => {
  it("setLocalReindex is callable and stores the hook", async () => {
    const { DriftTracker } = await import("../tracking/drift-tracker.js");

    // Create a minimal mock
    const mockGraph = {
      getEntitiesByFile: () => [],
      getDriftEntitiesForFile: () => [],
      upsertDriftEntity: vi.fn(),
      getCallersOf: () => [],
      findEntityByName: () => null,
      upsertDriftEdge: vi.fn(),
      hasRules: () => false,
      getRules: () => [],
      getDriftSummary: () => ({ total: 0, added: 0, modified: 0, deleted: 0 }),
      clearDriftOverlay: vi.fn(),
    } as unknown as import("../intelligence/local-graph.js").CozoGraphStore;

    const mockHashManager = {
      shouldProcess: () => "process",
      markProcessed: vi.fn(),
      save: vi.fn(),
      clearAll: vi.fn(),
      getState: () => ({}),
      restoreState: vi.fn(),
    } as unknown as import("../tracking/file-hash-state.js").FileHashManager;

    const tracker = new DriftTracker(
      {
        projectRoot: "/tmp/test",
        repoId: "test-repo",
        unerrDir: "/tmp/test/.unerr",
      },
      mockGraph,
      mockHashManager
    );

    const mockReindex = vi.fn().mockResolvedValue({ entities: 5, edges: 3 });
    tracker.setLocalReindex(mockReindex);

    // The hook is stored internally — we can't directly verify it,
    // but the fact that setLocalReindex doesn't throw is the test.
    expect(mockReindex).not.toHaveBeenCalled();
  });
});

describe("discoverSearchableFiles (content-search file walk, DB-free)", () => {
  it("returns code files and skips excluded dirs + non-code extensions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unerr-discover-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;");
      writeFileSync(join(dir, "src", "b.py"), "x = 1");
      writeFileSync(join(dir, "src", "notes.md"), "# docs"); // non-code → skipped
      writeFileSync(join(dir, "node_modules", "pkg", "i.js"), "1"); // excluded dir
      writeFileSync(join(dir, "dist", "out.js"), "1"); // excluded dir

      const { discoverSearchableFiles } = await import(
        "../intelligence/local-indexer.js"
      );
      const files = await discoverSearchableFiles(dir);

      expect(files).toContain("src/a.ts");
      expect(files).toContain("src/b.py");
      expect(files).not.toContain("src/notes.md"); // markdown is not code
      expect(files.some((f) => f.includes("node_modules"))).toBe(false);
      expect(files.some((f) => f.startsWith("dist/"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns relative paths and never queries a graph DB (no db arg)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unerr-discover-rel-"));
    try {
      mkdirSync(join(dir, "pkg", "deep"), { recursive: true });
      writeFileSync(join(dir, "pkg", "deep", "z.ts"), "export const z = 1;");
      const { discoverSearchableFiles } = await import(
        "../intelligence/local-indexer.js"
      );
      const files = await discoverSearchableFiles(dir);
      // Paths are project-root-relative (what searchFileContent resolves against cwd).
      expect(files).toEqual(["pkg/deep/z.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes a file exactly at the 1MB size limit and skips files over it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unerr-discover-size-"));
    // MAX_FILE_SIZE in local-indexer.ts is 1_048_576 (unexported const).
    const MAX_FILE_SIZE = 1_048_576;
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "exactly.ts"), "x".repeat(MAX_FILE_SIZE));
      writeFileSync(
        join(dir, "src", "toolarge.ts"),
        "x".repeat(MAX_FILE_SIZE + 1)
      );

      const { discoverSearchableFiles } = await import(
        "../intelligence/local-indexer.js"
      );
      const files = await discoverSearchableFiles(dir);

      expect(files).toContain("src/exactly.ts");
      expect(files).not.toContain("src/toolarge.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips dot-prefixed directories and their contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unerr-discover-dot-"));
    try {
      mkdirSync(join(dir, ".git", "objects"), { recursive: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, ".git", "objects", "pack.ts"), "1");
      writeFileSync(join(dir, "src", "visible.ts"), "export const v = 1;");

      const { discoverSearchableFiles } = await import(
        "../intelligence/local-indexer.js"
      );
      const files = await discoverSearchableFiles(dir);

      expect(files).toContain("src/visible.ts");
      expect(files.some((f) => f.includes(".git"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers a code file nested several levels deep and returns the correct root-relative path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unerr-discover-deep-"));
    try {
      mkdirSync(join(dir, "a", "b", "c", "d"), { recursive: true });
      writeFileSync(
        join(dir, "a", "b", "c", "d", "deep.ts"),
        "export const deep = true;"
      );

      const { discoverSearchableFiles } = await import(
        "../intelligence/local-indexer.js"
      );
      const files = await discoverSearchableFiles(dir);

      expect(files).toContain("a/b/c/d/deep.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── indexLocalProject event-loop yielding ───────────────────────
// Proves that the yield calls inserted into the per-file loop and around
// community detection actually fire. Uses a mock for index-yield so the
// test is deterministic (no timing dependency), and a minimal graphStore
// stub so the full pipeline can run without a real CozoDB instance.

describe("indexLocalProject event-loop yielding", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createFixtureProject();
    mockMaybeYield.mockClear();
    mockCreateYieldGate.mockClear();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("calls maybeYield at least once per file in the loop", async () => {
    const { indexLocalProject } = await import(
      "../intelligence/local-indexer.js"
    );

    // Minimal graphStore stub: db.run returns empty rows (triggers graceful
    // early-exits in community detection, orphan removal, etc.) and write/
    // clearDriftOverlay are no-ops. Any missing method throws and is caught
    // by the surrounding try/catch blocks in the pipeline.
    const mockDb = { run: vi.fn().mockResolvedValue({ rows: [] }) };
    const mockStore = {
      db: mockDb,
      write: vi.fn().mockResolvedValue({ rows: [] }),
      query: vi.fn().mockResolvedValue({ rows: [] }),
      clearDriftOverlay: vi.fn().mockResolvedValue(undefined),
    } as never;

    await indexLocalProject(projectDir, mockStore, "test-repo");

    // createYieldGate is called once for the parse loop plus once for each
    // finalize loop that now has a gate (buildSearchIndex entity loop,
    // computeCommunityDomains community loop, etc.) → total ≥ 2.
    expect(mockCreateYieldGate.mock.calls.length).toBeGreaterThanOrEqual(2);

    // maybeYield must have been called at least once per file (3 files in
    // the fixture) plus finalize-loop calls → total ≥ 3.
    expect(mockMaybeYield).toHaveBeenCalled();
    expect(mockMaybeYield.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("buildSearchIndex yield gate fires once per entity", async () => {
    const { buildSearchIndex } = await import(
      "../intelligence/search-index.js"
    );
    mockMaybeYield.mockClear();
    mockCreateYieldGate.mockClear();

    // Minimal CozoDb mock: returns 4 entities for the `?[key, name]` query,
    // swallows all :put writes.
    const mockDb = {
      async run(query: string) {
        if (
          typeof query === "string" &&
          query.includes("key, name") &&
          query.includes("*entities")
        ) {
          return {
            rows: [
              ["e1", "processPayment"],
              ["e2", "getUserById"],
              ["e3", "createOrder"],
              ["e4", "validateUser"],
            ],
          };
        }
        return { rows: [] };
      },
    } as never;

    await buildSearchIndex(mockDb);

    // Gate created once for the tokenization loop
    expect(mockCreateYieldGate).toHaveBeenCalledOnce();
    // maybeYield called once per entity (4 entities)
    expect(mockMaybeYield.mock.calls.length).toBe(4);
  });
});
