/**
 * Metric extraction — turn captured run artifacts into a RunSummary.
 *
 * The smoke harness exercises the extraction shape against empty inputs
 * (no-op agent produces no events). Ship-gate (Sprint C) and live eval
 * (Sprint D) feed real events.jsonl streams; the same functions apply.
 */

/**
 * One row in the proxy's events.jsonl, narrowed to the fields the eval
 * cares about. Other fields are passed through untouched.
 */
export interface ProxyEvent {
  ts: number;
  kind: string;
  tool?: string;
  /** Free-form payload; shape varies by event kind. */
  payload?: Record<string, unknown>;
}

/** Parse one events.jsonl payload into typed events. Bad lines are skipped. */
export function parseEventsJsonl(raw: string): ProxyEvent[] {
  if (raw.length === 0) return [];
  const out: ProxyEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        out.push(parsed as ProxyEvent);
      }
    } catch {
      // skip malformed lines — events.jsonl is best-effort capture
    }
  }
  return out;
}

/** Deduplicated list of tool names called this run. */
export function listToolsCalled(events: readonly ProxyEvent[]): string[] {
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "tool_call" && typeof ev.tool === "string") {
      seen.add(ev.tool);
    }
  }
  return Array.from(seen).sort();
}
