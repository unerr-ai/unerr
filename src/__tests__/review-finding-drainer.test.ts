/**
 * P9 — the review_finding events drainer.
 *
 * Reads the local findings store (`.unerr/state/review-findings.json`) and pushes
 * each finding as a `review_finding` ingest event. These tests pin:
 *  - no store → no drainer;
 *  - findings drain as review_finding events with firewall-safe detail keys;
 *  - the updatedAt cursor advances and re-drains only changed rows;
 *  - rows validate against the IngestEvent contract (UNERR_CONTRACT_STRICT=1).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BatchAck, CloudClient, CloudResult } from "../cloud/client.js";
import { buildReviewDrainers } from "../cloud/drainers/review.js";

// The reviewer is opt-in (OFF by default); the drainer emits nothing while
// disabled, so enable it for this file. Forks isolation keeps env file-local.
process.env.UNERR_REVIEW_ENABLED = "1";
import type { DrainerContext } from "../cloud/push-drainer.js";
import { FindingsStore } from "../review/findings-store.js";
import { buildReviewReportView } from "../review/report.js";
import type { ReviewFinding, ReviewReport } from "../review/types.js";

const DENYLIST = new Set([
  "file",
  "filepath",
  "path",
  "entity",
  "entity_key",
  "content",
  "code",
  "diff",
  "text",
]);

function finding(over: Partial<ReviewFinding>): ReviewFinding {
  return {
    checkerId: "breaking_caller",
    tier: 1,
    severity: "high",
    title: "9 callers mismatch changed signature of foo",
    evidence: ["src/a.ts:42 calls foo(x)"],
    action: "update the 9 callers of foo",
    needsModel: false,
    anchor: { kind: "f", value: "src/a.ts", line: 42 },
    ...over,
  } as ReviewFinding;
}

function seedStore(unerrDir: string, findings: ReviewFinding[]): void {
  const report: ReviewReport = {
    findings,
    suppressed: 0,
    checkersRun: ["breaking_caller"],
    checkersErrored: [],
    durationMs: 1,
    clean: findings.length === 0,
  };
  const view = buildReviewReportView(report, "staged", 1);
  const store = new FindingsStore(unerrDir);
  store.record(view, { branch: "main", commitRef: "abc123" });
  store.save();
}

function makeCtx(unerrDir: string, captured: unknown[][]): DrainerContext {
  const client = {
    async ingestEvents(rows: unknown[]): Promise<CloudResult<BatchAck>> {
      captured.push(rows);
      return {
        ok: true,
        value: { accepted: rows.length, rejected: [], parked: 0 },
      } as unknown as CloudResult<BatchAck>;
    },
  } as unknown as CloudClient;

  return {
    repoPath: "/repo",
    unerrDir,
    repoId: "repo-salt-id",
    client,
    source: "unerr-cli@test",
  };
}

describe("buildReviewDrainers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-review-drainer-"));
    process.env.UNERR_CONTRACT_STRICT = "1";
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.UNERR_CONTRACT_STRICT = undefined;
  });

  it("returns no drainer when the store does not exist", async () => {
    const set = await buildReviewDrainers(makeCtx(dir, []));
    expect(set.drainers).toHaveLength(0);
  });

  it("drains findings as review_finding events with firewall-safe keys", async () => {
    seedStore(dir, [finding({})]);
    const set = await buildReviewDrainers(makeCtx(dir, []));
    expect(set.drainers).toHaveLength(1);

    const drainer = set.drainers[0];
    expect(drainer?.key).toBe("events:review_finding");
    expect(drainer?.schema).toBeDefined();

    const batch = await drainer?.read({});
    expect(batch).not.toBeNull();
    const rows = batch?.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row?.type).toBe("review_finding");
    const detail = row?.detail as Record<string, unknown>;
    expect(detail.finding_key).toBeDefined();
    expect(detail.checker_id).toBe("breaking_caller");
    expect(detail.target_file).toBe("src/a.ts");
    expect(detail.start_line).toBe(42);
    expect(detail.state).toBe("open");
    expect(detail.branch).toBe("main");
    expect(detail.commit_ref).toBe("abc123");
    // No denylisted keys leaked through the envelope firewall.
    for (const key of Object.keys(detail)) {
      expect(DENYLIST.has(key)).toBe(false);
    }
  });

  it("validates each row against the IngestEvent contract", async () => {
    seedStore(dir, [finding({})]);
    const set = await buildReviewDrainers(makeCtx(dir, []));
    const drainer = set.drainers[0];
    const batch = await drainer?.read({});
    const row = (batch?.rows as unknown[])[0];
    // The drainer declares schema = IngestEvent; safeParse must accept the row.
    const res = drainer?.schema?.safeParse(row);
    expect(res?.success).toBe(true);
  });

  it("advances the cursor and re-drains nothing when unchanged", async () => {
    seedStore(dir, [finding({})]);
    const set = await buildReviewDrainers(makeCtx(dir, []));
    const drainer = set.drainers[0];

    const first = await drainer?.read({});
    expect(first).not.toBeNull();
    const next = first?.next;
    expect(next?.lastId).toBeGreaterThan(0);

    // Reading again past the cursor → nothing new.
    const second = await drainer?.read(next ?? {});
    expect(second).toBeNull();
  });
});
