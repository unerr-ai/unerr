/**
 * Sprint P1-6: Per-server health dashboard.
 *
 * Live status per child MCP server including:
 *   - Connection state (healthy/unhealthy/stopped/starting)
 *   - Last ping latency
 *   - Last error
 *   - Restart history (count + last restart timestamp)
 *   - Tool count exposed through this server
 *   - Manual restart trigger
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface ServerHealth {
  id: string;
  name: string;
  alias: string;
  status: "healthy" | "unhealthy" | "stopped" | "starting";
  lastPingMs: number | null;
  lastError: string | null;
  restartCount: number;
  lastRestartAt: string | null;
  upSince: string | null;
  toolCount: number;
}

interface ServersResponse {
  data: { servers: ServerHealth[] };
}

function StatusBadge({ status }: { status: ServerHealth["status"] }) {
  const styles: Record<ServerHealth["status"], string> = {
    healthy: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    unhealthy: "bg-red-500/15 text-red-400 border-red-500/30",
    stopped: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    starting: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === "healthy"
            ? "bg-emerald-400"
            : status === "unhealthy"
              ? "bg-red-400 animate-pulse"
              : status === "starting"
                ? "bg-amber-400 animate-pulse"
                : "bg-zinc-400"
        }`}
      />
      {status}
    </span>
  );
}

function formatUptime(upSince: string | null): string {
  if (!upSince) return "—";
  const ms = Date.now() - new Date(upSince).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function ServerCard({ server }: { server: ServerHealth }) {
  const queryClient = useQueryClient();

  const restartMutation = useMutation({
    mutationFn: () =>
      fetchJson(`/api/router/servers/${server.id}/restart`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["router-servers"] });
    },
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">{server.name}</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            prefix: <code className="text-violet-400">{server.alias}_*</code>
          </p>
        </div>
        <StatusBadge status={server.status} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <span className="text-zinc-500">Ping</span>
          <p className="mt-0.5 font-mono text-zinc-300">
            {server.lastPingMs !== null ? `${server.lastPingMs}ms` : "—"}
          </p>
        </div>
        <div>
          <span className="text-zinc-500">Tools</span>
          <p className="mt-0.5 font-mono text-zinc-300">{server.toolCount}</p>
        </div>
        <div>
          <span className="text-zinc-500">Uptime</span>
          <p className="mt-0.5 font-mono text-zinc-300">
            {formatUptime(server.upSince)}
          </p>
        </div>
        <div>
          <span className="text-zinc-500">Restarts</span>
          <p className="mt-0.5 font-mono text-zinc-300">
            {server.restartCount}
          </p>
        </div>
      </div>

      {server.lastError && (
        <div className="mt-3 rounded border border-red-500/20 bg-red-500/5 px-3 py-2">
          <p className="text-xs text-red-400 font-mono break-all">
            {server.lastError}
          </p>
        </div>
      )}

      {server.lastRestartAt && (
        <p className="mt-2 text-[10px] text-zinc-600">
          Last restart:{" "}
          {new Date(server.lastRestartAt).toLocaleString()}
        </p>
      )}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={() => restartMutation.mutate()}
          disabled={restartMutation.isPending || server.status === "starting"}
          className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-violet-500/50 hover:text-violet-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {restartMutation.isPending ? "Restarting…" : "Restart"}
        </button>
      </div>
    </div>
  );
}

export function RouterServersPage() {
  const { data, isLoading, error } = useQuery<ServersResponse>({
    queryKey: ["router-servers"],
    queryFn: () => fetchJson("/api/router/servers"),
    refetchInterval: 5_000,
  });

  if (isLoading) return <CardGridSkeleton count={3} />;

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
        Failed to load server health: {(error as Error).message}
      </div>
    );
  }

  const servers = data?.data?.servers ?? [];

  if (servers.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <p className="text-sm text-zinc-400">
          No child servers connected. Enable the router and restart your IDE.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">
          Child Servers ({servers.length})
        </h2>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {servers.filter((s) => s.status === "healthy").length} healthy
          {servers.some((s) => s.status === "unhealthy") && (
            <>
              <span className="ml-2 h-1.5 w-1.5 rounded-full bg-red-400" />
              {servers.filter((s) => s.status === "unhealthy").length} unhealthy
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {servers.map((server) => (
          <ServerCard key={server.id} server={server} />
        ))}
      </div>
    </div>
  );
}
