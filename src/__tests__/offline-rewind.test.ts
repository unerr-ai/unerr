/**
 * Tests for Zero-Network Rewind — Phase 5.5 P5.5-TEST-07a
 *
 * Tests offline rewind via CozoDB + local git operations.
 * Covers: file restoration, local ledger updates, timeline branching,
 * and blast radius resolution (<200ms).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { offlineRewind } from "../tracking/offline-rewind.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

vi.mock("../utils/git.js", () => ({
  checkoutFile: vi.fn().mockResolvedValue(undefined),
  getGit: vi.fn(),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

class MockCozoGraphStore {
  private entities: Array<{
    key: string;
    kind: string;
    name: string;
    file_path: string;
    start_line: number;
    signature: string;
    body: string;
    fan_in: number;
    fan_out: number;
    risk_level: string;
  }> = [];

  private edges: Array<{ from_key: string; to_key: string; type: string }> = [];

  addEntity(entity: (typeof this.entities)[number]): void {
    this.entities.push(entity);
  }

  addEdge(edge: (typeof this.edges)[number]): void {
    this.edges.push(edge);
  }

  getEntitiesByFile(filePath: string) {
    return this.entities
      .filter((e) => e.file_path === filePath)
      .map((e) => ({
        ...e,
        risk_level: e.risk_level as "high" | "medium" | "normal",
      }));
  }

  getCallersOf(entityKey: string) {
    return this.edges
      .filter((e) => e.to_key === entityKey)
      .map((e) => {
        const entity = this.entities.find((ent) => ent.key === e.from_key);
        return entity
          ? {
              ...entity,
              risk_level: entity.risk_level as "high" | "medium" | "normal",
            }
          : null;
      })
      .filter(Boolean);
  }

  clearDriftOverlay(): void {
    /* no-op for tests */
  }
}

