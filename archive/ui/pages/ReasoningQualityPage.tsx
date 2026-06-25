/**
 * Reasoning Layer — "Is your AI agent actually thinking better?"
 *
 * Grounded in the Active Cognition Reason Layer doc: unerr's value
 * isn't just token savings — it's about making the agent reason better
 * through four reinforcing pillars:
 *
 *   1. Cleaner Focus     — noise stripped → agent sees only what matters
 *   2. Found It First Try — graph intelligence → one-call code lookups
 *   3. Mistakes Prevented — blast radius, conventions, drift → risky
 *                           operations caught before they ship
 *   4. Lessons Remembered — persistent memory → past learnings shape
 *                           current decisions
 *
 * Design: decision-first (Hick's Law), max 4 hero metrics, plain
 * language (zero jargon), counterfactual framing, progressive
 * disclosure.
 */

import { DateRangeFilter } from "@/components/DateRangeFilter";
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

function qualityLabel(multiplier: number): {
  text: string;
  color: string;
  bg: string;
} {
  if (multiplier >= 5)
    return {
      text: "Exceptional",
      color: "text-emerald-400",
      bg: "bg-emerald-500/20",
    };
  if (multiplier >= 3)
    return {
      text: "Strong",
      color: "text-emerald-400",
      bg: "bg-emerald-500/20",
    };
  if (multiplier >= 2)
    return { text: "Good", color: "text-cyan-400", bg: "bg-cyan-500/20" };
  if (multiplier >= 1.5)
    return {
      text: "Improving",
      color: "text-amber-400",
      bg: "bg-amber-500/20",
    };
  return { text: "Building up", color: "text-zinc-400", bg: "bg-zinc-500/20" };
}

// ── Shared Pillar Card ───────────────────────────────────────────────

