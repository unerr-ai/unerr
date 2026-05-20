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
import { CardGridSkeleton, SkeletonBlock } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────

interface MechanismSummary {
  tokens_saved: number;
  tokens_delivered: number;
  event_count: number;
  pct_of_total: number;
}

interface GlobalResponse {
  data: {
    total_sessions: number;
    total_turns: number;
    total_tokens_without: number;
    total_tokens_with: number;
    total_tokens_saved: number;
    efficiency_pct: number;
    by_mechanism: Record<string, MechanismSummary>;
    event_count: number;
    avg_context_reduction: number;
    peak_context_reduction: number;
    total_context_avoided: number;
  };
}

interface SessionListEntry {
  session_id: string;
  event_count: number;
  total_saved: number;
  total_turns: number;
  avg_context_reduction: number;
  first_ts: string;
  last_ts: string;
  mechanisms: string[];
  agent_name: string | null;
}

interface SessionListResponse {
  data: SessionListEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface EventsResponse {
  data: TokenFlowEvent[];
  total: number;
  limit: number;
  offset: number;
}

interface SessionSummaryResponse {
  data: {
    session_id: string;
    total_turns: number;
    total_tokens_without: number;
    total_tokens_with: number;
    total_tokens_saved: number;
    efficiency_pct: number;
    by_mechanism: Record<string, MechanismSummary>;
    top_turns: Array<{
      turn: number;
      tool: string;
      tokens_without: number;
      tokens_delivered: number;
      tokens_saved: number;
      primary_mechanism: string;
    }>;
    event_count: number;
  } | null;
  _meta: { latency_ms: number };
}

interface TokenFlowEvent {
  id: number;
  ts: string;
  pid: number;
  turn: number;
  mechanism: string;
  tool: string | null;
  tokens_without: number;
  tokens_with: number;
  tokens_saved: number;
  session_id: string;
  detail?: Record<string, unknown>;
}

interface CumulativeTurn {
  turn: number;
  tools: string[];
  tokens_saved_this_turn: number;
  cumulative_tokens_saved: number;
  context_avoided: number;
  mechanisms_this_turn: Record<string, number>;
  cumulative_by_mechanism: Record<string, number>;
  event_count: number;
}

interface CumulativeResponse {
  data: CumulativeTurn[];
  total_turns: number;
  total_saved: number;
  avg_context_reduction: number;
  peak_context_reduction: number;
  total_context_avoided: number;
}

// ── Constants ────────────────────────────────────────────────────────

// COMPRESS-class mechanisms only. Graph queries and behavior interventions
// are PREVENT-class — they have no counterfactual byte count, so they
// appear in the Behavioral Events pane (verb-noun counters) instead.
const MECH_COLORS: Record<
  string,
  { bg: string; text: string; bar: string; ring: string }
> = {
  shell_compression: {
    bg: "bg-cyan-500/20",
    text: "text-cyan-400",
    bar: "bg-cyan-500",
    ring: "ring-cyan-500/40",
  },
  format_encoding: {
    bg: "bg-amber-500/20",
    text: "text-amber-400",
    bar: "bg-amber-500",
    ring: "ring-amber-500/40",
  },
  session_dedup: {
    bg: "bg-emerald-500/20",
    text: "text-emerald-400",
    bar: "bg-emerald-500",
    ring: "ring-emerald-500/40",
  },
  smart_truncation: {
    bg: "bg-blue-500/20",
    text: "text-blue-400",
    bar: "bg-blue-500",
    ring: "ring-blue-500/40",
  },
  file_read: {
    bg: "bg-indigo-500/20",
    text: "text-indigo-400",
    bar: "bg-indigo-500",
    ring: "ring-indigo-500/40",
  },
  fetch_url: {
    bg: "bg-teal-500/20",
    text: "text-teal-400",
    bar: "bg-teal-500",
    ring: "ring-teal-500/40",
  },
};

const ALL_MECHANISMS = [
  "shell_compression",
  "format_encoding",
  "session_dedup",
  "smart_truncation",
  "file_read",
  "fetch_url",
];

// Behavioral event types (PREVENT-class). Each one is a discrete named
// count surfaced in the Behavioral Events pane. The legend lives next to
// the pane so users can read what each counter means.
const BEHAVIOR_EVENT_LABELS: Record<string, string> = {
  graph_query_served: "Graph query served",
  full_read_avoided: "Full file read avoided",
  loop_broken: "Retry loop broken",
  cascade_guard: "Cascade guard fired",
  drift_consumed: "Drift signal consumed",
  intervention_halted: "Behavior intervention halted",
  intervention_warned: "Behavior warning emitted",
  defuddle_selector_skipped: "Defuddle selector skipped",
};

const BEHAVIOR_EVENT_DESCRIPTIONS: Record<string, string> = {
  graph_query_served:
    "Agent's graph-tool call (search_code, get_references, …) was served from the local graph instead of grep + N file reads.",
  full_read_avoided:
    "file_outline / get_file delivered a structural summary instead of a full file read.",
  loop_broken:
    "Circuit breaker halted a retry loop the agent was about to enter on the same entity.",
  cascade_guard:
    "A high fan-in edit was gated by the cascade guard before propagating.",
  drift_consumed:
    "A drift signal (`ur|dft`) was consumed — agent re-read the file before editing.",
  intervention_halted:
    "A pre-tool-use behavior halted a tool call before it ran.",
  intervention_warned:
    "A behavior emitted a warning but allowed the call to proceed.",
  defuddle_selector_skipped:
    "fetch_url's Defuddle extractor hit a non-fatal selector-parse error (nwsapi rejected a `:has()`/Tailwind arbitrary-value selector). First occurrence per signature is logged once; subsequent occurrences are counted only.",
};

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

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function mc(mechanism: string) {
  return (
    MECH_COLORS[mechanism] ?? {
      bg: "bg-zinc-500/20",
      text: "text-zinc-400",
      bar: "bg-zinc-500",
      ring: "ring-zinc-500/40",
    }
  );
}

/** Human-readable description of a single event from its detail field */
function describeEvent(evt: TokenFlowEvent): string {
  const d = evt.detail;
  if (!d) return evt.tool ?? "optimization";

  // Shell compression — show the actual command
  if (d.command) {
    const cmd = String(d.command);
    // Shorten long commands: keep first 80 chars
    return cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd;
  }

  // File read optimization — show the window/entity info
  if (d.optimization) {
    return String(d.optimization);
  }

  // Graph query / format encoding — show counterfactual or format
  if (d.counterfactual && d.counterfactual !== "generic file exploration") {
    return String(d.counterfactual);
  }
  if (d.format) {
    return `${evt.tool ?? "query"} → ${d.format} format`;
  }

  return evt.tool ?? "optimization";
}

/** Human-readable summary label for an entire turn (group of events) */
function describeTurn(events: TokenFlowEvent[]): {
  label: string;
  subtitle: string;
} {
  if (events.length === 0) return { label: "Empty turn", subtitle: "" };

  const tools = [
    ...new Set(events.map((e) => e.tool).filter(Boolean)),
  ] as string[];
  const mechs = [...new Set(events.map((e) => e.mechanism))];

  // Shell compression turns — show the actual command
  const shellEvt = events.find((e) => e.detail?.command);
  if (shellEvt) {
    const cmd = String(shellEvt.detail?.command);
    // Extract the meaningful part of the command
    const short = cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd;
    return {
      label: short,
      subtitle: `shell → ${events.length} optimization${events.length > 1 ? "s" : ""}`,
    };
  }

  // File read with entity/window info
  const fileEvt = events.find((e) => e.detail?.optimization);
  if (fileEvt) {
    const opt = String(fileEvt.detail?.optimization);
    const extra = events.length > 1 ? ` +${events.length - 1} more` : "";
    return { label: opt, subtitle: tools.join(", ") + extra };
  }

  // Graph query turns — describe by tool combination
  if (tools.length > 0) {
    const toolSummary = tools.join(" → ");
    const evtCount = events.length;
    const primaryMech = mechs[0]?.replace(/_/g, " ") ?? "";
    return {
      label: toolSummary,
      subtitle: `${evtCount} event${evtCount > 1 ? "s" : ""} · ${primaryMech}`,
    };
  }

  return {
    label: mechs.map((m) => m.replace(/_/g, " ")).join(", "),
    subtitle: `${events.length} event${events.length > 1 ? "s" : ""}`,
  };
}

// ── Shared sub-components ───────────────────────────────────────────

function KpiCard({
  label,
  value,
  accent,
  hint,
}: { label: string; value: string | number; accent?: string; hint?: string }) {
  return (
    <div className="el-raised rounded-lg p-4" title={hint}>
      <p className="t-tertiary text-xs uppercase tracking-wider">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold font-mono tabular-nums ${accent ?? "text-foreground"}`}
      >
        {value}
      </p>
    </div>
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

function MechanismPill({ mechanism }: { mechanism: string }) {
  const colors = mc(mechanism);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 ${colors.bg} ${colors.text} text-[10px] font-medium`}
    >
      {mechanism.replace(/_/g, " ")}
    </span>
  );
}

