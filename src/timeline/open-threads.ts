/**
 * Open Threads (ST-3a).
 *
 * Reads markers from timeline.db and returns mark_blocker rows that do not yet
 * have a matching mark_resolution (matched by blocker_ref → marker_id).
 * Resume strip + insights panel use this to surface unfinished work.
 *
 * Read-only: never writes anything.
 */

import type {
  CozoTimelineStore,
  MarkerRow,
} from "./timeline-store.js";

export interface OpenThread {
  marker_id: string;
  text: string;
  session_id: string;
  turn_id: string;
  ts: number;
  file_path: string;
}

export interface GetOpenThreadsOptions {
  sessionId?: string;
  limit?: number;
}

/**
 * Compute open threads from a pre-fetched list of markers. Pure — testable
 * without a database. Resolutions whose blocker_ref points at a blocker outside
 * this list are still counted (lookup by id, not membership).
 */
export function computeOpenThreads(markers: MarkerRow[]): OpenThread[] {
  const resolvedRefs = new Set<string>();
  for (const m of markers) {
    if (m.type === "mark_resolution" && m.blocker_ref.length > 0) {
      resolvedRefs.add(m.blocker_ref);
    }
  }

  const out: OpenThread[] = [];
  for (const m of markers) {
    if (m.type !== "mark_blocker") continue;
    if (resolvedRefs.has(m.marker_id)) continue;
    out.push({
      marker_id: m.marker_id,
      text: m.text,
      session_id: m.session_id,
      turn_id: m.turn_id,
      ts: m.ts,
      file_path: m.file_path,
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/**
 * Async convenience wrapper: pulls markers from the store, then runs
 * computeOpenThreads. Limit caps the underlying marker fetch (default 500).
 */
export async function getOpenThreads(
  store: CozoTimelineStore,
  opts: GetOpenThreadsOptions = {},
): Promise<OpenThread[]> {
  const markers = await store.listMarkers({
    sessionId: opts.sessionId,
    limit: opts.limit ?? 500,
  });
  return computeOpenThreads(markers);
}
