/**
 * Reasoning Trace dashboard page.
 *
 * 3-level hierarchical drill-down (same pattern as Token Trace):
 *
 *   Level 0 — GLOBAL:  Quality KPIs across all sessions + session list
 *   Level 1 — SESSION: Per-session quality metrics + health trajectory chart
 *   Level 2 — TURN:    Per-turn quality detail (via Token Trace deep link)
 *
 * Maps 1:1 to the tagline: "fewer tokens, turns & breakages"
 *   - Fewer tokens  → Signal-to-Noise Ratio, Context Density, Attention Multiplier
 *   - Fewer turns   → First-Call Resolution, Turns Saved, Exploration Loops Prevented
 *   - Fewer breakages → Blast Radius Warnings, Circuit Breaker, Convention Injections
 */

import { DateRangeFilter } from "@/components/DateRangeFilter";
import { HeadroomStrip, type HeadroomWindow } from "@/components/HeadroomStrip";
import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import {
  navigateRoute,
  setHashQueryParams,
  useHashQueryParam,
} from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { AgentBadge } from "./token-trace/components/AgentBadge";
import { Breadcrumb } from "./token-trace/components/Breadcrumb";
import { Pagination } from "./token-trace/components/Pagination";

// ── Types ────────────────────────────────────────────────────────────

interface QualityMetrics {
  signal_to_noise_ratio: number;
  noise_removed_pct: number;
  context_density: number;
  entities_resolved: number;
  graph_tokens_delivered: number;
  attention_multiplier: number;
  first_call_resolution_rate: number;
  graph_calls: number;
  total_tool_calls: number;
  turns_saved: number;
  exploration_loops_prevented: number;
  blast_radius_warnings: number;
  circuit_breaker_activations: number;
  convention_injections: number;
  prevention_score: number;
  reasoning_quality_multiplier: number;
  total_sessions: number;
  total_turns: number;
  total_events: number;
  // Persistent Memory pillar
  facts_surfaced: number;
  facts_recalled: number;
  facts_recorded: number;
  conventions_surfaced: number;
  resume_hits: number;
  negative_warnings: number;
  memory_signals_fired: number;
  verdicts_reinforced: number;
  verdicts_acted_on: number;
  verdicts_ignored: number;
  verdicts_corrected: number;
  verdicts_caught: number;
  memory_verdicts_total: number;
  memory_effectiveness_pct: number;
}

interface TrajectoryPoint {
  turn: number;
  snr: number;
  cumulative_noise_removed_pct: number;
  graph_calls_this_turn: number;
  context_density: number;
}

interface SessionQualityResponse {
  data:
    | (QualityMetrics & {
        session_id: string;
        trajectory: TrajectoryPoint[];
      })
    | null;
}

interface GlobalQualityResponse {
  data: QualityMetrics;
}

interface SessionListEntry {
  session_id: string;
  first_ts: string;
  last_ts: string;
  agent_name: string | null;
  noise_removed_pct: number;
  first_call_resolution_rate: number;
  prevention_score: number;
  reasoning_quality_multiplier: number;
  context_density: number;
  turns_saved: number;
  total_events: number;
  total_turns: number;
  memory_effectiveness_pct: number;
  memory_signals_fired: number;
  memory_verdicts_total: number;
}

