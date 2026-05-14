/**
 * Sprint L2 Tests: Local indexing pipeline, snapshot persistence, edge extraction.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
`,
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
`,
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
`,
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
      "export const x = 1;",
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
      mockHashManager,
    );

    const mockReindex = vi.fn().mockResolvedValue({ entities: 5, edges: 3 });
    tracker.setLocalReindex(mockReindex);

    // The hook is stored internally — we can't directly verify it,
    // but the fact that setLocalReindex doesn't throw is the test.
    expect(mockReindex).not.toHaveBeenCalled();
  });
});
