/**
 * Layer 10 TF-D.3: Token Flow dashboard page.
 *
 * 3-level hierarchical drill-down (Datadog APM / Grafana pattern):
 *
 *   Level 0 — GLOBAL:  Aggregate KPIs across all sessions + session list table
 *   Level 1 — SESSION: Session KPIs + cumulative savings chart + turn timeline
 *   Level 2 — TURN:    Per-event detail with mechanism breakdown
 *
 * Navigation: breadcrumb at top. Click session row → enter session.
 * Click turn row → enter turn. Breadcrumb segments navigate back.
 */

import { DateRangeFilter } from "@/components/DateRangeFilter";
import type { HeadroomWindow } from "@/components/HeadroomStrip";
import { CardGridSkeleton, SkeletonBlock } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import {
  navigateRoute,
  setHashQueryParams,
  useHashQueryParam,
} from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentBadge } from "./token-trace/components/AgentBadge";
import { Breadcrumb } from "./token-trace/components/Breadcrumb";
import { KpiStatCard } from "./token-trace/components/KpiStatCard";
import { MechanismPill } from "./token-trace/components/MechanismPill";
import { Pagination } from "./token-trace/components/Pagination";
import { SavingsOriginSplit } from "./token-trace/components/SavingsOriginSplit";
import { SavingsTrend } from "./token-trace/components/SavingsTrend";
import {
  ALL_MECHANISMS,
  BEHAVIOR_EVENT_DESCRIPTIONS,
  BEHAVIOR_EVENT_LABELS,
  type CumulativeResponse,
  type CumulativeTurn,
  type EventsResponse,
  type GlobalResponse,
  HIDDEN_BEHAVIOR_EVENTS,
  type MechanismSummary,
  type SessionListResponse,
  type SessionSummaryResponse,
  type TokenFlowEvent,
  describeEvent,
  describeTurn,
  fmt,
  fmtTime,
  mc,
  timeAgo,
} from "./token-trace/shared";

// ── Shared psychology-driven components (ported from Dashboard.tsx) ───

/** Count-up animation hook — dopamine peak on first data arrival (easeOutCubic).
 *  Respects prefers-reduced-motion. Only fires once per mount. */
