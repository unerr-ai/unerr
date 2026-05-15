/**
 * Compression Quality Feedback Loop — detects when compression causes agent retries.
 *
 * Monitors agent behavior AFTER compression events. If retry rate spikes
 * within 60s, automatically reduces compression aggressiveness.
 *
 * Adaptive logic:
 *   - Track (compression event) → (next 60s behavior)
 *   - Agent retries same entity OR re-requests same content → "over-compressed"
 *   - 3+ over-compression signals on same content type → increase retention by 20%
 *   - Hard floor: never compress below 40% retention
 *   - Reset: 10+ good compressions → cautiously reduce retention
 *
 * Layer 6 FE-E: per-tool Layer 6 tier (columnar → minified JSON → expanded JSON) after repeated retries.
 */

import type { Layer6EncodingTier } from "./format-encoder.js";

export type ContentType =
  | "git_diff"
  | "test_output"
  | "directory"
  | "file_content"
  | "generic"
  | "layer6_columnar"
  | "shell_tabular"
  | "shell_structured"
  | "shell_log_text"
  | "shell_diff"
  | "shell_tree_paths"
  | "shell_key_value"
  | "shell_error_diagnostic"
  | "shell_test_results"
  | "shell_progress_streaming"
  | "shell_yaml";

export interface CompressionQualitySignal {
  compressionId: string;
  contentType: ContentType;
  compressionRatio: number;
  followedByRetry: boolean;
  followedByReRequest: boolean;
  timestamp: number;
}

export interface CompressionAdaptiveConfig {
  minRetention: Record<ContentType, number>;
  adaptedRetention: Record<ContentType, number>;
  confidence: number;
}

const DEFAULT_RETENTION: Record<ContentType, number> = {
  git_diff: 0.3,
  test_output: 0.4,
  directory: 0.2,
  file_content: 0.35,
  generic: 0.25,
  layer6_columnar: 0.35,
  shell_tabular: 0.32,
  shell_structured: 0.3,
  shell_log_text: 0.34,
  shell_diff: 0.28,
  shell_tree_paths: 0.32,
  shell_key_value: 0.35,
  shell_error_diagnostic: 0.33,
  shell_test_results: 0.34,
  shell_progress_streaming: 0.3,
  shell_yaml: 0.32,
};

const HARD_FLOOR = 0.4;
const OVER_COMPRESSION_THRESHOLD = 3;
const RETENTION_INCREASE = 0.2;
const GOOD_STREAK_THRESHOLD = 10;
const RETENTION_DECREASE = 0.05;
const FEEDBACK_WINDOW_MS = 60_000;

/** FE-E.8 — downgrade Layer 6 wire format after sustained retries per tool name. */
const LAYER6_TIER_MINIFIED_RETRY = 3;
const LAYER6_TIER_EXPANDED_RETRY = 6;

export interface CompressionQualityMonitor {
  recordCompression: (
    id: string,
    contentType: ContentType,
    ratio: number
  ) => void;
  recordAgentAction: (
    entityKey: string,
    isRetry: boolean,
    isReRequest: boolean
  ) => void;
  /** Increment when the agent re-queries the same entity shortly after a Layer 6-encoded response. */
  recordLayer6Retry: (toolName: string) => void;
  getLayer6Tier: (toolName: string) => Layer6EncodingTier;
  getLayer6RetryCount: (toolName: string) => number;
  getAdaptiveConfig: () => CompressionAdaptiveConfig;
  getRetention: (contentType: ContentType) => number;
  getSignalCount: () => number;
}

