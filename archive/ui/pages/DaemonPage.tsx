import { WarmStartPanel } from "@/components/WarmStartPanel";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

interface DaemonInfo {
  pid: number;
  uptime: number;
  startedAt: string;
  version: string;
  port: number;
}

interface RepoStatusEntry {
  path: string;
  label: string;
  status: string;
  pid: number | null;
  memory: number | null;
  connections: number;
  lastActivity: string | null;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function DaemonPage() {
  const { data: daemon } = useQuery<DaemonInfo>({
    queryKey: ["pm", "info"],
    queryFn: () => fetchJson("/api/pm"),
    refetchInterval: 10_000,
  });

  const { data: reposData } = useQuery<{ repos: RepoStatusEntry[] }>({
    queryKey: ["pm", "repos"],
    queryFn: () => fetchJson("/api/repos"),
    refetchInterval: 5000,
  });

  const repos = reposData?.repos ?? [];

  return (
    <div className="space-y-6">
      {/* Process manager info */}
      {daemon && (
        <div className="el-raised rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground-emphasis mb-4">
            Process Manager
          </h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4 text-sm">
            <div>
              <p className="t-tertiary text-xs uppercase">PID</p>
              <p className="font-mono text-foreground-emphasis">{daemon.pid}</p>
            </div>
            <div>
              <p className="t-tertiary text-xs uppercase">Uptime</p>
              <p className="font-mono text-foreground-emphasis">
                {formatUptime(daemon.uptime)}
              </p>
            </div>
            <div>
              <p className="t-tertiary text-xs uppercase">Version</p>
              <p className="font-mono text-foreground-emphasis">
                {daemon.version}
              </p>
            </div>
            <div>
              <p className="t-tertiary text-xs uppercase">Dashboard Port</p>
              <p className="font-mono text-foreground-emphasis">
                {daemon.port}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Repo process table */}
      <div className="el-raised rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground-emphasis mb-4">
          Managed Processes
        </h2>
        {repos.length === 0 ? (
          <p className="t-tertiary text-sm">
            No repos registered. Run{" "}
            <code className="font-mono">unerr pm add .</code> from a project.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left t-tertiary text-xs uppercase tracking-wider">
                  <th className="pb-2 pr-4">Repo</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">PID</th>
                  <th className="pb-2 pr-4">Memory</th>
                  <th className="pb-2 pr-4">Connections</th>
                  <th className="pb-2">Last Activity</th>
                </tr>
              </thead>
              <tbody>
                {repos.map((repo) => (
                  <tr
                    key={repo.path}
                    className="border-b border-border-subtle/50 last:border-0"
                  >
                    <td className="py-3 pr-4">
                      <div className="font-medium text-foreground-emphasis">
                        {repo.label}
                      </div>
                      <div className="font-mono text-xs t-tertiary truncate max-w-xs">
                        {repo.path}
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          repo.status === "running"
                            ? "bg-success/10 text-success"
                            : repo.status === "error"
                              ? "bg-error/10 text-error"
                              : "bg-muted-foreground/10 text-muted-foreground"
                        }`}
                      >
                        {repo.status}
                      </span>
                    </td>
                    <td className="py-3 pr-4 font-mono">{repo.pid ?? "—"}</td>
                    <td className="py-3 pr-4 font-mono">
                      {repo.memory ? `${repo.memory} MB` : "—"}
                    </td>
                    <td className="py-3 pr-4 font-mono">{repo.connections}</td>
                    <td className="py-3 text-xs t-tertiary">
                      {repo.lastActivity
                        ? new Date(repo.lastActivity).toLocaleTimeString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Warm-start panel */}
      <WarmStartPanel />
    </div>
  );
}