interface SessionListResponse {
  data: SessionListEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface TrendPoint {
  session_id: string;
  first_ts: string;
  last_ts: string;
  noise_removed_pct: number;
  first_call_resolution_rate: number;
  prevention_score: number;
  reasoning_quality_multiplier: number;
  context_density: number;
  attention_multiplier: number;
  turns_saved: number;
  total_events: number;
  memory_effectiveness_pct: number;
  memory_signals_fired: number;
}

interface TrendResponse {
  data: TrendPoint[];
  total: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Shared sub-components ───────────────────────────────────────────

function KpiCard({
  label,
  value,
  accent,
  hint,
  subtitle,
}: {
  label: string;
  value: string | number;
  accent?: string;
  hint?: string;
  subtitle?: string;
}) {
  return (
    <div className="el-raised rounded-lg p-4" title={hint}>
      <p className="t-tertiary text-xs uppercase tracking-wider">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold font-mono tabular-nums ${accent ?? "text-foreground"}`}
      >
        {value}
      </p>
      {subtitle && (
        <p className="t-tertiary text-[10px] mt-1 leading-snug">{subtitle}</p>
      )}
    </div>
  );
}

// Breadcrumb, AgentBadge, and Pagination are shared with Token Trace and
// imported from token-trace/components/ — see the imports at the top. The
// local copies that used to live here were byte-identical duplicates
// (logbook-page-redesign §8 dedupe).

// ── Score Badge ──────────────────────────────────────────────────────

function ScoreBadge({
  value,
  max,
  label,
}: { value: number; max?: number; label?: string }) {
  const pct =
    max && max > 0 ? Math.min(100, Math.round((value / max) * 100)) : value;
  const color =
    pct >= 70
      ? "text-emerald-400"
      : pct >= 40
        ? "text-amber-400"
        : "text-red-400";
  const bg =
    pct >= 70
      ? "bg-emerald-500/20"
      : pct >= 40
        ? "bg-amber-500/20"
        : "bg-red-500/20";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${bg} ${color} text-[10px] font-medium`}
      title={label}
    >
      {pct}%
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════════
// LEVEL 0 — GLOBAL VIEW
// ══════════════════════════════════════════════════════════════════════

function GlobalView({
  onSelectSession,
}: { onSelectSession: (id: string) => void }) {
  const { url, queryKey } = useRepoApi();
  const fromTs = useHashQueryParam("from") ?? "";
  const toTs = useHashQueryParam("to") ?? "";
  const sessionOffsetParam = useHashQueryParam("session_offset");
  const sessionOffset = Number(sessionOffsetParam) || 0;
  const sessionLimit = 10;
  const setRange = (f: string, t: string) =>
    setHashQueryParams({
      from: f || null,
      to: t || null,
      session_offset: null,
    });
  const setSessionOffset = (next: number) =>
    setHashQueryParams({ session_offset: next > 0 ? String(next) : null });

  const dateParams =
    fromTs || toTs
      ? `${fromTs ? `&from_ts=${fromTs}` : ""}${toTs ? `&to_ts=${toTs}` : ""}`
      : "";

  const globalQ = useQuery({
    queryKey: queryKey(["reasoning-quality-global", fromTs, toTs]),
    queryFn: () =>
      fetchJson<GlobalQualityResponse>(
        url(`/api/reasoning-quality/global?_=1${dateParams}`)
      ),
    refetchInterval: 5_000,
  });

  const sessionsQ = useQuery({
    queryKey: queryKey([
      "reasoning-quality-sessions",
      fromTs,
      toTs,
      sessionOffset,
    ]),
    queryFn: () =>
      fetchJson<SessionListResponse>(
        url(
          `/api/reasoning-quality/sessions?limit=${sessionLimit}&offset=${sessionOffset}${dateParams}`
        )
      ),
    refetchInterval: 5_000,
  });

  const trendQ = useQuery({
    queryKey: queryKey(["reasoning-quality-trend", fromTs, toTs]),
    queryFn: () =>
      fetchJson<TrendResponse>(
        url(`/api/reasoning-quality/trend?_=1${dateParams}`)
      ),
    refetchInterval: 10_000,
  });

  if (globalQ.isLoading) return <CardGridSkeleton n={6} />;

  const g = globalQ.data?.data;
  const sessions = sessionsQ.data?.data ?? [];
  const sessionsTotal = sessionsQ.data?.total ?? 0;

  if (!g || g.total_events === 0) {
    return (
      <div className="el-raised rounded-lg p-10 text-center">
        <p className="t-secondary text-lg">No reasoning quality data yet</p>
        <p className="t-tertiary mt-2 text-sm">
          Quality metrics appear here as the agent uses unerr's graph-backed
          tools instead of grep/glob cycles.
        </p>
        <p className="t-tertiary mt-1 text-xs">
          This page shows how unerr improves your agent's thinking — not just
          saves tokens, but makes every remaining token count more.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-end gap-3 flex-wrap -mt-2">
        <DateRangeFilter
          fromTs={fromTs}
          toTs={toTs}
          onChange={(f, t) => setRange(f, t)}
        />
      </div>

      {/* ── Hero KPIs: The Big Four ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div
          className="el-raised rounded-lg p-5 border-t-2 border-emerald-500/60"
          title="Share of original tokens stripped before reaching the agent"
        >
          <p className="text-emerald-400 text-[10px] uppercase tracking-wider font-medium">
            Cleaner Context
          </p>
          <p className="text-3xl font-bold font-mono text-emerald-400 mt-2">
            {g.noise_removed_pct}%
          </p>
          <p className="t-secondary text-xs mt-1">Noise removed</p>
        </div>

        <div
          className="el-raised rounded-lg p-5 border-t-2 border-cyan-500/60"
          title="Lookups resolved in one graph call vs 3-5 grep/glob cycles"
        >
          <p className="text-cyan-400 text-[10px] uppercase tracking-wider font-medium">
            Fewer Turns
          </p>
          <p className="text-3xl font-bold font-mono text-cyan-400 mt-2">
            {g.first_call_resolution_rate}%
          </p>
          <p className="t-secondary text-xs mt-1">First-try resolution</p>
        </div>

        <div
          className="el-raised rounded-lg p-5 border-t-2 border-amber-500/60"
          title={`${g.blast_radius_warnings} warnings · ${g.convention_injections} hints${g.circuit_breaker_activations ? ` · ${g.circuit_breaker_activations} loop stops` : ""}`}
        >
          <p className="text-amber-400 text-[10px] uppercase tracking-wider font-medium">
            Fewer Breakages
          </p>
          <p className="text-3xl font-bold font-mono text-amber-400 mt-2">
            {g.prevention_score}
          </p>
          <p className="t-secondary text-xs mt-1">
            {g.blast_radius_warnings} warns · {g.convention_injections} hints
            {g.circuit_breaker_activations > 0
              ? ` · ${g.circuit_breaker_activations} stops`
              : ""}
          </p>
        </div>

        <div
          className="el-raised rounded-lg p-5 border-t-2 border-fuchsia-500/60"
          title="Share of fact/convention/resume signals that were load-bearing"
        >
          <p className="text-fuchsia-400 text-[10px] uppercase tracking-wider font-medium">
            Persistent Memory
          </p>
          <p className="text-3xl font-bold font-mono text-fuchsia-400 mt-2">
            {g.memory_verdicts_total > 0
              ? `${g.memory_effectiveness_pct}%`
              : g.memory_signals_fired > 0
                ? `${g.memory_signals_fired}↻`
                : "—"}
          </p>
          <p className="t-secondary text-xs mt-1">
            {g.memory_verdicts_total > 0
              ? `${g.verdicts_acted_on + g.verdicts_reinforced + g.verdicts_caught}/${g.memory_verdicts_total} load-bearing`
              : g.memory_signals_fired > 0
                ? "Verdicts pending"
                : "No memory signals yet"}
          </p>
        </div>
      </div>

      {/* ── Composite Score ── */}
      <div className="el-raised rounded-lg p-5 border-l-4 border-violet-500/40">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-foreground text-sm font-medium">
              Reasoning Trace Multiplier
            </h3>
            <p
              className="t-tertiary text-xs mt-1"
              title="Composite: compression × (1 + first-call resolution rate)"
            >
              Compression × precision.
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-violet-400 font-mono font-bold text-3xl">
              {g.reasoning_quality_multiplier}x
            </p>
          </div>
        </div>
      </div>

      {/* ── Quality Over Time (Temporal Trend) ── */}
      {(() => {
        const trend = trendQ.data?.data ?? [];
        if (trend.length < 2) return null;

        const maxMultiplier = Math.max(
          ...trend.map((t) => t.reasoning_quality_multiplier),
          1
        );
        const maxNoise = Math.max(...trend.map((t) => t.noise_removed_pct), 1);
        const maxFcr = Math.max(
          ...trend.map((t) => t.first_call_resolution_rate),
          1
        );

        return (
          <div className="el-raised rounded-lg p-5">
            <h3
              className="t-secondary text-sm font-medium mb-3"
              title="One bar per session, ordered chronologically. Rising = improving."
            >
              Quality Over Time
            </h3>

            {/* Multi-metric stacked chart */}
            <div className="space-y-4">
              {/* Noise Removed trend */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span
                    className="text-emerald-400 text-[10px] uppercase tracking-wider font-medium"
                    title="Higher = cleaner context"
                  >
                    Noise Removed %
                  </span>
                </div>
                <div className="flex gap-[2px]" style={{ height: "48px" }}>
                  {trend.slice(-40).map((pt, i) => {
                    const heightPct =
                      maxNoise > 0
                        ? Math.max(4, (pt.noise_removed_pct / maxNoise) * 100)
                        : 4;
                    const dateLabel = new Date(pt.first_ts).toLocaleDateString(
                      [],
                      {
                        month: "short",
                        day: "numeric",
                      }
                    );
                    return (
                      <div
                        key={pt.session_id}
                        className="group relative flex-1 min-w-[6px] max-w-[28px] h-full flex items-end"
                      >
                        <div
                          className="w-full bg-emerald-500 opacity-70 hover:opacity-100 rounded-t transition-all cursor-pointer"
                          style={{ height: `${heightPct}%` }}
                        />
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 pointer-events-none">
                          <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs whitespace-nowrap shadow-xl">
                            <div className="font-medium text-foreground">
                              {dateLabel}
                            </div>
                            <div className="text-emerald-400">
                              Noise removed: {pt.noise_removed_pct}%
                            </div>
                            <div className="t-secondary">
                              Session: {pt.session_id.slice(0, 8)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* First-Call Resolution trend */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-cyan-400 text-[10px] uppercase tracking-wider font-medium">
                    Found It First Try %
                  </span>
                  <span className="t-tertiary text-[10px]">
                    Higher = fewer wasted turns
                  </span>
                </div>
                <div className="flex gap-[2px]" style={{ height: "48px" }}>
                  {trend.slice(-40).map((pt) => {
                    const heightPct =
                      maxFcr > 0
                        ? Math.max(
                            4,
                            (pt.first_call_resolution_rate / maxFcr) * 100
                          )
                        : 4;
                    const dateLabel = new Date(pt.first_ts).toLocaleDateString(
                      [],
                      {
                        month: "short",
                        day: "numeric",
                      }
                    );
                    return (
                      <div
                        key={pt.session_id}
                        className="group relative flex-1 min-w-[6px] max-w-[28px] h-full flex items-end"
                      >
                        <div
                          className="w-full bg-cyan-500 opacity-70 hover:opacity-100 rounded-t transition-all cursor-pointer"
                          style={{ height: `${heightPct}%` }}
                        />
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 pointer-events-none">
                          <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs whitespace-nowrap shadow-xl">
                            <div className="font-medium text-foreground">
                              {dateLabel}
                            </div>
                            <div className="text-cyan-400">
                              First try: {pt.first_call_resolution_rate}%
                            </div>
                            <div className="t-secondary">
                              Turns saved: ~{pt.turns_saved}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Quality Multiplier trend */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span
                    className="text-violet-400 text-[10px] uppercase tracking-wider font-medium"
                    title="Higher = smarter agent"
                  >
                    Quality Multiplier
                  </span>
                </div>
                <div className="flex gap-[2px]" style={{ height: "48px" }}>
                  {trend.slice(-40).map((pt) => {
                    const heightPct =
                      maxMultiplier > 0
                        ? Math.max(
                            4,
                            (pt.reasoning_quality_multiplier / maxMultiplier) *
                              100
                          )
                        : 4;
                    const dateLabel = new Date(pt.first_ts).toLocaleDateString(
                      [],
                      {
                        month: "short",
                        day: "numeric",
                      }
                    );
                    return (
                      <div
                        key={pt.session_id}
                        className="group relative flex-1 min-w-[6px] max-w-[28px] h-full flex items-end"
                      >
                        <div
                          className="w-full bg-violet-500 opacity-70 hover:opacity-100 rounded-t transition-all cursor-pointer"
                          style={{ height: `${heightPct}%` }}
                        />
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 pointer-events-none">
                          <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs whitespace-nowrap shadow-xl">
                            <div className="font-medium text-foreground">
                              {dateLabel}
                            </div>
                            <div className="text-violet-400">
                              Quality: {pt.reasoning_quality_multiplier}x
                            </div>
                            <div className="t-secondary">
                              Attention boost: {pt.attention_multiplier}x
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Timeline labels */}
            {trend.length > 0 && (
              <div className="flex justify-between mt-2 pt-2 border-t border-border-subtle/50">
                <span className="t-tertiary text-[10px] font-mono">
                  {new Date(
                    trend[Math.max(0, trend.length - 40)].first_ts
                  ).toLocaleDateString([], {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <span className="t-tertiary text-[10px]">
                  {Math.min(40, trend.length)} sessions shown
                </span>
                <span className="t-tertiary text-[10px] font-mono">
                  {new Date(
                    trend[trend.length - 1].first_ts
                  ).toLocaleDateString([], {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
            )}

            {/* Legend */}
            <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-border-subtle/50">
              <div className="flex items-center gap-1.5">
                <div className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />
                <span className="t-tertiary text-[10px]">Noise removed</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2.5 w-2.5 rounded-sm bg-cyan-500" />
                <span className="t-tertiary text-[10px]">
                  First-call resolution
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2.5 w-2.5 rounded-sm bg-violet-500" />
                <span className="t-tertiary text-[10px]">
                  Quality multiplier
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Category Breakdowns ── */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Context Quality details */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="text-emerald-400 text-xs font-medium uppercase tracking-wider mb-4">
            Context Quality Details
          </h3>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between items-baseline">
                <span
                  className="t-secondary text-xs"
                  title="Fraction of original content kept (lower = cleaner)"
                >
                  Signal-to-Noise
                </span>
                <span className="text-foreground font-mono text-sm font-medium">
                  {g.signal_to_noise_ratio}
                </span>
              </div>
              <div className="mt-1.5 h-2 bg-surface-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all"
                  style={{
                    width: `${Math.max(3, (1 - g.signal_to_noise_ratio) * 100)}%`,
                  }}
                />
              </div>
            </div>

            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Entities resolved per 1K tokens delivered"
              >
                Context density
              </span>
              <span className="text-foreground font-mono text-sm font-medium">
                {g.context_density}
              </span>
            </div>

            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Estimated attention boost from noise removal"
              >
                Attention boost
              </span>
              <span className="text-foreground font-mono text-sm font-medium">
                {g.attention_multiplier}x
              </span>
            </div>

            <div className="pt-2 border-t border-border-subtle/50 space-y-1">
              <div className="flex justify-between items-baseline">
                <span className="t-tertiary text-xs">Entities resolved</span>
                <span className="t-secondary font-mono text-xs">
                  {fmt(g.entities_resolved)}
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span
                  className="t-tertiary text-xs"
                  title="Tokens delivered via graph queries"
                >
                  Graph tokens
                </span>
                <span className="t-secondary font-mono text-xs">
                  {fmt(g.graph_tokens_delivered)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Fewer Turns details */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="text-cyan-400 text-xs font-medium uppercase tracking-wider mb-4">
            Turn Efficiency Details
          </h3>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between items-baseline">
                <span
                  className="t-secondary text-xs"
                  title="Lookups resolved in 1 graph call vs 3-5 grep cycles"
                >
                  First-try resolution
                </span>
                <span className="text-foreground font-mono text-sm font-medium">
                  {g.first_call_resolution_rate}%
                </span>
              </div>
              <div className="mt-1.5 h-2 bg-surface-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan-500 rounded-full transition-all"
                  style={{
                    width: `${Math.max(3, g.first_call_resolution_rate)}%`,
                  }}
                />
              </div>
            </div>

            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Estimated grep→read cycles avoided"
              >
                Turns saved
              </span>
              <span className="text-cyan-400 font-mono text-sm font-medium">
                ~{fmt(g.turns_saved)}
              </span>
            </div>

            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Hook redirects that broke an exploration loop"
              >
                Loops stopped
              </span>
              <span className="text-foreground font-mono text-sm font-medium">
                {g.exploration_loops_prevented}
              </span>
            </div>

            <div className="pt-2 border-t border-border-subtle/50 space-y-1">
              <div className="flex justify-between items-baseline">
                <span className="t-tertiary text-xs">Graph calls</span>
                <span className="t-secondary font-mono text-xs">
                  {fmt(g.graph_calls)}
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="t-tertiary text-xs">Total tool calls</span>
                <span className="t-secondary font-mono text-xs">
                  {fmt(g.total_tool_calls)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Fewer Breakages details */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="text-amber-400 text-xs font-medium uppercase tracking-wider mb-4">
            Breakage Prevention Details
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Callers / refs / drift shown before edit"
              >
                Blast-radius warns
              </span>
              <span className="text-foreground font-mono text-sm font-medium">
                {g.blast_radius_warnings}
              </span>
            </div>

            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Project rules auto-injected into tool responses"
              >
                Convention hints
              </span>
              <span className="text-foreground font-mono text-sm font-medium">
                {g.convention_injections}
              </span>
            </div>

            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Circuit-breaker fires — agent stuck in fix→break→fix"
              >
                Loops stopped
              </span>
              <span
                className={`font-mono text-sm font-medium ${g.circuit_breaker_activations > 0 ? "text-red-400" : "text-foreground"}`}
              >
                {g.circuit_breaker_activations}
              </span>
            </div>

            <div className="pt-2 border-t border-border-subtle/50">
              <div className="flex justify-between items-baseline">
                <span
                  className="t-tertiary text-xs"
                  title="warnings + hints + (loops × 10)"
                >
                  Safety score
                </span>
                <span className="text-amber-400 font-mono text-xs font-medium">
                  {g.prevention_score} pts
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Persistent Memory Details ── */}
      <div className="el-raised rounded-lg p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div>
            <h3 className="text-fuchsia-400 text-xs font-medium uppercase tracking-wider">
              Persistent Memory
            </h3>
            <p
              className="t-tertiary text-xs mt-1"
              title="Each fact/convention/resume signal opens a 5-turn window and resolves into a verdict: reinforced · acted_on · caught · ignored · corrected. Load-bearing = reinforced + acted_on + caught."
            >
              Signals scored after a 5-turn observation window.
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-fuchsia-400 font-mono font-bold text-3xl">
              {g.memory_effectiveness_pct}%
            </p>
            <p className="t-tertiary text-[10px] uppercase tracking-wider mt-0.5">
              Load-bearing
            </p>
          </div>
        </div>

        {/* Verdict breakdown bar */}
        {g.memory_verdicts_total > 0 &&
          (() => {
            const total = g.memory_verdicts_total;
            const seg = (n: number) => (n / total) * 100;
            return (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="t-tertiary text-[10px] uppercase tracking-wider">
                    {total} verdict{total === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex h-3 rounded-full overflow-hidden bg-surface-secondary">
                  {g.verdicts_reinforced > 0 && (
                    <div
                      className="bg-emerald-500"
                      style={{ width: `${seg(g.verdicts_reinforced)}%` }}
                      title={`Reinforced: ${g.verdicts_reinforced}`}
                    />
                  )}
                  {g.verdicts_acted_on > 0 && (
                    <div
                      className="bg-fuchsia-500"
                      style={{ width: `${seg(g.verdicts_acted_on)}%` }}
                      title={`Acted on: ${g.verdicts_acted_on}`}
                    />
                  )}
                  {g.verdicts_caught > 0 && (
                    <div
                      className="bg-cyan-500"
                      style={{ width: `${seg(g.verdicts_caught)}%` }}
                      title={`Caught: ${g.verdicts_caught}`}
                    />
                  )}
                  {g.verdicts_ignored > 0 && (
                    <div
                      className="bg-zinc-600"
                      style={{ width: `${seg(g.verdicts_ignored)}%` }}
                      title={`Ignored: ${g.verdicts_ignored}`}
                    />
                  )}
                  {g.verdicts_corrected > 0 && (
                    <div
                      className="bg-red-500"
                      style={{ width: `${seg(g.verdicts_corrected)}%` }}
                      title={`Corrected: ${g.verdicts_corrected}`}
                    />
                  )}
                </div>
                <div className="flex flex-wrap gap-3 mt-2 text-[10px] t-tertiary">
                  <span>
                    <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500 mr-1" />
                    reinforced {g.verdicts_reinforced}
                  </span>
                  <span>
                    <span className="inline-block w-2 h-2 rounded-sm bg-fuchsia-500 mr-1" />
                    acted_on {g.verdicts_acted_on}
                  </span>
                  <span>
                    <span className="inline-block w-2 h-2 rounded-sm bg-cyan-500 mr-1" />
                    caught {g.verdicts_caught}
                  </span>
                  <span>
                    <span className="inline-block w-2 h-2 rounded-sm bg-zinc-600 mr-1" />
                    ignored {g.verdicts_ignored}
                  </span>
                  <span>
                    <span className="inline-block w-2 h-2 rounded-sm bg-red-500 mr-1" />
                    corrected {g.verdicts_corrected}
                  </span>
                </div>
              </div>
            );
          })()}

        {/* Signal volume sub-row */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 pt-3 border-t border-border-subtle/50">
          <div>
            <p className="t-tertiary text-[10px] uppercase tracking-wider">
              Facts surfaced
            </p>
            <p className="text-foreground font-mono text-sm font-medium mt-0.5">
              {fmt(g.facts_surfaced)}
            </p>
          </div>
          <div>
            <p className="t-tertiary text-[10px] uppercase tracking-wider">
              Facts recalled
            </p>
            <p className="text-foreground font-mono text-sm font-medium mt-0.5">
              {fmt(g.facts_recalled)}
            </p>
          </div>
          <div>
            <p className="t-tertiary text-[10px] uppercase tracking-wider">
              Facts recorded
            </p>
            <p className="text-foreground font-mono text-sm font-medium mt-0.5">
              {fmt(g.facts_recorded)}
            </p>
          </div>
          <div>
            <p className="t-tertiary text-[10px] uppercase tracking-wider">
              Conventions
            </p>
            <p className="text-foreground font-mono text-sm font-medium mt-0.5">
              {fmt(g.conventions_surfaced)}
            </p>
          </div>
          <div>
            <p className="t-tertiary text-[10px] uppercase tracking-wider">
              Resume hits
            </p>
            <p className="text-foreground font-mono text-sm font-medium mt-0.5">
              {fmt(g.resume_hits)}
            </p>
          </div>
          <div>
            <p className="t-tertiary text-[10px] uppercase tracking-wider">
              Anti-pattern warns
            </p>
            <p className="text-foreground font-mono text-sm font-medium mt-0.5">
              {fmt(g.negative_warnings)}
            </p>
          </div>
        </div>
      </div>

      {/* ── Session List ── */}
      <div className="el-raised rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
          <h3
            className="t-secondary text-sm font-medium"
            title="Click a row to drill into a session"
          >
            Sessions
          </h3>
          <span className="t-tertiary text-xs">
            {sessionsTotal} session{sessionsTotal !== 1 ? "s" : ""}
          </span>
        </div>

        {sessions.length === 0 ? (
          <p className="px-5 py-6 t-secondary text-sm">No sessions recorded.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm min-w-[800px]">
                <thead>
                  <tr className="border-b border-border-subtle t-tertiary text-xs uppercase">
                    <th
                      className="px-5 py-2.5 font-medium"
                      title="Unique session identifier"
                    >
                      Session
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium"
                      title="AI agent that ran this session"
                    >
                      Agent
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium"
                      title="When the last event was recorded"
                    >
                      Last Active
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-center"
                      title="% noise removed"
                    >
                      Noise Removed
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-center"
                      title="First-try lookup resolution"
                    >
                      First Try
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-center"
                      title="Warnings + hints + (loops × 10)"
                    >
                      Safety
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-center"
                      title="% of memory signals that were load-bearing"
                    >
                      Memory
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-right"
                      title="Wasted turns avoided"
                    >
                      Turns Saved
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-right"
                      title="Compression × precision"
                    >
                      Quality
                    </th>
                    <th className="px-3 py-2.5 pr-5 font-medium w-16" />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s, i) => (
                    <tr
                      key={s.session_id}
                      className="border-b border-border-subtle hover:bg-surface-secondary transition-colors cursor-pointer group"
                      onClick={() => onSelectSession(s.session_id)}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-foreground group-hover:text-violet-400 transition-colors">
                            {s.session_id.slice(0, 12)}
                          </span>
                          {i === 0 && sessionOffset === 0 && (
                            <span className="rounded-full bg-emerald-500/20 text-emerald-400 px-2 py-0.5 text-[10px] font-medium">
                              latest
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <AgentBadge name={s.agent_name} />
                      </td>
                      <td className="px-3 py-3 t-secondary text-xs">
                        {timeAgo(s.last_ts)}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <ScoreBadge
                          value={s.noise_removed_pct}
                          label="Noise removed %"
                        />
                      </td>
                      <td className="px-3 py-3 text-center">
                        <ScoreBadge
                          value={s.first_call_resolution_rate}
                          label="First-call resolution rate"
                        />
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className="text-amber-400 font-mono text-xs font-medium">
                          {s.prevention_score}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center">
                        {s.memory_verdicts_total > 0 ? (
                          <span
                            className="text-fuchsia-400 font-mono text-xs font-medium"
                            title={`${s.memory_verdicts_total} verdict${
                              s.memory_verdicts_total === 1 ? "" : "s"
                            } from ${s.memory_signals_fired} signals`}
                          >
                            {s.memory_effectiveness_pct}%
                          </span>
                        ) : s.memory_signals_fired > 0 ? (
                          <span
                            className="t-tertiary font-mono text-xs"
                            title={`${s.memory_signals_fired} signal${
                              s.memory_signals_fired === 1 ? "" : "s"
                            } fired — verdicts pending`}
                          >
                            {s.memory_signals_fired}↻
                          </span>
                        ) : (
                          <span className="t-tertiary font-mono text-xs">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span className="text-cyan-400 font-mono text-xs">
                          ~{s.turns_saved}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span className="text-violet-400 font-mono font-medium text-sm">
                          {s.reasoning_quality_multiplier}x
                        </span>
                      </td>
                      <td className="pl-4 py-3 pr-5 text-right w-16">
                        <span className="inline-flex items-center gap-1 text-xs text-violet-400 opacity-0 group-hover:opacity-100 transition-opacity font-medium whitespace-nowrap">
                          View{" "}
                          <svg
                            aria-hidden="true"
                            className="w-3.5 h-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-2 border-t border-border-subtle">
              <Pagination
                total={sessionsTotal}
                limit={sessionLimit}
                offset={sessionOffset}
                onPageChange={setSessionOffset}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// LEVEL 1 — SESSION VIEW
// ══════════════════════════════════════════════════════════════════════

function SessionView({ sessionId }: { sessionId: string }) {
  const { url, queryKey } = useRepoApi();
  const sessionQ = useQuery({
    queryKey: queryKey(["reasoning-quality-session", sessionId]),
    queryFn: () =>
      fetchJson<SessionQualityResponse>(
        url(`/api/reasoning-quality/session?session_id=${sessionId}`)
      ),
    refetchInterval: 5_000,
  });

  if (sessionQ.isLoading) return <CardGridSkeleton n={6} />;

  const s = sessionQ.data?.data;
  if (!s) {
    return (
      <div className="el-raised rounded-lg p-8 text-center">
        <p className="t-secondary">
          No quality data for session {sessionId.slice(0, 12)}
        </p>
      </div>
    );
  }

  const trajectory = s.trajectory ?? [];

  return (
    <div className="space-y-6">
      {/* ── Session Hero KPIs ── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-7">
        <KpiCard
          label="Noise Removed"
          value={`${s.noise_removed_pct}%`}
          accent="text-emerald-400"
          hint="Percentage of unnecessary tokens stripped from context"
          subtitle="Cleaner signal for the agent"
        />
        <KpiCard
          label="Found First Try"
          value={`${s.first_call_resolution_rate}%`}
          accent="text-cyan-400"
          hint="Code lookups resolved in 1 graph call"
          subtitle="vs 3-5 grep/glob cycles"
        />
        <KpiCard
          label="Safety Score"
          value={s.prevention_score}
          accent="text-amber-400"
          hint="Warnings, convention hints, and doom spiral stops"
          subtitle="Breakages prevented"
        />
        <KpiCard
          label="Memory"
          value={
            s.memory_verdicts_total > 0
              ? `${s.memory_effectiveness_pct}%`
              : s.memory_signals_fired > 0
                ? `${s.memory_signals_fired}↻`
                : "—"
          }
          accent="text-fuchsia-400"
          hint="% of fact/convention/resume signals that were load-bearing"
          subtitle={
            s.memory_verdicts_total > 0
              ? `${s.memory_verdicts_total} verdicts resolved`
              : "Verdicts pending"
          }
        />
        <KpiCard
          label="Turns Saved"
          value={`~${fmt(s.turns_saved)}`}
          accent="text-cyan-400"
          hint="Estimated wasted turns avoided"
          subtitle="Each = a grep→read cycle skipped"
        />
        <KpiCard
          label="Attention Boost"
          value={`${s.attention_multiplier}x`}
          accent="text-emerald-400"
          hint="Estimated focus improvement from noise removal"
          subtitle="Based on attention research"
        />
        <KpiCard
          label="Quality Multiplier"
          value={`${s.reasoning_quality_multiplier}x`}
          accent="text-violet-400"
          hint="Composite: compression × precision"
          subtitle="How much smarter the agent is"
        />
      </div>

      {/* ── Session Health Trajectory ── */}
      {trajectory.length > 0 && (
        <div className="el-raised rounded-lg p-5">
          <h3 className="t-secondary text-sm font-medium mb-1">
            Session Health Over Time
          </h3>
          <p className="t-tertiary text-xs mb-3">
            Shows how context quality evolved through the session. A flat or
            rising "noise removed" line means the session stayed clean. Without
            unerr, this typically degrades as context fills up.
          </p>
          <div className="flex gap-[3px]" style={{ height: "120px" }}>
            {trajectory.slice(-60).map((pt) => {
              const heightPct = Math.max(4, pt.cumulative_noise_removed_pct);
              return (
                <div
                  key={pt.turn}
                  className="group relative flex-1 min-w-[6px] max-w-[28px] h-full flex items-end"
                >
                  <div
                    className="w-full bg-emerald-500 opacity-70 hover:opacity-100 rounded-t transition-all cursor-pointer"
                    style={{ height: `${heightPct}%` }}
                  />
                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 pointer-events-none">
                    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs whitespace-nowrap shadow-xl">
                      <div className="font-medium text-foreground">
                        Turn #{pt.turn}
                      </div>
                      <div className="text-emerald-400 mt-0.5">
                        Noise removed: {pt.cumulative_noise_removed_pct}%
                      </div>
                      <div className="t-secondary">SNR: {pt.snr}</div>
                      <div className="text-cyan-400">
                        Graph calls: {pt.graph_calls_this_turn}
                      </div>
                      {pt.context_density > 0 && (
                        <div className="t-secondary">
                          Density: {pt.context_density}/1K tok
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-1.5">
            <span className="t-tertiary text-[10px] font-mono">
              T{trajectory.length > 60 ? trajectory.length - 59 : 1}
            </span>
            <span className="t-tertiary text-[10px] font-mono">
              T{trajectory.length}
            </span>
          </div>
          <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border-subtle/50">
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />
              <span className="t-tertiary text-[10px]">
                Cumulative noise removed %
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Category Breakdowns ── */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Context Quality */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="text-emerald-400 text-xs font-medium uppercase tracking-wider mb-4">
            Context Quality
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Signal-to-Noise Ratio</span>
              <span className="text-foreground font-mono text-xs">
                {s.signal_to_noise_ratio}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Context Density</span>
              <span className="text-foreground font-mono text-xs">
                {s.context_density} entities/1K tok
              </span>
            </div>
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Entities Resolved</span>
              <span className="text-foreground font-mono text-xs">
                {fmt(s.entities_resolved)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Attention Boost</span>
              <span className="text-foreground font-mono text-xs">
                {s.attention_multiplier}x
              </span>
            </div>
          </div>
        </div>

        {/* Turn Efficiency */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="text-cyan-400 text-xs font-medium uppercase tracking-wider mb-4">
            Turn Efficiency
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Found First Try</span>
              <span className="text-foreground font-mono text-xs">
                {s.first_call_resolution_rate}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Graph Calls</span>
              <span className="text-foreground font-mono text-xs">
                {fmt(s.graph_calls)} / {fmt(s.total_tool_calls)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Turns Saved</span>
              <span className="text-cyan-400 font-mono text-xs">
                ~{fmt(s.turns_saved)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Loops Prevented</span>
              <span className="text-foreground font-mono text-xs">
                {s.exploration_loops_prevented}
              </span>
            </div>
          </div>
        </div>

        {/* Breakage Prevention */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="text-amber-400 text-xs font-medium uppercase tracking-wider mb-4">
            Breakage Prevention
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Blast Radius Warnings</span>
              <span className="text-foreground font-mono text-xs">
                {s.blast_radius_warnings}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Convention Hints</span>
              <span className="text-foreground font-mono text-xs">
                {s.convention_injections}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="t-secondary text-xs">Doom Spirals Stopped</span>
              <span
                className={`font-mono text-xs ${s.circuit_breaker_activations > 0 ? "text-red-400" : "text-foreground"}`}
              >
                {s.circuit_breaker_activations}
              </span>
            </div>
            <div className="flex justify-between pt-2 border-t border-border-subtle/50">
              <span className="t-tertiary text-xs">Safety Score</span>
              <span className="text-amber-400 font-mono text-xs font-medium">
                {s.prevention_score} pts
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── This session on the other surfaces (§8 cross-link) ── */}
      <div className="el-raised rounded-lg p-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs">
        <button
          type="button"
          className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
          onClick={() => navigateRoute("token-trace", { session: sessionId })}
        >
          See token-level detail in Token Trace →
        </button>
        <button
          type="button"
          className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
          onClick={() => navigateRoute("logbook", { session: sessionId })}
        >
          See this session in What unerr did →
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// MAIN PAGE — Router with breadcrumb
// ══════════════════════════════════════════════════════════════════════

type ViewState = { level: "global" } | { level: "session"; sessionId: string };

export function ReasoningQualityPage() {
  // URL-backed view state — `?session=` controls drill-down level, so a
  // reload or shared link lands in the same session view. Same model as
  // Token Trace for consistency.
  const sessionId = useHashQueryParam("session") || null;
  const windowParam = useHashQueryParam("window");
  const headroomWindow: HeadroomWindow =
    windowParam === "today" ||
    windowParam === "this_week" ||
    windowParam === "since_install"
      ? windowParam
      : "since_install";

  const view: ViewState = sessionId
    ? { level: "session", sessionId }
    : { level: "global" };

  const setHeadroomWindow = (w: HeadroomWindow) =>
    setHashQueryParams({ window: w });
  const goGlobal = () => setHashQueryParams({ session: null });
  const goSession = (id: string) => setHashQueryParams({ session: id });

  const crumbs: Array<{ label: string; onClick?: () => void }> = [];

  if (view.level === "session") {
    crumbs.push(
      { label: "All Sessions", onClick: goGlobal },
      { label: `Session ${view.sessionId.slice(0, 12)}` }
    );
  }

  return (
    <div>
      <HeadroomStrip
        windowSelected={headroomWindow}
        onWindowChange={setHeadroomWindow}
        sessionId={view.level === "session" ? view.sessionId : undefined}
      />

      {crumbs.length > 0 && <Breadcrumb items={crumbs} />}

      {view.level === "global" && <GlobalView onSelectSession={goSession} />}

      {view.level === "session" && <SessionView sessionId={view.sessionId} />}
    </div>
  );
}
