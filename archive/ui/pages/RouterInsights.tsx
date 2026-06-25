/**
 * Sprint P2-6: Router Insights page (Phase 2 upgrade).
 *
 * Shows:
 *   - Accuracy lift metric (current vs baseline)
 *   - Prevented wrong calls count
 *   - Retries saved
 *   - Intelligence association summary
 *   - Family nudge accuracy (from Phase 1)
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

interface LiftData {
  accuracyLift: number;
  retryReduction: number;
  preventionRate: number;
  currentAccuracy: number;
  baselineAccuracy: number;
  isPositive: boolean;
  confidence: "low" | "medium" | "high";
}

interface CounterData {
  preventedWrongCalls: number;
  totalSoftRefuses: number;
  alternativesTaken: number;
  alternativesSucceeded: number;
  retriesSaved: number;
  totalRetries: number;
  baselineRetries: number;
}

interface AssociationSummary {
  totalAssociations: number;
  highQualityCount: number;
  driverPercentage: number;
  topAssociations: {
    triggerType: string;
    triggerDetail: string;
    family: string;
    count: number;
    avgQuality: number;
  }[];
}

interface InsightsV2Response {
  data: {
    lift: LiftData;
    counter: CounterData;
    associations: AssociationSummary | null;
  };
}

function LiftCard({ lift }: { lift: LiftData }) {
  const liftPct = Math.round(lift.accuracyLift * 100);
  const sign = liftPct >= 0 ? "+" : "";
  const color = lift.isPositive
    ? "text-emerald-400"
    : liftPct === 0
      ? "text-zinc-400"
      : "text-red-400";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
        Accuracy Lift
      </p>
      <p className={`mt-2 text-3xl font-bold tabular-nums ${color}`}>
        {sign}
        {liftPct}%
      </p>
      <div className="mt-3 flex items-center gap-3 text-xs text-zinc-500">
        <span className="font-mono">
          {Math.round(lift.currentAccuracy * 100)}% current
        </span>
        <span>vs</span>
        <span className="font-mono">
          {Math.round(lift.baselineAccuracy * 100)}% baseline
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
            lift.confidence === "high"
              ? "bg-emerald-500/15 text-emerald-400"
              : lift.confidence === "medium"
                ? "bg-amber-500/15 text-amber-400"
                : "bg-zinc-700/50 text-zinc-400"
          }`}
        >
          {lift.confidence} confidence
        </span>
      </div>
    </div>
  );
}

function CounterCards({ counter }: { counter: CounterData }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
          Wrong Calls Prevented
        </p>
        <p className="mt-2 text-2xl font-bold text-emerald-400 tabular-nums">
          {counter.preventedWrongCalls}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          of {counter.totalSoftRefuses} soft-refuses (
          {counter.alternativesTaken} alternatives taken)
        </p>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
          Retries Saved
        </p>
        <p className="mt-2 text-2xl font-bold text-cyan-400 tabular-nums">
          {counter.retriesSaved}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          {counter.totalRetries} retries this session (baseline:{" "}
          {counter.baselineRetries})
        </p>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
          Prevention Rate
        </p>
        <p className="mt-2 text-2xl font-bold text-violet-400 tabular-nums">
          {counter.totalSoftRefuses > 0
            ? `${Math.round((counter.preventedWrongCalls / counter.totalSoftRefuses) * 100)}%`
            : "—"}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          How often soft-refuses lead to successful corrections
        </p>
      </div>
    </div>
  );
}

function AssociationPanel({ data }: { data: AssociationSummary }) {
  const driverPct = Math.round(data.driverPercentage * 100);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">
          Intelligence Associations
        </h3>
        <span className="text-xs text-zinc-500">
          {data.totalAssociations} this week
        </span>
      </div>
      <div className="mt-3 flex items-center gap-4">
        <div>
          <span className="text-2xl font-bold text-violet-400 tabular-nums">
            {driverPct}%
          </span>
          <p className="text-xs text-zinc-500">
            of tool calls intelligence-driven
          </p>
        </div>
        <div className="h-12 w-px bg-zinc-800" />
        <div>
          <span className="text-2xl font-bold text-emerald-400 tabular-nums">
            {data.highQualityCount}
          </span>
          <p className="text-xs text-zinc-500">high-quality outcomes</p>
        </div>
      </div>
      {data.topAssociations.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium text-zinc-500">Top Associations</p>
          {data.topAssociations.map((a, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="text-zinc-300">
                <span className="font-mono text-violet-400">
                  {a.triggerType}
                </span>
                :{a.triggerDetail} →{" "}
                <span className="font-mono text-cyan-400">{a.family}_*</span>
              </span>
              <span className="tabular-nums text-zinc-500">
                {a.count}× (quality: {Math.round(a.avgQuality * 100)}%)
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RouterInsightsPage() {
  const { data, isLoading, error } = useQuery<InsightsV2Response>({
    queryKey: ["router-insights-v2"],
    queryFn: () => fetchJson("/api/router/insights/v2"),
    refetchInterval: 10_000,
  });

  if (isLoading) return <CardGridSkeleton count={6} />;

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
        Failed to load insights: {(error as Error).message}
      </div>
    );
  }

  const { lift, counter, associations } = data?.data ?? {
    lift: {
      accuracyLift: 0,
      retryReduction: 0,
      preventionRate: 0,
      currentAccuracy: 1,
      baselineAccuracy: 1,
      isPositive: false,
      confidence: "low" as const,
    },
    counter: {
      preventedWrongCalls: 0,
      totalSoftRefuses: 0,
      alternativesTaken: 0,
      alternativesSucceeded: 0,
      retriesSaved: 0,
      totalRetries: 0,
      baselineRetries: 0,
    },
    associations: null,
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-100">Router Insights</h2>

      <LiftCard lift={lift} />
      <CounterCards counter={counter} />

      {associations && <AssociationPanel data={associations} />}

      {!associations && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center">
          <p className="text-sm text-zinc-400">
            No association data yet. Intelligence associations appear after the
            router detects signals (ur|rsk, ur|fct) driving subsequent tool
            calls.
          </p>
        </div>
      )}
    </div>
  );
}
