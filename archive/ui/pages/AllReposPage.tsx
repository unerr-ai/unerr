import { fetchJson } from "@/lib/api";
import { navigateRoute } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";

interface RepoStatusEntry {
  path: string;
  label: string;
  status: "running" | "stopped" | "starting" | "error";
  pid: number | null;
  memory: number | null;
  idle: number | null;
  connections: number;
  lastActivity: string | null;
  entityCount: number | null;
  edgeCount: number | null;
  needsInput: { key: string; auto: string; reason: string }[];
}

interface AggregateSummary {
  summary: {
    totalRepos: number;
    runningRepos: number;
    stoppedRepos: number;
    totalEntities: number;
    totalEdges: number;
    totalMemoryMb: number;
    totalConnections: number;
    totalNeedsInput: number;
  };
  tokenFlow: { saved: number; total: number; violations: number };
  reasoning: { sessions: number; avgQuality: number };
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-success shadow-[0_0_6px_rgba(52,211,153,0.6)]",
  stopped: "bg-muted-foreground/40",
  starting: "bg-warning animate-pulse",
  error: "bg-error",
};

function formatIdle(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function AllReposPage() {
  const { data: reposData } = useQuery<{ repos: RepoStatusEntry[] }>({
    queryKey: ["daemon", "repos"],
    queryFn: () => fetchJson("/api/repos"),
    refetchInterval: 5000,
  });

  const { data: aggregate } = useQuery<AggregateSummary>({
    queryKey: ["daemon", "aggregate"],
    queryFn: () => fetchJson("/api/repos/aggregate"),
    refetchInterval: 10_000,
  });

  const repos = reposData?.repos ?? [];
  const agg = aggregate?.summary;

  return (
    <div className="space-y-6">
      {/* Aggregated overview cards */}
      {agg && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard
            label="Repositories"
            value={agg.totalRepos}
            sub={`${agg.runningRepos} running`}
          />
          <StatCard
            label="Total Entities"
            value={agg.totalEntities.toLocaleString()}
            sub={`${agg.totalEdges.toLocaleString()} edges`}
          />
          <StatCard
            label="Memory"
            value={`${agg.totalMemoryMb} MB`}
            sub={`across ${agg.runningRepos} processes`}
          />
          <StatCard
            label="Connections"
            value={agg.totalConnections}
            sub={
              agg.totalNeedsInput > 0
                ? `${agg.totalNeedsInput} need input`
                : "all healthy"
            }
          />
        </div>
      )}

      {/* Token flow aggregate */}
      {aggregate?.tokenFlow && aggregate.tokenFlow.total > 0 && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <StatCard
            label="Tokens Saved"
            value={aggregate.tokenFlow.saved.toLocaleString()}
            sub="across all repos"
            accent
          />
          <StatCard
            label="Tool Calls"
            value={aggregate.tokenFlow.total.toLocaleString()}
            sub="resolved locally"
          />
          <StatCard
            label="Violations"
            value={aggregate.tokenFlow.violations}
            sub="caught"
          />
        </div>
      )}

      {/* Repos grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {repos.map((repo) => (
          <button
            key={repo.path}
            type="button"
            onClick={() => navigateRoute("overview", repo.label)}
            className="el-raised flex flex-col gap-3 rounded-lg p-4 text-left transition-all hover:ring-2 hover:ring-brand/30"
          >
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_COLORS[repo.status] ?? STATUS_COLORS.stopped}`}
                title={repo.status}
              />
              <span className="text-sm font-semibold text-foreground-emphasis truncate">
                {repo.label}
              </span>
            </div>
            <p className="t-tertiary text-xs font-mono truncate">{repo.path}</p>
            <div className="flex items-center gap-4 text-xs t-tertiary">
              {repo.status === "running" && (
                <>
                  <span>{repo.memory ?? 0} MB</span>
                  <span>
                    {repo.entityCount?.toLocaleString() ?? 0} entities
                  </span>
                  <span>idle {formatIdle(repo.idle)}</span>
                  <span>{repo.connections} conn</span>
                </>
              )}
              {repo.status === "stopped" && (
                <span className="italic">Stopped</span>
              )}
              {repo.status === "starting" && (
                <span className="animate-pulse">Starting…</span>
              )}
              {repo.status === "error" && (
                <span className="text-error">Error</span>
              )}
            </div>
            {repo.needsInput.length > 0 && (
              <div className="flex items-center gap-1 text-xs text-warning">
                <span>⚠</span>
                <span>
                  {repo.needsInput.length} need
                  {repo.needsInput.length === 1 ? "s" : ""} input
                </span>
              </div>
            )}
          </button>
        ))}
        {repos.length === 0 && (
          <div className="col-span-full text-center py-12 t-tertiary">
            <p className="text-lg font-medium">No repos registered</p>
            <p className="mt-2 text-sm">
              Run{" "}
              <code className="font-mono text-foreground">unerr pm add .</code>{" "}
              from a project directory.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="el-raised rounded-lg p-4">
      <p className="t-tertiary text-xs uppercase tracking-wider">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold ${accent ? "text-brand" : "text-foreground-emphasis"}`}
      >
        {value}
      </p>
      {sub && <p className="t-tertiary mt-1 text-xs">{sub}</p>}
    </div>
  );
}
