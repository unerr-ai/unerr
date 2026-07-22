/**
 * No-graph escape hatch — `QueryRouter.execute()` must prepend ONE `ur|act`
 * line naming built-in Read/Grep/Glob (and telling the agent to stop calling
 * search_code/get_references/file_outline) when the repo's graph is absent or
 * below `MIN_USEFUL_ENTITIES`, and must never emit it once the graph is ready.
 *
 * Readiness is read straight off the filesystem (`readGraphReadiness`), so
 * each test writes `.unerr/{config.json,graph.db,state/graph-stats.json}`
 * fixtures into a temp dir and points the router at it via `setProjectRoot`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_USEFUL_ENTITIES } from "../intelligence/graph-readiness.js";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { QueryRouter } from "../intelligence/query-router.js";

// 16 lowercase hex chars — resolveKeyArg's fast path, skips the DB name
// lookup entirely so get_references doesn't need a searchEntities mock.
const ENTITY_KEY = "0123456789abcdef";

function createMockLocalGraph(): CozoGraphStore {
  const mockDb = { run: vi.fn(async () => ({ rows: [] })) };
  return {
    db: mockDb,
    searchEntities: vi.fn().mockResolvedValue([]),
    getCallersOf: vi.fn().mockResolvedValue([]),
    getCalleesOf: vi.fn().mockResolvedValue([]),
    getEntity: vi.fn().mockResolvedValue(null),
    getImports: vi.fn().mockResolvedValue([]),
    hasRules: vi.fn().mockResolvedValue(false),
    getRules: vi.fn().mockResolvedValue([]),
    hasJustifications: vi.fn().mockResolvedValue(false),
    getBusinessContext: vi.fn().mockResolvedValue(null),
    getConventions: vi.fn().mockResolvedValue([]),
    getConventionsForEntity: vi.fn().mockResolvedValue([]),
    getDriftEntitiesForFile: vi.fn().mockResolvedValue([]),
    getDriftSummary: vi.fn().mockResolvedValue({
      added: 0,
      modified: 0,
      deleted: 0,
      total: 0,
    }),
    healthCheck: vi.fn().mockReturnValue({ status: "up", latencyMs: 0 }),
    isLoaded: vi.fn().mockReturnValue(true),
  } as unknown as CozoGraphStore;
}

/** Write `.unerr/{config.json,graph.db,state/graph-stats.json}` fixtures. */
function writeUnerrFixture(dir: string, entities: number | undefined): void {
  const unerrDir = path.join(dir, ".unerr");
  fs.mkdirSync(unerrDir, { recursive: true });
  fs.writeFileSync(path.join(unerrDir, "config.json"), "{}");
  fs.writeFileSync(path.join(unerrDir, "graph.db"), "");
  if (entities !== undefined) {
    fs.mkdirSync(path.join(unerrDir, "state"), { recursive: true });
    fs.writeFileSync(
      path.join(unerrDir, "state", "graph-stats.json"),
      JSON.stringify({ entities, edges: 0, rules: 0 })
    );
  }
}

/** Count occurrences of the `ur|act` no-graph line across a response body,
 *  regardless of the wire shape (string, MCP text-block array, or object). */
function countEscapeHatchLines(content: unknown): number {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return (text.match(/ur\|act no code graph indexed/g) ?? []).length;
}

describe("QueryRouter — no-graph escape hatch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unerr-no-graph-router-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe.each(["search_code", "get_references"] as const)(
    "%s",
    (toolName) => {
      const argsFor = (tool: string): Record<string, unknown> =>
        tool === "search_code" ? { query: "anything" } : { key: ENTITY_KEY };

      it("emits the escape-hatch line exactly once when the graph is empty", async () => {
        writeUnerrFixture(tmpDir, MIN_USEFUL_ENTITIES - 1);
        const router = new QueryRouter(createMockLocalGraph());
        router.setProjectRoot(tmpDir);

        const result = await router.execute(toolName, argsFor(toolName));

        expect(countEscapeHatchLines(result.content)).toBe(1);
        const text = JSON.stringify(result.content);
        expect(text).toContain("ur|act");
        expect(text).toContain("Read");
        expect(text).toContain("Grep");
        expect(text).toContain("Glob");
        expect(text).toContain("search_code");
        expect(text).toContain("get_references");
        expect(text).toContain("file_outline");
      });

      it("emits the escape-hatch line exactly once when no graph exists at all", async () => {
        // No .unerr/ directory whatsoever — the "no-config" reason.
        const router = new QueryRouter(createMockLocalGraph());
        router.setProjectRoot(tmpDir);

        const result = await router.execute(toolName, argsFor(toolName));

        expect(countEscapeHatchLines(result.content)).toBe(1);
      });

      it("never emits the escape-hatch line when the graph is ready", async () => {
        writeUnerrFixture(tmpDir, MIN_USEFUL_ENTITIES + 500);
        const router = new QueryRouter(createMockLocalGraph());
        router.setProjectRoot(tmpDir);

        const result = await router.execute(toolName, argsFor(toolName));

        expect(countEscapeHatchLines(result.content)).toBe(0);
        expect(JSON.stringify(result.content)).not.toContain(
          "ur|act no code graph indexed"
        );
      });
    }
  );

  it("does not gate non-navigation tools (get_conventions) on graph readiness", async () => {
    writeUnerrFixture(tmpDir, MIN_USEFUL_ENTITIES - 1);
    const router = new QueryRouter(createMockLocalGraph());
    router.setProjectRoot(tmpDir);

    const result = await router.execute("get_conventions", {});

    expect(countEscapeHatchLines(result.content)).toBe(0);
  });

  it("emits the softer retry line (not stop-for-session) while indexing", async () => {
    // graph.db present but no stats file yet → reason "indexing": the graph is
    // about to land, so the agent must be told to retry, not to give up.
    writeUnerrFixture(tmpDir, undefined);
    const router = new QueryRouter(createMockLocalGraph());
    router.setProjectRoot(tmpDir);

    const result = await router.execute("search_code", { query: "anything" });

    const text = JSON.stringify(result.content);
    expect(text).toContain("ur|act graph is still indexing");
    expect(text).toContain("re-call search_code");
    // Must NOT tell the agent to abandon the tools for the whole session.
    expect(countEscapeHatchLines(result.content)).toBe(0);
  });
});
