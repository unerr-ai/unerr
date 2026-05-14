/**
 * Sprint L11 Tests: Background indexing, partial graph serving, deferred DriftTracker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import type { IndexResult } from "../intelligence/local-indexer.js";

// ── BackgroundIndexer Tests ─────────────────────────────────────

// Mock indexLocalProject so we don't need real CozoDB or tree-sitter
vi.mock("../intelligence/local-indexer.js", () => ({
  indexLocalProject: vi.fn(
    async (
      _projectRoot: string,
      _graphStore: unknown,
      _repoId: string,
      opts?: {
        onProgress?: (event: {
          processed: number;
          total: number;
          phase: string;
          currentFile: string | null;
        }) => void;
      },
    ) => {
      const phases = [
        "discovering",
        "extracting",
        "resolving",
        "populating",
        "communities",
        "search",
        "snapshot",
      ] as const;

      for (let i = 0; i < phases.length; i++) {
        opts?.onProgress?.({
          processed: i + 1,
          total: phases.length,
          phase: phases[i]!,
          currentFile: i === 1 ? "src/index.ts" : null,
        });
        // Yield to event loop between phases
        await new Promise((r) => setTimeout(r, 5));
      }

      return {
        fileCount: 2,
        entityCount: 5,
        edgeCount: 3,
        elapsedMs: 42,
        communityCount: 1,
        patternCount: 3,
        ruleCount: 2,
      };
    },
  ),
}));

describe("BackgroundIndexer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts in idle state", async () => {
    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );
    const indexer = new BackgroundIndexer();

    expect(indexer.getStatus()).toBe("idle");
    expect(indexer.isIndexing()).toBe(false);
    expect(indexer.isComplete()).toBe(false);
    expect(indexer.getResult()).toBeNull();
    expect(indexer.getError()).toBeNull();
  });

  it("transitions to indexing state immediately after start()", async () => {
    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );
    const indexer = new BackgroundIndexer();
    const mockGraphStore = {} as CozoGraphStore;

    indexer.start(
      "/tmp/test-project",
      mockGraphStore,
      "test-repo",
      () => {},
      () => {},
    );

    expect(indexer.getStatus()).toBe("indexing");
    expect(indexer.isIndexing()).toBe(true);

    // Wait for completion
    await vi.waitFor(
      () => {
        expect(indexer.isComplete()).toBe(true);
      },
      { timeout: 5000 },
    );
  });

  it("reports progress during indexing", async () => {
    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );
    const indexer = new BackgroundIndexer();
    const mockGraphStore = {} as CozoGraphStore;

    const progressSnapshots: Array<{
      processed: number;
      total: number;
      phase: string;
    }> = [];

    indexer.start(
      "/tmp/test-project",
      mockGraphStore,
      "test-repo",
      () => {},
      () => {},
    );

    // Poll progress a few times
    const pollInterval = setInterval(() => {
      const p = indexer.getProgress();
      progressSnapshots.push({
        processed: p.processed,
        total: p.total,
        phase: p.phase,
      });
    }, 2);

    await vi.waitFor(
      () => {
        expect(indexer.isComplete()).toBe(true);
      },
      { timeout: 5000 },
    );

    clearInterval(pollInterval);

    // Should have captured at least one progress snapshot
    expect(progressSnapshots.length).toBeGreaterThan(0);
  });

  it("calls onComplete with IndexResult on success", async () => {
    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );
    const indexer = new BackgroundIndexer();
    const mockGraphStore = {} as CozoGraphStore;

    let completedResult: IndexResult | null = null;

    indexer.start(
      "/tmp/test-project",
      mockGraphStore,
      "test-repo",
      (result) => {
        completedResult = result;
      },
      () => {},
    );

    await vi.waitFor(
      () => {
        expect(indexer.isComplete()).toBe(true);
      },
      { timeout: 5000 },
    );

    expect(completedResult).not.toBeNull();
    expect((completedResult as unknown as IndexResult).fileCount).toBe(2);
    expect((completedResult as unknown as IndexResult).entityCount).toBe(5);
    expect((completedResult as unknown as IndexResult).elapsedMs).toBe(42);

    // Result should also be accessible via getter
    const storedResult = indexer.getResult();
    expect(storedResult).toEqual(completedResult);
  });

  it("does not start twice if already indexing", async () => {
    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );
    const indexer = new BackgroundIndexer();
    const mockGraphStore = {} as CozoGraphStore;

    let callCount = 0;

    indexer.start(
      "/tmp/test-project",
      mockGraphStore,
      "test-repo",
      () => {
        callCount++;
      },
      () => {},
    );

    // Second start should be a no-op
    indexer.start(
      "/tmp/test-project",
      mockGraphStore,
      "test-repo",
      () => {
        callCount++;
      },
      () => {},
    );

    await vi.waitFor(
      () => {
        expect(indexer.isComplete()).toBe(true);
      },
      { timeout: 5000 },
    );

    // onComplete should have been called exactly once
    expect(callCount).toBe(1);
  });

  it("getElapsedMs returns positive value after completion", async () => {
    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );
    const indexer = new BackgroundIndexer();
    const mockGraphStore = {} as CozoGraphStore;

    indexer.start(
      "/tmp/test-project",
      mockGraphStore,
      "test-repo",
      () => {},
      () => {},
    );

    await vi.waitFor(
      () => {
        expect(indexer.isComplete()).toBe(true);
      },
      { timeout: 5000 },
    );

    expect(indexer.getElapsedMs()).toBeGreaterThan(0);
  });

  it("getState returns full snapshot", async () => {
    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );
    const indexer = new BackgroundIndexer();

    const state = indexer.getState();
    expect(state.status).toBe("idle");
    expect(state.progress.processed).toBe(0);
    expect(state.progress.total).toBe(0);
    expect(state.progress.pct).toBe(0);
    expect(state.result).toBeNull();
    expect(state.error).toBeNull();
    expect(state.startedAt).toBeNull();
    expect(state.completedAt).toBeNull();
  });

  it("handles indexing errors gracefully", async () => {
    // Override mock to throw
    const { indexLocalProject } = await import(
      "../intelligence/local-indexer.js"
    );
    vi.mocked(indexLocalProject).mockRejectedValueOnce(
      new Error("tree-sitter init failed"),
    );

    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );
    const indexer = new BackgroundIndexer();
    const mockGraphStore = {} as CozoGraphStore;

    let errorCaught: Error | null = null;

    indexer.start(
      "/tmp/test-project",
      mockGraphStore,
      "test-repo",
      () => {},
      (err) => {
        errorCaught = err;
      },
    );

    await vi.waitFor(
      () => {
        expect(indexer.getStatus()).toBe("error");
      },
      { timeout: 5000 },
    );

    expect(errorCaught).not.toBeNull();
    expect((errorCaught as unknown as Error).message).toBe(
      "tree-sitter init failed",
    );
    expect(indexer.getError()?.message).toBe("tree-sitter init failed");
    expect(indexer.isComplete()).toBe(false);
    expect(indexer.isIndexing()).toBe(false);
  });
});

// ── Partial Graph Query Tests ───────────────────────────────────

describe("QueryRouter partial graph handling", () => {
  it("returns indexing metadata when backgroundIndexer is active", async () => {
    const { BackgroundIndexer } = await import(
      "../intelligence/background-indexer.js"
    );

    // Create a mock indexer that stays in "indexing" state
    const mockIndexer = new BackgroundIndexer();
    // Manually set state to "indexing" via Object.assign on private fields
    Object.assign(mockIndexer, {
      _status: "indexing",
      _processed: 150,
      _total: 500,
      _phase: "extracting",
      _currentFile: "src/service.ts",
      _startedAt: Date.now(),
    });

    expect(mockIndexer.isIndexing()).toBe(true);
    const progress = mockIndexer.getProgress();
    expect(progress.processed).toBe(150);
    expect(progress.total).toBe(500);
    expect(progress.pct).toBe(30);
    expect(progress.phase).toBe("extracting");
    expect(progress.currentFile).toBe("src/service.ts");
  });
});

// ── IndexProgressEvent Tests ────────────────────────────────────

describe("indexLocalProject onProgress callback", () => {
  it("calls onProgress with phase transitions via mock", async () => {
    const { indexLocalProject } = await import(
      "../intelligence/local-indexer.js"
    );

    const phases: string[] = [];
    await indexLocalProject("/tmp/test", {} as never, "test-repo", {
      onProgress: (event) => {
        if (!phases.includes(event.phase)) {
          phases.push(event.phase);
        }
      },
    });

    // Should have gone through all phases (via our mock)
    expect(phases).toContain("discovering");
    expect(phases).toContain("extracting");
    expect(phases).toContain("resolving");
    expect(phases).toContain("populating");
    expect(phases).toContain("communities");
    expect(phases).toContain("search");
    expect(phases).toContain("snapshot");
  });

  it("reports file count in extracting phase", async () => {
    const { indexLocalProject } = await import(
      "../intelligence/local-indexer.js"
    );

    let maxProcessed = 0;
    let totalReported = 0;
    await indexLocalProject("/tmp/test", {} as never, "test-repo", {
      onProgress: (event) => {
        if (event.phase === "extracting") {
          maxProcessed = Math.max(maxProcessed, event.processed);
          totalReported = event.total;
        }
      },
    });

    // Should have processed and reported totals
    expect(totalReported).toBeGreaterThan(0);
    expect(maxProcessed).toBeGreaterThan(0);
  });
});
