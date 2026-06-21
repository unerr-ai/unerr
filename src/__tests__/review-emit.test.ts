/**
 * REVIEW producer — verifies FindingsStore.record() (the content-addressed dedup
 * chokepoint) mirrors each surfaced finding into the unified per-repo event store
 * as one contract-shaped `review_finding` event. HR-2: an entity anchor is hashed
 * to an opaque 16-hex id (never the raw entity key), `target_file` is repo-relative
 * (the firewall-safe key the server stores), and detail carries no raw source.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestEvent } from "@unerr-ai/contracts/ingest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetEmitContextForTest, configureEmit } from "../events/enqueue.js";
import { PROXY_SEGMENT, segmentPath } from "../events/event-store.js";
import { FindingsStore } from "../review/findings-store.js";
import type { ReviewReportView } from "../review/report.js";

/** Minimal report view: one entity-anchored finding + one file-anchored finding. */
function reportView(): ReviewReportView {
  return {
    scope: "staged",
    filesReviewed: 1,
    clean: false,
    total: 2,
    suppressed: 0,
    bySeverity: { info: 0, low: 0, medium: 0, high: 2, critical: 0 },
    needsModel: 0,
    checkersRun: ["breaking_caller", "boundary_check"],
    checkersErrored: [],
    durationMs: 1,
    groups: [
      {
        anchor: "e:src/proxy/proxy.ts::startProxy",
        anchorKind: "entity",
        topSeverity: "high",
        findings: [
          {
            checkerId: "breaking_caller",
            tier: 1,
            severity: "high",
            needsModel: false,
            title: "9 callers mismatch changed signature of startProxy",
            evidence: ["3 of 4 sibling callers null-check first"],
            action:
              "update the 9 callers of startProxy to pass the new argument",
            line: 42,
          },
        ],
      },
      {
        anchor: "f:src/proxy/bridge.ts",
        anchorKind: "file",
        topSeverity: "high",
        findings: [
          {
            checkerId: "boundary_check",
            tier: 1,
            severity: "high",
            needsModel: false,
            title: "bridge.ts imports an intelligence module",
            evidence: [
              "src/proxy/bridge.ts imports src/intelligence/local-graph.ts",
            ],
            action: "remove the intelligence import from src/proxy/bridge.ts",
            line: 7,
          },
        ],
      },
    ],
  };
}

describe("REVIEW producer — FindingsStore emits a review_finding event per finding", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-review-emit-"));
    _resetEmitContextForTest();
    configureEmit({
      repoRoot,
      segment: PROXY_SEGMENT,
      source: "unerr-cli@test",
    });
  });

  afterEach(() => {
    _resetEmitContextForTest();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("writes one contract-valid review_finding per finding, with hashed entity anchor", () => {
    const store = new FindingsStore(join(repoRoot, ".unerr"));
    store.record(reportView(), { commitRef: "abc123", branch: "main" });

    const segment = segmentPath(repoRoot, PROXY_SEGMENT);
    const events = readFileSync(segment, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "review_finding");

    // One event per surfaced finding (two groups, one finding each).
    expect(events).toHaveLength(2);

    // Every event validates against the shared contract's IngestEvent union.
    for (const event of events) {
      expect(IngestEvent.safeParse(event).success).toBe(true);
    }

    const byChecker = new Map(
      events.map((e) => [(e.detail as Record<string, unknown>).checker_id, e])
    );

    // Entity-anchored finding: entity_id is a 16-hex hash, never the raw key.
    const entityEvent = byChecker.get("breaking_caller");
    expect(entityEvent).toBeDefined();
    const entityDetail = entityEvent?.detail as Record<string, unknown>;
    expect(entityDetail.entity_id).toMatch(/^[0-9a-f]{16}$/);
    expect(entityDetail.entity_id).not.toContain("startProxy");
    expect("target_file" in entityDetail).toBe(false);
    expect(entityDetail.severity).toBe("high");
    expect(entityDetail.commit_ref).toBe("abc123");
    expect(entityDetail.branch).toBe("main");
    expect(entityDetail.state).toBe("open");
    expect(typeof entityDetail.finding_key).toBe("string");

    // File-anchored finding: repo-relative target_file, 1-based start_line, no entity_id.
    const fileEvent = byChecker.get("boundary_check");
    expect(fileEvent).toBeDefined();
    const fileDetail = fileEvent?.detail as Record<string, unknown>;
    expect(fileDetail.target_file).toBe("src/proxy/bridge.ts");
    expect(fileDetail.start_line).toBe(7);
    expect("entity_id" in fileDetail).toBe(false);
  });
});
