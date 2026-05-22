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
import { HeadroomStrip, type HeadroomWindow } from "@/components/HeadroomStrip";
import { CardGridSkeleton, SkeletonBlock } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { setHashQueryParams, useHashQueryParam } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AgentBadge } from "./token-trace/components/AgentBadge";
import { Breadcrumb } from "./token-trace/components/Breadcrumb";
import { KpiStatCard } from "./token-trace/components/KpiStatCard";
import { MechanismPill } from "./token-trace/components/MechanismPill";
import { Pagination } from "./token-trace/components/Pagination";
import { SavingsTrend } from "./token-trace/components/SavingsTrend";
import {
  ALL_MECHANISMS,
  BEHAVIOR_EVENT_DESCRIPTIONS,
  BEHAVIOR_EVENT_LABELS,
  type CumulativeResponse,
  type CumulativeTurn,
  type EventsResponse,
  type GlobalResponse,
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

// ── Shared sub-components ───────────────────────────────────────────

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
            <div className="flex-1 h-5 rounded bg-surface-secondary overflow-hidden">
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

// ── Preventions Pane ─────────────────────────────────────────────────
//
// Surfaces PREVENT-class counters (graph queries served, file reads
// avoided, retry loops broken, …). These are *not* token-savings rows
// — they're discrete named events. We deliberately do not invent a
// "would have cost N tokens" number because the counterfactual is
// unknowable. The user reads the counts; the count *is* the value.
//
// Pattern: Turborepo "FULL TURBO" / GitHub Security "alerts dismissed".

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
        ? " (Filtered)"
        : " (All Time)"
      : " (This Session)";

  const entries = useMemo(() => {
    if (!counts) return [] as Array<[string, number]>;
    return Object.entries(counts.by_type).sort(([, a], [, b]) => b - a);
  }, [counts]);

  return (
    <div className="el-raised rounded-lg p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="t-secondary text-sm font-medium">
          Preventions{headerSuffix}
        </h3>
        <span className="t-tertiary text-xs">
          {counts ? counts.total : 0} total
        </span>
      </div>
      <p className="t-tertiary text-xs mb-3 leading-snug">
        Discrete named counters for PREVENT-class wins — graph queries served,
        file reads avoided, retry loops broken. No counterfactual byte count:
        the count itself is the measure.
      </p>
      {q.isLoading ? (
        <SkeletonBlock height={120} />
      ) : entries.length === 0 ? (
        <p className="t-secondary text-sm py-3">No behavioral events yet.</p>
      ) : (
        <div className="space-y-1.5">
          {entries.map(([type, n]) => (
            <div
              key={type}
              className="flex items-center gap-3 py-1"
              title={BEHAVIOR_EVENT_DESCRIPTIONS[type] ?? type}
            >
              <span className="text-violet-300 text-xs font-medium w-52 shrink-0 truncate">
                {BEHAVIOR_EVENT_LABELS[type] ?? type.replace(/_/g, " ")}
              </span>
              <div className="flex-1 h-5 rounded bg-surface-secondary overflow-hidden">
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

// ── Turn-scoped behavioral events list ────────────────────────────────
//
// Raw, time-ordered events for a single turn. The Session view shows
// aggregates; the Turn view shows the actual events one-by-one so the
// user can read what the agent was prevented from doing.

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

  const events = q.data?.data ?? [];

  return (
    <div className="el-raised rounded-lg p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="t-secondary text-sm font-medium">
          Preventions in this Turn
        </h3>
        <span className="t-tertiary text-xs">
          {events.length} event{events.length !== 1 ? "s" : ""}
        </span>
      </div>
      <p className="t-tertiary text-xs mb-3 leading-snug">
        PREVENT-class events fired during turn #{turn}. Each row is a discrete
        win — a graph query served, a full read avoided, a retry loop broken.
      </p>
      {events.length === 0 ? (
        <p className="t-secondary text-sm py-3">
          No behavioral events in this turn.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[700px]">
            <thead>
              <tr className="border-b border-border-subtle t-tertiary uppercase">
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Tool</th>
                <th className="px-3 py-2 font-medium">Entity</th>
                <th className="px-3 py-2 font-medium text-right">Bytes</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={`${e.session_id}-${e.id}-${e.ts}`}
                  className="border-b border-border-subtle/40 hover:bg-surface-secondary/40"
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
          className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 text-xs font-medium t-secondary hover:text-foreground hover:bg-surface-secondary transition-colors"
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

      {/* Global KPI row — Big Four (matches Reasoning Trace aesthetic) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiStatCard
          label="Tokens Saved"
          value={fmt(g.total_tokens_saved)}
          subtitle="direct rescue"
          accent="emerald"
          hint="Tokens removed from agent responses before they could weigh down context"
        />
        <KpiStatCard
          label="Context Avoided"
          value={fmt(g.total_context_avoided)}
          subtitle={
            g.total_tokens_saved > 0
              ? `${(g.total_context_avoided / g.total_tokens_saved).toFixed(1)}× compounded`
              : "carried forward"
          }
          accent="cyan"
          hint="Total token-turns of context pressure prevented — savings compound because each turn's rescue carries forward to all future turns"
        />
        <KpiStatCard
          label="Rescue Rate"
          value={`${g.efficiency_pct}%`}
          subtitle="tokens kept out"
          accent="violet"
          hint="Share of original tokens that unerr rescued (saved ÷ original)"
        />
        <KpiStatCard
          label="Sessions"
          value={g.total_sessions}
          subtitle={`${g.total_turns} turn${g.total_turns === 1 ? "" : "s"}`}
          accent="fuchsia"
          hint="Distinct agent sessions tracked, plus total turns across them"
        />
      </div>

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

      {/* Global mechanism breakdown */}
      <div className="el-raised rounded-lg p-5">
        <h3 className="t-secondary text-sm font-medium mb-1">
          Savings by Mechanism
          {fromTs || toTs ? " (Filtered)" : " (All Time)"}
        </h3>
        <p className="t-tertiary text-xs mb-3 leading-snug">
          COMPRESS-class: physically measured bytes removed before the response
          reached the agent.
        </p>
        <MechanismBars
          mechanisms={g.by_mechanism}
          totalSaved={g.total_tokens_saved}
        />
      </div>

      {/* Global behavioral events — PREVENT-class verb-noun counters */}
      <PreventionsPane scope="global" fromTs={fromTs} toTs={toTs} />

      {/* Session list — the primary navigation into drill-down */}
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
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm min-w-[700px]">
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
                      className="px-3 py-2.5 font-medium"
                      title="Number of savings events in this session"
                    >
                      Events
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium"
                      title="Types of rescue applied (e.g. graph query, shell compression)"
                    >
                      Mechanisms
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-right"
                      title="Total tokens saved from agent responses (direct rescue)"
                    >
                      Tokens Saved
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-right"
                      title="Average tokens of context pressure avoided per turn — savings compound because each turn's rescue carries to all future turns"
                    >
                      Avg Context Saved
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
                      <td className="px-3 py-3 font-mono text-xs tabular-nums">
                        {s.event_count}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {s.mechanisms.slice(0, 4).map((m) => (
                            <MechanismPill key={m} mechanism={m} />
                          ))}
                          {s.mechanisms.length > 4 && (
                            <span className="t-tertiary text-[10px]">
                              +{s.mechanisms.length - 4}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span className="text-success font-mono font-medium text-sm">
                          {fmt(s.total_saved)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        {s.avg_context_reduction > 0 ? (
                          <span
                            className="text-cyan-400 font-mono font-medium text-sm"
                            title={`Each turn ran with ~${fmt(s.avg_context_reduction)} fewer tokens in context on average (across ${s.total_turns} turns)`}
                          >
                            {fmt(s.avg_context_reduction)}
                          </span>
                        ) : (
                          <span className="t-tertiary font-mono text-sm">
                            —
                          </span>
                        )}
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
      {/* Session KPIs — Big Four */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiStatCard
          label="Tokens Saved"
          value={fmt(s.total_tokens_saved)}
          subtitle="direct rescue"
          accent="emerald"
          hint="Tokens unerr rescued from agent responses this session"
        />
        <KpiStatCard
          label="Context Avoided"
          value={fmt(cumulativeQ.data?.total_context_avoided ?? 0)}
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
        <KpiStatCard
          label="Turns"
          value={s.total_turns}
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

      {/* Two-column: Cumulative chart + Mechanism breakdown */}
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

        {/* Mechanism breakdown */}
        <div className="el-raised rounded-lg p-5">
          <h3 className="t-secondary text-sm font-medium mb-1">
            Savings by Mechanism
          </h3>
          <p className="t-tertiary text-xs mb-3 leading-snug">
            COMPRESS-class: measured bytes removed from this session's tool
            responses.
          </p>
          <MechanismBars
            mechanisms={s.by_mechanism}
            totalSaved={s.total_tokens_saved}
          />
        </div>

        {/* Behavioral events for this session */}
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
                      className="border-b border-border-subtle hover:bg-surface-secondary transition-colors cursor-pointer group"
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
                        <div className="w-32 h-4 relative rounded-sm bg-surface-secondary overflow-hidden">
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

      {/* Turn KPIs — 3 cards (tokens / rescue rate / context avoided) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiStatCard
          label="Tokens Saved"
          value={fmt(totalSaved)}
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
        <KpiStatCard
          label="Context Avoided"
          value={fmt(thisTurnCumulative?.context_avoided ?? 0)}
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

      {/* Behavioral events fired during this turn */}
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
                      className="border-b border-border-subtle hover:bg-surface-secondary transition-colors"
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
                <tr className="border-t border-border-subtle font-medium bg-surface-secondary/30">
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
  // URL-backed state — view (session+turn) and window are all driven from
  // the hash query-string, so reloads and shared links land in the same
  // drill-down level. `?session=` and `?turn=` together describe the view
  // level: neither → global, session only → session, both → turn.
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

  // Build breadcrumb — only shown when drilled into session/turn (header already says "Token Trace")
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
      <HeadroomStrip
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
