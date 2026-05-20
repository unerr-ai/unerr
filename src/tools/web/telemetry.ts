/**
 * fetch_url compression telemetry.
 *
 * Writes one row per call to the metrics-store `compression_events` table with
 * category="fetch_url". The dashboard's existing recentCompression/poll APIs
 * surface it alongside shell-compression rows — no new endpoint needed.
 */

import { appendCompressionLog } from "../../proxy/shell-compression-log.js";
import { safeSavedPct } from "./compression-ratio.js";

export interface FetchUrlTelemetry {
  url: string;
  rawBytes: number;
  compressedBytes: number;
  durationMs: number;
  extractor: "defuddle" | "readability" | "raw-body";
  cacheHit?: boolean;
  /**
   * Quality signals — recorded alongside compression so the dashboard can
   * distinguish "clean extraction" from "fell through to raw-body on an SPA
   * shell" without inferring from byte counts alone.
   */
  blocked?: "cloudflare" | "hcaptcha" | "perimeterx";
  playwrightRescued?: boolean;
  bm25Ranked?: boolean;
  wordCount?: number;
}

export function recordFetchUrlTelemetry(
  cwd: string,
  ev: FetchUrlTelemetry
): void {
  // Clamp at 0 on inflated SPAs (extracted_bytes ≥ raw_bytes). Without this
  // the dashboard's aggregate AVG(saved_pct) gets dragged into the negative
  // by Twitter/X-shaped SPA shells, contradicting the clamped value the
  // agent saw in the response envelope.
  const savedPct = safeSavedPct(ev.rawBytes, ev.compressedBytes);
  const flags: string[] = [];
  if (ev.blocked) flags.push(`blocked=${ev.blocked}`);
  if (ev.playwrightRescued) flags.push("playwright");
  if (ev.bm25Ranked) flags.push("bm25");
  if (typeof ev.wordCount === "number") flags.push(`wc=${ev.wordCount}`);
  const teeFile =
    ev.cacheHit && flags.length === 0
      ? "cache-hit"
      : flags.length > 0
        ? flags.join(" ")
        : undefined;
  appendCompressionLog(cwd, {
    ts: new Date().toISOString(),
    command: `fetch_url ${ev.url}`,
    category: "fetch_url",
    confidence: 1,
    rawBytes: ev.rawBytes,
    compressedBytes: ev.compressedBytes,
    savedPct,
    omniFallback: ev.extractor === "raw-body",
    teeFile,
  });
}