let testDir: string;
let unerrDir: string;
let graph: MockCozoGraphStore;
let ledger: ShadowLedger;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `unerr-test-rewind-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  unerrDir = join(testDir, ".unerr");
  mkdirSync(join(unerrDir, "ledger"), { recursive: true });
  mkdirSync(join(unerrDir, "state"), { recursive: true });

  graph = new MockCozoGraphStore();
  ledger = new ShadowLedger(unerrDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function recordEntry(
  tool: string,
  branch: string,
  headSha: string,
  args?: { files?: string[] }
) {
  return ledger.record(tool, args ?? {}, {}, branch, headSha);
}

describe("Zero-Network Rewind (P5.5-TEST-07a)", () => {
  it("returns error when target entry not found in local ledger", async () => {
    const result = await offlineRewind({
      targetEntryId: "nonexistent",
      cwd: testDir,
      unerrDir,
      graph: graph as unknown as CozoGraphStore,
      ledger,
    });

    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("not found");
  });

  it("dry run returns blast radius without applying changes", async () => {
    const target = recordEntry("sync_local_diff", "main", "sha-target", {
      files: ["src/ok.ts"],
    });

    recordEntry("sync_local_diff", "main", "sha-bad", {
      files: ["src/bad.ts"],
    });

    const result = await offlineRewind({
      targetEntryId: target.id,
      cwd: testDir,
      unerrDir,
      graph: graph as unknown as CozoGraphStore,
      ledger,
      dryRun: true,
    });

    expect(result.status).toBe("dry_run");
    expect(result.rewindEntryId).toBeNull();
    expect(result.filesRestored.length).toBe(0);
  });

  it("local shadow.jsonl updated with status: simulated", async () => {
    const target = recordEntry("sync_local_diff", "main", "sha-111", {
      files: ["src/a.ts"],
    });
    recordEntry("sync_local_diff", "main", "sha-222", {
      files: ["src/b.ts"],
    });

    const result = await offlineRewind({
      targetEntryId: target.id,
      cwd: testDir,
      unerrDir,
      graph: graph as unknown as CozoGraphStore,
      ledger,
    });

    expect(result.status).toBe("simulated");

    const allEntries = ledger.readAllEntries();
    const rewindEntry = allEntries.find((e) => e.id === result.rewindEntryId);
    expect(rewindEntry).toBeDefined();
    expect(rewindEntry?.tool).toBe("revert_to_working_state");
    expect(
      (rewindEntry?.result_summary as Record<string, unknown>).rewind_status
    ).toBe("simulated");
    expect((rewindEntry?.args_summary as Record<string, unknown>).offline).toBe(
      true
    );
  });

  it("local timeline_branch incremented in branch_context.json", async () => {
    const target = recordEntry("sync_local_diff", "main", "sha-aaa");
    recordEntry("sync_local_diff", "main", "sha-bbb");

    const result = await offlineRewind({
      targetEntryId: target.id,
      cwd: testDir,
      unerrDir,
      graph: graph as unknown as CozoGraphStore,
      ledger,
    });

    expect(result.timelineBranch).toBe(2);

    const contextPath = join(unerrDir, "ledger", "branch_context.json");
    expect(existsSync(contextPath)).toBe(true);
    const context = JSON.parse(readFileSync(contextPath, "utf-8")) as {
      timeline_branch: number;
    };
    expect(context.timeline_branch).toBe(2);
  });

  it("rewind produces a valid rewind entry", async () => {
    const target = recordEntry("sync_local_diff", "main", "sha-ccc");
    recordEntry("sync_local_diff", "main", "sha-ddd");

    const result = await offlineRewind({
      targetEntryId: target.id,
      cwd: testDir,
      unerrDir,
      graph: graph as unknown as CozoGraphStore,
      ledger,
    });

    expect(result.status).toBe("simulated");
    expect(result.rewindEntryId).toBeTruthy();
  });

  it("blast radius resolution uses CozoDB entities and callers", async () => {
    graph.addEntity({
      key: "fn-process",
      kind: "function",
      name: "processOrder",
      file_path: "src/orders.ts",
      start_line: 10,
      signature: "processOrder()",
      body: "",
      fan_in: 5,
      fan_out: 2,
      risk_level: "high",
    });

    graph.addEntity({
      key: "fn-checkout",
      kind: "function",
      name: "checkout",
      file_path: "src/checkout.ts",
      start_line: 1,
      signature: "checkout()",
      body: "",
      fan_in: 3,
      fan_out: 1,
      risk_level: "medium",
    });

    graph.addEdge({
      from_key: "fn-checkout",
      to_key: "fn-process",
      type: "calls",
    });

    const ledgerPath = join(unerrDir, "ledger", "shadow.jsonl");
    const targetEntry = {
      id: "tgt-blast",
      ts: new Date(Date.now() - 2000).toISOString(),
      tool: "sync_local_diff",
      args_summary: { files: ["src/ok.ts"] },
      result_summary: {},
      branch: "main",
      head_sha: "sha-tgt",
      session_id: "test-session",
      correlation_id: null,
    };
    const badEntry = {
      id: "bad-blast",
      ts: new Date(Date.now() - 1000).toISOString(),
      tool: "sync_local_diff",
      args_summary: { files: ["src/orders.ts"] },
      result_summary: {},
      branch: "main",
      head_sha: "sha-bad",
      session_id: "test-session",
      correlation_id: null,
    };
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(targetEntry)}\n${JSON.stringify(badEntry)}\n`
    );

    const freshLedger = new ShadowLedger(unerrDir);

    const result = await offlineRewind({
      targetEntryId: "tgt-blast",
      cwd: testDir,
      unerrDir,
      graph: graph as unknown as CozoGraphStore,
      ledger: freshLedger,
      dryRun: true,
    });

    expect(result.status).toBe("dry_run");
    expect(result.blastRadius.affectedEntities.length).toBe(1);
    expect(result.blastRadius.affectedEntities[0]?.key).toBe("fn-process");
    expect(result.blastRadius.affectedEntities[0]?.riskLevel).toBe("high");
    expect(result.blastRadius.affectedCallers).toBe(1);
    expect(result.blastRadius.resolvedInMs).toBeLessThan(200);
  });

  it("sequential offline rewinds increment timeline branch correctly", async () => {
    const target = recordEntry("sync_local_diff", "main", "sha-seq-1");
    recordEntry("sync_local_diff", "main", "sha-seq-2");

    const r1 = await offlineRewind({
      targetEntryId: target.id,
      cwd: testDir,
      unerrDir,
      graph: graph as unknown as CozoGraphStore,
      ledger,
    });
    expect(r1.timelineBranch).toBe(2);

    recordEntry("sync_local_diff", "main", "sha-seq-3");

    const r2 = await offlineRewind({
      targetEntryId: target.id,
      cwd: testDir,
      unerrDir,
      graph: graph as unknown as CozoGraphStore,
      ledger,
    });
    expect(r2.timelineBranch).toBe(3);
  });
});