export function createCompressionQualityMonitor(): CompressionQualityMonitor {
  const recentCompressions: Array<{
    id: string;
    contentType: ContentType;
    ratio: number;
    timestamp: number;
    entityKey?: string;
  }> = [];
  const signals: CompressionQualitySignal[] = [];
  const overCompressionCounts: Record<ContentType, number> = {
    git_diff: 0,
    test_output: 0,
    directory: 0,
    file_content: 0,
    generic: 0,
    layer6_columnar: 0,

    shell_tabular: 0,
    shell_structured: 0,
    shell_log_text: 0,
    shell_diff: 0,
    shell_tree_paths: 0,
    shell_key_value: 0,
    shell_error_diagnostic: 0,
    shell_test_results: 0,
    shell_progress_streaming: 0,
    shell_yaml: 0,
  };
  const goodStreaks: Record<ContentType, number> = {
    git_diff: 0,
    test_output: 0,
    directory: 0,
    file_content: 0,
    generic: 0,
    layer6_columnar: 0,

    shell_tabular: 0,
    shell_structured: 0,
    shell_log_text: 0,
    shell_diff: 0,
    shell_tree_paths: 0,
    shell_key_value: 0,
    shell_error_diagnostic: 0,
    shell_test_results: 0,
    shell_progress_streaming: 0,
    shell_yaml: 0,
  };
  const adapted: Record<ContentType, number> = { ...DEFAULT_RETENTION };

  const layer6RetriesByTool = new Map<string, number>();

  function recordCompression(
    id: string,
    contentType: ContentType,
    ratio: number
  ): void {
    recentCompressions.push({ id, contentType, ratio, timestamp: Date.now() });
    if (recentCompressions.length > 100) recentCompressions.shift();
  }

  function recordAgentAction(
    entityKey: string,
    isRetry: boolean,
    isReRequest: boolean
  ): void {
    const now = Date.now();
    const cutoff = now - FEEDBACK_WINDOW_MS;

    const recentForEntity = recentCompressions.filter(
      (c) => c.timestamp > cutoff
    );

    if (recentForEntity.length === 0) return;

    for (const compression of recentForEntity) {
      const ct = compression.contentType;
      if (isRetry || isReRequest) {
        signals.push({
          compressionId: compression.id,
          contentType: ct,
          compressionRatio: compression.ratio,
          followedByRetry: isRetry,
          followedByReRequest: isReRequest,
          timestamp: now,
        });

        overCompressionCounts[ct] = (overCompressionCounts[ct] ?? 0) + 1;
        goodStreaks[ct] = 0;

        if ((overCompressionCounts[ct] ?? 0) >= OVER_COMPRESSION_THRESHOLD) {
          adapted[ct] = Math.min(
            1.0,
            (adapted[ct] ?? DEFAULT_RETENTION[ct]) + RETENTION_INCREASE
          );
          overCompressionCounts[ct] = 0;
        }
      } else {
        goodStreaks[ct] = (goodStreaks[ct] ?? 0) + 1;

        if ((goodStreaks[ct] ?? 0) >= GOOD_STREAK_THRESHOLD) {
          adapted[ct] = Math.max(
            DEFAULT_RETENTION[ct],
            (adapted[ct] ?? DEFAULT_RETENTION[ct]) - RETENTION_DECREASE
          );
          goodStreaks[ct] = 0;
        }
      }
    }
  }

  function getRetention(contentType: ContentType): number {
    return Math.max(
      HARD_FLOOR,
      adapted[contentType] ?? DEFAULT_RETENTION[contentType]
    );
  }

  function getAdaptiveConfig(): CompressionAdaptiveConfig {
    const totalSignals = signals.length;
    return {
      minRetention: { ...DEFAULT_RETENTION },
      adaptedRetention: { ...adapted },
      confidence: Math.min(1.0, totalSignals * 0.05),
    };
  }

  function getSignalCount(): number {
    return signals.length;
  }

  function recordLayer6Retry(toolName: string): void {
    layer6RetriesByTool.set(
      toolName,
      (layer6RetriesByTool.get(toolName) ?? 0) + 1
    );
  }

  function getLayer6RetryCount(toolName: string): number {
    return layer6RetriesByTool.get(toolName) ?? 0;
  }

  function getLayer6Tier(toolName: string): Layer6EncodingTier {
    const n = layer6RetriesByTool.get(toolName) ?? 0;
    if (n >= LAYER6_TIER_EXPANDED_RETRY) return "expanded";
    if (n >= LAYER6_TIER_MINIFIED_RETRY) return "minified";
    return "columnar";
  }

  return {
    recordCompression,
    recordAgentAction,
    recordLayer6Retry,
    getLayer6Tier,
    getLayer6RetryCount,
    getAdaptiveConfig,
    getRetention,
    getSignalCount,
  };
}
