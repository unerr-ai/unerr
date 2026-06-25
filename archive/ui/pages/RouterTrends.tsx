/**
 * Sprint P2-6: Cross-session trend lines.
 *
 * Displays time-series data across sessions:
 *   - Accuracy lift over time
 *   - Retries saved per session
 *   - Masking effectiveness (ratio of masked/total tools)
 *   - Associations detected per session
 *
 * Uses pure CSS/HTML bar charts (no chart library dependency).
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

interface TrendPoint {
  sessionId: string;
  date: string;
  accuracyLift: number;
  retriesSaved: number;
  maskingEffectiveness: number;
  associationsDetected: number;
}

interface TrendsResponse {
  data: TrendPoint[];
}

function MiniBarChart({
  data,
  valueKey,
  maxValue,
  color,
  formatValue,
}: {
  data: TrendPoint[];
  valueKey: keyof Pick<
    TrendPoint,
    | "accuracyLift"
    | "retriesSaved"
    | "maskingEffectiveness"
    | "associationsDetected"
  >;
  maxValue: number;
  color: string;
  formatValue: (v: number) => string;
}) {
  const effectiveMax = maxValue || 1;

  return (
    <div className="flex items-end gap-1 h-24">
      {data.map((point, i) => {
        const val = point[valueKey] as number;
        const heightPct = Math.max(2, (Math.abs(val) / effectiveMax) * 100);
        const isNeg = val < 0;

        return (
          <div
            key={i}
            className="flex-1 flex flex-col items-center group relative"
            title={`${point.date}: ${formatValue(val)}`}
          >
            <div
              className={`w-full rounded-t transition-all ${isNeg ? "bg-red-500/60" : color} group-hover:opacity-80`}
              style={{ height: `${heightPct}%` }}
            />
            <div className="absolute -top-6 hidden group-hover:block text-[10px] text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded whitespace-nowrap z-10">
              {formatValue(val)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TrendCard({
  title,
  subtitle,
  data,
  valueKey,
  color,
  formatValue,
  currentValue,
}: {
  title: string;
  subtitle: string;
  data: TrendPoint[];
  valueKey: keyof Pick<
    TrendPoint,
    | "accuracyLift"
    | "retriesSaved"
    | "maskingEffectiveness"
    | "associationsDetected"
  >;
  color: string;
  formatValue: (v: number) => string;
  currentValue: string;
}) {
  const values = data.map((d) => Math.abs(d[valueKey] as number));
  const maxVal = Math.max(...values, 1);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
          {title}
        </p>
        <span className="text-xs font-mono text-zinc-300 tabular-nums">
          {currentValue}
        </span>
      </div>
      <p className="text-[10px] text-zinc-600 mb-3">{subtitle}</p>
      {data.length > 1 ? (
        <MiniBarChart
          data={data}
          valueKey={valueKey}
          maxValue={maxVal}
          color={color}
          formatValue={formatValue}
        />
      ) : (
        <div className="h-24 flex items-center justify-center text-xs text-zinc-600">
          Need ≥2 sessions for trend
        </div>
      )}
      {data.length > 0 && (
        <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-600">
          <span>
            {data.length > 0 ? new Date(data[0].date).toLocaleDateString() : ""}
          </span>
          <span>
            {data.length > 1
              ? new Date(data[data.length - 1].date).toLocaleDateString()
              : ""}
          </span>
        </div>
      )}
    </div>
  );
}

export function RouterTrendsPage() {
  const { data, isLoading, error } = useQuery<TrendsResponse>({
    queryKey: ["router-trends"],
    queryFn: () => fetchJson("/api/router/trends"),
    refetchInterval: 30_000,
  });

  if (isLoading) return <CardGridSkeleton count={4} />;

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
        Failed to load trends: {(error as Error).message}
      </div>
    );
  }

  const trends = data?.data ?? [];

  if (trends.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-zinc-100">
          Cross-Session Trends
        </h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center">
          <p className="text-sm text-zinc-400">
            No trend data available. Trends populate after multiple sessions
            with the intent classifier active.
          </p>
        </div>
      </div>
    );
  }

  const latest = trends[trends.length - 1];

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-100">
        Cross-Session Trends
      </h2>
      <p className="text-xs text-zinc-500">{trends.length} sessions tracked</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <TrendCard
          title="Accuracy Lift"
          subtitle="Router impact on tool selection accuracy"
          data={trends}
          valueKey="accuracyLift"
          color="bg-emerald-500"
          formatValue={(v) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`}
          currentValue={`${latest.accuracyLift >= 0 ? "+" : ""}${Math.round(latest.accuracyLift * 100)}%`}
        />
        <TrendCard
          title="Retries Saved"
          subtitle="Unnecessary retries prevented per session"
          data={trends}
          valueKey="retriesSaved"
          color="bg-cyan-500"
          formatValue={(v) => String(v)}
          currentValue={String(latest.retriesSaved)}
        />
        <TrendCard
          title="Masking Effectiveness"
          subtitle="% of tools successfully masked without user override"
          data={trends}
          valueKey="maskingEffectiveness"
          color="bg-violet-500"
          formatValue={(v) => `${Math.round(v * 100)}%`}
          currentValue={`${Math.round(latest.maskingEffectiveness * 100)}%`}
        />
        <TrendCard
          title="Associations Detected"
          subtitle="Signal → tool-call intelligence associations per session"
          data={trends}
          valueKey="associationsDetected"
          color="bg-amber-500"
          formatValue={(v) => String(v)}
          currentValue={String(latest.associationsDetected)}
        />
      </div>
    </div>
  );
}
