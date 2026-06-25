import type { GlobalRouteId, RepoRouteId, RouteId } from "@/lib/router";
import { navigateRoute } from "@/lib/router";
import type { ReactNode } from "react";

// ── Per-repo nav items ──────────────────────────────────────────

const REPO_NAV: { id: RepoRouteId; label: string }[] = [
  { id: "overview", label: "Dashboard" },
  { id: "logbook", label: "What unerr did" },
  { id: "guard", label: "Cascade Guard" },
  { id: "token-trace", label: "Token Trace" },
  { id: "reasoning", label: "Reasoning Trace" },
  { id: "visual", label: "Codebase Map" },
  { id: "graph", label: "Code Intelligence" },
  { id: "facts", label: "Project Memory" },
  { id: "activity", label: "Activity" },
  { id: "router", label: "MCP Router" },
  { id: "router-sessions", label: "Router Sessions" },
  { id: "settings", label: "Settings" },
];

// ── Global (daemon) nav items ───────────────────────────────────

const GLOBAL_NAV: { id: GlobalRouteId; label: string }[] = [
  { id: "all-repos", label: "All Repositories" },
  { id: "daemon", label: "Daemon" },
];

function parseRepoPath(cwd: string): { name: string; dir: string } {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? cwd;
  const dir =
    parts.length >= 2
      ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
      : name;
  return { name, dir };
}

type Props = {
  title: string;
  subtitle?: string;
  statusDot?: "live" | "reconnecting";
  repoPath?: string;
  activeRoute: RouteId;
  repoLabel?: string | null;
  isDaemonMode?: boolean;
  repos?: { label: string; status: string }[];
  /**
   * A4 Tier-2 passive auth banner. Rendered below the header ONLY when the
   * badge is `warn`/`attention` (a plan is lapsing/lost) — `ok`/`info` states
   * show nothing, so the banner never nags a working or deliberate-free user.
   */
  authBanner?: { line: string; badge: string } | null;
  /**
   * U3 Tier-2 passive auto-update banner. Rendered below the header ONLY for
   * actionable states (`available`/`pending`/`rolled-back`) — `up-to-date`
   * and `disabled` show nothing, so a current install never sees a banner.
   */
  updateBanner?: { line: string; status: string } | null;
  children: ReactNode;
};