function PillarCard({
  icon,
  color,
  borderColor,
  title,
  value,
  unit,
  subtitle,
  detail,
  tooltip,
}: {
  icon: string;
  color: string;
  borderColor: string;
  title: string;
  value: string | number;
  unit?: string;
  subtitle: string;
  detail?: string;
  tooltip?: string;
}) {
  return (
    <div
      className={`el-raised rounded-lg p-5 border-t-2 ${borderColor}`}
      title={tooltip}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">{icon}</span>
        <p
          className={`${color} text-[10px] uppercase tracking-wider font-medium`}
        >
          {title}
        </p>
      </div>
      <p className={`text-3xl font-bold font-mono ${color}`}>
        {value}
        {unit && <span className="text-lg ml-0.5">{unit}</span>}
      </p>
      <p className="t-secondary text-xs mt-1.5">{subtitle}</p>
      {detail && (
        <p className="t-tertiary text-[10px] mt-1 leading-snug">{detail}</p>
      )}
    </div>
  );
}

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
        <p className="t-secondary text-lg">No reasoning data yet</p>
        <p className="t-tertiary mt-2 text-sm max-w-md mx-auto">
          This page tracks how unerr improves your agent's thinking — not just
          saving tokens, but making every remaining token count more. Data
          appears as soon as the agent starts using unerr's tools.
        </p>
      </div>
    );
  }

  const ql = qualityLabel(g.reasoning_quality_multiplier);

  return (
    <div className="space-y-6">
      {/* Date filter */}
      <div className="flex items-center justify-end gap-3 flex-wrap -mt-2">
        <DateRangeFilter
          fromTs={fromTs}
          toTs={toTs}
          onChange={(f, t) => setRange(f, t)}
        />
      </div>

      {/* ── Hero: Reasoning Quality Score ── */}
      <div className="el-raised rounded-lg p-6 border-l-4 border-violet-500/60">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-foreground font-semibold text-base">
              Is your agent reasoning better?
            </h2>
            <p className="t-tertiary text-xs mt-1 max-w-lg leading-relaxed">
              unerr doesn't just save tokens — it makes every remaining token
              count more. By feeding the right code, past learnings, and project
              conventions at exactly the right moment, your agent makes better
              decisions with less context.
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-violet-400 font-mono font-bold text-4xl">
              {g.reasoning_quality_multiplier}x
            </p>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 ${ql.bg} ${ql.color} text-[10px] font-medium mt-1`}
            >
              {ql.text}
            </span>
            <p className="t-tertiary text-[10px] mt-1">reasoning improvement</p>
          </div>
        </div>
      </div>

      {/* ── Four Pillars ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <PillarCard
          icon="🔍"
          color="text-emerald-400"
          borderColor="border-emerald-500/60"
          title="Cleaner Focus"
          value={`${g.noise_removed_pct}%`}
          subtitle="of irrelevant code removed before the agent saw it"
          detail={`The agent focused on ${fmt(g.entities_resolved)} relevant code entities instead of reading entire files`}
          tooltip={`Signal-to-noise ratio: ${g.signal_to_noise_ratio} · Context density: ${g.context_density} entities per 1K tokens · Attention boost: ${g.attention_multiplier}x`}
        />

        <PillarCard
          icon="⚡"
          color="text-cyan-400"
          borderColor="border-cyan-500/60"
          title="Found It First Try"
          value={`${g.first_call_resolution_rate}%`}
          subtitle="of code lookups resolved in a single call"
          detail={`Saved ~${fmt(g.turns_saved)} wasted turns that would have been spent searching through files`}
          tooltip={`${fmt(g.graph_calls)} graph-backed lookups out of ${fmt(g.total_tool_calls)} total tool calls · ${g.exploration_loops_prevented} search loops stopped`}
        />

        <PillarCard
          icon="🛡️"
          color="text-amber-400"
          borderColor="border-amber-500/60"
          title="Mistakes Prevented"
          value={g.prevention_score}
          subtitle="risky operations caught before they shipped"
          detail={[
            g.blast_radius_warnings > 0
              ? `${g.blast_radius_warnings} high-impact edits flagged`
              : null,
            g.convention_injections > 0
              ? `${g.convention_injections} style rules applied`
              : null,
            g.circuit_breaker_activations > 0
              ? `${g.circuit_breaker_activations} agent loops stopped`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          tooltip="Includes blast-radius warnings (risky edits with many callers), convention injections (project rules applied automatically), and circuit breaker activations (agent retry loops stopped)"
        />

        <PillarCard
          icon="🧠"
          color="text-fuchsia-400"
          borderColor="border-fuchsia-500/60"
          title="Lessons Remembered"
          value={
            g.memory_verdicts_total > 0
              ? `${g.memory_effectiveness_pct}%`
              : g.memory_signals_fired > 0
                ? `${g.memory_signals_fired}`
                : "—"
          }
          unit={
            g.memory_verdicts_total > 0
              ? ""
              : g.memory_signals_fired > 0
                ? " notes"
                : ""
          }
          subtitle={
            g.memory_verdicts_total > 0
              ? "of past learnings actually changed the agent's decisions"
              : g.memory_signals_fired > 0
                ? "past learnings surfaced — tracking impact"
                : "No past learnings surfaced yet"
          }
          detail={
            g.memory_verdicts_total > 0
              ? `${g.verdicts_acted_on + g.verdicts_reinforced + g.verdicts_caught} out of ${g.memory_verdicts_total} surfaced notes were load-bearing`
              : undefined
          }
          tooltip="Each time unerr surfaces a past note, convention, or session resume, it tracks whether the agent actually used it. Load-bearing = the note changed what the agent did."
        />
      </div>

      {/* ── How It Works (the Active Cognition story) ── */}
      <div className="el-raised rounded-lg p-5">
        <h3 className="t-secondary text-sm font-medium mb-3">
          How unerr improves reasoning
        </h3>
        <div className="grid gap-4 lg:grid-cols-3 text-xs">
          <div className="space-y-2">
            <p className="text-emerald-400 font-medium uppercase tracking-wider text-[10px]">
              1. Feeds the right code
            </p>
            <p className="t-secondary leading-relaxed">
              Instead of dumping entire files, unerr uses a live code graph to
              serve only the relevant functions, types, and callers. The agent
              sees {g.noise_removed_pct}% less noise — which research shows
              directly improves LLM attention and accuracy.
            </p>
            <div className="flex gap-4 pt-1.5 border-t border-border-subtle/50">
              <div>
                <span className="t-tertiary text-[10px]">Entities served</span>
                <p className="text-foreground font-mono text-sm">
                  {fmt(g.entities_resolved)}
                </p>
              </div>
              <div>
                <span className="t-tertiary text-[10px]">Attention boost</span>
                <p className="text-foreground font-mono text-sm">
                  {g.attention_multiplier}x
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-cyan-400 font-medium uppercase tracking-wider text-[10px]">
              2. Frees up context space
            </p>
            <p className="t-secondary leading-relaxed">
              By stripping noise and resolving lookups in one call, unerr frees
              context window space. That freed space is used for the agent's
              actual reasoning — longer chains of thought, more alternatives
              considered, better decisions.
            </p>
            <div className="flex gap-4 pt-1.5 border-t border-border-subtle/50">
              <div>
                <span className="t-tertiary text-[10px]">Graph lookups</span>
                <p className="text-foreground font-mono text-sm">
                  {fmt(g.graph_calls)}
                </p>
              </div>
              <div>
                <span className="t-tertiary text-[10px]">
                  Wasted turns prevented
                </span>
                <p className="text-foreground font-mono text-sm">
                  ~{fmt(g.turns_saved)}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-fuchsia-400 font-medium uppercase tracking-wider text-[10px]">
              3. Surfaces past learnings
            </p>
            <p className="t-secondary leading-relaxed">
              Rules you've taught, conventions detected, and decisions from past
              sessions are surfaced at the exact moment the agent needs them —
              so the agent doesn't re-derive what it already learned, and
              doesn't repeat past mistakes.
            </p>
            <div className="flex gap-4 pt-1.5 border-t border-border-subtle/50">
              <div>
                <span className="t-tertiary text-[10px]">Notes surfaced</span>
                <p className="text-foreground font-mono text-sm">
                  {fmt(g.facts_surfaced)}
                </p>
              </div>
              <div>
                <span className="t-tertiary text-[10px]">Rules applied</span>
                <p className="text-foreground font-mono text-sm">
                  {fmt(g.conventions_surfaced)}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Quality Over Time ── */}
      {(() => {
        const trend = trendQ.data?.data ?? [];
        if (trend.length < 2) return null;

        const maxNoise = Math.max(...trend.map((t) => t.noise_removed_pct), 1);
        const maxFcr = Math.max(
          ...trend.map((t) => t.first_call_resolution_rate),
          1
        );
        const maxMultiplier = Math.max(
          ...trend.map((t) => t.reasoning_quality_multiplier),
          1
        );

        return (
          <div className="el-raised rounded-lg p-5">
            <h3 className="t-secondary text-sm font-medium mb-1">
              Reasoning improvement over time
            </h3>
            <p className="t-tertiary text-xs mb-3">
              Each bar is one session. Rising bars mean the agent is getting
              better at focusing, finding code, and avoiding mistakes.
            </p>

            <div className="space-y-4">
              {/* Cleaner Focus trend */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-emerald-400 text-[10px] uppercase tracking-wider font-medium">
                    Cleaner focus
                  </span>
                  <span className="t-tertiary text-[10px]">
                    Higher = less noise
                  </span>
                </div>
                <div className="flex gap-[2px]" style={{ height: "48px" }}>
                  {trend.slice(-40).map((pt) => {
                    const heightPct =
                      maxNoise > 0
                        ? Math.max(4, (pt.noise_removed_pct / maxNoise) * 100)
                        : 4;
                    const dateLabel = new Date(pt.first_ts).toLocaleDateString(
                      [],
                      { month: "short", day: "numeric" }
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
                              {pt.noise_removed_pct}% noise removed
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Found First Try trend */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-cyan-400 text-[10px] uppercase tracking-wider font-medium">
                    Found it first try
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
                      { month: "short", day: "numeric" }
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
                              {pt.first_call_resolution_rate}% first try
                            </div>
                            <div className="t-secondary">
                              ~{pt.turns_saved} wasted turns prevented
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Reasoning Multiplier trend */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-violet-400 text-[10px] uppercase tracking-wider font-medium">
                    Overall reasoning improvement
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
                      { month: "short", day: "numeric" }
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
                              {pt.reasoning_quality_multiplier}x improvement
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
                  ).toLocaleDateString([], { month: "short", day: "numeric" })}
                </span>
                <span className="t-tertiary text-[10px]">
                  {Math.min(40, trend.length)} sessions shown
                </span>
                <span className="t-tertiary text-[10px] font-mono">
                  {new Date(
                    trend[trend.length - 1].first_ts
                  ).toLocaleDateString([], { month: "short", day: "numeric" })}
                </span>
              </div>
            )}

            {/* Legend */}
            <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-border-subtle/50">
              <div className="flex items-center gap-1.5">
                <div className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />
                <span className="t-tertiary text-[10px]">Cleaner focus</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2.5 w-2.5 rounded-sm bg-cyan-500" />
                <span className="t-tertiary text-[10px]">Found first try</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2.5 w-2.5 rounded-sm bg-violet-500" />
                <span className="t-tertiary text-[10px]">
                  Overall improvement
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Persistent Memory — what your notes actually did ── */}
      {g.memory_signals_fired > 0 && (
        <div className="el-raised rounded-lg p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
            <div>
              <h3 className="text-fuchsia-400 text-xs font-medium uppercase tracking-wider">
                Your notes in action
              </h3>
              <p className="t-tertiary text-xs mt-1 max-w-lg">
                Every time unerr surfaces a past rule, convention, or session
                note, it tracks whether the agent actually used it. Here's how
                your accumulated knowledge performed.
              </p>
            </div>
            {g.memory_verdicts_total > 0 && (
              <div className="text-right shrink-0">
                <p className="text-fuchsia-400 font-mono font-bold text-3xl">
                  {g.memory_effectiveness_pct}%
                </p>
                <p className="t-tertiary text-[10px] uppercase tracking-wider mt-0.5">
                  were load-bearing
                </p>
              </div>
            )}
          </div>

          {/* Outcome breakdown bar */}
          {g.memory_verdicts_total > 0 &&
            (() => {
              const total = g.memory_verdicts_total;
              const seg = (n: number) => (n / total) * 100;
              return (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="t-tertiary text-[10px]">
                      {total} note{total === 1 ? "" : "s"} surfaced and tracked
                    </span>
                  </div>
                  <div className="flex h-3 rounded-full overflow-hidden bg-surface-secondary">
                    {g.verdicts_reinforced > 0 && (
                      <div
                        className="bg-emerald-500"
                        style={{ width: `${seg(g.verdicts_reinforced)}%` }}
                        title={`Confirmed existing rule: ${g.verdicts_reinforced}`}
                      />
                    )}
                    {g.verdicts_acted_on > 0 && (
                      <div
                        className="bg-fuchsia-500"
                        style={{ width: `${seg(g.verdicts_acted_on)}%` }}
                        title={`Changed the agent's approach: ${g.verdicts_acted_on}`}
                      />
                    )}
                    {g.verdicts_caught > 0 && (
                      <div
                        className="bg-cyan-500"
                        style={{ width: `${seg(g.verdicts_caught)}%` }}
                        title={`Prevented a mistake: ${g.verdicts_caught}`}
                      />
                    )}
                    {g.verdicts_ignored > 0 && (
                      <div
                        className="bg-zinc-600"
                        style={{ width: `${seg(g.verdicts_ignored)}%` }}
                        title={`Not used this time: ${g.verdicts_ignored}`}
                      />
                    )}
                    {g.verdicts_corrected > 0 && (
                      <div
                        className="bg-red-500"
                        style={{ width: `${seg(g.verdicts_corrected)}%` }}
                        title={`Note was outdated and corrected: ${g.verdicts_corrected}`}
                      />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-3 mt-2 text-[10px] t-tertiary">
                    {g.verdicts_reinforced > 0 && (
                      <span>
                        <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500 mr-1" />
                        Confirmed existing rule ({g.verdicts_reinforced})
                      </span>
                    )}
                    {g.verdicts_acted_on > 0 && (
                      <span>
                        <span className="inline-block w-2 h-2 rounded-sm bg-fuchsia-500 mr-1" />
                        Changed approach ({g.verdicts_acted_on})
                      </span>
                    )}
                    {g.verdicts_caught > 0 && (
                      <span>
                        <span className="inline-block w-2 h-2 rounded-sm bg-cyan-500 mr-1" />
                        Prevented mistake ({g.verdicts_caught})
                      </span>
                    )}
                    {g.verdicts_ignored > 0 && (
                      <span>
                        <span className="inline-block w-2 h-2 rounded-sm bg-zinc-600 mr-1" />
                        Not used ({g.verdicts_ignored})
                      </span>
                    )}
                    {g.verdicts_corrected > 0 && (
                      <span>
                        <span className="inline-block w-2 h-2 rounded-sm bg-red-500 mr-1" />
                        Outdated &amp; corrected ({g.verdicts_corrected})
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}

          {/* Signal types */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 pt-3 border-t border-border-subtle/50">
            <div>
              <p className="t-tertiary text-[10px]">Rules you taught</p>
              <p className="text-foreground font-mono text-sm font-medium mt-0.5">
                {fmt(g.facts_recorded)}
              </p>
            </div>
            <div>
              <p className="t-tertiary text-[10px]">Notes recalled</p>
              <p className="text-foreground font-mono text-sm font-medium mt-0.5">
                {fmt(g.facts_recalled)}
              </p>
            </div>
            <div>
              <p className="t-tertiary text-[10px]">Conventions applied</p>
              <p className="text-foreground font-mono text-sm font-medium mt-0.5">
                {fmt(g.conventions_surfaced)}
              </p>
            </div>
            <div>
              <p className="t-tertiary text-[10px]">Sessions resumed</p>
              <p className="text-foreground font-mono text-sm font-medium mt-0.5">
                {fmt(g.resume_hits)}
              </p>
            </div>
            <div>
              <p className="t-tertiary text-[10px]">Anti-patterns warned</p>
              <p className="text-foreground font-mono text-sm font-medium mt-0.5">
                {fmt(g.negative_warnings)}
              </p>
            </div>
            <div>
              <p className="t-tertiary text-[10px]">Total notes surfaced</p>
              <p className="text-foreground font-mono text-sm font-medium mt-0.5">
                {fmt(g.facts_surfaced)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Session List ── */}
      <div className="el-raised rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
          <h3 className="t-secondary text-sm font-medium">Sessions</h3>
          <span className="t-tertiary text-xs">
            {sessionsTotal} session{sessionsTotal !== 1 ? "s" : ""}
          </span>
        </div>

        {sessions.length === 0 ? (
          <p className="px-5 py-6 t-secondary text-sm">No sessions yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm min-w-[800px]">
                <thead>
                  <tr className="border-b border-border-subtle t-tertiary text-xs uppercase">
                    <th className="px-5 py-2.5 font-medium">Session</th>
                    <th className="px-3 py-2.5 font-medium">Agent</th>
                    <th className="px-3 py-2.5 font-medium">Last Active</th>
                    <th
                      className="px-3 py-2.5 font-medium text-center"
                      title="% of noise removed from context"
                    >
                      Focus
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-center"
                      title="% of lookups resolved in one call"
                    >
                      First Try
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-center"
                      title="Risky operations caught"
                    >
                      Safety
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-center"
                      title="% of surfaced notes that changed the outcome"
                    >
                      Memory
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-right"
                      title="Wasted turns avoided"
                    >
                      Saved
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-right"
                      title="Overall reasoning improvement"
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
                          label="Noise removed"
                        />
                      </td>
                      <td className="px-3 py-3 text-center">
                        <ScoreBadge
                          value={s.first_call_resolution_rate}
                          label="First-try resolution"
                        />
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className="text-amber-400 font-mono text-xs font-medium">
                          {s.prevention_score}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center">
                        {s.memory_verdicts_total > 0 ? (
                          <span className="text-fuchsia-400 font-mono text-xs font-medium">
                            {s.memory_effectiveness_pct}%
                          </span>
                        ) : s.memory_signals_fired > 0 ? (
                          <span className="t-tertiary font-mono text-xs">
                            {s.memory_signals_fired} notes
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
          No data for session {sessionId.slice(0, 12)}
        </p>
      </div>
    );
  }

  const trajectory = s.trajectory ?? [];
  const ql = qualityLabel(s.reasoning_quality_multiplier);

  return (
    <div className="space-y-6">
      {/* ── Session Hero ── */}
      <div className="el-raised rounded-lg p-5 border-l-4 border-violet-500/40">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-foreground text-sm font-medium">
              Session reasoning quality
            </h3>
            <p className="t-tertiary text-xs mt-1">
              How well the agent reasoned across {s.total_turns} turn
              {s.total_turns === 1 ? "" : "s"} in this session.
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-violet-400 font-mono font-bold text-3xl">
              {s.reasoning_quality_multiplier}x
            </p>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 ${ql.bg} ${ql.color} text-[10px] font-medium mt-1`}
            >
              {ql.text}
            </span>
          </div>
        </div>
      </div>

      {/* ── Four Pillars ── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <PillarCard
          icon="🔍"
          color="text-emerald-400"
          borderColor="border-emerald-500/60"
          title="Cleaner Focus"
          value={`${s.noise_removed_pct}%`}
          subtitle="noise removed"
          detail={`${fmt(s.entities_resolved)} entities served · ${s.attention_multiplier}x attention boost`}
        />
        <PillarCard
          icon="⚡"
          color="text-cyan-400"
          borderColor="border-cyan-500/60"
          title="Found First Try"
          value={`${s.first_call_resolution_rate}%`}
          subtitle="one-call resolution"
          detail={`~${fmt(s.turns_saved)} wasted turns prevented`}
        />
        <PillarCard
          icon="🛡️"
          color="text-amber-400"
          borderColor="border-amber-500/60"
          title="Mistakes Prevented"
          value={s.prevention_score}
          subtitle="risky operations caught"
          detail={[
            s.blast_radius_warnings > 0
              ? `${s.blast_radius_warnings} high-impact edits flagged`
              : null,
            s.convention_injections > 0
              ? `${s.convention_injections} style rules applied`
              : null,
            s.circuit_breaker_activations > 0
              ? `${s.circuit_breaker_activations} loops stopped`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        <PillarCard
          icon="🧠"
          color="text-fuchsia-400"
          borderColor="border-fuchsia-500/60"
          title="Lessons Remembered"
          value={
            s.memory_verdicts_total > 0
              ? `${s.memory_effectiveness_pct}%`
              : s.memory_signals_fired > 0
                ? `${s.memory_signals_fired}`
                : "—"
          }
          unit={
            s.memory_verdicts_total > 0
              ? ""
              : s.memory_signals_fired > 0
                ? " notes"
                : ""
          }
          subtitle={
            s.memory_verdicts_total > 0
              ? "load-bearing"
              : s.memory_signals_fired > 0
                ? "notes surfaced"
                : "No notes surfaced"
          }
        />
      </div>

      {/* ── Session Health Over Time ── */}
      {trajectory.length > 0 && (
        <div className="el-raised rounded-lg p-5">
          <h3 className="t-secondary text-sm font-medium mb-1">
            How context quality changed through the session
          </h3>
          <p className="t-tertiary text-xs mb-3">
            Each bar is one turn. Without unerr, this line typically drops as
            context fills up — a rising or flat line means the session stayed
            clean.
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
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 pointer-events-none">
                    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs whitespace-nowrap shadow-xl">
                      <div className="font-medium text-foreground">
                        Turn #{pt.turn}
                      </div>
                      <div className="text-emerald-400 mt-0.5">
                        {pt.cumulative_noise_removed_pct}% noise removed
                      </div>
                      <div className="text-cyan-400">
                        {pt.graph_calls_this_turn} graph lookup
                        {pt.graph_calls_this_turn !== 1 ? "s" : ""}
                      </div>
                      {pt.context_density > 0 && (
                        <div className="t-secondary">
                          {pt.context_density} entities per 1K tokens
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
              Turn {trajectory.length > 60 ? trajectory.length - 59 : 1}
            </span>
            <span className="t-tertiary text-[10px] font-mono">
              Turn {trajectory.length}
            </span>
          </div>
          <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border-subtle/50">
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />
              <span className="t-tertiary text-[10px]">
                Cumulative noise removed
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Detailed Breakdowns ── */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Cleaner Focus details */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="text-emerald-400 text-xs font-medium uppercase tracking-wider mb-4">
            Focus details
          </h3>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between items-baseline">
                <span className="t-secondary text-xs">Noise removed</span>
                <span className="text-foreground font-mono text-sm font-medium">
                  {s.noise_removed_pct}%
                </span>
              </div>
              <div className="mt-1.5 h-2 bg-surface-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all"
                  style={{ width: `${Math.max(3, s.noise_removed_pct)}%` }}
                />
              </div>
            </div>
            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="How many relevant code entities per 1K tokens delivered"
              >
                Information density
              </span>
              <span className="text-foreground font-mono text-sm font-medium">
                {s.context_density}
              </span>
            </div>
            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Estimated improvement in LLM attention from noise removal"
              >
                Attention improvement
              </span>
              <span className="text-foreground font-mono text-sm font-medium">
                {s.attention_multiplier}x
              </span>
            </div>
            <div className="pt-2 border-t border-border-subtle/50 space-y-1">
              <div className="flex justify-between items-baseline">
                <span className="t-tertiary text-xs">Code entities served</span>
                <span className="t-secondary font-mono text-xs">
                  {fmt(s.entities_resolved)}
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="t-tertiary text-xs">Tokens via graph</span>
                <span className="t-secondary font-mono text-xs">
                  {fmt(s.graph_tokens_delivered)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Found First Try details */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="text-cyan-400 text-xs font-medium uppercase tracking-wider mb-4">
            Efficiency details
          </h3>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between items-baseline">
                <span className="t-secondary text-xs">One-call resolution</span>
                <span className="text-foreground font-mono text-sm font-medium">
                  {s.first_call_resolution_rate}%
                </span>
              </div>
              <div className="mt-1.5 h-2 bg-surface-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan-500 rounded-full transition-all"
                  style={{
                    width: `${Math.max(3, s.first_call_resolution_rate)}%`,
                  }}
                />
              </div>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="t-secondary text-xs">
                Wasted turns prevented
              </span>
              <span className="text-cyan-400 font-mono text-sm font-medium">
                ~{fmt(s.turns_saved)}
              </span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="t-secondary text-xs">Search loops stopped</span>
              <span className="text-foreground font-mono text-sm font-medium">
                {s.exploration_loops_prevented}
              </span>
            </div>
            <div className="pt-2 border-t border-border-subtle/50 space-y-1">
              <div className="flex justify-between items-baseline">
                <span className="t-tertiary text-xs">Graph lookups</span>
                <span className="t-secondary font-mono text-xs">
                  {fmt(s.graph_calls)}
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="t-tertiary text-xs">Total tool calls</span>
                <span className="t-secondary font-mono text-xs">
                  {fmt(s.total_tool_calls)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Mistakes Prevented details */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="text-amber-400 text-xs font-medium uppercase tracking-wider mb-4">
            Safety details
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="High-impact edits where unerr showed all callers before the change"
              >
                High-impact edits flagged
              </span>
              <span className="text-foreground font-mono text-sm font-medium">
                {s.blast_radius_warnings}
              </span>
            </div>
            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Project conventions automatically applied to prevent style violations"
              >
                Style rules applied
              </span>
              <span className="text-foreground font-mono text-sm font-medium">
                {s.convention_injections}
              </span>
            </div>
            <div className="flex justify-between items-baseline">
              <span
                className="t-secondary text-xs"
                title="Agent was stuck in a retry loop — unerr broke it"
              >
                Agent loops stopped
              </span>
              <span
                className={`font-mono text-sm font-medium ${s.circuit_breaker_activations > 0 ? "text-red-400" : "text-foreground"}`}
              >
                {s.circuit_breaker_activations}
              </span>
            </div>
            <div className="flex justify-between pt-2 border-t border-border-subtle/50">
              <span className="t-tertiary text-xs">Total safety score</span>
              <span className="text-amber-400 font-mono text-xs font-medium">
                {s.prevention_score}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Cross-links ── */}
      <div className="el-raised rounded-lg p-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs">
        <button
          type="button"
          className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
          onClick={() => navigateRoute("token-trace", { session: sessionId })}
        >
          See token savings in Token Trace →
        </button>
        <button
          type="button"
          className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
          onClick={() => navigateRoute("logbook", { session: sessionId })}
        >
          See full activity log →
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════

type ViewState = { level: "global" } | { level: "session"; sessionId: string };

export function ReasoningQualityPage() {
  const sessionId = useHashQueryParam("session") || null;

  const view: ViewState = sessionId
    ? { level: "session", sessionId }
    : { level: "global" };

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
      {crumbs.length > 0 && <Breadcrumb items={crumbs} />}

      {view.level === "global" && <GlobalView onSelectSession={goSession} />}

      {view.level === "session" && <SessionView sessionId={view.sessionId} />}
    </div>
  );
}