function useCountUp(target: number, durationMs = 900): number {
  const [val, setVal] = useState(target);
  const started = useRef(false);
  useEffect(() => {
    if (started.current || target <= 0) {
      setVal(target);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setVal(target);
      return;
    }
    started.current = true;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - (1 - p) ** 3;
      setVal(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setVal(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return val;
}

function CountUp({
  value,
  format,
  prefix,
}: {
  value: number;
  format: (n: number) => string;
  prefix?: string;
}) {
  const animated = useCountUp(value);
  return (
    <>
      {prefix}
      {format(Math.round(animated))}
    </>
  );
}

/** Accessible InfoTip — hover OR keyboard-focus reveals contextual explanation.
 *  Per NN/g: tooltips appear on focus as well as hover, carry <150 chars,
 *  and are never the ONLY source of essential info. */
function InfoTip({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label ?? "More information"}
        aria-describedby={open ? id : undefined}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border-subtle font-mono text-[9px] font-bold leading-none t-tertiary transition-colors hover:border-violet-400 hover:text-violet-300 focus-visible:text-violet-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-400"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        i
      </button>
      {open ? (
        <span
          role="tooltip"
          id={id}
          className="absolute left-1/2 top-full z-30 mt-2 w-64 -translate-x-1/2 rounded-lg border border-border-subtle bg-background px-3 py-2 text-left text-[11px] font-normal normal-case leading-snug tracking-normal t-secondary shadow-xl"
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

/** First-visit contextual callout — progressive disclosure for domain
 *  explanations. Shows expanded on first visit (localStorage), collapses
 *  to a subtle "Learn more" link after dismiss. Per NN/g: essential-on-
 *  first-encounter content uses contextual disclosure, not tooltips. */
function FirstVisitCallout({
  storageKey,
  children,
}: {
  storageKey: string;
  children: React.ReactNode;
}) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      /* SSR / private browsing */
    }
  }, [storageKey]);

  if (dismissed) return null;
  return (
    <div className="relative mt-4 rounded-lg border border-violet-500/20 bg-violet-500/4 px-4 py-3">
      <button
        type="button"
        onClick={dismiss}
        className="absolute right-3 top-3 text-[10px] font-medium text-violet-400 hover:text-violet-300 transition-colors"
        aria-label="Dismiss explanation"
      >
        Got it
      </button>
      {children}
    </div>
  );
}

// ── Headroom types (inlined from HeadroomStrip to avoid the component) ──
interface HeadroomBlock {
  window: string;
  headroom_turns: number;
  turns_observed: number;
  avg_turn_tokens_without: number;
  avg_saved_per_turn: number;
  turns_to_limit_with: number;
  turns_to_limit_without: number;
  sessions: number;
  total_tokens_saved: number;
}
interface HeadroomResponse {
  data: Record<HeadroomWindow, HeadroomBlock>;
  _meta: { latency_ms: number; context_limit: number };
}

/** Detect agent billing model from agent name for Von Restorff highlighting. */
function detectBillingModel(
  agentName: string | undefined
): "credit" | "window" | "unknown" {
  if (!agentName) return "unknown";
  const n = agentName.toLowerCase();
  if (n.includes("cursor") || n.includes("copilot")) return "credit";
  if (n.includes("claude") || n.includes("windsurf")) return "window";
  return "unknown";
}

// ── Shared sub-components ───────────────────────────────────────────

/** KPI card with CountUp animation — wraps KpiStatCard with animated number.
 *  Numbers count-up on first mount (dopamine peak), then snap on refetch. */
function AnimatedKpiCard({
  label,
  rawValue,
  subtitle,
  accent,
  hint,
  prefix,
  sparklinePoints,
}: {
  label: string;
  rawValue: number;
  subtitle?: string;
  accent: "emerald" | "cyan" | "violet" | "fuchsia" | "amber" | "rose";
  hint?: string;
  prefix?: string;
  sparklinePoints?: number[];
}) {
  const animated = useCountUp(rawValue);
  const display = `${prefix ?? ""}${fmt(Math.round(animated))}`;
  return (
    <KpiStatCard
      label={label}
      value={display}
      subtitle={subtitle}
      accent={accent}
      hint={hint}
      sparklinePoints={sparklinePoints}
    />
  );
}

function MechanismBars({
  mechanisms,
  totalSaved,
}: { mechanisms: Record<string, MechanismSummary>; totalSaved: number }) {
  const entries = Object.entries(mechanisms).sort(
    ([, a], [, b]) => b.tokens_saved - a.tokens_saved
  );
  if (entries.length === 0)
    return <p className="t-secondary text-sm py-3">No mechanism data.</p>;
  const maxSaved = entries[0][1].tokens_saved || 1;

  return (
    <div className="space-y-1.5">
      {entries.map(([mech, data]) => {
        const colors = mc(mech);
        const w = Math.max(3, (data.tokens_saved / maxSaved) * 100);
        return (
          <div key={mech} className="flex items-center gap-3 py-0.5">
            <span
              className={`${colors.text} text-xs font-medium w-36 shrink-0 truncate`}
            >
              {mech.replace(/_/g, " ")}
            </span>
            <div className="flex-1 h-5 rounded bg-white/[0.06] overflow-hidden">
              <div
                className={`h-full ${colors.bar} opacity-80 rounded`}
                style={{ width: `${w}%` }}
              />
            </div>
            <span className="text-success font-mono text-xs w-14 text-right shrink-0">
              {fmt(data.tokens_saved)}
            </span>
            <span className="t-tertiary font-mono text-xs w-10 text-right shrink-0">
              {data.pct_of_total}%
            </span>
            <span className="t-tertiary text-xs w-8 text-right shrink-0">
              {data.event_count}×
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Mistakes Prevented Pane ──────────────────────────────────────────

interface BehaviorCounts {
  by_type: Record<string, number>;
  by_tool: Record<string, number>;
  total: number;
}

interface BehaviorSessionResponse {
  data: { session_id: string | null; counts: BehaviorCounts };
}

interface BehaviorGlobalResponse {
  data: { total_sessions: number; counts: BehaviorCounts };
}

function PreventionsPane({
  scope,
  sessionId,
  fromTs,
  toTs,
}: {
  scope: "global" | "session";
  sessionId?: string;
  fromTs?: string;
  toTs?: string;
}) {
  const { url, queryKey } = useRepoApi();
  const dateParams =
    fromTs || toTs
      ? `${fromTs ? `&from_ts=${fromTs}` : ""}${toTs ? `&to_ts=${toTs}` : ""}`
      : "";

  const q = useQuery({
    queryKey: queryKey([
      "behavior-events",
      scope,
      sessionId ?? "",
      fromTs ?? "",
      toTs ?? "",
    ]),
    queryFn: () => {
      if (scope === "global") {
        return fetchJson<BehaviorGlobalResponse>(
          url(`/api/behavior-events/global?_=1${dateParams}`)
        ).then((r) => r.data.counts);
      }
      const sidParam = sessionId ? `session_id=${sessionId}` : "_=1";
      return fetchJson<BehaviorSessionResponse>(
        url(`/api/behavior-events/session?${sidParam}`)
      ).then((r) => r.data.counts);
    },
    refetchInterval: 5_000,
  });

  const counts = q.data;
  const headerSuffix =
    scope === "global"
      ? fromTs || toTs
        ? ""
        : " (all time)"
      : " (this session)";

  const entries = useMemo(() => {
    if (!counts) return [] as Array<[string, number]>;
    return Object.entries(counts.by_type)
      .filter(([type, n]) => n > 0 && !HIDDEN_BEHAVIOR_EVENTS.has(type))
      .sort(([, a], [, b]) => b - a);
  }, [counts]);

  const visibleTotal = entries.reduce((s, [, n]) => s + n, 0);

  return (
    <div className="el-raised rounded-lg p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="t-secondary text-sm font-medium">
          Mistakes prevented{headerSuffix}
        </h3>
        <span className="t-tertiary text-xs">{fmt(visibleTotal)} caught</span>
      </div>
      <p className="t-tertiary text-xs mb-3 leading-snug">
        Problems unerr caught before they reached your code — hover any row to
        see what would have gone wrong without it.
      </p>
      {q.isLoading ? (
        <SkeletonBlock height={120} />
      ) : entries.length === 0 ? (
        <p className="t-secondary text-sm py-3">
          No issues caught yet — unerr starts tracking as soon as your agent
          calls a tool.
        </p>
      ) : (
        <div className="space-y-1.5">
          {entries.map(([type, n]) => (
            <div
              key={type}
              className="flex items-center gap-3 py-1 group cursor-default"
              title={BEHAVIOR_EVENT_DESCRIPTIONS[type] ?? type}
            >
              <span className="text-violet-300 text-xs font-medium w-52 shrink-0 truncate">
                {BEHAVIOR_EVENT_LABELS[type] ?? type.replace(/_/g, " ")}
              </span>
              <div className="flex-1 h-5 rounded bg-white/[0.06] overflow-hidden">
                <div
                  className="h-full bg-violet-500 opacity-80 rounded"
                  style={{
                    width: `${Math.max(
                      3,
                      (n / (entries[0]?.[1] || 1)) * 100
                    )}%`,
                  }}
                />
              </div>
              <span className="text-violet-200 font-mono text-xs w-14 text-right shrink-0">
                {fmt(n)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Token-overhead levers (additive — T5.3) ────────────────────────

interface OverheadLeversResponse {
  data: {
    recon: {
      count: number;
      avg_sections: number;
      avg_tokens: number;
      pct_digest: number;
      pct_large_sweep: number;
      by_task_size: Record<string, number>;
    };
    ceremony: {
      suppressed_count: number;
      by_banner: Record<string, number>;
    };
  };
}

/**
 * Additive card surfacing the server-side token-overhead levers: `unerr recon`
 * adoption + task-size mix (R1/R5) and verbose-banner suppression (R4). This is
 * NOT a cache_read/cache_write before/after — that bill lives in the agent
 * transcript and is proven offline by scripts/measure-token-baseline.mjs. The
 * card proves the levers fire; the byte-savings panes above are untouched.
 */
function OverheadLeversPane() {
  const { url, queryKey } = useRepoApi();
  const q = useQuery({
    queryKey: queryKey(["overhead-levers"]),
    queryFn: () =>
      fetchJson<OverheadLeversResponse>(
        url("/api/token-flow/overhead-levers")
      ).then((r) => r.data),
    refetchInterval: 5_000,
  });

  const d = q.data;
  const taskSizes = useMemo(() => {
    if (!d) return [] as Array<[string, number]>;
    return Object.entries(d.recon.by_task_size).sort(([, a], [, b]) => b - a);
  }, [d]);
  const taskTotal = taskSizes.reduce((s, [, n]) => s + n, 0);

  return (
    <div className="el-raised rounded-lg p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="t-secondary text-sm font-medium">
          Token-overhead levers
        </h3>
        <span className="t-tertiary text-xs">
          {d ? fmt(d.recon.count) : "—"} recon calls
        </span>
      </div>
      <p className="t-tertiary text-xs mb-3 leading-snug">
        Server-side proof the round-trip-reduction levers fire: one{" "}
        <code>unerr recon</code> call replaces the ~5-call discovery fan-out,
        the footprint self-selects by task size, and verbose hook banners drop
        to terse after their first emission. The absolute cache_read/cache_write
        bill is measured offline (
        <code>scripts/measure-token-baseline.mjs</code>
        ).
      </p>
      {q.isLoading ? (
        <SkeletonBlock height={120} />
      ) : !d || (d.recon.count === 0 && d.ceremony.suppressed_count === 0) ? (
        <p className="t-secondary text-sm py-3">
          No levers fired yet — run <code>unerr recon "&lt;task&gt;"</code> or
          edit a file twice to move the counters.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-white/[0.04] px-3 py-2.5">
              <div className="t-tertiary text-xs">recon calls</div>
              <div className="text-violet-200 font-mono text-lg">
                {fmt(d.recon.count)}
              </div>
              <div className="t-tertiary text-xs">
                avg {d.recon.avg_sections} sections · ~{fmt(d.recon.avg_tokens)}{" "}
                tok
              </div>
            </div>
            <div className="rounded-lg bg-white/[0.04] px-3 py-2.5">
              <div className="t-tertiary text-xs">large sweeps</div>
              <div className="text-violet-200 font-mono text-lg">
                {d.recon.pct_large_sweep}%
              </div>
              <div className="t-tertiary text-xs">
                {d.recon.pct_digest}% emitted digest
              </div>
            </div>
            <div className="rounded-lg bg-white/[0.04] px-3 py-2.5">
              <div className="t-tertiary text-xs">banners suppressed</div>
              <div className="text-violet-200 font-mono text-lg">
                {fmt(d.ceremony.suppressed_count)}
              </div>
              <div className="t-tertiary text-xs">once per session</div>
            </div>
          </div>
          {taskSizes.length > 0 && (
            <div className="space-y-1.5">
              <div className="t-tertiary text-xs mb-1">Task-size mix</div>
              {taskSizes.map(([size, n]) => (
                <div key={size} className="flex items-center gap-3 py-0.5">
                  <span className="text-violet-300 text-xs font-medium w-32 shrink-0 truncate">
                    {size.replace(/_/g, " ")}
                  </span>
                  <div className="flex-1 h-5 rounded bg-white/[0.06] overflow-hidden">
                    <div
                      className="h-full bg-violet-500 opacity-80 rounded"
                      style={{
                        width: `${Math.max(
                          3,
                          (n / (taskSizes[0]?.[1] || 1)) * 100
                        )}%`,
                      }}
                    />
                  </div>
                  <span className="text-violet-200 font-mono text-xs w-20 text-right shrink-0">
                    {fmt(n)} (
                    {taskTotal > 0 ? Math.round((n / taskTotal) * 100) : 0}%)
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Turn-scoped events list ────────────────────────────────────────

interface BehaviorEventRow {
  id: number;
  ts: string;
  session_id: string;
  pid: number;
  turn: number;
  type: string;
  tool: string | null;
  entity_key: string | null;
  response_bytes: number | null;
  detail?: Record<string, unknown>;
}

interface BehaviorEventsResponse {
  data: BehaviorEventRow[];
  total: number;
  limit: number;
  offset: number;
}

function TurnPreventionsList({
  sessionId,
  turn,
}: {
  sessionId: string;
  turn: number;
}) {
  const { url, queryKey } = useRepoApi();
  const q = useQuery({
    queryKey: queryKey(["behavior-events-turn", sessionId, turn]),
    queryFn: () =>
      fetchJson<BehaviorEventsResponse>(
        url(
          `/api/behavior-events/events?session_id=${sessionId}&turn=${turn}&limit=200`
        )
      ),
    refetchInterval: 5_000,
  });

  if (q.isLoading) {
    return (
      <div className="el-raised rounded-lg p-5">
        <SkeletonBlock height={80} />
      </div>
    );
  }

  const allEvents = q.data?.data ?? [];
  const events = allEvents.filter((e) => !HIDDEN_BEHAVIOR_EVENTS.has(e.type));

  return (
    <div className="el-raised rounded-lg p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="t-secondary text-sm font-medium">
          Mistakes prevented in this turn
        </h3>
        <span className="t-tertiary text-xs">{events.length} caught</span>
      </div>
      <p className="t-tertiary text-xs mb-3 leading-snug">
        Each row is something unerr caught during turn #{turn} — hover for
        details on what would have gone wrong.
      </p>
      {events.length === 0 ? (
        <p className="t-secondary text-sm py-3">
          No issues caught in this turn.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[700px]">
            <thead>
              <tr className="border-b border-border-subtle t-tertiary uppercase">
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">What was prevented</th>
                <th className="px-3 py-2 font-medium">Tool</th>
                <th className="px-3 py-2 font-medium">File / Entity</th>
                <th className="px-3 py-2 font-medium text-right">Size</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={`${e.session_id}-${e.id}-${e.ts}`}
                  className="border-b border-border-subtle/40 hover:bg-white/[0.03]"
                  title={BEHAVIOR_EVENT_DESCRIPTIONS[e.type] ?? e.type}
                >
                  <td className="px-3 py-1.5 font-mono t-tertiary whitespace-nowrap">
                    {fmtTime(e.ts)}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="text-violet-300">
                      {BEHAVIOR_EVENT_LABELS[e.type] ??
                        e.type.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-mono t-secondary">
                    {e.tool ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono t-secondary truncate max-w-[260px]">
                    {e.entity_key ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 font-mono t-secondary text-right">
                    {e.response_bytes != null ? fmt(e.response_bytes) : "—"}
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

// ══════════════════════════════════════════════════════════════════════
// LEVEL 0 — GLOBAL VIEW
// ══════════════════════════════════════════════════════════════════════

function GlobalView({
  onSelectSession,
}: {
  onSelectSession: (id: string) => void;
}) {
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
    queryKey: queryKey(["token-flow-global", fromTs, toTs]),
    queryFn: () =>
      fetchJson<GlobalResponse>(url(`/api/token-flow/global?_=1${dateParams}`)),
    refetchInterval: 5_000,
  });

  const sessionsQ = useQuery({
    queryKey: queryKey(["token-flow-sessions", fromTs, toTs, sessionOffset]),
    queryFn: () =>
      fetchJson<SessionListResponse>(
        url(
          `/api/token-flow/sessions?limit=${sessionLimit}&offset=${sessionOffset}${dateParams}`
        )
      ),
    refetchInterval: 5_000,
  });

  if (globalQ.isLoading) return <CardGridSkeleton n={4} />;

  const g = globalQ.data?.data;
  const sessions = sessionsQ.data?.data ?? [];
  const sessionsTotal = sessionsQ.data?.total ?? 0;

  if (!g || g.event_count === 0) {
    return (
      <div className="el-raised rounded-lg p-10 text-center">
        <p className="t-secondary text-lg">No token flow data yet</p>
        <p className="t-tertiary mt-2 text-sm">
          Token savings appear here as the agent makes tool calls through unerr.
        </p>
        <p className="t-tertiary mt-1 text-xs">
          Sources: graph queries, shell compression, format encoding, session
          dedup, smart truncation, file reads, behavior automation.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top bar: Date range filter + Export */}
      <div className="flex items-center justify-end gap-3 flex-wrap -mt-2">
        <DateRangeFilter
          fromTs={fromTs}
          toTs={toTs}
          onChange={(f, t) => setRange(f, t)}
        />
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-xs font-medium t-secondary transition-colors hover:border-border-strong hover:bg-white/[0.06] hover:text-foreground"
          title="Export all token flow data as CSV"
          onClick={() => {
            const dateParams =
              fromTs || toTs
                ? `${fromTs ? `&from_ts=${fromTs}` : ""}${toTs ? `&to_ts=${toTs}` : ""}`
                : "";
            fetch(url(`/api/token-flow/events?limit=500${dateParams}`))
              .then((r) => r.json())
              .then((json) => {
                const events = json.data ?? [];
                if (events.length === 0) return;
                const headers = [
                  "timestamp",
                  "session_id",
                  "turn",
                  "mechanism",
                  "tool",
                  "tokens_without",
                  "tokens_with",
                  "tokens_saved",
                  "detail",
                ];
                const rows = events.map((e: Record<string, unknown>) =>
                  [
                    e.ts,
                    e.session_id,
                    e.turn,
                    e.mechanism,
                    e.tool ?? "",
                    e.tokens_without,
                    e.tokens_with,
                    e.tokens_saved,
                    (e.detail ?? "").toString().replace(/"/g, '""'),
                  ]
                    .map((v) => `"${v}"`)
                    .join(",")
                );
                const csv = [headers.join(","), ...rows].join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `token-economics-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              });
          }}
        >
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
              d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          Export CSV
        </button>
      </div>

      {/* Global KPI row — Big Four with CountUp animation */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <AnimatedKpiCard
          label="Tokens Saved"
          rawValue={g.total_tokens_saved}
          subtitle="direct rescue"
          accent="emerald"
          hint="Tokens removed from agent responses before they could weigh down context"
        />
        <AnimatedKpiCard
          label="Context Avoided"
          rawValue={g.total_context_avoided}
          subtitle={
            g.total_tokens_saved > 0
              ? `${(g.total_context_avoided / g.total_tokens_saved).toFixed(1)}× compounded`
              : "carried forward"
          }
          accent="cyan"
          hint="Cumulative token-turns of context pressure prevented — savings compound because each turn's rescue carries forward to all future turns"
        />
        <KpiStatCard
          label="Rescue Rate"
          value={`${g.efficiency_pct}%`}
          subtitle="tokens kept out"
          accent="violet"
          hint="Share of original tokens that unerr rescued (saved ÷ original)"
        />
        <AnimatedKpiCard
          label="Sessions"
          rawValue={g.total_sessions}
          subtitle={`${g.total_turns} turn${g.total_turns === 1 ? "" : "s"}`}
          accent="fuchsia"
          hint="Distinct agent sessions tracked, plus total turns across them"
        />
      </div>

      {/* Where your savings come from — the differentiation centerpiece.
       *  Splits the same by_mechanism data into code-intelligence (the
       *  unerr-only tier) vs output-compression (table-stakes), so the
       *  80/20 reality leads the page. Replaces the old flat mechanism
       *  list below — every mechanism still shows, now grouped + contrasted. */}
      <SavingsOriginSplit
        byMechanism={g.by_mechanism}
        totalSaved={g.total_tokens_saved}
      />

      {/* Carry-forward savings — narrative; numbers live in the KPI row */}
      {g.avg_context_reduction > 0 && (
        <div className="el-raised rounded-lg p-4 border-l-2 border-cyan-500/60">
          <h3 className="text-foreground text-sm font-medium">
            Carry-Forward Savings
          </h3>
          <p className="t-tertiary text-xs mt-1 max-w-2xl leading-snug">
            Each turn ran with{" "}
            <span className="text-cyan-400 font-medium">
              {fmt(g.avg_context_reduction)}
            </span>{" "}
            fewer tokens on average across {g.total_turns} turn
            {g.total_turns === 1 ? "" : "s"}, peaking at{" "}
            {fmt(g.peak_context_reduction)}.
          </p>
        </div>
      )}

      {/* Time-series trend — stacked area by mechanism */}
      <SavingsTrend fromTs={fromTs} toTs={toTs} bucket="day" />

      {/* Mistakes prevented — qualitative proof of the code-intelligence
       *  tier above: unnecessary file reads prevented, stale edits caught,
       *  loops broken — things only a repo-aware tool can catch. */}
      <PreventionsPane scope="global" fromTs={fromTs} toTs={toTs} />

      {/* Token-overhead levers (additive — T5.3): server-side proof that the
       *  round-trip-reduction levers fire (recon adoption, task-size mix,
       *  verbose-banner suppression). NOT a cache_read/write before/after —
       *  that bill is measured offline by measure-token-baseline.mjs. */}
      <OverheadLeversPane />

      {/* Session list — card-style rows with hover counterfactual */}
      <div className="el-raised rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
          <h3 className="t-secondary text-sm font-medium">Sessions</h3>
          <span className="t-tertiary text-xs">
            {sessionsTotal} session{sessionsTotal !== 1 ? "s" : ""}
          </span>
        </div>

        {sessions.length === 0 ? (
          <p className="px-5 py-6 t-secondary text-sm">No sessions recorded.</p>
        ) : (
          <>
            <div className="divide-y divide-border-subtle">
              {sessions.map((s, i) => {
                const effPct =
                  s.total_saved > 0 && s.avg_context_reduction > 0
                    ? Math.round(
                        (s.total_saved /
                          (s.total_saved +
                            s.total_turns * (s.avg_context_reduction || 1))) *
                          100
                      )
                    : null;

                return (
                  <div
                    key={s.session_id}
                    className="group relative cursor-pointer px-5 py-4 transition-all hover:bg-white/3"
                    onClick={() => onSelectSession(s.session_id)}
                  >
                    {/* Top row: ID + Agent + Time + Action */}
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-mono text-xs text-foreground group-hover:text-violet-400 transition-colors shrink-0">
                          {s.session_id.slice(0, 12)}
                        </span>
                        {i === 0 && sessionOffset === 0 && (
                          <span className="rounded-full bg-emerald-500/20 text-emerald-400 px-2 py-0.5 text-[10px] font-medium shrink-0">
                            latest
                          </span>
                        )}
                        <AgentBadge name={s.agent_name} />
                        <span className="t-tertiary text-xs shrink-0">
                          {timeAgo(s.last_ts)}
                        </span>
                      </div>
                      <span className="inline-flex items-center gap-1 text-xs text-violet-400 opacity-0 group-hover:opacity-100 transition-opacity font-medium whitespace-nowrap shrink-0">
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
                    </div>

                    {/* Bottom row: metrics + mechanisms */}
                    <div className="flex items-center gap-4 mt-2.5 flex-wrap">
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="text-emerald-400 font-mono font-semibold text-sm tabular-nums">
                          {fmt(s.total_saved)}
                        </span>
                        <span className="t-tertiary text-[10px]">saved</span>
                      </span>
                      {s.avg_context_reduction > 0 && (
                        <span className="inline-flex items-baseline gap-1.5">
                          <span className="text-cyan-400 font-mono font-semibold text-sm tabular-nums">
                            {fmt(s.avg_context_reduction)}
                          </span>
                          <span className="t-tertiary text-[10px]">
                            avg ctx/turn
                          </span>
                        </span>
                      )}
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="t-secondary font-mono text-xs tabular-nums">
                          {s.total_turns}
                        </span>
                        <span className="t-tertiary text-[10px]">
                          turn{s.total_turns === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="t-secondary font-mono text-xs tabular-nums">
                          {s.event_count}
                        </span>
                        <span className="t-tertiary text-[10px]">
                          event{s.event_count === 1 ? "" : "s"}
                        </span>
                      </span>
                      <div className="flex flex-wrap gap-1 ml-auto">
                        {s.mechanisms.slice(0, 4).map((m) => (
                          <MechanismPill key={m} mechanism={m} />
                        ))}
                        {s.mechanisms.length > 4 && (
                          <span className="t-tertiary text-[10px]">
                            +{s.mechanisms.length - 4}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Hover counterfactual — "without unerr" ghost line.
                     *  Peak-End rule: the strongest emotional anchor is seeing
                     *  what you avoided. Appears only on hover to avoid clutter. */}
                    <div className="h-0 overflow-hidden group-hover:h-auto group-hover:mt-2.5 transition-all">
                      <div className="flex items-center gap-2 rounded-md bg-rose-500/6 border border-rose-500/10 px-3 py-1.5">
                        <svg
                          aria-hidden="true"
                          className="w-3 h-3 text-rose-400 shrink-0"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                          />
                        </svg>
                        <span className="text-rose-300/80 text-[10px]">
                          Without unerr: {fmt(s.total_saved)} extra tokens in
                          every subsequent turn's context
                          {s.avg_context_reduction > 0 &&
                            ` · ${fmt(s.avg_context_reduction)} avg context pressure per turn`}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
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

function SessionView({
  sessionId,
  onSelectTurn,
}: {
  sessionId: string;
  onSelectTurn: (turn: number) => void;
}) {
  const { url, queryKey } = useRepoApi();
  const [turnPage, setTurnPage] = useState(0);
  const turnsPerPage = 10;

  const sessionQ = useQuery({
    queryKey: queryKey(["token-flow-session", sessionId]),
    queryFn: () =>
      fetchJson<SessionSummaryResponse>(
        url(
          `/api/token-flow/session${sessionId ? `?session_id=${sessionId}` : ""}`
        )
      ),
    refetchInterval: 5_000,
  });

  const cumulativeQ = useQuery({
    queryKey: queryKey(["token-flow-cumulative", sessionId]),
    queryFn: () =>
      fetchJson<CumulativeResponse>(
        url(`/api/token-flow/cumulative?session_id=${sessionId}`)
      ),
    refetchInterval: 5_000,
  });

  const eventsQ = useQuery({
    queryKey: queryKey(["token-flow-events", sessionId]),
    queryFn: () =>
      fetchJson<EventsResponse>(
        url(`/api/token-flow/events?session_id=${sessionId}`)
      ),
    refetchInterval: 5_000,
  });

  if (sessionQ.isLoading) return <CardGridSkeleton n={4} />;

  const s = sessionQ.data?.data;
  const cumulative = cumulativeQ.data?.data ?? [];
  const events = eventsQ.data?.data ?? [];

  if (!s) {
    return (
      <div className="el-raised rounded-lg p-8 text-center">
        <p className="t-secondary">
          No data for session {sessionId.slice(0, 12)}
        </p>
      </div>
    );
  }

  // Group events by turn for the turn list
  const turnGroups = new Map<number, TokenFlowEvent[]>();
  for (const e of events) {
    const group = turnGroups.get(e.turn) ?? [];
    group.push(e);
    turnGroups.set(e.turn, group);
  }
  const allSortedTurns = [...turnGroups.entries()].sort(([a], [b]) => b - a);
  const sortedTurns = allSortedTurns.slice(
    turnPage * turnsPerPage,
    (turnPage + 1) * turnsPerPage
  );

  // Max saved per turn for bar scaling
  const maxTurnSaved = sortedTurns.reduce((max, [, evts]) => {
    const total = evts.reduce((s, e) => s + e.tokens_saved, 0);
    return Math.max(max, total);
  }, 1);

  // Lookup cumulative data by turn number for context-avoided column
  const cumulativeByTurn = new Map<number, CumulativeTurn>();
  for (const ct of cumulative) {
    cumulativeByTurn.set(ct.turn, ct);
  }

  return (
    <div className="space-y-6">
      {/* Session KPIs — Big Four with CountUp */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <AnimatedKpiCard
          label="Tokens Saved"
          rawValue={s.total_tokens_saved}
          subtitle="direct rescue"
          accent="emerald"
          hint="Tokens unerr rescued from agent responses this session"
        />
        <AnimatedKpiCard
          label="Context Avoided"
          rawValue={cumulativeQ.data?.total_context_avoided ?? 0}
          subtitle={
            s.total_tokens_saved > 0 &&
            (cumulativeQ.data?.total_context_avoided ?? 0) > 0
              ? `${((cumulativeQ.data?.total_context_avoided ?? 0) / s.total_tokens_saved).toFixed(1)}× compounded`
              : "carried forward"
          }
          accent="cyan"
          hint="Cumulative token-turns of context pressure prevented this session"
        />
        <KpiStatCard
          label="Rescue Rate"
          value={`${s.efficiency_pct}%`}
          subtitle="tokens kept out"
          accent="violet"
          hint="Share of original tokens rescued (saved ÷ original)"
        />
        <AnimatedKpiCard
          label="Turns"
          rawValue={s.total_turns}
          subtitle={`${s.event_count} event${s.event_count === 1 ? "" : "s"}`}
          accent="fuchsia"
          hint="Conversation turns in this session"
        />
      </div>

      {/* Carry-forward savings — narrative; numbers live in the KPI row */}
      {(cumulativeQ.data?.avg_context_reduction ?? 0) > 0 &&
        (() => {
          const cs = cumulativeQ.data!;
          return (
            <div className="el-raised rounded-lg p-4 border-l-2 border-cyan-500/60">
              <h3 className="text-foreground text-sm font-medium">
                Carry-Forward Savings
              </h3>
              <p className="t-tertiary text-xs mt-1 max-w-2xl leading-snug">
                Each turn ran with{" "}
                <span className="text-cyan-400 font-medium">
                  {fmt(cs.avg_context_reduction)}
                </span>{" "}
                fewer tokens on average across {s.total_turns} turn
                {s.total_turns === 1 ? "" : "s"}, peaking at{" "}
                {fmt(cs.peak_context_reduction)}.
              </p>
            </div>
          );
        })()}

      {/* Where this session's savings come from — same contrast as the
       *  global view, scoped to this session's by_mechanism. */}
      <SavingsOriginSplit
        byMechanism={s.by_mechanism}
        totalSaved={s.total_tokens_saved}
      />

      {/* Two-column: Cumulative chart + Mistakes prevented */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Cumulative savings chart */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="t-secondary text-sm font-medium mb-1">
            Cumulative Savings
          </h3>
          <p className="t-tertiary text-xs mb-3">
            Each bar = cumulative tokens saved through that turn. Showing latest{" "}
            {Math.min(60, cumulative.length)} of {cumulative.length} turns.
            Hover for details.
          </p>
          {cumulative.length === 0 ? (
            <div className="h-[140px] flex items-center justify-center">
              <p className="t-tertiary text-xs">Loading chart data...</p>
            </div>
          ) : (
            <>
              <div className="flex gap-[3px]" style={{ height: "140px" }}>
                {cumulative.slice(-60).map((turn) => {
                  const max =
                    cumulative[cumulative.length - 1]
                      ?.cumulative_tokens_saved || 1;
                  const heightPct = (turn.cumulative_tokens_saved / max) * 100;
                  const mechs = Object.entries(turn.mechanisms_this_turn).sort(
                    ([, a], [, b]) => b - a
                  );
                  const primary = mechs[0]?.[0] ?? "shell_compression";
                  const colors = mc(primary);

                  return (
                    <div
                      key={turn.turn}
                      className="group relative flex-1 min-w-[6px] max-w-[28px] h-full flex items-end"
                    >
                      <div
                        className={`w-full ${colors.bar} opacity-70 hover:opacity-100 rounded-t transition-all cursor-pointer`}
                        style={{ height: `${Math.max(4, heightPct)}%` }}
                        onClick={() => onSelectTurn(turn.turn)}
                      />
                      {/* Hover tooltip */}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 pointer-events-none">
                        <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs whitespace-nowrap shadow-xl">
                          <div className="font-medium text-foreground">
                            Turn #{turn.turn}
                          </div>
                          <div className="t-tertiary mt-0.5">
                            {turn.tools.join(", ") || "exec"}
                          </div>
                          <div className="text-success mt-1">
                            +{fmt(turn.tokens_saved_this_turn)} this turn
                          </div>
                          <div className="t-secondary">
                            Cumulative: {fmt(turn.cumulative_tokens_saved)}
                          </div>
                          <div className="text-cyan-400 mt-0.5">
                            Context avoided: {fmt(turn.context_avoided)}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {Object.keys(turn.mechanisms_this_turn).map((m) => (
                              <MechanismPill key={m} mechanism={m} />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-1.5">
                <span className="t-tertiary text-[10px] font-mono">
                  T{cumulative.length > 60 ? cumulative.length - 59 : 1}
                </span>
                <span className="t-tertiary text-[10px] font-mono">
                  T{cumulative.length}
                </span>
              </div>
              {/* Legend */}
              <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-border-subtle/50">
                {ALL_MECHANISMS.filter((m) =>
                  cumulative.some((d) => m in d.mechanisms_this_turn)
                ).map((m) => (
                  <div key={m} className="flex items-center gap-1.5">
                    <div className={`h-2.5 w-2.5 rounded-sm ${mc(m).bar}`} />
                    <span className="t-tertiary text-[10px]">
                      {m.replace(/_/g, " ")}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Mistakes prevented for this session */}
        <PreventionsPane scope="session" sessionId={sessionId} />
      </div>

      {/* Turn list — the drill-down into individual turns */}
      <div className="el-raised rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
          <div>
            <h3 className="t-secondary text-sm font-medium">Turns</h3>
            <p className="t-tertiary text-xs mt-0.5">
              Click a turn to see all events and mechanisms within it.
            </p>
          </div>
          <span className="t-tertiary text-xs">
            {allSortedTurns.length} turn{allSortedTurns.length !== 1 ? "s" : ""}
          </span>
        </div>

        {sortedTurns.length === 0 ? (
          <p className="px-5 py-6 t-secondary text-sm">No turns recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm min-w-[800px]">
              <thead>
                <tr className="border-b border-border-subtle t-tertiary text-xs uppercase">
                  <th
                    className="px-5 py-2.5 font-medium w-14"
                    title="Turn number in the conversation"
                  >
                    Turn
                  </th>
                  <th
                    className="px-3 py-2.5 font-medium"
                    title="Summary of what happened in this turn"
                  >
                    Description
                  </th>
                  <th
                    className="px-3 py-2.5 font-medium w-36"
                    title="Relative savings compared to the largest turn — wider bar means more tokens saved"
                  >
                    Savings Bar
                  </th>
                  <th
                    className="px-3 py-2.5 font-medium"
                    title="Types of rescue applied this turn"
                  >
                    Mechanisms
                  </th>
                  <th
                    className="px-3 py-2.5 font-medium text-right"
                    title="Tokens unerr rescued from agent responses this turn (direct savings)"
                  >
                    Saved
                  </th>
                  <th
                    className="px-3 py-2.5 font-medium text-right"
                    title="Cumulative tokens of context avoided at this point — prior savings carry forward, keeping context smaller for this and future turns"
                  >
                    Context Avoided
                  </th>
                  <th
                    className="px-3 py-2.5 font-medium text-right"
                    title="Number of savings events this turn"
                  >
                    Events
                  </th>
                  <th className="px-3 py-2.5 pr-5 font-medium w-16" />
                </tr>
              </thead>
              <tbody>
                {sortedTurns.map(([turn, turnEvents]) => {
                  const totalSaved = turnEvents.reduce(
                    (s, e) => s + e.tokens_saved,
                    0
                  );
                  const mechs = [
                    ...new Set(turnEvents.map((e) => e.mechanism)),
                  ];
                  const { label, subtitle } = describeTurn(turnEvents);
                  const turnCumulative = cumulativeByTurn.get(turn);

                  return (
                    <tr
                      key={turn}
                      className="group cursor-pointer border-b border-border-subtle transition-colors hover:bg-white/[0.04]"
                      onClick={() => onSelectTurn(turn)}
                    >
                      {/* Turn number */}
                      <td className="px-5 py-3">
                        <span className="t-tertiary font-mono text-xs group-hover:text-violet-400 transition-colors">
                          #{turn}
                        </span>
                      </td>

                      {/* Descriptive label + subtitle */}
                      <td className="px-3 py-3">
                        <div className="min-w-0 max-w-[260px]">
                          <p className="text-foreground font-mono text-xs truncate group-hover:text-violet-300 transition-colors">
                            {label}
                          </p>
                          {subtitle && (
                            <p className="t-tertiary text-[10px] mt-0.5 truncate">
                              {subtitle}
                            </p>
                          )}
                        </div>
                      </td>

                      {/* Waterfall bar — stacked by mechanism */}
                      <td className="px-3 py-3">
                        <div className="w-32 h-4 relative rounded-sm bg-white/[0.06] overflow-hidden">
                          {(() => {
                            const mechSavings = new Map<string, number>();
                            for (const e of turnEvents) {
                              mechSavings.set(
                                e.mechanism,
                                (mechSavings.get(e.mechanism) ?? 0) +
                                  e.tokens_saved
                              );
                            }
                            let offset = 0;
                            return [...mechSavings.entries()]
                              .sort(([, a], [, b]) => b - a)
                              .map(([mech, saved]) => {
                                const w =
                                  maxTurnSaved > 0
                                    ? (saved / maxTurnSaved) * 100
                                    : 0;
                                const left = offset;
                                offset += w;
                                const colors = mc(mech);
                                return (
                                  <div
                                    key={mech}
                                    className={`absolute inset-y-0 ${colors.bar} opacity-80`}
                                    style={{
                                      left: `${left}%`,
                                      width: `${Math.max(1, w)}%`,
                                    }}
                                  />
                                );
                              });
                          })()}
                        </div>
                      </td>

                      {/* Mechanism pills */}
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {mechs.map((m) => (
                            <MechanismPill key={m} mechanism={m} />
                          ))}
                        </div>
                      </td>

                      {/* Saved */}
                      <td className="px-3 py-3 text-right">
                        <span className="text-success font-mono font-medium text-xs">
                          {fmt(totalSaved)}
                        </span>
                      </td>

                      {/* Context avoided */}
                      <td className="px-3 py-3 text-right">
                        {turnCumulative ? (
                          <span
                            className="text-cyan-400 font-mono font-medium text-xs"
                            title={`${fmt(turnCumulative.context_avoided)} tokens of cumulative context avoided at turn #${turn}`}
                          >
                            {fmt(turnCumulative.context_avoided)}
                          </span>
                        ) : (
                          <span className="t-tertiary font-mono text-xs">
                            —
                          </span>
                        )}
                      </td>

                      {/* Event count */}
                      <td className="px-3 py-3 text-right">
                        <span className="t-tertiary text-xs">
                          {turnEvents.length}
                        </span>
                      </td>

                      {/* View action */}
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          total={allSortedTurns.length}
          limit={turnsPerPage}
          offset={turnPage * turnsPerPage}
          onPageChange={(newOffset) =>
            setTurnPage(Math.floor(newOffset / turnsPerPage))
          }
        />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// LEVEL 2 — TURN VIEW
// ══════════════════════════════════════════════════════════════════════

function TurnView({
  sessionId,
  turn,
}: {
  sessionId: string;
  turn: number;
}) {
  const { url, queryKey } = useRepoApi();
  const eventsQ = useQuery({
    queryKey: queryKey(["token-flow-events", sessionId, turn]),
    queryFn: () =>
      fetchJson<EventsResponse>(
        url(`/api/token-flow/events?session_id=${sessionId}&turn=${turn}`)
      ),
  });

  const cumulativeQ = useQuery({
    queryKey: queryKey(["token-flow-cumulative", sessionId]),
    queryFn: () =>
      fetchJson<CumulativeResponse>(
        url(`/api/token-flow/cumulative?session_id=${sessionId}`)
      ),
  });
  const thisTurnCumulative = cumulativeQ.data?.data?.find(
    (t) => t.turn === turn
  );
  const totalTurns = cumulativeQ.data?.total_turns ?? 0;
  const remainingTurns =
    totalTurns > 0
      ? totalTurns -
        (cumulativeQ.data?.data?.findIndex((t) => t.turn === turn) ?? 0) -
        1
      : 0;

  const events = eventsQ.data?.data ?? [];
  const eventsPerPage = 10;
  const [eventOffset, setEventOffset] = useState(0);
  const pagedEvents = events.slice(eventOffset, eventOffset + eventsPerPage);
  const totalSaved = events.reduce((s, e) => s + e.tokens_saved, 0);
  const totalWithout = events.reduce((s, e) => s + e.tokens_without, 0);
  const totalWith = events.reduce((s, e) => s + e.tokens_with, 0);
  const tools = [
    ...new Set(events.map((e) => e.tool).filter(Boolean)),
  ] as string[];
  const effPct =
    totalWithout > 0 ? Math.round((totalSaved / totalWithout) * 100) : 0;

  // Group by mechanism for summary
  const mechBreakdown: Record<string, MechanismSummary> = {};
  for (const e of events) {
    const existing = mechBreakdown[e.mechanism] ?? {
      tokens_saved: 0,
      tokens_delivered: 0,
      event_count: 0,
      pct_of_total: 0,
    };
    existing.tokens_saved += e.tokens_saved;
    existing.tokens_delivered += e.tokens_with;
    existing.event_count++;
    mechBreakdown[e.mechanism] = existing;
  }
  for (const data of Object.values(mechBreakdown)) {
    data.pct_of_total =
      totalSaved > 0 ? Math.round((data.tokens_saved / totalSaved) * 100) : 0;
  }

  if (eventsQ.isLoading) return <CardGridSkeleton n={4} />;

  return (
    <div className="space-y-6">
      {/* Turn summary — what happened */}
      {(() => {
        const { label, subtitle } = describeTurn(events);
        return (
          <div className="el-raised rounded-lg p-4 border-l-4 border-violet-500/60">
            <p className="text-foreground font-mono text-sm font-medium">
              {label}
            </p>
            {subtitle && (
              <p className="t-tertiary text-xs mt-0.5">{subtitle}</p>
            )}
          </div>
        );
      })()}

      {/* Turn KPIs — 3 cards with CountUp */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <AnimatedKpiCard
          label="Tokens Saved"
          rawValue={totalSaved}
          subtitle={
            tools.length > 0
              ? tools.slice(0, 2).join(", ") +
                (tools.length > 2 ? ` +${tools.length - 2}` : "")
              : "exec"
          }
          accent="emerald"
          hint="Tokens unerr rescued from agent responses this turn"
        />
        <KpiStatCard
          label="Rescue Rate"
          value={`${effPct}%`}
          subtitle={`${fmt(totalWithout)} → ${fmt(totalWith)}`}
          accent="violet"
          hint="Share of original tokens rescued this turn (Without − Delivered)"
        />
        <AnimatedKpiCard
          label="Context Avoided"
          rawValue={thisTurnCumulative?.context_avoided ?? 0}
          subtitle={
            remainingTurns > 0
              ? `carries to ${remainingTurns} more turn${remainingTurns === 1 ? "" : "s"}`
              : "carry-forward"
          }
          accent="cyan"
          hint="Cumulative token-turns of context pressure prevented at this point"
        />
      </div>

      {/* Mechanism breakdown for this turn */}
      {Object.keys(mechBreakdown).length > 0 && (
        <div className="el-raised rounded-lg p-5">
          <h3 className="t-secondary text-sm font-medium mb-3">
            Mechanisms in this Turn
          </h3>
          <MechanismBars mechanisms={mechBreakdown} totalSaved={totalSaved} />
        </div>
      )}

      {/* Mistakes prevented during this turn */}
      <TurnPreventionsList sessionId={sessionId} turn={turn} />

      {/* Event table — Splunk-style expandable rows */}
      <div className="el-raised rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
          <div>
            <h3 className="t-secondary text-sm font-medium">Events</h3>
            <p className="t-tertiary text-xs mt-0.5">
              Every savings event in turn #{turn}: tool calls, exec commands,
              and the mechanism that rescued tokens.
            </p>
          </div>
          <span className="t-tertiary text-xs">
            {events.length} event{events.length !== 1 ? "s" : ""}
          </span>
        </div>

        {events.length === 0 ? (
          <p className="px-5 py-6 t-secondary text-sm">
            No events for this turn.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm min-w-[900px]">
              <thead>
                <tr className="border-b border-border-subtle t-tertiary text-xs uppercase">
                  <th
                    className="px-5 py-3 font-medium"
                    title="When this savings event occurred"
                  >
                    Time
                  </th>
                  <th
                    className="px-3 py-3 font-medium"
                    title="Type of rescue applied (e.g. graph query, shell compression)"
                  >
                    Mechanism
                  </th>
                  <th
                    className="px-3 py-3 font-medium"
                    title="MCP tool that triggered this rescue"
                  >
                    Tool
                  </th>
                  <th
                    className="px-3 py-3 font-medium text-right"
                    title="Tokens that would have been sent without unerr"
                  >
                    Without
                  </th>
                  <th
                    className="px-3 py-3 font-medium text-right"
                    title="Tokens actually delivered to the agent after unerr's rescue"
                  >
                    Delivered
                  </th>
                  <th
                    className="px-3 py-3 font-medium text-right"
                    title="Tokens rescued by this savings event (Without − Delivered)"
                  >
                    Saved
                  </th>
                  <th
                    className="px-3 py-3 pr-5 font-medium"
                    title="Description of what was rescued"
                  >
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedEvents.map((evt) => {
                  const colors = mc(evt.mechanism);
                  const evtPct =
                    evt.tokens_without > 0
                      ? Math.round(
                          (evt.tokens_saved / evt.tokens_without) * 100
                        )
                      : 0;
                  return (
                    <tr
                      key={evt.id}
                      className="border-b border-border-subtle transition-colors hover:bg-white/[0.04]"
                    >
                      <td className="t-tertiary px-5 py-3 font-mono text-xs whitespace-nowrap">
                        {fmtTime(evt.ts)}
                      </td>
                      <td className="px-3 py-3">
                        <MechanismPill mechanism={evt.mechanism} />
                      </td>
                      <td className="t-secondary px-3 py-3 font-mono text-xs whitespace-nowrap">
                        {evt.tool ?? "—"}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                        {fmt(evt.tokens_without)}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                        {fmt(evt.tokens_with)}
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <span className="text-success font-mono font-medium text-xs">
                          {fmt(evt.tokens_saved)}
                        </span>
                        <span className="t-tertiary text-[10px] ml-1">
                          ({evtPct}%)
                        </span>
                      </td>
                      <td className="px-3 py-3 pr-5 font-mono text-xs max-w-[400px]">
                        <span className="t-secondary break-words leading-relaxed">
                          {describeEvent(evt)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border-subtle font-medium bg-white/[0.04]">
                  <td className="px-5 py-3" colSpan={3}>
                    <span className="t-secondary text-xs uppercase tracking-wider">
                      Turn Total
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">
                    {fmt(totalWithout)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">
                    {fmt(totalWith)}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <span className="text-success font-mono font-medium text-xs">
                      {fmt(totalSaved)}
                    </span>
                    <span className="t-tertiary text-[10px] ml-1">
                      ({effPct}%)
                    </span>
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <div className="px-5 py-2 border-t border-border-subtle">
          <Pagination
            total={events.length}
            limit={eventsPerPage}
            offset={eventOffset}
            onPageChange={setEventOffset}
          />
        </div>
      </div>

      {/* ── This turn on the other surfaces (§8 cross-link) ── */}
      <div className="el-raised rounded-lg p-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs">
        <button
          type="button"
          className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
          onClick={() =>
            navigateRoute("prompt-trace", {
              session: sessionId,
              turn: String(turn),
            })
          }
        >
          Open the prompt trace for turn {turn} →
        </button>
        <button
          type="button"
          className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
          onClick={() => navigateRoute("logbook", { session: sessionId })}
        >
          See this session in What unerr did →
        </button>
        <button
          type="button"
          className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
          onClick={() => navigateRoute("reasoning", { session: sessionId })}
        >
          See reasoning detail →
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// MAIN PAGE — Router with breadcrumb
// ══════════════════════════════════════════════════════════════════════

type ViewState =
  | { level: "global" }
  | { level: "session"; sessionId: string }
  | { level: "turn"; sessionId: string; turn: number };

export function TokenFlowPage() {
  const sessionId = useHashQueryParam("session") || null;
  const turnParam = useHashQueryParam("turn");
  const turn = turnParam ? Number(turnParam) : null;
  const windowParam = useHashQueryParam("window");
  const headroomWindow: HeadroomWindow =
    windowParam === "today" ||
    windowParam === "this_week" ||
    windowParam === "since_install"
      ? windowParam
      : "since_install";

  const view: ViewState =
    sessionId && Number.isFinite(turn)
      ? { level: "turn", sessionId, turn: turn as number }
      : sessionId
        ? { level: "session", sessionId }
        : { level: "global" };

  const setHeadroomWindow = (w: HeadroomWindow) =>
    setHashQueryParams({ window: w });
  const goGlobal = () => setHashQueryParams({ session: null, turn: null });
  const goSession = (id: string) =>
    setHashQueryParams({ session: id, turn: null });
  const goTurn = (id: string, t: number) =>
    setHashQueryParams({ session: id, turn: String(t) });

  const crumbs: Array<{ label: string; onClick?: () => void }> = [];

  if (view.level === "session" || view.level === "turn") {
    crumbs.push(
      { label: "All Sessions", onClick: goGlobal },
      {
        label: `Session ${view.sessionId.slice(0, 12)}`,
        onClick:
          view.level === "turn" ? () => goSession(view.sessionId) : undefined,
      }
    );
  }

  if (view.level === "turn") {
    crumbs.push({ label: `Turn #${view.turn}` });
  }

  return (
    <div>
      {/* Impact Hero — replaces the old HeadroomStrip with a Dashboard-level
       *  dominant-number anchor + contextual agent-aware explanation */}
      <ImpactHero
        windowSelected={headroomWindow}
        onWindowChange={setHeadroomWindow}
        sessionId={view.level === "global" ? undefined : view.sessionId}
      />

      {crumbs.length > 0 && <Breadcrumb items={crumbs} />}

      {view.level === "global" && <GlobalView onSelectSession={goSession} />}

      {view.level === "session" && (
        <SessionView
          sessionId={view.sessionId}
          onSelectTurn={(turn) => goTurn(view.sessionId, turn)}
        />
      )}

      {view.level === "turn" && (
        <TurnView sessionId={view.sessionId} turn={view.turn} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// IMPACT HERO — dominant-number anchor with psychology-driven layout
//
//  ┌──────────────────────────────────────────────────────────────┐
//  │  29.2M tokens saved (CountUp · emerald · anchoring bias)    │
//  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐               │
//  │  │ Turns  │ │ Reach  │ │ Rate   │ │ Avg    │  ← KPI cards  │
//  │  │ Earned │ │ /Sess  │ │ %      │ │ Turn   │  with InfoTip  │
//  │  └────────┘ └────────┘ └────────┘ └────────┘               │
//  │  [Today] [This Week] [Since Install]         (window chips)  │
//  │  ▸ first-visit callout (progressive disclosure, dismiss)     │
//  └──────────────────────────────────────────────────────────────┘
// ══════════════════════════════════════════════════════════════════════

interface SessionHeadroomResponse {
  data: {
    session_id: string;
    turn_count: number;
    avg_input_tokens_per_turn: number;
    total_tokens_saved: number;
    extra_turns_bought: number;
    headroom_compounded: number;
    turns_to_limit_with: number;
    turns_to_limit_without: number;
    per_turn: Array<{
      turn: number;
      tokens_saved: number;
      input_tokens: number;
      ts: string;
      headroom: number;
    }>;
  };
}

function ImpactHero({
  windowSelected,
  onWindowChange,
  sessionId,
}: {
  windowSelected: HeadroomWindow;
  onWindowChange: (next: HeadroomWindow) => void;
  sessionId?: string;
}) {
  const { url, queryKey } = useRepoApi();

  const globalQ = useQuery({
    queryKey: queryKey(["token-flow", "headroom"]),
    queryFn: () => fetchJson<HeadroomResponse>(url("/api/token-flow/headroom")),
    refetchInterval: 30_000,
  });

  const sessionQ = useQuery({
    queryKey: queryKey(["token-flow", "headroom-session", sessionId ?? ""]),
    queryFn: () =>
      sessionId
        ? fetchJson<SessionHeadroomResponse>(
            url(`/api/token-flow/headroom/session/${sessionId}`)
          )
        : Promise.resolve(null),
    enabled: !!sessionId,
  });

  const blocks = globalQ.data?.data;
  const sessionBlock = sessionQ.data?.data;
  const block = blocks?.[windowSelected];

  // Dominant number: total tokens saved (anchoring bias — largest number first)
  const totalSavedRaw = sessionBlock
    ? sessionBlock.total_tokens_saved
    : (block?.total_tokens_saved ?? 0);

  // Turns earned (credit-billed agents)
  const turnsEarnedRaw = sessionBlock
    ? sessionBlock.headroom_compounded
    : (block?.headroom_turns ?? 0);
  const turnsOver = sessionBlock
    ? sessionBlock.turn_count
    : (block?.turns_observed ?? 0);

  // Reach/session (window-billed agents)
  const reachSource = sessionBlock ?? blocks?.since_install;
  const reachWith = reachSource?.turns_to_limit_with ?? 0;
  const reachWithout = reachSource?.turns_to_limit_without ?? 0;
  const reachGain = Math.max(0, reachWith - reachWithout);

  // Avg turn tokens
  const avgWithout = block?.avg_turn_tokens_without ?? 0;
  const avgWith = Math.max(0, avgWithout - (block?.avg_saved_per_turn ?? 0));

  // Agent-aware highlighting (Von Restorff effect — isolate the relevant metric)
  const latestAgent = sessionBlock ? undefined : undefined;
  const billing = detectBillingModel(latestAgent);
  const turnsHighlight = billing === "credit" || billing === "unknown";
  const reachHighlight = billing === "window" || billing === "unknown";

  const windowLabel = (w: HeadroomWindow) =>
    w === "today" ? "Today" : w === "this_week" ? "This Week" : "Since Install";

  return (
    <section className="mb-6">
      {/* Dominant number — anchoring bias: largest, most impressive value first */}
      <div className="el-raised rounded-xl overflow-hidden">
        <div className="relative px-6 pt-6 pb-5">
          {/* Gradient wash — emerald top tint */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-linear-to-b from-emerald-500/6 to-transparent"
          />
          <div className="relative flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <div>
              <p className="text-emerald-400 text-[10px] uppercase tracking-wider font-medium flex items-center gap-1.5">
                Tokens Saved
                <InfoTip text="Counts tokens unerr removed from the operations it touched — file reads, web fetches, shell output, dedup. Does not include system prompt, tool schemas, conversation history, reasoning, or native Read/Edit calls." />
              </p>
              <p className="text-5xl sm:text-6xl font-bold font-mono text-emerald-400 mt-2 tabular-nums tracking-tighter leading-none">
                <CountUp value={totalSavedRaw} format={fmt} />
              </p>
              <p className="t-secondary text-xs mt-2">
                on operations unerr handled
                {!sessionId && (
                  <span className="t-tertiary ml-1">
                    · {windowLabel(windowSelected).toLowerCase()}
                  </span>
                )}
              </p>
            </div>

            {/* Window chips — only on global view */}
            {!sessionId && (
              <div className="flex items-center gap-1">
                {(["today", "this_week", "since_install"] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => onWindowChange(w)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                      windowSelected === w
                        ? "bg-emerald-500/20 text-emerald-300 shadow-sm"
                        : "bg-surface-secondary t-secondary hover:bg-surface-tertiary hover:text-foreground"
                    }`}
                  >
                    {windowLabel(w)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 4-card KPI grid (Stripe dashboard pattern — supporting stats beneath anchor) */}
        <div className="grid grid-cols-2 lg:grid-cols-4 border-t border-border-subtle divide-x divide-border-subtle">
          {/* Turns Earned — credit-billed agents */}
          <div
            className={`px-5 py-4 transition-all ${turnsHighlight ? "bg-emerald-500/3" : ""}`}
          >
            <p className="text-emerald-400 text-[10px] uppercase tracking-wider font-medium flex items-center gap-1.5">
              Turns Earned
              <InfoTip text="Extra turns you got for free. Calculated as total tokens saved divided by average tokens per turn. Applies to credit-billed agents — Cursor fast-requests, API metered requests." />
            </p>
            <p className="text-2xl font-bold font-mono text-emerald-400 mt-1.5 tabular-nums">
              +<CountUp value={turnsEarnedRaw} format={fmt} />
            </p>
            <p className="t-tertiary text-[11px] mt-1">
              over {fmt(turnsOver)} turn{turnsOver === 1 ? "" : "s"}
            </p>
            {turnsHighlight && (
              <div className="mt-2 h-0.5 w-8 rounded-full bg-emerald-400/40" />
            )}
          </div>

          {/* Reach/Session — window-billed agents */}
          <div
            className={`px-5 py-4 transition-all ${reachHighlight ? "bg-violet-500/3" : ""}`}
          >
            <p className="text-violet-400 text-[10px] uppercase tracking-wider font-medium flex items-center gap-1.5">
              Reach / Session
              <InfoTip text="Per-session ceiling extension: how many more turns each session can reach before context exhaustion. Derived from lifetime average, stable across windows. Applies to window-billed agents — Claude Code 5-hour windows, Copilot Pro caps." />
            </p>
            <p className="text-2xl font-bold font-mono text-violet-400 mt-1.5 tabular-nums">
              +<CountUp value={reachGain} format={fmt} />
            </p>
            <p className="t-tertiary text-[11px] mt-1">
              up to turn {fmt(reachWith)}
            </p>
            {reachHighlight && (
              <div className="mt-2 h-0.5 w-8 rounded-full bg-violet-400/40" />
            )}
          </div>

          {/* Rescue Rate */}
          <div className="px-5 py-4">
            <p className="text-cyan-400 text-[10px] uppercase tracking-wider font-medium flex items-center gap-1.5">
              Rescue Rate
              <InfoTip text="Share of original tokens that unerr rescued — saved ÷ original. Higher means more compression per operation." />
            </p>
            <p className="text-2xl font-bold font-mono text-cyan-400 mt-1.5 tabular-nums">
              {block
                ? `${Math.round((block.avg_saved_per_turn / (block.avg_turn_tokens_without || 1)) * 100)}%`
                : "—"}
            </p>
            <p className="t-tertiary text-[11px] mt-1">tokens kept out</p>
          </div>

          {/* Avg Turn Tokens */}
          <div className="px-5 py-4">
            <p className="text-foreground/60 text-[10px] uppercase tracking-wider font-medium flex items-center gap-1.5">
              Avg Turn
              <InfoTip text="Average tokens per turn without unerr vs with unerr. The gap shows how much context pressure unerr removes on every turn." />
            </p>
            <p className="text-2xl font-bold font-mono text-foreground mt-1.5 tabular-nums">
              {fmt(avgWithout)}
            </p>
            <p className="t-tertiary text-[11px] mt-1">
              vs {fmt(avgWith)} with unerr
            </p>
          </div>
        </div>
      </div>

      {/* First-visit callout — progressive disclosure for billing model.
       *  Shows on first visit, dismisses permanently to localStorage. */}
      <FirstVisitCallout storageKey="unerr-token-trace-billing-explained">
        <div className="pr-12">
          <p className="text-violet-300 text-[11px] font-medium mb-1">
            Two metrics, two billing models
          </p>
          <p className="t-secondary text-[11px] leading-relaxed">
            <span className="text-emerald-300 font-medium">Turns earned</span>{" "}
            is usage-cumulative — extra prompts within your request quota.
            Relevant for credit-billed agents (Cursor fast-requests, API
            requests).{" "}
            <span className="text-violet-300 font-medium">Reach/session</span>{" "}
            is a per-session ceiling — extra turns before context exhaustion.
            Relevant for window-billed agents (Claude Code 5h windows, Copilot
            Pro caps). One of the two holds for your agent's billing model.
          </p>
        </div>
      </FirstVisitCallout>
    </section>
  );
}
