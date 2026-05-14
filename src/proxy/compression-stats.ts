/**
 * Compression Metrics Collector — tracks per-compression stats for the session.
 *
 * Records: content type, original size, compressed size, sections preserved/omitted,
 * annotations added, duration. Feeds into token accounting and the quality feedback loop.
 */

export interface CompressionEvent {
  id: string;
  contentType:
    | "git_diff"
    | "test_output"
    | "directory"
    | "file_content"
    | "generic";
  originalTokens: number;
  compressedTokens: number;
  sectionsPreserved: number;
  sectionsOmitted: number;
  annotationsAdded: number;
  durationMs: number;
  timestamp: number;
}

export interface CompressionSessionStats {
  totalEvents: number;
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  totalSaved: number;
  avgCompressionRatio: number;
  byContentType: Record<string, { count: number; saved: number }>;
}

export interface CompressionStatsCollector {
  record: (event: Omit<CompressionEvent, "id" | "timestamp">) => string;
  getEvent: (id: string) => CompressionEvent | null;
  getRecentEvents: (count?: number) => CompressionEvent[];
  getSessionStats: () => CompressionSessionStats;
  reset: () => void;
}

let eventCounter = 0;

export function createCompressionStatsCollector(): CompressionStatsCollector {
  const events: CompressionEvent[] = [];

  function record(event: Omit<CompressionEvent, "id" | "timestamp">): string {
    const id = `comp-${++eventCounter}-${Date.now()}`;
    events.push({ ...event, id, timestamp: Date.now() });
    return id;
  }

  function getEvent(id: string): CompressionEvent | null {
    return events.find((e) => e.id === id) ?? null;
  }

  function getRecentEvents(count = 20): CompressionEvent[] {
    return events.slice(-count);
  }

  function getSessionStats(): CompressionSessionStats {
    const stats: CompressionSessionStats = {
      totalEvents: events.length,
      totalOriginalTokens: 0,
      totalCompressedTokens: 0,
      totalSaved: 0,
      avgCompressionRatio: 0,
      byContentType: {},
    };

    for (const event of events) {
      stats.totalOriginalTokens += event.originalTokens;
      stats.totalCompressedTokens += event.compressedTokens;
      const saved = event.originalTokens - event.compressedTokens;
      stats.totalSaved += saved;

      const ct = event.contentType;
      if (!stats.byContentType[ct])
        stats.byContentType[ct] = { count: 0, saved: 0 };
      stats.byContentType[ct]!.count++;
      stats.byContentType[ct]!.saved += saved;
    }

    stats.avgCompressionRatio =
      stats.totalOriginalTokens > 0
        ? Math.round((stats.totalSaved / stats.totalOriginalTokens) * 100) / 100
        : 0;

    return stats;
  }

  function reset(): void {
    events.length = 0;
  }

  return { record, getEvent, getRecentEvents, getSessionStats, reset };
}
