/**
 * Router session metrics aggregator — reads JSONL telemetry records and
 * produces per-session summaries for the dashboard and CLI status.
 *
 * Two modes:
 *   1. In-memory: uses the live `RouterTelemetryRecorder.getSessionSummary()`
 *      for the current session (no disk I/O, O(1)).
 *   2. Historical: scans `metrics.jsonl` + archived `metrics-*.jsonl.gz`
 *      files and groups by sessionId. Used by the dashboard and
 *      `unerr router status`.
 *
 * The aggregator is a pure function over records — no mutable state,
 * no side effects. Suitable for import from dashboard pages or CLI.
 */

import { createReadStream, existsSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";

import type {
  RouterSessionSummary,
  RouterTelemetryRecord,
} from "./router-telemetry.js";

// ── Per-session aggregation ──────────────────────────────────────

export interface SessionMetricsSummary extends RouterSessionSummary {
  readonly firstCallTs: string;
  readonly lastCallTs: string;
  readonly topTools: readonly { name: string; count: number }[];
  readonly outcomeBreakdown: {
    readonly executed: number;
    readonly softRefused: number;
    readonly passthroughDegraded: number;
    readonly childError: number;
  };
  readonly avgLatencyMs: number;
}

export function aggregateSession(
  records: readonly RouterTelemetryRecord[]
): SessionMetricsSummary | null {
  if (records.length === 0) return null;

  const sessionId = records[0]!.sessionId;
  let totalTokensSaved = 0;
  let totalTokensIn = 0;
  let softRefuseCount = 0;
  let unlockCount = 0;
  let totalLatency = 0;
  let executed = 0;
  let softRefused = 0;
  let passthroughDegraded = 0;
  let childError = 0;
  const toolCounts = new Map<string, number>();

  let firstCallTs = records[0]!.ts;
  let lastCallTs = records[0]!.ts;

  for (const rec of records) {
    totalTokensSaved += rec.tokensSaved;
    totalTokensIn += rec.tokensIn;
    totalLatency += rec.latencyMs.total;

    if (rec.outcome === "soft_refused") {
      softRefuseCount++;
      softRefused++;
    } else if (rec.outcome === "executed") {
      executed++;
    } else if (rec.outcome === "passthrough_degraded") {
      passthroughDegraded++;
    } else if (rec.outcome === "child_error") {
      childError++;
    }

    if (rec.unlocks) unlockCount += rec.unlocks.length;

    toolCounts.set(rec.toolName, (toolCounts.get(rec.toolName) ?? 0) + 1);

    if (rec.ts < firstCallTs) firstCallTs = rec.ts;
    if (rec.ts > lastCallTs) lastCallTs = rec.ts;
  }

  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const totalBase = totalTokensIn + totalTokensSaved;

  return {
    sessionId,
    totalCalls: records.length,
    totalTokensSaved,
    totalTokensIn,
    softRefuseCount,
    unlockCount,
    efficiency:
      totalBase > 0 ? Math.round((totalTokensSaved / totalBase) * 100) : 0,
    firstCallTs,
    lastCallTs,
    topTools,
    outcomeBreakdown: {
      executed,
      softRefused,
      passthroughDegraded,
      childError,
    },
    avgLatencyMs:
      records.length > 0 ? Math.round(totalLatency / records.length) : 0,
  };
}

// ── Multi-session aggregation from disk ──────────────────────────

export function groupBySession(
  records: readonly RouterTelemetryRecord[]
): ReadonlyMap<string, readonly RouterTelemetryRecord[]> {
  const map = new Map<string, RouterTelemetryRecord[]>();
  for (const rec of records) {
    let arr = map.get(rec.sessionId);
    if (!arr) {
      arr = [];
      map.set(rec.sessionId, arr);
    }
    arr.push(rec);
  }
  return map;
}

/**
 * Read all current + archived metrics and produce per-session summaries.
 * Used by the dashboard. Returns sessions sorted by most recent first.
 */
export async function readAllSessionMetrics(
  unerrDir: string
): Promise<readonly SessionMetricsSummary[]> {
  const routerDir = join(unerrDir, "router");
  const allRecords: RouterTelemetryRecord[] = [];

  const currentPath = join(routerDir, "metrics.jsonl");
  if (existsSync(currentPath)) {
    const body = await fs.readFile(currentPath, "utf8");
    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      try {
        allRecords.push(JSON.parse(line) as RouterTelemetryRecord);
      } catch {
        // Skip malformed lines
      }
    }
  }

  let entries: string[];
  try {
    entries = readdirSync(routerDir);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.startsWith("metrics-") || !entry.endsWith(".jsonl.gz")) continue;
    try {
      const lines = await readGzipJsonl(join(routerDir, entry));
      allRecords.push(...lines);
    } catch {
      // Skip corrupt archives
    }
  }

  const grouped = groupBySession(allRecords);
  const summaries: SessionMetricsSummary[] = [];
  for (const [, recs] of grouped) {
    const summary = aggregateSession(recs);
    if (summary) summaries.push(summary);
  }

  summaries.sort((a, b) => b.lastCallTs.localeCompare(a.lastCallTs));
  return summaries;
}

async function readGzipJsonl(
  filePath: string
): Promise<RouterTelemetryRecord[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath).pipe(createGunzip());
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const records: RouterTelemetryRecord[] = [];
      for (const line of body.split("\n")) {
        if (line.length === 0) continue;
        try {
          records.push(JSON.parse(line) as RouterTelemetryRecord);
        } catch {
          // Skip malformed
        }
      }
      resolve(records);
    });
  });
}
