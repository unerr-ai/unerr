/**
 * URL-synced filter state for the Timeline page.
 *
 * Hash format: `#/session-timeline?from=…&to=…&session=…&agent=…&type=…&q=…&page=…&density=…`
 *
 * All values are optional; invalid params silently fall back to defaults so a
 * shared link can never break the page. State changes are written via
 * `history.replaceState` (no extra history entries on every filter tweak).
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

export interface TimelineFilters {
  /** UTC ms epoch — inclusive lower bound on turn.started_at. */
  from?: number;
  /** UTC ms epoch — inclusive upper bound on turn.started_at. */
  to?: number;
  /** Session id (full string, exact match). */
  session?: string;
  /** Agent name (e.g. "claude-code", "cursor"). */
  agent?: string;
  /** Marker type filter for the side panels (e.g. "mark_blocker"). */
  type?: string;
  /** Free-text search over turn titles. */
  q?: string;
  /** 1-indexed page number. */
  page: number;
  /** Page size. */
  perPage: number;
  /** Visual density. */
  density: "comfortable" | "compact";
}

export const DEFAULT_FILTERS: TimelineFilters = {
  page: 1,
  perPage: 15,
  density: "comfortable",
};

const VALID_DENSITY = new Set<TimelineFilters["density"]>([
  "comfortable",
  "compact",
]);

function parseFilters(): TimelineFilters {
  if (typeof window === "undefined") return { ...DEFAULT_FILTERS };
  const hash = window.location.hash.replace(/^#/, "");
  const qIdx = hash.indexOf("?");
  if (qIdx === -1) return { ...DEFAULT_FILTERS };
  const params = new URLSearchParams(hash.slice(qIdx + 1));

  const filters: TimelineFilters = { ...DEFAULT_FILTERS };

  const from = Number(params.get("from"));
  if (Number.isFinite(from) && from > 0) filters.from = from;

  const to = Number(params.get("to"));
  if (Number.isFinite(to) && to > 0) filters.to = to;

  const session = params.get("session");
  if (session && session.length > 0) filters.session = session;

  const agent = params.get("agent");
  if (agent && agent.length > 0) filters.agent = agent;

  const type = params.get("type");
  if (type && type.length > 0) filters.type = type;

  const q = params.get("q");
  if (q && q.length > 0) filters.q = q;

  const page = Number(params.get("page"));
  if (Number.isInteger(page) && page > 0) filters.page = page;

  const perPage = Number(params.get("perPage"));
  if (Number.isInteger(perPage) && perPage > 0 && perPage <= 200)
    filters.perPage = perPage;

  const density = params.get("density");
  if (density && VALID_DENSITY.has(density as TimelineFilters["density"]))
    filters.density = density as TimelineFilters["density"];

  return filters;
}

function serializeFilters(filters: TimelineFilters): string {
  const params = new URLSearchParams();
  if (filters.from !== undefined) params.set("from", String(filters.from));
  if (filters.to !== undefined) params.set("to", String(filters.to));
  if (filters.session) params.set("session", filters.session);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.type) params.set("type", filters.type);
  if (filters.q) params.set("q", filters.q);
  if (filters.page !== DEFAULT_FILTERS.page)
    params.set("page", String(filters.page));
  if (filters.perPage !== DEFAULT_FILTERS.perPage)
    params.set("perPage", String(filters.perPage));
  if (filters.density !== DEFAULT_FILTERS.density)
    params.set("density", filters.density);
  const s = params.toString();
  return s.length > 0 ? `?${s}` : "";
}

// Snapshot lives in module scope so useSyncExternalStore can give every
// component the same identity-stable reference until the URL changes.
let snapshotCache = "";
let snapshotValue: TimelineFilters = parseFilters();

function getSnapshot(): TimelineFilters {
  if (typeof window === "undefined") return snapshotValue;
  const sig = window.location.hash;
  if (sig !== snapshotCache) {
    snapshotCache = sig;
    snapshotValue = parseFilters();
  }
  return snapshotValue;
}

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useTimelineFilters(): {
  filters: TimelineFilters;
  setFilters: (patch: Partial<TimelineFilters>) => void;
  clear: () => void;
} {
  const filters = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const writeHash = useCallback((next: TimelineFilters) => {
    if (typeof window === "undefined") return;
    const base =
      window.location.hash.replace(/^#/, "").split("?")[0] || "/activity";
    const newHash = `#${base}${serializeFilters(next)}`;
    if (window.location.hash !== newHash) {
      // Use replaceState so filter tweaks don't pollute history.
      window.history.replaceState(null, "", newHash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  }, []);

  const setFilters = useCallback(
    (patch: Partial<TimelineFilters>) => {
      const next: TimelineFilters = { ...filters, ...patch };
      // Mutating any filter except `page` resets pagination — otherwise the
      // user lands on a non-existent page of newly-filtered results.
      const pageChanged = "page" in patch;
      const onlyDensity = Object.keys(patch).every((k) => k === "density");
      if (!pageChanged && !onlyDensity) next.page = 1;
      writeHash(next);
    },
    [filters, writeHash]
  );

  const clear = useCallback(() => {
    writeHash({ ...DEFAULT_FILTERS });
  }, [writeHash]);

  // Ensure cache invalidates when the component mounts (handles back/forward).
  useEffect(() => {
    snapshotCache = "";
  }, []);

  return { filters, setFilters, clear };
}

// ── helpers used by the page ────────────────────────────────────────────────

export function activeFilterChips(filters: TimelineFilters): Array<{
  key: keyof TimelineFilters;
  label: string;
}> {
  const chips: Array<{ key: keyof TimelineFilters; label: string }> = [];
  if (filters.from !== undefined || filters.to !== undefined) {
    chips.push({
      key: "from",
      label: formatRangeChip(filters.from, filters.to),
    });
  }
  if (filters.session) {
    chips.push({
      key: "session",
      label: `Session ${filters.session.slice(0, 8)}`,
    });
  }
  if (filters.agent) {
    chips.push({ key: "agent", label: `Agent: ${filters.agent}` });
  }
  if (filters.type) {
    chips.push({ key: "type", label: friendlyTypeLabel(filters.type) });
  }
  if (filters.q) {
    chips.push({ key: "q", label: `“${filters.q}”` });
  }
  return chips;
}

function friendlyTypeLabel(type: string): string {
  switch (type) {
    case "mark_intent":
      return "🎯 Goals only";
    case "mark_decision":
      return "💡 Decisions only";
    case "mark_blocker":
      return "⚠ Stuck moments only";
    case "mark_resolution":
      return "✅ Solutions only";
    default:
      return type;
  }
}

function formatRangeChip(from?: number, to?: number): string {
  if (from && to) {
    return `${formatShort(from)} → ${formatShort(to)}`;
  }
  if (from) return `Since ${formatShort(from)}`;
  if (to) return `Until ${formatShort(to)}`;
  return "All time";
}

function formatShort(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Resolve a quick-preset string to a {from, to} pair (or "all" → clear). */
export function quickRange(
  preset: "today" | "7d" | "30d" | "all",
  nowMs = Date.now()
): { from?: number; to?: number } {
  if (preset === "all") return {};
  const dayMs = 24 * 60 * 60_000;
  if (preset === "today") {
    const start = new Date(nowMs);
    start.setHours(0, 0, 0, 0);
    return { from: start.getTime(), to: nowMs };
  }
  if (preset === "7d") return { from: nowMs - 7 * dayMs, to: nowMs };
  if (preset === "30d") return { from: nowMs - 30 * dayMs, to: nowMs };
  return {};
}
