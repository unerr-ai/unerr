/**
 * Sprint P2-6: Intelligence-association explorer.
 *
 * Browse week-level association summaries:
 *   - Quality distribution (high/medium/low)
 *   - Breakdown by trigger type and family
 *   - Top-ranked associations with click-through to traces
 *   - Driver percentage (how much of agent behavior is intelligence-driven)
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

interface AssociationData {
  weekStart: string;
  weekEnd: string;
  totalAssociations: number;
  byTriggerType: Record<string, number>;
  byFamily: Record<string, number>;
  highQualityCount: number;
  mediumQualityCount: number;
  lowQualityCount: number;
  topAssociations: {
    triggerType: string;
    triggerDetail: string;
    family: string;
    count: number;
    avgQuality: number;
  }[];
  driverPercentage: number;
}

interface AssociationsResponse {
  data: AssociationData | null;
}

function QualityDistribution({ high, medium, low }: { high: number; medium: number; low: number }) {
  const total = high + medium + low;
  if (total === 0) return null;

  const highPct = (high / total) * 100;
  const medPct = (medium / total) * 100;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">Quality Distribution</p>
      <div className="h-4 w-full rounded-full overflow-hidden bg-zinc-800 flex">
        {highPct > 0 && (
          <div className="bg-emerald-500 transition-all" style={{ width: `${highPct}%` }} title={`High: ${high}`} />
        )}
        {medPct > 0 && (
          <div className="bg-amber-500 transition-all" style={{ width: `${medPct}%` }} title={`Medium: ${medium}`} />
        )}
        {total - high - medium > 0 && (
          <div className="bg-red-500/50 transition-all flex-1" title={`Low: ${low}`} />
        )}
      </div>
      <div className="mt-2 flex items-center gap-4 text-xs text-zinc-500">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" />{high} high</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" />{medium} medium</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500/50" />{low} low</span>
      </div>
    </div>
  );
}

function BreakdownTable({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">{title}</p>
      <div className="space-y-2">
        {entries.map(([key, count]) => {
          const maxCount = entries[0][1];
          const pct = (count / maxCount) * 100;
          return (
            <div key={key} className="flex items-center gap-3">
              <span className="text-xs font-mono text-zinc-300 w-28 truncate">{key}</span>
              <div className="flex-1 h-2 rounded-full bg-zinc-800">
                <div className="h-2 rounded-full bg-violet-500/70" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs text-zinc-500 tabular-nums w-8 text-right">{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RouterAssociationsPage() {
  const { data, isLoading, error } = useQuery<AssociationsResponse>({
    queryKey: ["router-associations"],
    queryFn: () => fetchJson("/api/router/associations"),
    refetchInterval: 30_000,
  });

  if (isLoading) return <CardGridSkeleton count={4} />;

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
        Failed to load associations: {(error as Error).message}
      </div>
    );
  }

  const assoc = data?.data;

  if (!assoc) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-zinc-100">Intelligence Associations</h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center">
          <p className="text-sm text-zinc-400">
            No association data yet. Associations are detected when a signal
            (like ur|rsk or ur|hnt) precedes a tool call within a 3-turn window.
          </p>
        </div>
      </div>
    );
  }

  const weekLabel = `${new Date(assoc.weekStart).toLocaleDateString()} — ${new Date(assoc.weekEnd).toLocaleDateString()}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">Intelligence Associations</h2>
        <span className="text-xs text-zinc-500">{weekLabel}</span>
      </div>

      {/* Top stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Total Associations</p>
          <p className="mt-2 text-2xl font-bold text-violet-400 tabular-nums">{assoc.totalAssociations}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Driver %</p>
          <p className="mt-2 text-2xl font-bold text-cyan-400 tabular-nums">{Math.round(assoc.driverPercentage * 100)}%</p>
          <p className="mt-1 text-xs text-zinc-500">of calls intelligence-driven</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">High-Quality</p>
          <p className="mt-2 text-2xl font-bold text-emerald-400 tabular-nums">{assoc.highQualityCount}</p>
          <p className="mt-1 text-xs text-zinc-500">successful driven outcomes</p>
        </div>
      </div>

      <QualityDistribution high={assoc.highQualityCount} medium={assoc.mediumQualityCount} low={assoc.lowQualityCount} />

      <div className="grid gap-4 sm:grid-cols-2">
        <BreakdownTable title="By Trigger Type" data={assoc.byTriggerType} />
        <BreakdownTable title="By Family" data={assoc.byFamily} />
      </div>

      {/* Top associations table */}
      {assoc.topAssociations.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800">
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Top Associations</p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                <th className="px-4 py-2 text-left">Trigger</th>
                <th className="px-4 py-2 text-left">Family</th>
                <th className="px-4 py-2 text-right">Count</th>
                <th className="px-4 py-2 text-right">Avg Quality</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {assoc.topAssociations.map((a, i) => (
                <tr key={i}>
                  <td className="px-4 py-2.5 text-xs">
                    <span className="font-mono text-violet-400">{a.triggerType}</span>
                    <span className="text-zinc-500 ml-1">{a.triggerDetail}</span>
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono text-cyan-400">{a.family}</td>
                  <td className="px-4 py-2.5 text-xs text-right tabular-nums">{a.count}</td>
                  <td className="px-4 py-2.5 text-xs text-right tabular-nums">
                    <span className={`${
                      a.avgQuality >= 0.7 ? "text-emerald-400" :
                      a.avgQuality >= 0.4 ? "text-amber-400" :
                      "text-red-400"
                    }`}>
                      {Math.round(a.avgQuality * 100)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