export function AppShell({
  title,
  subtitle,
  statusDot,
  repoPath,
  activeRoute,
  repoLabel,
  isDaemonMode,
  repos,
  authBanner,
  updateBanner,
  children,
}: Props) {
  const repo = repoPath ? parseRepoPath(repoPath) : null;
  const isGlobalRoute = activeRoute === "all-repos" || activeRoute === "daemon";

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="flex w-full shrink-0 flex-col border-b border-border-subtle bg-sidebar px-5 py-6 md:w-56 md:border-r md:border-b-0 md:sticky md:top-0 md:h-screen md:overflow-y-auto">
        {/* Brand */}
        <div className="mb-8 flex items-center justify-center">
          <img
            src="/icon-wordmark.png"
            alt="unerr"
            className="h-7"
            draggable={false}
          />
        </div>

        {/* Daemon nav section (when in daemon mode) */}
        {isDaemonMode && (
          <>
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest t-tertiary">
              Global
            </p>
            <nav className="flex flex-col gap-0.5 mb-4" aria-label="Global">
              {GLOBAL_NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateRoute(item.id)}
                  className={`block w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    activeRoute === item.id
                      ? "el-raised font-medium text-foreground-emphasis"
                      : "text-muted-foreground hover:text-foreground hover:el-raised"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            {/* Repo switcher */}
            {repos && repos.length > 0 && (
              <>
                <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest t-tertiary">
                  Repositories
                </p>
                <div className="flex flex-col gap-0.5 mb-4">
                  {repos.map((r) => (
                    <button
                      key={r.label}
                      type="button"
                      onClick={() => navigateRoute("overview", r.label)}
                      className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        repoLabel === r.label && !isGlobalRoute
                          ? "el-raised font-medium text-foreground-emphasis"
                          : "text-muted-foreground hover:text-foreground hover:el-raised"
                      }`}
                    >
                      <span
                        className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                          r.status === "running"
                            ? "bg-success shadow-[0_0_4px_rgba(52,211,153,0.6)]"
                            : r.status === "error"
                              ? "bg-error"
                              : "bg-muted-foreground/40"
                        }`}
                      />
                      <span className="truncate">{r.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Per-repo nav (only when a repo is selected) */}
            {repoLabel && !isGlobalRoute && (
              <>
                <div className="divider-shimmer mb-3" />
                <nav className="flex flex-col gap-0.5" aria-label="Repo">
                  {REPO_NAV.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => navigateRoute(item.id, repoLabel)}
                      className={`block w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        activeRoute === item.id
                          ? "el-raised font-medium text-foreground-emphasis"
                          : "text-muted-foreground hover:text-foreground hover:el-raised"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </nav>
              </>
            )}
          </>
        )}

        {/* Standalone mode nav (no daemon) */}
        {!isDaemonMode && (
          <nav className="flex flex-col gap-0.5" aria-label="Primary">
            {REPO_NAV.map((item) => (
              <a
                key={item.id}
                href={item.id === "overview" ? "#/" : `#/${item.id}`}
                className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                  activeRoute === item.id
                    ? "el-raised font-medium text-foreground-emphasis"
                    : "text-muted-foreground hover:text-foreground hover:el-raised"
                }`}
              >
                {item.label}
              </a>
            ))}
          </nav>
        )}

        {/* Footer */}
        {subtitle ? (
          <div className="mt-auto pt-8">
            <div className="divider-shimmer mb-4" />
            <p className="t-tertiary text-xs leading-relaxed">{subtitle}</p>
          </div>
        ) : null}
      </aside>

      {/* Main content */}
      <main className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
        <header className="flex items-center justify-between border-b border-border-subtle bg-background/90 px-6 py-4 backdrop-blur-sm">
          <h1>{title}</h1>
          {repo && (
            <div className="flex items-center gap-2" title={repoPath}>
              <span
                className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                  statusDot === "live"
                    ? "bg-success shadow-[0_0_6px_rgba(52,211,153,0.6)]"
                    : "bg-warning animate-pulse"
                }`}
                title={statusDot === "live" ? "Connected" : "Reconnecting..."}
              />
              <span className="text-sm font-medium text-foreground-emphasis">
                {repo.name}
              </span>
              <span className="t-tertiary text-xs font-mono hidden sm:inline">
                {repo.dir}
              </span>
            </div>
          )}
        </header>
        {authBanner &&
          (authBanner.badge === "warn" || authBanner.badge === "attention") && (
            <div
              role="status"
              className={`flex items-center gap-2 border-b px-6 py-2.5 text-sm ${
                authBanner.badge === "attention"
                  ? "border-error/30 bg-error/10 text-error"
                  : "border-warning/30 bg-warning/10 text-warning"
              }`}
            >
              <span
                className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                  authBanner.badge === "attention" ? "bg-error" : "bg-warning"
                }`}
              />
              <span>{authBanner.line}</span>
            </div>
          )}
        {updateBanner &&
          (updateBanner.status === "available" ||
            updateBanner.status === "pending" ||
            updateBanner.status === "rolled-back") && (
            <div
              role="status"
              className={`flex items-center gap-2 border-b px-6 py-2.5 text-sm ${
                updateBanner.status === "rolled-back"
                  ? "border-error/30 bg-error/10 text-error"
                  : "border-data/30 bg-data/10 text-data"
              }`}
            >
              <span
                className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
                  updateBanner.status === "rolled-back" ? "bg-error" : "bg-data"
                }`}
              />
              <span>{updateBanner.line}</span>
            </div>
          )}
        <div className="flex-1 p-6">{children}</div>
      </main>
    </div>
  );
}
