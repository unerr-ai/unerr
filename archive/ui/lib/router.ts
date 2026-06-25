import { useCallback, useEffect, useState } from "react";

// ── Per-repo routes (existing dashboard pages) ──────────────────

export type RepoRouteId =
  | "overview"
  | "visual"
  | "graph"
  | "facts"
  | "logbook"
  | "guard"
  | "token-trace"
  | "reasoning"
  | "prompt-trace"
  | "activity"
  | "router"
  | "router-sessions"
  | "settings";

// ── Global routes (daemon-level pages) ──────────────────────────

export type GlobalRouteId = "all-repos" | "daemon";

// ── Combined route type ─────────────────────────────────────────

export type RouteId = RepoRouteId | GlobalRouteId;

const ROUTE_TITLES: Record<RouteId, string> = {
  overview: "Dashboard",
  visual: "Codebase Map",
  graph: "Code Intelligence",
  facts: "Project Memory",
  logbook: "What unerr did",
  guard: "Cascade Guard",
  "token-trace": "Token Trace",
  reasoning: "Reasoning Trace",
  "prompt-trace": "Prompt Trace",
  activity: "Activity",
  router: "MCP Router",
  "router-sessions": "Router Sessions",
  settings: "Settings",
  "all-repos": "All Repositories",
  daemon: "Daemon Supervisor",
};

export function routeTitle(id: RouteId): string {
  return ROUTE_TITLES[id];
}

// ── Hash parsing ────────────────────────────────────────────────

export interface ParsedRoute {
  routeId: RouteId;
  repoLabel: string | null;
}