/** Breadcrumb navigation */
function Breadcrumb({
  items,
}: {
  items: Array<{ label: string; onClick?: () => void }>;
}) {
  return (
    <nav className="flex items-center gap-1.5 text-sm mb-5">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={item.label} className="flex items-center gap-1.5">
            {i > 0 && <span className="t-tertiary">›</span>}
            {isLast ? (
              <span className="text-foreground font-medium">{item.label}</span>
            ) : (
              <button
                type="button"
                className="text-violet-400 hover:text-violet-300 transition-colors cursor-pointer"
                onClick={item.onClick}
              >
                {item.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

const AGENT_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  "claude-code": {
    bg: "bg-amber-500/20",
    text: "text-amber-400",
    label: "Claude Code",
  },
  "claude-desktop": {
    bg: "bg-amber-500/20",
    text: "text-amber-400",
    label: "Claude Desktop",
  },
  cursor: { bg: "bg-blue-500/20", text: "text-blue-400", label: "Cursor" },
  cline: { bg: "bg-emerald-500/20", text: "text-emerald-400", label: "Cline" },
  windsurf: { bg: "bg-cyan-500/20", text: "text-cyan-400", label: "Windsurf" },
  copilot: { bg: "bg-zinc-500/20", text: "text-zinc-400", label: "Copilot" },
};

function AgentBadge({ name }: { name: string | null }) {
  if (!name) return <span className="t-tertiary text-[10px]">unknown</span>;
  const normalized = name.toLowerCase().replace(/\s+/g, "-");
  const style = AGENT_STYLES[normalized] ?? {
    bg: "bg-zinc-500/20",
    text: "text-zinc-400",
    label: name,
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 ${style.bg} ${style.text} text-[10px] font-medium`}
    >
      {style.label}
    </span>
  );
}

function Pagination({
  total,
  limit,
  offset,
  onPageChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onPageChange: (newOffset: number) => void;
}) {
  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between px-1 py-2">
      <span className="t-tertiary text-xs">
        {offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={currentPage <= 1}
          className="px-2.5 py-1 rounded text-xs font-medium bg-surface-secondary hover:bg-surface-tertiary disabled:opacity-30 disabled:cursor-not-allowed text-foreground transition-colors"
          onClick={() => onPageChange(Math.max(0, offset - limit))}
        >
          ‹ Prev
        </button>
        <span className="t-secondary text-xs px-2 font-mono">
          {currentPage}/{totalPages}
        </span>
        <button
          type="button"
          disabled={currentPage >= totalPages}
          className="px-2.5 py-1 rounded text-xs font-medium bg-surface-secondary hover:bg-surface-tertiary disabled:opacity-30 disabled:cursor-not-allowed text-foreground transition-colors"
          onClick={() => onPageChange(offset + limit)}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}

// ── Behavioral Events Pane ───────────────────────────────────────────
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

function BehaviorEventsPane({
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
          Behavioral Events{headerSuffix}
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

function TurnBehaviorEvents({
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
          Behavioral Events in this Turn
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
  const [fromTs, setFromTs] = useState("");
  const [toTs, setToTs] = useState("");
  const [sessionOffset, setSessionOffset] = useState(0);
  const sessionLimit = 20;

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
          onChange={(f, t) => {
            setFromTs(f);
            setToTs(t);
            setSessionOffset(0);
          }}
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

      {/* Global KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiCard
          label="Total Tokens Saved"
          value={fmt(g.total_tokens_saved)}
          accent="text-success"
          hint="Total tokens removed from responses across all sessions — direct savings before context compounding"
        />
        <KpiCard
          label="Context Avoided"
          value={fmt(g.total_context_avoided)}
          accent="text-cyan-400"
          hint="Total token-turns of context pressure prevented — savings compound because each turn's reduction carries forward to all future turns"
        />
        <KpiCard
          label="Total Delivered"
          value={fmt(g.total_tokens_with)}
          hint="Total tokens actually sent to the agent after optimization"
        />
        <KpiCard
          label="Efficiency"
          value={`${g.efficiency_pct}%`}
          accent="text-violet-400"
          hint="Percentage of original tokens that were optimized away (saved ÷ original)"
        />
        <KpiCard
          label="Sessions"
          value={g.total_sessions}
          hint="Number of distinct agent sessions tracked"
        />
      </div>

      {/* Context pressure prevented — shows cascading impact */}
      {g.avg_context_reduction > 0 && (
        <div className="el-raised rounded-lg p-5 border-l-4 border-cyan-500/60">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-foreground text-sm font-medium">
                Context Pressure Prevented
              </h3>
              <p className="t-tertiary text-xs mt-1 max-w-xl">
                Across {g.total_sessions} session
                {g.total_sessions !== 1 ? "s" : ""} and {g.total_turns} turns,{" "}
                <span className="text-cyan-400 font-medium">
                  {fmt(g.total_context_avoided)}
                </span>{" "}
                total token-turns of context avoided — each turn ran with{" "}
                {fmt(g.avg_context_reduction)} fewer tokens on average, peaking
                at {fmt(g.peak_context_reduction)}.
              </p>
            </div>
            <div className="flex gap-6 shrink-0">
              <div className="text-right">
                <p className="t-tertiary text-[10px] uppercase tracking-wider">
                  Total Context Avoided
                </p>
                <p className="text-cyan-400 font-mono font-medium text-lg">
                  {fmt(g.total_context_avoided)}
                </p>
              </div>
              <div className="text-right">
                <p className="t-tertiary text-[10px] uppercase tracking-wider">
                  Avg / Turn
                </p>
                <p className="text-foreground font-mono font-medium text-lg">
                  {fmt(g.avg_context_reduction)}
                </p>
              </div>
              <div className="text-right">
                <p className="t-tertiary text-[10px] uppercase tracking-wider">
                  Direct Savings
                </p>
                <p className="text-success font-mono font-medium text-lg">
                  {fmt(g.total_tokens_saved)}
                </p>
              </div>
              <div className="text-right">
                <p className="t-tertiary text-[10px] uppercase tracking-wider">
                  Compound Multiplier
                </p>
                <p className="text-violet-400 font-mono font-medium text-lg">
                  {g.total_tokens_saved > 0
                    ? `${(g.total_context_avoided / g.total_tokens_saved).toFixed(1)}×`
                    : "—"}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global mechanism breakdown */}
      <div className="el-raised rounded-lg p-5">
        <h3 className="t-secondary text-sm font-medium mb-1">
          Savings by Mechanism{fromTs || toTs ? " (Filtered)" : " (All Time)"}
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
      <BehaviorEventsPane scope="global" fromTs={fromTs} toTs={toTs} />

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
                      title="Number of optimization events in this session"
                    >
                      Events
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium"
                      title="Types of optimization applied (e.g. graph query, shell compression)"
                    >
                      Mechanisms
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-right"
                      title="Total tokens removed from responses (direct savings)"
                    >
                      Tokens Saved
                    </th>
                    <th
                      className="px-3 py-2.5 font-medium text-right"
                      title="Average tokens of context pressure avoided per turn — savings compound because each turn's reduction carries to all future turns"
                    >
                      Avg Context Reduced
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
  const turnsPerPage = 20;

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
      {/* Session KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiCard
          label="Tokens Saved"
          value={fmt(s.total_tokens_saved)}
          accent="text-success"
          hint="Tokens removed from responses in this session"
        />
        <KpiCard
          label="Delivered"
          value={fmt(s.total_tokens_with)}
          hint="Tokens actually sent to the agent after optimization"
        />
        <KpiCard
          label="Without unerr"
          value={fmt(s.total_tokens_without)}
          hint="Tokens that would have been sent without unerr"
        />
        <KpiCard
          label="Efficiency"
          value={`${s.efficiency_pct}%`}
          accent="text-violet-400"
          hint="Percentage of original tokens optimized away"
        />
        <KpiCard
          label="Turns"
          value={s.total_turns}
          hint="Number of conversation turns in this session"
        />
      </div>

      {/* Context pressure prevented for this session */}
      {(cumulativeQ.data?.avg_context_reduction ?? 0) > 0 &&
        (() => {
          const cs = cumulativeQ.data!;
          return (
            <div className="el-raised rounded-lg p-5 border-l-4 border-cyan-500/60">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h3 className="text-foreground text-sm font-medium">
                    Context Pressure Prevented
                  </h3>
                  <p className="t-tertiary text-xs mt-1 max-w-xl">
                    Across {s.total_turns} turns,{" "}
                    <span className="text-cyan-400 font-medium">
                      {fmt(cs.total_context_avoided)}
                    </span>{" "}
                    total token-turns of context avoided — each turn ran with{" "}
                    {fmt(cs.avg_context_reduction)} fewer tokens on average,
                    peaking at {fmt(cs.peak_context_reduction)}.
                  </p>
                </div>
                <div className="flex gap-6 shrink-0">
                  <div className="text-right">
                    <p className="t-tertiary text-[10px] uppercase tracking-wider">
                      Total Context Avoided
                    </p>
                    <p className="text-cyan-400 font-mono font-medium text-lg">
                      {fmt(cs.total_context_avoided)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="t-tertiary text-[10px] uppercase tracking-wider">
                      Avg / Turn
                    </p>
                    <p className="text-foreground font-mono font-medium text-lg">
                      {fmt(cs.avg_context_reduction)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="t-tertiary text-[10px] uppercase tracking-wider">
                      Direct Savings
                    </p>
                    <p className="text-success font-mono font-medium text-lg">
                      {fmt(s.total_tokens_saved)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="t-tertiary text-[10px] uppercase tracking-wider">
                      Compound Multiplier
                    </p>
                    <p className="text-violet-400 font-mono font-medium text-lg">
                      {s.total_tokens_saved > 0
                        ? `${(cs.total_context_avoided / s.total_tokens_saved).toFixed(1)}×`
                        : "—"}
                    </p>
                  </div>
                </div>
              </div>
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
        <BehaviorEventsPane scope="session" sessionId={sessionId} />
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
                    title="Types of optimization applied in this turn"
                  >
                    Mechanisms
                  </th>
                  <th
                    className="px-3 py-2.5 font-medium text-right"
                    title="Tokens removed from responses in this turn (direct savings)"
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
                    title="Number of optimization events in this turn"
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
  const eventsPerPage = 20;
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

      {/* Turn KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiCard
          label="Tokens Saved"
          value={fmt(totalSaved)}
          accent="text-success"
          hint="Tokens removed in this turn"
        />
        <KpiCard
          label="Without unerr"
          value={fmt(totalWithout)}
          hint="Tokens that would have been sent without optimization"
        />
        <KpiCard
          label="Delivered"
          value={fmt(totalWith)}
          hint="Tokens actually sent to the agent"
        />
        <KpiCard
          label="Efficiency"
          value={`${effPct}%`}
          accent="text-violet-400"
          hint="Percentage of tokens optimized away this turn"
        />
        <KpiCard
          label="Tools"
          value={tools.join(", ") || "exec"}
          hint="MCP tools that triggered optimizations in this turn"
        />
      </div>

      {/* Context impact for this turn */}
      {thisTurnCumulative && (
        <div className="el-raised rounded-lg p-4 border-l-4 border-cyan-500/60">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-foreground text-sm font-medium">
                Context Impact
              </h3>
              <p className="t-tertiary text-xs mt-1">
                At this point, {fmt(thisTurnCumulative.context_avoided)} tokens
                of cumulative context avoided
                {remainingTurns > 0
                  ? ` — this turn's ${fmt(thisTurnCumulative.tokens_saved_this_turn)} savings carry forward to ${remainingTurns} more turn${remainingTurns !== 1 ? "s" : ""}`
                  : ""}
                .
              </p>
            </div>
            <div className="flex gap-5 shrink-0">
              <div className="text-right">
                <p className="t-tertiary text-[10px] uppercase tracking-wider">
                  This Turn
                </p>
                <p className="text-success font-mono font-medium">
                  {fmt(thisTurnCumulative.tokens_saved_this_turn)}
                </p>
              </div>
              <div className="text-right">
                <p className="t-tertiary text-[10px] uppercase tracking-wider">
                  Context Avoided
                </p>
                <p className="text-cyan-400 font-mono font-medium">
                  {fmt(thisTurnCumulative.context_avoided)}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

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
      <TurnBehaviorEvents sessionId={sessionId} turn={turn} />

      {/* Event table — Splunk-style expandable rows */}
      <div className="el-raised rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
          <div>
            <h3 className="t-secondary text-sm font-medium">Events</h3>
            <p className="t-tertiary text-xs mt-0.5">
              Every optimization event in turn #{turn}: tool calls, exec
              commands, and the mechanism that reduced tokens.
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
                    title="When this optimization event occurred"
                  >
                    Time
                  </th>
                  <th
                    className="px-3 py-3 font-medium"
                    title="Type of optimization applied (e.g. graph query, shell compression)"
                  >
                    Mechanism
                  </th>
                  <th
                    className="px-3 py-3 font-medium"
                    title="MCP tool that triggered this optimization"
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
                    title="Tokens actually delivered to the agent after optimization"
                  >
                    Delivered
                  </th>
                  <th
                    className="px-3 py-3 font-medium text-right"
                    title="Tokens removed by this optimization (Without − Delivered)"
                  >
                    Saved
                  </th>
                  <th
                    className="px-3 py-3 pr-5 font-medium"
                    title="Description of what was optimized"
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
  const [view, setView] = useState<ViewState>({ level: "global" });

  const goGlobal = () => setView({ level: "global" });
  const goSession = (sessionId: string) =>
    setView({ level: "session", sessionId });
  const goTurn = (sessionId: string, turn: number) =>
    setView({ level: "turn", sessionId, turn });

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
