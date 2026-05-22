import { HealthMapView } from "@/components/HealthMapView";
import { CardGridSkeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { navigateRoute } from "@/lib/router";
import type {
  Bottleneck,
  CommunityHealth,
  EfficiencyResponse,
  GraphStatsResponse,
  InsightCard,
  InsightsResponse,
  IntentsResponse,
  ReadingTourResponse,
  ReadingTourStop,
  RiskHotspot,
  RiskHotspotsResponse,
} from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/* ── Constants ─────────────────────────────────────────────────────────── */

const RISK_BG: Record<string, string> = {
  critical: "bg-red-500/15 text-red-400 border-red-500/20",
  high: "bg-red-500/15 text-red-400 border-red-500/20",
  medium: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  low: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
};
const RISK_DOT: Record<string, string> = {
  critical: "bg-red-400",
  high: "bg-red-400",
  medium: "bg-amber-400",
  low: "bg-emerald-400",
};
const RISK_COLOR: Record<string, string> = {
  critical: "text-red-400",
  high: "text-red-400",
  medium: "text-amber-400",
  low: "text-emerald-400",
};

const SEVERITY_STYLE: Record<
  string,
  { border: string; bg: string; icon: string; iconColor: string }
> = {
  critical: {
    border: "border-red-500/30",
    bg: "bg-red-500/5",
    icon: "!!",
    iconColor: "text-red-400 bg-red-500/20",
  },
  warning: {
    border: "border-amber-500/30",
    bg: "bg-amber-500/5",
    icon: "!",
    iconColor: "text-amber-400 bg-amber-500/20",
  },
  info: {
    border: "border-blue-500/30",
    bg: "bg-blue-500/5",
    icon: "i",
    iconColor: "text-blue-400 bg-blue-500/20",
  },
  positive: {
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/5",
    icon: "\u2713",
    iconColor: "text-emerald-400 bg-emerald-500/20",
  },
};

const GRADE_COLOR: Record<string, string> = {
  A: "text-emerald-400",
  B: "text-emerald-400",
  C: "text-amber-400",
  D: "text-red-400",
  F: "text-red-400",
};

/* ── Helpers ───────────────────────────────────────────────────────────── */

function riskScore(h: RiskHotspot): number {
  const riskWeight =
    h.risk_level === "high" ? 3 : h.risk_level === "medium" ? 2 : 1;
  const testPenalty = h.test_count === 0 ? 2 : 1;
  return h.degree * riskWeight * testPenalty;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function pct(n: number): string {
  return `${n}%`;
}

/* ── Micro-components ──────────────────────────────────────────────────── */

function RiskBadge({ level }: { level: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${RISK_BG[level] ?? RISK_BG.low}`}
    >
      <span
        className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${RISK_DOT[level] ?? RISK_DOT.low}`}
      />
      {level}
    </span>
  );
}

function TestIndicator({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-400/80">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400/60" />
        untested
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400/80">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400/60" />
      {count} test{count !== 1 ? "s" : ""}
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * SECTION 1: Health Score Hero
 * ═══════════════════════════════════════════════════════════════════════ */

function HealthScoreHero({
  insights,
  stats,
  isLoading,
}: {
  insights: InsightsResponse["data"];
  stats: GraphStatsResponse["data"];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <CardGridSkeleton n={4} />
      </div>
    );
  }

  if (!insights || !stats) {
    return (
      <div className="glass-panel rounded-xl px-6 py-8 text-center">
        <p className="t-secondary text-sm">
          Graph not loaded yet &mdash; start the proxy or wait for indexing.
        </p>
      </div>
    );
  }

  const grade = insights.healthGrade;
  const score = insights.healthScore;
  const brCov = insights.blastRadiusCoverage;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      {/* Score ring */}
      <div className="glass-panel rounded-xl flex flex-col items-center justify-center py-6 px-4 gap-2">
        <div className="relative flex items-center justify-center">
          <svg aria-hidden="true" viewBox="0 0 120 120" className="h-28 w-28">
            <circle
              cx="60"
              cy="60"
              r="52"
              fill="none"
              stroke="currentColor"
              strokeWidth="8"
              className="text-surface-overlay"
            />
            <circle
              cx="60"
              cy="60"
              r="52"
              fill="none"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${(score / 100) * 327} 327`}
              transform="rotate(-90 60 60)"
              className={
                score >= 80
                  ? "text-emerald-400"
                  : score >= 50
                    ? "text-amber-400"
                    : "text-red-400"
              }
              style={{ transition: "stroke-dasharray 0.6s ease" }}
            />
          </svg>
          <div className="absolute flex flex-col items-center">
            <span
              className={`text-3xl font-bold ${GRADE_COLOR[grade] ?? "text-foreground"}`}
            >
              {grade}
            </span>
            <span className="text-xs t-tertiary font-mono">{score}/100</span>
          </div>
        </div>
        <span className="text-xs t-tertiary">Codebase Health</span>
      </div>

      {/* Right column: primary metrics + advanced disclosure */}
      <div className="flex flex-col gap-3">
        {/* Primary metrics — the three signals every user should grok at a glance */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MetricTile
            label="Tested Reach"
            value={pct(brCov)}
            hint="% of your code's dependency reach that has tests guarding it."
            accent={brCov >= 75 ? "emerald" : brCov >= 50 ? "amber" : "red"}
          />
          <MetricTile
            label="Chokepoints"
            value={String(insights.bottlenecks.length)}
            hint="High-traffic files with no tests — break one, break many."
            accent={insights.bottlenecks.length > 0 ? "red" : "emerald"}
          />
          <MetricTile
            label="Risk Concentrated In Top 5"
            value={pct(insights.riskConcentration)}
            hint="Higher = more fragile codebase (few files carry most risk)."
            accent={
              insights.riskConcentration > 60
                ? "red"
                : insights.riskConcentration > 40
                  ? "amber"
                  : "emerald"
            }
          />
        </div>

        {/* Advanced metrics — hidden by default to avoid number-soup */}
        <details className="group rounded-xl border border-border-subtle bg-sidebar/40 px-4 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
            Advanced metrics ({fmtNum(stats.entityCount)} entities ·{" "}
            {stats.communityCount} modules)
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <MetricTile
              label="High-Risk Files"
              value={String(insights.riskDistribution.high)}
              sub={`of ${insights.riskDistribution.high + insights.riskDistribution.medium + insights.riskDistribution.low} analyzed`}
              hint="Files with high blast radius and weak test coverage."
              accent={insights.riskDistribution.high > 0 ? "red" : "emerald"}
            />
            <MetricTile
              label="Untested Reach"
              value={fmtNum(insights.untestedBlastRadius)}
              sub={`of ${fmtNum(insights.totalBlastRadius)} total`}
              hint="Dependency edges that no test currently exercises."
              accent={
                insights.untestedBlastRadius > insights.testedBlastRadius
                  ? "red"
                  : "emerald"
              }
            />
            <MetricTile
              label="Modules"
              value={String(stats.communityCount)}
              sub={`${fmtNum(stats.fileCount)} files`}
              hint="Clusters of files that change together (auto-detected)."
            />
            {insights.mostCoupledPair ? (
              <MetricTile
                label="Tightest Co-Change Pair"
                value={String(insights.mostCoupledPair.weight)}
                sub={`${insights.mostCoupledPair.from.slice(0, 16)}…`}
                hint="Two files edited together this many times — likely coupled."
                accent={
                  insights.mostCoupledPair.weight >= 10 ? "amber" : undefined
                }
              />
            ) : (
              <MetricTile
                label="Drift"
                value={fmtNum(stats.driftCount)}
                sub={stats.driftCount > 0 ? "entities drifted" : "clean"}
                hint="Entities modified since the graph was last indexed."
              />
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  sub,
  hint,
  accent,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  accent?: "emerald" | "amber" | "red";
  onClick?: () => void;
}) {
  const valColor =
    accent === "emerald"
      ? "text-emerald-400"
      : accent === "red"
        ? "text-red-400"
        : accent === "amber"
          ? "text-amber-400"
          : "text-foreground-emphasis";
  const interactive = onClick
    ? "cursor-pointer hover:el-raised transition-colors text-left"
    : "";
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`glass-panel rounded-xl px-4 py-3 w-full ${interactive}`}
      title={hint}
    >
      <div className="t-tertiary text-[10px] uppercase tracking-wider">
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold font-mono ${valColor}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 t-tertiary text-[10px]">{sub}</div>}
      {hint && (
        <div className="mt-1 text-[10px] text-muted-foreground leading-snug">
          {hint}
        </div>
      )}
    </Tag>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * SECTION 2: "What You Don't Know" Insight Cards
 * ═══════════════════════════════════════════════════════════════════════ */

const INSIGHT_CTA: Record<
  string,
  { label: string; action: "scroll" | "route"; target: string } | null
> = {
  "blast-radius-coverage": {
    label: "View hotspots",
    action: "scroll",
    target: "section-risk-hotspots",
  },
  bottlenecks: {
    label: "View bottlenecks",
    action: "scroll",
    target: "section-risk-hotspots",
  },
  "risk-concentration": {
    label: "View top 5",
    action: "scroll",
    target: "section-risk-hotspots",
  },
  "coupling-hotspot": {
    label: "View module graph",
    action: "route",
    target: "visual",
  },
  "no-high-risk": null,
};

function InsightCardsSection({ cards }: { cards: InsightCard[] }) {
  if (cards.length === 0) return null;

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="section-label text-violet-500">
          What needs your attention
        </h2>
        <span className="t-tertiary text-xs">
          ranked findings your IDE can't surface — start here
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const style = SEVERITY_STYLE[card.severity] ?? SEVERITY_STYLE.info;
          const cta = INSIGHT_CTA[card.id] ?? null;
          return (
            <div
              key={card.id}
              className={`rounded-xl border ${style.border} ${style.bg} p-4 transition-colors flex flex-col`}
            >
              <div className="flex items-start gap-3 flex-1">
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold ${style.iconColor}`}
                >
                  {style.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium text-foreground-emphasis leading-snug">
                    {card.title}
                  </h3>
                  <p className="mt-1.5 text-xs t-secondary leading-relaxed">
                    {card.description}
                  </p>
                  {card.metric !== undefined && card.metricLabel && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-foreground-emphasis">
                        {card.metric}
                      </span>
                      <span className="t-tertiary text-[10px] uppercase tracking-wider">
                        {card.metricLabel}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              {cta && (
                <div className="mt-3 pt-3 border-t border-border-subtle/40">
                  <button
                    type="button"
                    onClick={() =>
                      cta.action === "scroll"
                        ? scrollTo(cta.target)
                        : navigateRoute(cta.target as never)
                    }
                    className="text-xs text-violet-400 hover:text-violet-300 transition-colors font-medium"
                  >
                    {cta.label} →
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * SECTION 3: Risk Hotspots — Top 3 Hero Cards + Compact List
 * ═══════════════════════════════════════════════════════════════════════ */

function RiskHotspotsSection({
  hotspots,
  bottlenecks,
  isLoading,
  isError,
}: {
  hotspots: RiskHotspot[];
  bottlenecks: Bottleneck[];
  isLoading: boolean;
  isError: boolean;
}) {
  const top3 = hotspots.slice(0, 3);
  const rest = hotspots.slice(3);
  const bottleneckKeys = new Set(bottlenecks.map((b) => b.key));

  const openInVisual = (key: string) => {
    window.location.hash = `#/visual?entity=${encodeURIComponent(key)}`;
  };

  return (
    <section id="section-risk-hotspots">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="section-label text-violet-500">Risk Hotspots</h2>
          <span className="t-tertiary text-xs">
            files where a small change can cascade — fix these first
          </span>
        </div>
        <button
          type="button"
          onClick={() => navigateRoute("visual")}
          className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
        >
          View map &rarr;
        </button>
      </div>

      {isLoading ? (
        <TableSkeleton cols={4} rows={6} />
      ) : isError ? (
        <div className="glass-panel rounded-xl px-4 py-6">
          <p className="text-error text-sm">
            Could not load risk data &mdash; graph may still be indexing.
          </p>
        </div>
      ) : hotspots.length === 0 ? (
        <div className="glass-panel rounded-xl px-4 py-6 text-center">
          <p className="t-secondary text-sm">No entities indexed yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Top 3 hero cards */}
          <div className="grid gap-3 sm:grid-cols-3">
            {top3.map((h, i) => {
              const isBottleneck = bottleneckKeys.has(h.key);
              return (
                <button
                  type="button"
                  key={h.key}
                  onClick={() => openInVisual(h.key)}
                  className="glass-panel rounded-xl p-4 text-left w-full cursor-pointer hover:el-raised transition-all"
                  aria-label={`Open ${h.name} in graph visualizer`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-medium t-tertiary uppercase tracking-wider">
                      #{i + 1} highest risk
                    </span>
                    <RiskBadge level={h.risk_level} />
                  </div>
                  <div className="font-mono text-sm font-medium text-foreground-emphasis truncate">
                    {h.name}
                  </div>
                  <div className="mt-1 text-[10px] t-tertiary truncate">
                    {h.file_path}
                  </div>
                  <div
                    className="mt-3 flex items-center gap-3 text-xs"
                    title={`Called by ${h.fan_in} places · calls ${h.fan_out} things`}
                  >
                    <div className="font-mono">
                      <span className="t-tertiary">called by </span>
                      <span
                        className={
                          RISK_COLOR[h.risk_level] ?? "text-foreground"
                        }
                      >
                        {h.fan_in}
                      </span>
                    </div>
                    <div className="font-mono">
                      <span className="t-tertiary">calls </span>
                      <span className="text-foreground">{h.fan_out}</span>
                    </div>
                    <TestIndicator count={h.test_count} />
                  </div>
                  {isBottleneck && (
                    <div className="mt-2 rounded-md bg-red-500/10 px-2 py-1 text-[10px] text-red-400 font-medium">
                      Structural bottleneck
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Compact list for the rest */}
          {rest.length > 0 && (
            <div className="glass-panel rounded-xl overflow-hidden">
              <div className="custom-scrollbar max-h-[320px] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface-overlay/95 backdrop-blur-sm">
                    <tr className="border-b border-border-subtle t-tertiary text-left">
                      <th className="py-2 pl-4 pr-2 font-medium">Entity</th>
                      <th className="py-2 px-2 font-medium">Kind</th>
                      <th
                        className="py-2 px-2 font-medium text-right"
                        title="Number of places that depend on this entity"
                      >
                        Called By
                      </th>
                      <th
                        className="py-2 px-2 font-medium text-right"
                        title="Number of things this entity uses"
                      >
                        Calls
                      </th>
                      <th className="py-2 px-2 font-medium">Risk</th>
                      <th className="py-2 px-2 font-medium">Tests</th>
                      <th className="py-2 px-2 pr-4 font-medium">Module</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {rest.map((h) => (
                      <tr
                        key={h.key}
                        onClick={() => openInVisual(h.key)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openInVisual(h.key);
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-label={`Open ${h.name} in graph visualizer`}
                        className="transition-colors hover:el-raised cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-500"
                      >
                        <td className="py-2 pl-4 pr-2">
                          <div className="font-mono text-foreground-emphasis truncate max-w-[180px]">
                            {h.name}
                          </div>
                          <div className="t-tertiary truncate max-w-[180px]">
                            {h.file_path}
                          </div>
                        </td>
                        <td className="py-2 px-2">
                          <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] t-tertiary">
                            {h.kind}
                          </span>
                        </td>
                        <td
                          className={`py-2 px-2 text-right font-mono ${RISK_COLOR[h.risk_level] ?? ""}`}
                        >
                          {h.fan_in}
                        </td>
                        <td className="py-2 px-2 text-right font-mono">
                          {h.fan_out}
                        </td>
                        <td className="py-2 px-2">
                          <RiskBadge level={h.risk_level} />
                        </td>
                        <td className="py-2 px-2">
                          <TestIndicator count={h.test_count} />
                        </td>
                        <td className="py-2 px-2 pr-4">
                          <span className="text-violet-400/60 truncate max-w-[100px] inline-block">
                            {h.community_label || "\u2014"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * SECTION 4: Module Health Grid
 * ═══════════════════════════════════════════════════════════════════════ */

function ModuleHealthGrid({
  communities,
  onSelectModule,
}: {
  communities: CommunityHealth[];
  onSelectModule: (label: string) => void;
}) {
  if (communities.length === 0) return null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="section-label text-violet-500">Module Health</h2>
        <span className="t-tertiary text-xs">
          which parts of the codebase are well-tested vs. exposed
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {communities.map((c) => {
          const brColor =
            c.blastRadiusCoveragePct >= 75
              ? "text-emerald-400"
              : c.blastRadiusCoveragePct >= 50
                ? "text-amber-400"
                : "text-red-400";
          const barColor =
            c.blastRadiusCoveragePct >= 75
              ? "bg-emerald-400"
              : c.blastRadiusCoveragePct >= 50
                ? "bg-amber-400"
                : "bg-red-400";

          return (
            <button
              type="button"
              key={c.label}
              onClick={() => onSelectModule(c.label)}
              className="glass-panel rounded-xl p-4 text-left w-full cursor-pointer hover:el-raised transition-all"
              aria-label={`Open ${c.label} in File Health Map`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-foreground-emphasis truncate max-w-[160px]">
                  {c.label}
                </span>
                <span className={`font-mono text-sm font-semibold ${brColor}`}>
                  {c.blastRadiusCoveragePct}%
                </span>
              </div>

              {/* Progress bar */}
              <div className="h-1.5 rounded-full bg-surface-overlay overflow-hidden mb-3">
                <div
                  className={`h-full rounded-full ${barColor} transition-all duration-500`}
                  style={{ width: `${c.blastRadiusCoveragePct}%` }}
                />
              </div>

              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div>
                  <div className="t-tertiary">Entities</div>
                  <div className="font-mono text-foreground-emphasis">
                    {c.entities}
                  </div>
                </div>
                <div>
                  <div className="t-tertiary">Tested</div>
                  <div className="font-mono text-emerald-400">{c.tested}</div>
                </div>
                <div>
                  <div className="t-tertiary">Untested</div>
                  <div
                    className={`font-mono ${c.untested > 0 ? "text-red-400" : "text-emerald-400"}`}
                  >
                    {c.untested}
                  </div>
                </div>
              </div>

              {/* Risk pills */}
              {(c.riskHigh > 0 || c.riskMedium > 0) && (
                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                  {c.riskHigh > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
                      <span className="h-1 w-1 rounded-full bg-red-400" />
                      {c.riskHigh} high
                    </span>
                  )}
                  {c.riskMedium > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
                      <span className="h-1 w-1 rounded-full bg-amber-400" />
                      {c.riskMedium} med
                    </span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * SECTION 5: Search + Entity Detail
 * ═══════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════
 * Main Page
 * ═══════════════════════════════════════════════════════════════════════ */

type CodeIntelTab = "overview" | "file-health";

function parseTabFromHash(): CodeIntelTab {
  if (typeof window === "undefined") return "overview";
  const raw = window.location.hash.replace(/^#/, "").trim();
  const segs = raw.split("/").filter(Boolean);
  return segs[1] === "file-health" ? "file-health" : "overview";
}

function writeTabToHash(next: CodeIntelTab): void {
  const target = next === "file-health" ? "#/graph/file-health" : "#/graph";
  if (window.location.hash !== target) {
    window.history.replaceState(null, "", target);
  }
}

export function GraphExplorer() {
  const [tab, setTabState] = useState<CodeIntelTab>(() => parseTabFromHash());
  const [healthMapInitialFilter, setHealthMapInitialFilter] = useState<
    string | undefined
  >(undefined);

  const setTab = (next: CodeIntelTab) => {
    setTabState(next);
    writeTabToHash(next);
  };

  const openModuleInHealthMap = (label: string) => {
    setHealthMapInitialFilter(label);
    setTab("file-health");
  };

  useEffect(() => {
    const onHash = () => setTabState(parseTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const { url, queryKey } = useRepoApi();

  /* ── Data queries ────────────────────────────────────────────────── */

  const statsQ = useQuery({
    queryKey: queryKey(["intelligence", "graph-stats"]),
    queryFn: () =>
      fetchJson<GraphStatsResponse>(url("/api/intelligence/graph-stats")),
    enabled: tab === "overview",
  });

  const insightsQ = useQuery({
    queryKey: queryKey(["intelligence", "insights"]),
    queryFn: () =>
      fetchJson<InsightsResponse>(url("/api/intelligence/insights")),
    enabled: tab === "overview",
  });

  const hotspotsQ = useQuery({
    queryKey: queryKey(["intelligence", "risk-hotspots"]),
    queryFn: () =>
      fetchJson<RiskHotspotsResponse>(
        url("/api/intelligence/risk-hotspots?limit=25")
      ),
    enabled: tab === "overview",
  });

  // R1: Now strip — session efficiency + active intents
  const efficiencyQ = useQuery({
    queryKey: queryKey(["session", "efficiency"]),
    queryFn: () =>
      fetchJson<EfficiencyResponse>(url("/api/session/efficiency")),
    enabled: tab === "overview",
    staleTime: 10_000,
  });

  const intentsQ = useQuery({
    queryKey: queryKey(["session", "intents"]),
    queryFn: () => fetchJson<IntentsResponse>(url("/api/session/intents")),
    enabled: tab === "overview",
    staleTime: 10_000,
  });

  // R2: Reading Tour — top backbone files for unfamiliar repos
  const tourQ = useQuery({
    queryKey: queryKey(["intelligence", "reading-tour"]),
    queryFn: () =>
      fetchJson<ReadingTourResponse>(
        url("/api/intelligence/reading-tour?limit=5")
      ),
    enabled: tab === "overview",
    staleTime: 5 * 60_000,
  });

  const tour = tourQ.data?.data;
  const showReadingTour =
    !!tour &&
    tour.stops.length >= 3 &&
    (efficiencyQ.data?.data?.totalCalls ?? 0) === 0 &&
    (intentsQ.data?.data?.length ?? 0) === 0;

  const insights = insightsQ.data?.data;
  const hotspots = (hotspotsQ.data?.data ?? []).sort(
    (a, b) => riskScore(b) - riskScore(a)
  );

  return (
    <div className="space-y-6">
      {/* Tab switcher */}
      <div
        className="inline-flex rounded-lg border border-border-subtle bg-sidebar p-1"
        role="tablist"
        aria-label="Code Intelligence view"
      >
        <TabButton
          active={tab === "overview"}
          onClick={() => setTab("overview")}
        >
          Overview
        </TabButton>
        <TabButton
          active={tab === "file-health"}
          onClick={() => setTab("file-health")}
        >
          File Health Map
        </TabButton>
      </div>

      {tab === "overview" ? (
        <div className="space-y-8">
          {/* Now strip — session-aware context */}
          <NowStrip
            efficiency={efficiencyQ.data?.data ?? null}
            intents={intentsQ.data?.data ?? null}
            hotspots={hotspots}
          />

          {/* Reading Tour — only on fresh repos with no session history */}
          {showReadingTour && tour && (
            <ReadingTourCard
              stops={tour.stops}
              estimatedReadingTimeMin={tour.estimatedReadingTimeMin}
            />
          )}

          {/* LEAD: What needs your attention — graph-derived insights first */}
          {insights && <InsightCardsSection cards={insights.insights} />}

          {/* Risk Hotspots — the files most likely to break things */}
          <RiskHotspotsSection
            hotspots={hotspots}
            bottlenecks={insights?.bottlenecks ?? []}
            isLoading={hotspotsQ.isLoading}
            isError={hotspotsQ.isError}
          />

          {/* Health Hero — at-a-glance score + secondary metrics */}
          <HealthScoreHero
            insights={insights ?? null}
            stats={statsQ.data?.data ?? null}
            isLoading={statsQ.isLoading || insightsQ.isLoading}
          />

          {/* Module Health Grid — drill-down by area of the codebase */}
          {insights && (
            <ModuleHealthGrid
              communities={insights.communityHealth}
              onSelectModule={openModuleInHealthMap}
            />
          )}
        </div>
      ) : (
        <HealthMapView initialFilter={healthMapInitialFilter} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
        active
          ? "el-raised font-medium text-foreground-emphasis"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * R2: Reading Tour — cold-repo onboarding card
 * ═══════════════════════════════════════════════════════════════════════ */

function ReadingTourCard({
  stops,
  estimatedReadingTimeMin,
}: {
  stops: ReadingTourStop[];
  estimatedReadingTimeMin: number;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const active = stops[activeIdx];

  const openInVisual = (key: string) => {
    window.location.hash = `#/visual?entity=${encodeURIComponent(key)}`;
  };

  return (
    <section
      aria-label="Reading tour"
      className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-5"
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium text-violet-300 uppercase tracking-wider">
              New to this codebase?
            </span>
          </div>
          <h2 className="mt-1 text-base font-semibold text-foreground-emphasis">
            Reading Tour — start here
          </h2>
          <p className="mt-1 text-xs t-secondary leading-relaxed max-w-2xl">
            {stops.length} files form the structural backbone of this repo.
            Reading them in order gives you ~80% of the architecture in about{" "}
            {estimatedReadingTimeMin} minutes.
          </p>
        </div>
        <div className="t-tertiary text-[10px] uppercase tracking-wider shrink-0">
          {activeIdx + 1} / {stops.length}
        </div>
      </div>

      {/* Stop selector strip */}
      <div className="flex gap-1.5 mb-4 overflow-x-auto custom-scrollbar pb-1">
        {stops.map((stop, i) => (
          <button
            key={stop.key}
            type="button"
            onClick={() => setActiveIdx(i)}
            className={`shrink-0 px-3 py-1.5 rounded-md text-xs transition-colors ${
              i === activeIdx
                ? "bg-violet-500/30 text-violet-100 font-medium"
                : "bg-surface-overlay/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="text-[10px] mr-1.5 opacity-60">#{stop.rank}</span>
            {stop.name}
          </button>
        ))}
      </div>

      {/* Active stop detail */}
      {active && (
        <div className="rounded-lg bg-surface-overlay/40 border border-border-subtle p-4">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <div className="font-mono text-sm text-foreground-emphasis truncate">
              {active.name}
            </div>
            <span className="text-[10px] t-tertiary uppercase tracking-wider shrink-0">
              {active.kind}
            </span>
          </div>
          <div className="t-tertiary text-[11px] font-mono truncate mb-2">
            {active.file_path}
          </div>
          <p className="text-xs t-secondary leading-relaxed">{active.why}</p>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => openInVisual(active.key)}
              className="text-xs text-violet-400 hover:text-violet-300 transition-colors font-medium"
            >
              Open in graph →
            </button>
            {activeIdx > 0 && (
              <button
                type="button"
                onClick={() => setActiveIdx((i) => i - 1)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Prev
              </button>
            )}
            {activeIdx < stops.length - 1 && (
              <button
                type="button"
                onClick={() => setActiveIdx((i) => i + 1)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Next →
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * R1: Now Strip — session-aware context above the fold
 * ═══════════════════════════════════════════════════════════════════════ */

function NowStrip({
  efficiency,
  intents,
  hotspots,
}: {
  efficiency: EfficiencyResponse["data"];
  intents: IntentsResponse["data"] | null;
  hotspots: RiskHotspot[];
}) {
  const savedTokens = efficiency?.savedTokens ?? 0;

  // Cross-reference: which active-session entities are in the hotspot set?
  const hotspotKeys = new Set(hotspots.map((h) => h.key));
  const touchedHotspots = new Set<string>();
  if (intents) {
    for (const intent of intents) {
      for (const e of intent.entitiesModified ?? []) {
        if (hotspotKeys.has(e)) touchedHotspots.add(e);
      }
    }
  }

  // Nothing useful yet — fade in once we have a signal
  const hasAnything = savedTokens > 0 || touchedHotspots.size > 0;
  if (!hasAnything) return null;

  const fmtTokens = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-violet-500/20 bg-violet-500/5 px-4 py-2.5 text-xs">
      <span className="t-tertiary uppercase tracking-wider text-[10px]">
        This session
      </span>
      {touchedHotspots.size > 0 && (
        <button
          type="button"
          onClick={() =>
            document
              .getElementById("section-risk-hotspots")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          className="flex items-center gap-1.5 text-foreground hover:text-violet-300 transition-colors"
        >
          <span className="text-amber-400 font-semibold">
            {touchedHotspots.size}
          </span>
          <span>hotspot{touchedHotspots.size !== 1 ? "s" : ""} touched</span>
          <span className="text-violet-400">→</span>
        </button>
      )}
      {savedTokens > 0 && (
        <button
          type="button"
          onClick={() => navigateRoute("reasoning")}
          className="flex items-center gap-1.5 text-foreground hover:text-cyan-300 transition-colors"
          title="Counted on operations unerr handled (file reads, web fetches, shell output, dedup). Not whole-turn savings."
        >
          <span className="text-emerald-400 font-semibold">
            {fmtTokens(savedTokens)}
          </span>
          <span>tokens saved today · on ops unerr handled</span>
          <span className="text-cyan-400">→</span>
        </button>
      )}
    </div>
  );
}
