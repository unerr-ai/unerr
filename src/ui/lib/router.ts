import { useCallback, useEffect, useState } from "react";

// ── Per-repo routes (existing dashboard pages) ──────────────────

export type RepoRouteId =
  | "overview"
  | "visual"
  | "graph"
  | "facts"
  | "token-trace"
  | "reasoning"
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
  "token-trace": "Token Trace",
  reasoning: "Reasoning Quality",
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
    case "visual":
      return "visual";
    case "graph":
      return "graph";
    case "facts":
      return "facts";
    case "token-trace":
      return "token-trace";
    case "reasoning":
      return "reasoning";
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

export function navigateRoute(next: RouteId, repoLabel?: string): void {
  if (next === "all-repos" || next === "daemon") {
    window.location.hash = `#/${next}`;
    return;
  }
  if (repoLabel) {
    window.location.hash =
      next === "overview"
        ? `#/repo/${repoLabel}`
        : `#/repo/${repoLabel}/${next}`;
    return;
  }
  window.location.hash = next === "overview" ? "#/" : `#/${next}`;
}

export function useNavigateRoute(): (
  next: RouteId,
  repoLabel?: string
) => void {
  return useCallback(
    (next: RouteId, repoLabel?: string) => navigateRoute(next, repoLabel),
    []
  );
}