function parseHash(): ParsedRoute {
  const raw =
    window.location.hash.replace(/^#/, "").split("?")[0]?.trim() || "/";
  const segments = raw.split("/").filter(Boolean);

  // Global routes: #/all-repos, #/daemon
  const first = segments[0]?.toLowerCase();
  if (first === "all-repos") return { routeId: "all-repos", repoLabel: null };
  if (first === "daemon") return { routeId: "daemon", repoLabel: null };

  // Repo-prefixed routes: #/repo/<label>/<route>
  if (first === "repo" && segments.length >= 2) {
    const label = segments[1]!;
    const routeSeg = segments[2]?.toLowerCase();
    return { routeId: matchRepoRoute(routeSeg), repoLabel: label };
  }

  // Bare per-repo routes (standalone mode): #/<route>
  return { routeId: matchRepoRoute(first), repoLabel: null };
}

function matchRepoRoute(seg: string | undefined): RepoRouteId {
  switch (seg) {
    case "overview":
    case "dashboard":
      return "overview";
    case "visual":
      return "visual";
    case "graph":
      return "graph";
    case "facts":
      return "facts";
    case "logbook":
    case "story":
      return "logbook";
    case "guard":
    case "cascade-guard":
      return "guard";
    // Legacy session-economy bookmarks redirect to Token Trace, which
    // now hosts the headroom story alongside the existing token data.
    case "session-economy":
    case "economy":
    case "headroom":
      return "token-trace";
    // Sidekick Memory was merged into Project Memory (route `facts`). Old
    // bookmarks redirect there so no link breaks.
    case "sidekick-memory":
    case "sidekick":
    case "memory":
      return "facts";
    case "token-trace":
      return "token-trace";
    case "reasoning":
      return "reasoning";
    case "prompt-trace":
      return "prompt-trace";
    case "activity":
    case "session-timeline":
    case "timeline":
      return "activity";
    case "router":
      return "router";
    case "router-sessions":
      return "router-sessions";
    case "settings":
      return "settings";
    default:
      // The bare hash resolves to the Dashboard (the default landing).
      // Explicit /logbook still routes to "What unerr did" — see case
      // above. Daemon-mode landings redirect to /all-repos via App.tsx.
      return "overview";
  }
}

// ── Hooks ───────────────────────────────────────────────────────

export function useHashRoute(): RouteId {
  const [route, setRoute] = useState<RouteId>(() =>
    typeof window === "undefined" ? "overview" : parseHash().routeId
  );

  useEffect(() => {
    setRoute(parseHash().routeId);
    const onHash = () => setRoute(parseHash().routeId);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return route;
}

export function useParsedRoute(): ParsedRoute {
  const [parsed, setParsed] = useState<ParsedRoute>(() =>
    typeof window === "undefined"
      ? { routeId: "overview" as RouteId, repoLabel: null }
      : parseHash()
  );

  useEffect(() => {
    setParsed(parseHash());
    const onHash = () => setParsed(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return parsed;
}

export function useRepoLabel(): string | null {
  const parsed = useParsedRoute();
  return parsed.repoLabel;
}

// ── Navigation ──────────────────────────────────────────────────

export function navigateRoute(
  next: RouteId,
  repoLabelOrQuery?: string | Record<string, string>,
  maybeQuery?: Record<string, string>
): void {
  const explicitRepoLabel =
    typeof repoLabelOrQuery === "string" ? repoLabelOrQuery : undefined;
  const query =
    typeof repoLabelOrQuery === "object" ? repoLabelOrQuery : maybeQuery;
  const qs =
    query && Object.keys(query).length > 0
      ? `?${new URLSearchParams(query).toString()}`
      : "";
  if (next === "all-repos" || next === "daemon") {
    window.location.hash = `#/${next}${qs}`;
    return;
  }
  // Default to the currently-active repo label so in-repo pages
  // (Dashboard turn cards, GraphExplorer CTAs, …) that omit the
  // label argument don't accidentally drop out of the repo scope.
  // Standalone mode has no current repoLabel, so behavior there is
  // unchanged.
  const repoLabel = explicitRepoLabel ?? parseHash().repoLabel ?? undefined;
  // The bare hash resolves to "overview" (the default landing), so emit
  // a bare hash for it and an explicit segment for every other route —
  // including `navigateRoute("logbook", ...)`, which lands on the
  // "What unerr did" archive at `#/logbook`.
  if (repoLabel) {
    window.location.hash =
      next === "overview"
        ? `#/repo/${repoLabel}${qs}`
        : `#/repo/${repoLabel}/${next}${qs}`;
    return;
  }
  window.location.hash = next === "overview" ? `#/${qs}` : `#/${next}${qs}`;
}

/** Read a single query-string value from the current `window.location.hash`.
 *  Pages parse `?window=…` etc. via this helper to stay routing-library-free. */
export function hashQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash || "";
  const qIdx = hash.indexOf("?");
  if (qIdx === -1) return null;
  return new URLSearchParams(hash.slice(qIdx + 1)).get(name);
}

/** Atomically update one or more query-string values in the current hash.
 *  Passing `null` for a key removes it. The path segment of the hash is
 *  preserved unchanged — only the `?…` portion is rewritten. Triggers a
 *  single `hashchange` event so all subscribers stay in sync. */
export function setHashQueryParams(
  updates: Record<string, string | null>
): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash || "#/";
  const qIdx = hash.indexOf("?");
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);
  const params = new URLSearchParams(qIdx === -1 ? "" : hash.slice(qIdx + 1));
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  const nextHash = qs ? `${path}?${qs}` : path;
  if (nextHash !== hash) window.location.hash = nextHash;
}

/** Reactive read of one query-string value off the hash. Re-renders on
 *  `hashchange`. Returns `null` when the key is absent. */
export function useHashQueryParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(() =>
    typeof window === "undefined" ? null : hashQueryParam(name)
  );
  useEffect(() => {
    const onHash = () => setValue(hashQueryParam(name));
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [name]);
  return value;
}

export function useNavigateRoute(): (
  next: RouteId,
  repoLabelOrQuery?: string | Record<string, string>,
  maybeQuery?: Record<string, string>
) => void {
  return useCallback(
    (
      next: RouteId,
      repoLabelOrQuery?: string | Record<string, string>,
      maybeQuery?: Record<string, string>
    ) => navigateRoute(next, repoLabelOrQuery, maybeQuery),
    []
  );
}
