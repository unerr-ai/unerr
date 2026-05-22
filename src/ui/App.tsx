import { AppShell } from "@/components/layout/AppShell";
import { fetchJson } from "@/lib/api";
import { queryClient } from "@/lib/query-client";
import { RepoContext, type RepoContextValue } from "@/lib/repo-context";
import {
  type RouteId,
  routeTitle,
  useHashRoute,
  useParsedRoute,
} from "@/lib/router";
import { connectDashboardSse } from "@/lib/sse";
import type { LiveFeedItem } from "@/lib/sse";
import type { SessionStatsPayload } from "@/lib/types";
import { AllReposPage } from "@/pages/AllReposPage";
import { DaemonPage } from "@/pages/DaemonPage";
import { Dashboard } from "@/pages/Dashboard";
import { FactsPage } from "@/pages/FactsPage";
import { GraphExplorer } from "@/pages/GraphExplorer";
import { GraphVisualPage } from "@/pages/GraphVisualPage";
import { LogbookPage } from "@/pages/LogbookPage";
import { ReasoningQualityPage } from "@/pages/ReasoningQualityPage";
import { RouterSessionPage } from "@/pages/RouterSession";
import { RouterStatusPage } from "@/pages/RouterStatus";
import { SessionTimelinePage } from "@/pages/SessionTimelinePage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SidekickMemoryPage } from "@/pages/SidekickMemoryPage";
import { TokenFlowPage } from "@/pages/TokenFlowPage";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

export function App() {
  const route = useHashRoute();
  const parsed = useParsedRoute();
  const [sseConnected, setSseConnected] = useState(false);

  // Detect process-manager mode by probing /api/pm.
  // `daemonResolved` gates standalone-only side effects (SSE, /api/system/status)
  // so they don't fire before we know whether we're served by the process manager.
  const { data: daemonInfo, isFetched: daemonResolved } = useQuery({
    queryKey: ["pm", "info"],
    queryFn: () =>
      fetchJson<{ pid: number; port: number }>("/api/pm").catch(() => null),
    staleTime: 60_000,
    retry: false,
  });

  const isDaemonMode = !!daemonInfo;

  // Fetch repos list (daemon mode only)
  const { data: reposData } = useQuery<{
    repos: { label: string; path: string; status: string }[];
  }>({
    queryKey: ["daemon", "repos"],
    queryFn: () => fetchJson("/api/repos"),
    refetchInterval: 5000,
    enabled: isDaemonMode,
  });

  const repos = reposData?.repos ?? [];

  // SSE connection (standalone mode only — wait for daemon probe to resolve first)
  useEffect(() => {
    if (!daemonResolved || isDaemonMode) return;
    return connectDashboardSse(queryClient, setSseConnected);
  }, [daemonResolved, isDaemonMode]);

  const { data: liveFeed = [] } = useQuery<LiveFeedItem[]>({
    queryKey: ["live-feed"],
    initialData: [],
  });

  const { data: sessionSnapshot } = useQuery<SessionStatsPayload | undefined>({
    queryKey: ["session-snapshot"],
  });

  const { data: systemStatus } = useQuery({
    queryKey: ["system", "status"],
    queryFn: () =>
      fetchJson<{ data: { cwd: string } }>("/api/system/status").catch(
        () => null
      ),
    staleTime: 60_000,
    enabled: daemonResolved && !isDaemonMode,
  });

  // Build repo context
  const selectedRepo = parsed.repoLabel
    ? repos.find((r) => r.label === parsed.repoLabel)
    : null;

  const repoCtx = useMemo<RepoContextValue>(
    () => ({
      label: parsed.repoLabel,
      path: selectedRepo?.path ?? null,
      status: (selectedRepo?.status as RepoContextValue["status"]) ?? null,
      apiBase: parsed.repoLabel ? `/api/repo/${parsed.repoLabel}` : "",
      isDaemonMode,
    }),
    [parsed.repoLabel, selectedRepo, isDaemonMode]
  );

  // In daemon mode, redirect to all-repos when landing on the bare hash
  // without a repo selected. Step 3 of the honest-headroom migration: the
  // bare hash now resolves to "logbook" (Logbook is the default), so the
  // redirect targets "logbook" instead of "overview". An explicit
  // /overview hit in daemon mode also redirects so users get the repo
  // picker first.
  const effectiveRoute: RouteId =
    isDaemonMode &&
    (route === "logbook" || route === "overview") &&
    !parsed.repoLabel
      ? "all-repos"
      : route;

  const title = routeTitle(effectiveRoute);

  let body: ReactNode;
  switch (effectiveRoute) {
    case "all-repos":
      body = <AllReposPage />;
      break;
    case "daemon":
      body = <DaemonPage />;
      break;
    case "overview":
      body = <Dashboard />;
      break;
    case "visual":
      body = <GraphVisualPage />;
      break;
    case "graph":
      body = <GraphExplorer />;
      break;
    case "facts":
      body = <FactsPage />;
      break;
    case "logbook":
      body = <LogbookPage />;
      break;
    case "sidekick-memory":
      body = <SidekickMemoryPage />;
      break;
    case "token-trace":
      body = <TokenFlowPage />;
      break;
    case "reasoning":
      body = <ReasoningQualityPage />;
      break;
    case "activity":
      body = <SessionTimelinePage />;
      break;
    case "router":
      body = <RouterStatusPage />;
      break;
    case "router-sessions":
      body = <RouterSessionPage />;
      break;
    case "settings":
      body = <SettingsPage />;
      break;
  }

  return (
    <RepoContext.Provider value={repoCtx}>
      <AppShell
        title={title}
        activeRoute={effectiveRoute}
        statusDot={
          isDaemonMode ? undefined : sseConnected ? "live" : "reconnecting"
        }
        repoPath={isDaemonMode ? selectedRepo?.path : systemStatus?.data?.cwd}
        repoLabel={parsed.repoLabel}
        isDaemonMode={isDaemonMode}
        repos={repos}
      >
        {body}
      </AppShell>
    </RepoContext.Provider>
  );
}
