/**
 * Sprint P0-6: Router Status page.
 *
 * Live view of:
 *   - Activation state (enabled/disabled)
 *   - Proxied servers with aliases
 *   - Current session KPIs (calls, tokens saved, soft-refuses, unlocks)
 *   - Recent tool calls feed
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

interface ProxiedServer {
  name: string;
  alias: string;
  sourceAgent: string;
}

interface OverrideInfo {
  unmasked: string[];
  masked: string[];
  unmaskAll: boolean;
  updatedAt: string;
}

interface RouterStatusResponse {
  data: {
    enabled: boolean;
    enabledAt?: string;
    phase: number;
    proxiedServers: ProxiedServer[];
    autoMaskedServers?: string[];
    overrides?: OverrideInfo;
    session: {
      totalCalls: number;
      totalTokensSaved: number;
      totalTokensIn: number;
      softRefuseCount: number;
      unlockCount: number;
      efficiency: number;
    } | null;
  };
}

interface RecentRecord {
  toolName: string;
  outcome: string;
  tokensIn: number;
  tokensSaved: number;
  latencyMs: { total: number };
  ts: string;
}

interface RecentResponse {
  data: { records: RecentRecord[] };
}

function fmtNum(n: number): string {
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function KpiCard({
  label,
  value,
  sub,
  color = "text-live",
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="card p-4 flex flex-col gap-1">
      <span className="section-label">{label}</span>
      <span
        className={`font-mono font-semibold text-2xl tabular-nums ${color}`}
      >
        {value}
      </span>
      {sub ? <span className="t-tertiary text-xs">{sub}</span> : null}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const cls =
    outcome === "executed"
      ? "bg-success/15 text-success"
      : outcome === "soft_refused"
        ? "bg-warning/15 text-warning"
        : "bg-error/15 text-error";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {outcome.replace(/_/g, " ")}
    </span>
  );
}

export function RouterStatusPage() {
  const statusQ = useQuery({
    queryKey: ["router", "status"],
    queryFn: () => fetchJson<RouterStatusResponse>("/api/router/status"),
    refetchInterval: 5_000,
  });

  const recentQ = useQuery({
    queryKey: ["router", "recent"],
    queryFn: () => fetchJson<RecentResponse>("/api/router/recent?limit=20"),
    refetchInterval: 3_000,
    enabled: statusQ.data?.data?.enabled === true,
  });

  if (statusQ.isLoading) return <CardGridSkeleton />;

  const data = statusQ.data?.data;
  if (!data) return <CardGridSkeleton />;

  if (!data.enabled) {
    return (
      <div className="space-y-6">
        <div className="card p-8 text-center">
          <div className="text-4xl mb-4">⏸</div>
          <h2 className="text-xl font-semibold mb-2">MCP Router is Disabled</h2>
          <p className="t-secondary max-w-md mx-auto">
            Run{" "}
            <code className="font-mono text-sm bg-muted px-1.5 py-0.5 rounded">
              unerr enable mcp-router
            </code>{" "}
            in your repository to activate the gateway. It will inspect your IDE
            MCP configs and consolidate them into a single intelligent endpoint.
          </p>
        </div>
      </div>
    );
  }

  const session = data.session;
  const recent = recentQ.data?.data?.records ?? [];
  const maskedSet = new Set(data.autoMaskedServers ?? []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">MCP Gateway Router</h2>
          <p className="t-secondary text-sm">
            Phase {data.phase} · Enabled{" "}
            {data.enabledAt
              ? new Date(data.enabledAt).toLocaleDateString()
              : ""}
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-success/15 px-3 py-1 text-sm font-medium text-success">
          <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_4px_rgba(52,211,153,0.6)]" />
          Active
        </span>
      </div>

      {/* KPI cards */}
      {session && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KpiCard label="Tool Calls" value={fmtNum(session.totalCalls)} />
          <KpiCard
            label="Tokens Saved"
            value={fmtNum(session.totalTokensSaved)}
            sub={`of ${fmtNum(session.totalTokensIn)} in`}
            color="text-live"
          />
          <KpiCard
            label="Soft Refuses"
            value={session.softRefuseCount}
            color="text-warning"
          />
          <KpiCard
            label="Unlocks"
            value={session.unlockCount}
            color="text-accent"
          />
        </div>
      )}

      {/* Proxied servers */}
      {data.proxiedServers.length > 0 && (
        <div className="card">
          <div className="p-4 border-b border-border-subtle">
            <h3 className="font-semibold">
              Proxied Servers ({data.proxiedServers.length})
            </h3>
            {maskedSet.size > 0 && (
              <p className="text-xs t-tertiary mt-1">
                {maskedSet.size} auto-masked (never used) — saves ~
                {maskedSet.size * 2000} tokens/session
              </p>
            )}
          </div>
          <div className="divide-y divide-border-subtle">
            {data.proxiedServers.map((s) => {
              const isMasked = maskedSet.has(s.name);
              return (
                <div
                  key={s.name}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-2 w-2 rounded-full ${isMasked ? "bg-zinc-500" : "bg-success"}`}
                    />
                    <span
                      className={`font-medium ${isMasked ? "t-tertiary" : ""}`}
                    >
                      {s.name}
                    </span>
                    {isMasked && (
                      <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                        auto-masked
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 t-secondary text-sm">
                    <span className="font-mono">{s.alias}_*</span>
                    <span>{s.sourceAgent}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Active overrides */}
      {data.overrides &&
        (data.overrides.unmaskAll ||
          data.overrides.unmasked.length > 0 ||
          data.overrides.masked.length > 0) && (
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Active Overrides</h3>
              <button
                className="text-xs t-tertiary hover:text-error transition-colors"
                onClick={() =>
                  fetch("/api/router/clear-overrides", { method: "POST" }).then(
                    () => statusQ.refetch()
                  )
                }
              >
                Clear All
              </button>
            </div>
            {data.overrides.unmaskAll ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="h-2 w-2 rounded-full bg-success" />
                <span className="font-medium">All families unmasked</span>
                <span className="t-tertiary text-xs">
                  (intent masking disabled)
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                {data.overrides.unmasked.map((f) => (
                  <div key={f} className="flex items-center gap-2 text-sm">
                    <span className="h-2 w-2 rounded-full bg-success" />
                    <span className="font-mono">{f}</span>
                    <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">
                      unmasked
                    </span>
                  </div>
                ))}
                {data.overrides.masked.map((f) => (
                  <div key={f} className="flex items-center gap-2 text-sm">
                    <span className="h-2 w-2 rounded-full bg-warning" />
                    <span className="font-mono">{f}</span>
                    <span className="inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">
                      masked
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      {/* Efficiency bar */}
      {session && session.totalCalls > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="section-label">Token Efficiency</span>
            <span className="font-mono text-sm tabular-nums">
              {Math.round(session.efficiency * 100)}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-success transition-all duration-500"
              style={{ width: `${Math.round(session.efficiency * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Recent calls */}
      {recent.length > 0 && (
        <div className="card">
          <div className="p-4 border-b border-border-subtle">
            <h3 className="font-semibold">Recent Calls</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle t-tertiary">
                  <th className="px-4 py-2 text-left font-medium">Tool</th>
                  <th className="px-4 py-2 text-left font-medium">Outcome</th>
                  <th className="px-4 py-2 text-right font-medium">
                    Tokens In
                  </th>
                  <th className="px-4 py-2 text-right font-medium">Saved</th>
                  <th className="px-4 py-2 text-right font-medium">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {recent
                  .slice()
                  .reverse()
                  .map((r, i) => (
                    <tr key={`${r.ts}-${i}`} className="hover:bg-muted/50">
                      <td className="px-4 py-2 font-mono text-xs">
                        {r.toolName}
                      </td>
                      <td className="px-4 py-2">
                        <OutcomeBadge outcome={r.outcome} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r.tokensIn}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-success">
                        {r.tokensSaved > 0
                          ? `+${r.tokensSaved}`
                          : r.tokensSaved}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums t-tertiary">
                        {r.latencyMs.total.toFixed(1)}ms
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
