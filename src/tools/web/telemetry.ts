/**
 * fetch_url compression telemetry.
 *
 * Writes one row per call to the metrics-store `compression_events` table with
 * category="fetch_url". The dashboard's existing recentCompression/poll APIs
 * surface it alongside shell-compression rows — no new endpoint needed.
 */

import { appendCompressionLog } from "../../proxy/shell-compression-log.js";

export interface FetchUrlTelemetry {
  url: string;
  rawBytes: number;
  compressedBytes: number;
  durationMs: number;
  extractor: "defuddle" | "readability" | "raw-body";
  cacheHit?: boolean;
}

export function recordFetchUrlTelemetry(
  cwd: string,
  ev: FetchUrlTelemetry
): void {
  const savedPct =
    ev.rawBytes > 0
      ? Math.round(((ev.rawBytes - ev.compressedBytes) / ev.rawBytes) * 100)
      : 0;
  appendCompressionLog(cwd, {
    ts: new Date().toISOString(),
    command: `fetch_url ${ev.url}`,
    category: "fetch_url",
    confidence: 1,
    rawBytes: ev.rawBytes,
    compressedBytes: ev.compressedBytes,
    savedPct,
    omniFallback: ev.extractor === "raw-body",
    teeFile: ev.cacheHit ? "cache-hit" : undefined,
  });
}
