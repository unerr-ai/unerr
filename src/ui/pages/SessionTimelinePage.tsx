/**
 * Session Timeline — unified, user-facing view (UX-1 → UX-10).
 *
 * The single canonical Timeline page. Combines the legacy Layer 9 narratives
 * (episodic facts / hot files / fact health) with the modern timeline.db
 * subsystem (activity bursts, intents, markers, loops, reinforced signals)
 * behind one filter / pagination / drawer experience.
 *
 * Vocabulary: every label is the user-facing term. Internal schema words
 * (turn, marker, intent, opened_by, …) stay in the database layer.
 *   • turn               → activity moment
 *   • marker             → note  (subtypes: 🎯 Goal · 💡 Decision · ⚠ Stuck · ✅ Solved)
 *   • intent             → task you've been working on
 *   • blocker            → unresolved issue
 *   • opened_by          → how the boundary was detected
 *   • closed_reason      → why it ended
 *   • reinforced signal  → pattern we've learned
 *
 * Layout (desktop ≥ 1024 px):
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  First-run explainer (collapsible)                                  │
 *   │  KPI strip — Activities / Sessions / Tasks / Unresolved             │
 *   │  Sticky FilterBar — date · agent · session · note type · search     │
 *   │  Active filter chips (removable)                                    │
 *   │  Pick-up-where-you-left-off strip  (when prior session < 7d)        │
 *   │  Activity heatmap — last 30 days (click a day to scope)             │
 *   │  Tasks you've been working on (intent rail)                         │
 *   ├──────────────────────────────────────────┬──────────────────────────┤
 *   │  Activity moments (paginated)            │  Insights                │
 *   │  Click a row → activity detail drawer    │  • Stuck patterns + Try  │
 *   │                                          │  • Hot files             │
 *   │                                          │  • Patterns we've learned │
 *   └──────────────────────────────────────────┴──────────────────────────┘
 *
 * URL state: filters + page are written to the hash so views are shareable.
 *
 * Data sources (read-only across both layers):
 *   /api/timeline/health, /turns, /markers, /sessions, /agents,
 *   /heatmap, /intents, /resume, /loops, /open-threads, /signals
 *   /api/facts?type=episodic   (Layer 9 — edit narratives)
 */

import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import {
  type TimelineFilters,
  activeFilterChips,
  quickRange,
  useTimelineFilters,
} from "@/lib/timeline-filters";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

// ── Wire types ─────────────────────────────────────────────────────────────

interface TurnRow {
  turn_id: string;
  session_id: string;
  started_at: number;
  ended_at: number;
  opened_by: string;
  closed_reason: string;
  tool_count: number;
  file_count: number;
  edit_count: number;
  title: string;
  outcome: string;
}

interface MarkerRow {
  marker_id: string;
  type: string;
  text: string;
  session_id: string;
  turn_id: string;
  ts: number;
  blocker_ref: string;
  file_path: string;
}

interface SessionRow {
  session_id: string;
  first_seen: number;
  last_seen: number;
  turn_count: number;
  edit_count: number;
  file_count: number;
  agent_name: string;
}

interface AgentRow {
  agent_name: string;
  session_count: number;
  last_seen: number;
}

interface HeatmapBucket {
  ts: number;
  turns: number;
  edits: number;
  tools: number;
}

interface ResumeData {
  session_id: string;
  last_turn_id: string;
  last_active_at: number;
  elapsed_ms: number;
  intent: string;
  open_threads: Array<{
    marker_id: string;
    text: string;
    file_path: string;
    ts: number;
  }>;
}

interface IntentRailRow {
  intent_id: string;
  title: string;
  started_at: number;
  last_active_at: number;
  status: string;
  confidence: number;
  source: string;
}

interface EpisodicFact {
  fact_id: string;
  fact_type: string;
  scope: string;
  subject: string;
  content: string;
  base_confidence: number;
  created_at: number;
  source: string;
}

// ── Friendly labels for the four marker types ──────────────────────────────

const NOTE_TYPES: Array<{
  value: string;
  label: string;
  emoji: string;
  color: string;
}> = [
  { value: "", label: "All notes", emoji: "▣", color: "text-zinc-300" },
  {
    value: "mark_intent",
    label: "Goals",
    emoji: "🎯",
    color: "text-violet-300",
  },
  {
    value: "mark_decision",
    label: "Decisions",
    emoji: "💡",
    color: "text-cyan-300",
  },
  {
    value: "mark_blocker",
    label: "Stuck moments",
    emoji: "⚠",
    color: "text-rose-300",
  },
  {
    value: "mark_resolution",
    label: "Solutions",
    emoji: "✅",
    color: "text-emerald-300",
  },
];

function noteMeta(type: string) {
  return (
    NOTE_TYPES.find((n) => n.value === type) ?? {
      value: type,
      label: type,
      emoji: "•",
      color: "text-zinc-300",
    }
  );
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDateShort(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function fmtDateTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtIsoLocal(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const tzOffset = d.getTimezoneOffset() * 60_000;
  return new Date(ts - tzOffset).toISOString().slice(0, 10);
}

function parseLocalDate(s: string, endOfDay = false): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return undefined;
  return endOfDay ? t + 24 * 60 * 60_000 - 1 : t;
}

// Episodic-fact parser — content is shaped like
// "What: …. Why: …. How: …. Sequence: …". Loose match so we can render
// what/why/how as separate paragraphs.
function parseEpisodicNarrative(content: string): {
  what?: string;
  why?: string;
  how?: string;
} {
  const out: { what?: string; why?: string; how?: string } = {};
  const m = content.match(/What:\s*([^.]+?)(?:\.|$)/i);
  if (m) out.what = m[1].trim();
  const w = content.match(/Why:\s*([^.]+?)(?:\.|$)/i);
  if (w) out.why = w[1].trim();
  const h = content.match(/How:\s*([^.]+?)(?:\.|$)/i);
  if (h) out.how = h[1].trim();
  return out;
}

// ── Top-level page ──────────────────────────────────────────────────────────

export function SessionTimelinePage() {
  const { url, queryKey } = useRepoApi();
  const { filters, setFilters, clear } = useTimelineFilters();
  const [drawerTurnId, setDrawerTurnId] = useState<string | null>(null);
  const [explainerOpen, setExplainerOpen] = useState<boolean | null>(null);

  const { data: healthData, error: healthError } = useQuery<{
    data: { ok: boolean; db_path: string; is_new: boolean };
  }>({
    queryKey: queryKey(["timeline", "health"]),
    queryFn: () => fetchJson(url("/api/timeline/health")),
    staleTime: 30_000,
    retry: false,
  });
  const subsystemReady = !!healthData?.data?.ok && !healthError;

  const turnsQuery = useMemo(() => buildTurnsQuery(filters), [filters]);
  const { data: turnsData, isFetching: turnsFetching } = useQuery<{
    data: TurnRow[];
    total: number;
    returned: number;
    offset: number;
    limit: number;
  }>({
    queryKey: queryKey(["timeline", "turns", turnsQuery]),
    queryFn: () => fetchJson(url(`/api/timeline/turns?${turnsQuery}`)),
    staleTime: 10_000,
    enabled: subsystemReady,
  });
  const turns = turnsData?.data ?? [];
  const totalTurns = turnsData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalTurns / filters.perPage));

  const markersQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.session) params.set("session_id", filters.session);
    if (filters.type) params.set("type", filters.type);
    params.set("limit", "500");
    return params.toString();
  }, [filters.session, filters.type]);

  const { data: markersData } = useQuery<{ data: MarkerRow[] }>({
    queryKey: queryKey(["timeline", "markers", markersQuery]),
    queryFn: () => fetchJson(url(`/api/timeline/markers?${markersQuery}`)),
    staleTime: 10_000,
    enabled: subsystemReady,
  });
  const markers = markersData?.data ?? [];
  const markersByTurn = useMemo(() => groupByTurn(markers), [markers]);

  const { data: sessionsData } = useQuery<{ data: SessionRow[] }>({
    queryKey: queryKey(["timeline", "sessions"]),
    queryFn: () => fetchJson(url("/api/timeline/sessions?limit=200")),
    staleTime: 30_000,
    enabled: subsystemReady,
  });
  const sessions = sessionsData?.data ?? [];

  const { data: agentsData } = useQuery<{ data: AgentRow[] }>({
    queryKey: queryKey(["timeline", "agents"]),
    queryFn: () => fetchJson(url("/api/timeline/agents")),
    staleTime: 60_000,
    enabled: subsystemReady,
  });
  const agents = agentsData?.data ?? [];

  const { data: heatmapData } = useQuery<{
    data: HeatmapBucket[];
    from_ts: number;
    to_ts: number;
  }>({
    queryKey: queryKey(["timeline", "heatmap"]),
    queryFn: () => fetchJson(url("/api/timeline/heatmap?days=30")),
    staleTime: 60_000,
    enabled: subsystemReady,
  });

  const { data: resumeData } = useQuery<{ data: ResumeData | null }>({
    queryKey: queryKey(["timeline", "resume"]),
    queryFn: () => fetchJson(url("/api/timeline/resume")),
    staleTime: 15_000,
    enabled: subsystemReady,
  });
  const resume = resumeData?.data ?? null;

  const { data: intentsData } = useQuery<{ data: IntentRailRow[] }>({
    queryKey: queryKey(["timeline", "intents"]),
    queryFn: () => fetchJson(url("/api/timeline/intents?limit=10")),
    staleTime: 30_000,
    enabled: subsystemReady,
  });
  const intents = intentsData?.data ?? [];

  const { data: episodicData } = useQuery<{ data: EpisodicFact[] }>({
    queryKey: queryKey(["facts", "episodic"]),
    queryFn: () => fetchJson(url("/api/facts?type=episodic&limit=50")),
    staleTime: 30_000,
    retry: false,
  });
  const episodicFacts = episodicData?.data ?? [];
  const episodicByFile = useMemo(() => {
    const m = new Map<string, EpisodicFact[]>();
    for (const f of episodicFacts) {
      const list = m.get(f.scope) ?? [];
      list.push(f);
      m.set(f.scope, list);
    }
    return m;
  }, [episodicFacts]);

  const visibleSessions = useMemo(() => {
    if (!filters.agent) return sessions;
    return sessions.filter((s) => s.agent_name === filters.agent);
  }, [sessions, filters.agent]);

  useEffect(() => {
    if (!drawerTurnId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerTurnId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerTurnId]);

  const isCold = totalTurns <= 3;
  const isExplainerVisible = explainerOpen === null ? isCold : explainerOpen;

  if (healthError || !subsystemReady) {
    return <SubsystemDisabledBanner />;
  }

  const chips = activeFilterChips(filters);
  const drawerTurn = drawerTurnId
    ? (turns.find((t) => t.turn_id === drawerTurnId) ?? null)
    : null;
  const drawerMarkers = drawerTurnId
    ? (markersByTurn.get(drawerTurnId) ?? [])
    : [];

  return (
    <div className="space-y-6">
      {isExplainerVisible && (
        <FirstRunExplainer onDismiss={() => setExplainerOpen(false)} />
      )}

      <KpiStrip
        activityCount={totalTurns}
        sessionCount={sessions.length}
        taskCount={intents.filter((i) => i.status === "active").length}
        unresolvedCount={resume?.open_threads.length ?? 0}
      />

      <FilterBar
        filters={filters}
        sessions={visibleSessions}
        agents={agents}
        chips={chips}
        onChange={setFilters}
        onClear={clear}
        isFetching={turnsFetching}
      />

      {resume && <ResumeStrip resume={resume} />}

      <div className="space-y-5">
        {heatmapData && heatmapData.data.length > 0 && (
          <ActivityHeatmap
            buckets={heatmapData.data}
            filters={filters}
            onDayClick={(ts) => {
              const dayMs = 24 * 60 * 60_000;
              setFilters({ from: ts, to: ts + dayMs - 1 });
            }}
          />
        )}

        {intents.length > 0 && <TaskRail intents={intents} />}

        <ActivityList
          turns={turns}
          markersByTurn={markersByTurn}
          filters={filters}
          totalTurns={totalTurns}
          totalPages={totalPages}
          onPageChange={(p) => setFilters({ page: p })}
          onTurnClick={(id) => setDrawerTurnId(id)}
          selectedTurnId={drawerTurnId}
          isFetching={turnsFetching}
        />
      </div>

      {drawerTurn && (
        <ActivityDetailDrawer
          turn={drawerTurn}
          markers={drawerMarkers}
          episodicByFile={episodicByFile}
          onClose={() => setDrawerTurnId(null)}
        />
      )}
    </div>
  );
}

// ── Banners ────────────────────────────────────────────────────────────────

function SubsystemDisabledBanner() {
  return (
    <div className="el-raised rounded-lg p-5 border-l-4 border-amber-500/60">
      <div className="text-amber-400 text-[10px] uppercase tracking-wider font-medium">
        Activity subsystem isn't running
      </div>
      <p className="t-tertiary text-xs mt-2 leading-relaxed">
        We capture your agent's activity into{" "}
        <code className="font-mono">.unerr/timeline.db</code> only when the
        subsystem is on. Restart unerr (or unset{" "}
        <code className="font-mono">UNERR_TIMELINE_V2=0</code>) and reload this
        page.
      </p>
    </div>
  );
}

function FirstRunExplainer({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="el-raised rounded-lg p-5 border-l-4 border-violet-500/60 relative">
      <button
        type="button"
        onClick={onDismiss}
        className="absolute top-3 right-3 t-tertiary hover:text-foreground text-xs px-2 py-0.5"
        aria-label="Dismiss explainer"
      >
        ✕
      </button>
      <h3 className="text-violet-400 text-[10px] uppercase tracking-wider font-medium">
        What is this page?
      </h3>
      <ul className="t-secondary text-xs space-y-1.5 leading-relaxed mt-2 max-w-2xl">
        <li>
          <strong className="text-foreground">Every burst of work</strong> your
          agent does — between idle pauses — shows up as one{" "}
          <em>activity moment</em>.
        </li>
        <li>
          <strong className="text-foreground">Notes</strong> your agent drops
          along the way (🎯 a goal, 💡 a decision, ⚠ when it gets stuck, ✅ a
          fix) turn the raw activity into a readable story.
        </li>
        <li>
          <strong className="text-foreground">Filters + the heatmap</strong> let
          you scope to a day, a coding session, a specific AI agent, or a search
          term. Every filter is shareable via the URL.
        </li>
      </ul>
      <p className="t-tertiary text-[10px] mt-3">
        Hint: start each non-trivial task with <code>mark_intent</code> and
        you'll see crisp activity titles instead of file names.
      </p>
    </div>
  );
}

// ── KPI strip ──────────────────────────────────────────────────────────────

function KpiStrip({
  activityCount,
  sessionCount,
  taskCount,
  unresolvedCount,
}: {
  activityCount: number;
  sessionCount: number;
  taskCount: number;
  unresolvedCount: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        label="Activity moments"
        sublabel="bursts of agent work"
        value={activityCount}
        accent="cyan"
      />
      <KpiCard
        label="Coding sessions"
        sublabel="each daemon run"
        value={sessionCount}
        accent="emerald"
      />
      <KpiCard
        label="Tasks in progress"
        sublabel="ongoing efforts"
        value={taskCount}
        accent="violet"
      />
      <KpiCard
        label="Unresolved issues"
        sublabel={unresolvedCount > 0 ? "needs attention" : "all clear"}
        value={unresolvedCount}
        accent={unresolvedCount > 0 ? "rose" : "zinc"}
      />
    </div>
  );
}

type KpiAccent = "zinc" | "violet" | "rose" | "cyan" | "emerald";

const KPI_ACCENT: Record<
  KpiAccent,
  { border: string; label: string; value: string }
> = {
  cyan: {
    border: "border-cyan-500/60",
    label: "text-cyan-400",
    value: "text-cyan-400",
  },
  emerald: {
    border: "border-emerald-500/60",
    label: "text-emerald-400",
    value: "text-emerald-400",
  },
  violet: {
    border: "border-violet-500/60",
    label: "text-violet-400",
    value: "text-violet-400",
  },
  rose: {
    border: "border-rose-500/60",
    label: "text-rose-400",
    value: "text-rose-400",
  },
  zinc: {
    border: "border-border-subtle",
    label: "t-tertiary",
    value: "text-foreground",
  },
};

function KpiCard({
  label,
  sublabel,
  value,
  accent = "zinc",
}: {
  label: string;
  sublabel: string;
  value: number;
  accent?: KpiAccent;
}) {
  const tokens = KPI_ACCENT[accent];
  return (
    <div
      className={`el-raised rounded-lg p-5 border-t-2 ${tokens.border}`}
      title={sublabel}
    >
      <p
        className={`${tokens.label} text-[10px] uppercase tracking-wider font-medium`}
      >
        {label}
      </p>
      <p className={`text-3xl font-bold font-mono ${tokens.value} mt-2`}>
        {value.toLocaleString()}
      </p>
      <p className="t-secondary text-xs mt-1">{sublabel}</p>
    </div>
  );
}

// ── FilterBar ──────────────────────────────────────────────────────────────

function FilterBar({
  filters,
  sessions,
  agents,
  chips,
  onChange,
  onClear,
  isFetching,
}: {
  filters: TimelineFilters;
  sessions: SessionRow[];
  agents: AgentRow[];
  chips: ReturnType<typeof activeFilterChips>;
  onChange: (patch: Partial<TimelineFilters>) => void;
  onClear: () => void;
  isFetching: boolean;
}) {
  const [searchDraft, setSearchDraft] = useState(filters.q ?? "");
  useEffect(() => {
    setSearchDraft(filters.q ?? "");
  }, [filters.q]);

  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? "") !== searchDraft) {
        onChange({ q: searchDraft || undefined });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [searchDraft, filters.q, onChange]);

  const activePreset = useMemo(() => {
    if (!filters.from && !filters.to) return "all";
    const now = Date.now();
    const r7 = quickRange("7d", now);
    const r30 = quickRange("30d", now);
    const rT = quickRange("today", now);
    if (
      filters.from &&
      Math.abs(filters.from - (r7.from ?? 0)) < 60_000 &&
      filters.to &&
      Math.abs(filters.to - (r7.to ?? 0)) < 60_000
    )
      return "7d";
    if (
      filters.from &&
      Math.abs(filters.from - (r30.from ?? 0)) < 60_000 &&
      filters.to &&
      Math.abs(filters.to - (r30.to ?? 0)) < 60_000
    )
      return "30d";
    if (
      filters.from &&
      Math.abs(filters.from - (rT.from ?? 0)) < 60_000 &&
      filters.to &&
      Math.abs(filters.to - (rT.to ?? 0)) < 60_000
    )
      return "today";
    return "custom";
  }, [filters.from, filters.to]);

  return (
    <div className="sticky top-0 z-20 -mx-6 px-6 py-3 bg-background/85 backdrop-blur border-b border-border-subtle space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <PresetGroup
          value={activePreset}
          onChange={(p) => {
            if (p === "custom") return;
            const r = quickRange(p);
            onChange({ from: r.from, to: r.to });
          }}
        />

        <DateRangeInputs
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => onChange({ from, to })}
        />

        {agents.length > 0 && (
          <Select
            value={filters.agent ?? ""}
            onChange={(v) => onChange({ agent: v || undefined })}
            ariaLabel="Filter by AI agent"
          >
            <option value="">All AI agents ({agents.length})</option>
            {agents.map((a) => (
              <option key={a.agent_name} value={a.agent_name}>
                {a.agent_name} — {a.session_count} session
                {a.session_count === 1 ? "" : "s"}
              </option>
            ))}
          </Select>
        )}

        <Select
          value={filters.session ?? ""}
          onChange={(v) => onChange({ session: v || undefined })}
          ariaLabel="Filter by coding session"
        >
          <option value="">All coding sessions ({sessions.length})</option>
          {sessions.map((s) => (
            <option key={s.session_id} value={s.session_id}>
              {fmtDateTime(s.last_seen)} — {s.turn_count} activit
              {s.turn_count === 1 ? "y" : "ies"}
              {s.agent_name && s.agent_name !== "unknown"
                ? ` · ${s.agent_name}`
                : ""}
            </option>
          ))}
        </Select>

        <Select
          value={filters.type ?? ""}
          onChange={(v) => onChange({ type: v || undefined })}
          ariaLabel="Filter by note type"
        >
          {NOTE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.emoji} {t.label}
            </option>
          ))}
        </Select>

        <input
          type="search"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          placeholder="Search your work…"
          className="flex-1 min-w-[160px] rounded-md border border-border-subtle bg-surface-secondary px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-violet-500"
          aria-label="Search activity titles"
        />

        <DensityToggle
          value={filters.density}
          onChange={(density) => onChange({ density })}
        />

        {isFetching && (
          <span className="text-[11px] t-tertiary font-mono">loading…</span>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <button
              type="button"
              key={chip.key}
              onClick={() => {
                if (chip.key === "from")
                  onChange({ from: undefined, to: undefined });
                else if (chip.key === "session")
                  onChange({ session: undefined });
                else if (chip.key === "agent") onChange({ agent: undefined });
                else if (chip.key === "type") onChange({ type: undefined });
                else if (chip.key === "q") onChange({ q: undefined });
              }}
              className="inline-flex items-center gap-1 rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300 hover:border-violet-400 hover:bg-violet-500/20"
            >
              {chip.label}
              <span aria-hidden>✕</span>
            </button>
          ))}
          <button
            type="button"
            onClick={onClear}
            className="text-[11px] t-tertiary hover:text-foreground underline-offset-2 hover:underline ml-1"
          >
            Clear all filters
          </button>
        </div>
      )}
    </div>
  );
}

function PresetGroup({
  value,
  onChange,
}: {
  value: string;
  onChange: (p: "today" | "7d" | "30d" | "all" | "custom") => void;
}) {
  const items: Array<{ id: "today" | "7d" | "30d" | "all"; label: string }> = [
    { id: "today", label: "Today" },
    { id: "7d", label: "Last 7 days" },
    { id: "30d", label: "Last 30 days" },
    { id: "all", label: "All time" },
  ];
  return (
    <div className="inline-flex rounded-md border border-border-subtle overflow-hidden">
      {items.map((it, i) => (
        <button
          type="button"
          key={it.id}
          onClick={() => onChange(it.id)}
          className={`px-2.5 py-1 text-xs transition-colors ${
            value === it.id
              ? "bg-violet-500/30 text-violet-200"
              : "bg-surface-secondary t-secondary hover:bg-surface-secondary/70"
          } ${i > 0 ? "border-l border-border-subtle" : ""}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function DateRangeInputs({
  from,
  to,
  onChange,
}: {
  from?: number;
  to?: number;
  onChange: (from?: number, to?: number) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 text-xs t-secondary">
      <input
        type="date"
        aria-label="From date"
        value={fmtIsoLocal(from)}
        onChange={(e) => onChange(parseLocalDate(e.target.value, false), to)}
        className="rounded-md border border-border-subtle bg-surface-secondary px-2 py-1 text-foreground"
      />
      <span>→</span>
      <input
        type="date"
        aria-label="To date"
        value={fmtIsoLocal(to)}
        onChange={(e) => onChange(from, parseLocalDate(e.target.value, true))}
        className="rounded-md border border-border-subtle bg-surface-secondary px-2 py-1 text-foreground"
      />
    </div>
  );
}

function Select({
  value,
  onChange,
  ariaLabel,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="rounded-md border border-border-subtle bg-surface-secondary px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500 max-w-[260px]"
    >
      {children}
    </select>
  );
}

function DensityToggle({
  value,
  onChange,
}: {
  value: TimelineFilters["density"];
  onChange: (d: TimelineFilters["density"]) => void;
}) {
  return (
    <div
      className="inline-flex rounded-md border border-border-subtle overflow-hidden"
      role="group"
      aria-label="Row density"
    >
      <button
        type="button"
        onClick={() => onChange("comfortable")}
        className={`px-2 py-1 text-[11px] transition-colors ${
          value === "comfortable"
            ? "bg-violet-500/30 text-violet-200"
            : "bg-surface-secondary t-secondary hover:bg-surface-secondary/70"
        }`}
        title="Spacious rows"
        aria-pressed={value === "comfortable"}
      >
        ☰
      </button>
      <button
        type="button"
        onClick={() => onChange("compact")}
        className={`px-2 py-1 text-[11px] border-l border-border-subtle transition-colors ${
          value === "compact"
            ? "bg-violet-500/30 text-violet-200"
            : "bg-surface-secondary t-secondary hover:bg-surface-secondary/70"
        }`}
        title="Dense rows"
        aria-pressed={value === "compact"}
      >
        ≡
      </button>
    </div>
  );
}

// ── Resume + heatmap + task rail ───────────────────────────────────────────

function ResumeStrip({ resume }: { resume: ResumeData }) {
  const intent =
    resume.intent && resume.intent.length > 0
      ? resume.intent
      : "your last session";
  return (
    <div className="el-raised rounded-lg p-5 border-l-4 border-cyan-500/60 flex flex-wrap items-start gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-cyan-400 text-[10px] uppercase tracking-wider font-medium">
          Pick up where you left off
        </div>
        <div className="text-foreground text-sm font-medium mt-2 truncate">
          {intent}
        </div>
        <div className="t-tertiary text-xs mt-1">
          last active {fmtElapsed(resume.elapsed_ms)} · session{" "}
          <span className="font-mono">{resume.session_id.slice(0, 8)}</span>
        </div>
      </div>
      {resume.open_threads.length > 0 && (
        <div className="min-w-0 flex-1">
          <div className="text-rose-400 text-[10px] uppercase tracking-wider font-medium">
            Unresolved ({resume.open_threads.length})
          </div>
          <ul className="space-y-1 mt-2">
            {resume.open_threads.slice(0, 3).map((t) => (
              <li key={t.marker_id} className="t-secondary text-xs">
                <span className="text-rose-400">⚠</span> {t.text}
                {t.file_path && (
                  <span className="t-tertiary font-mono ml-1">
                    ({t.file_path})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ActivityHeatmap({
  buckets,
  filters,
  onDayClick,
}: {
  buckets: HeatmapBucket[];
  filters: TimelineFilters;
  onDayClick: (ts: number) => void;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.turns));
  const totalActivity = buckets.reduce((s, b) => s + b.turns, 0);
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-secondary/40 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[11px] uppercase tracking-wider t-secondary font-mono">
            Your last {buckets.length} days at a glance
          </div>
          <div className="text-[11px] t-tertiary mt-0.5">
            {totalActivity.toLocaleString()} activity moment
            {totalActivity === 1 ? "" : "s"} · brighter = busier · click any day
            to focus
          </div>
        </div>
        <div className="text-[11px] t-tertiary font-mono">peak {max}/day</div>
      </div>
      <div className="flex items-end gap-[3px] pb-1">
        {buckets.map((b) => (
          <HeatmapCell
            key={b.ts}
            bucket={b}
            max={max}
            active={isDaySelected(b.ts, filters)}
            onClick={() => onDayClick(b.ts)}
          />
        ))}
      </div>
    </div>
  );
}

function HeatmapCell({
  bucket,
  max,
  active,
  onClick,
}: {
  bucket: HeatmapBucket;
  max: number;
  active: boolean;
  onClick: () => void;
}) {
  const intensity = bucket.turns === 0 ? 0 : bucket.turns / max;
  const bg =
    bucket.turns === 0
      ? "bg-foreground/10 border border-border-subtle"
      : intensity > 0.75
        ? "bg-violet-400"
        : intensity > 0.5
          ? "bg-violet-500/85"
          : intensity > 0.25
            ? "bg-violet-500/55"
            : "bg-violet-500/30";
  const ring = active ? "ring-2 ring-cyan-400" : "";
  const tip = `${fmtDateShort(bucket.ts)} — ${bucket.turns} activity moment${bucket.turns === 1 ? "" : "s"}, ${bucket.edits} file edit${bucket.edits === 1 ? "" : "s"}, ${bucket.tools} tool call${bucket.tools === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={tip}
      className={`h-8 flex-1 min-w-[8px] rounded-sm hover:scale-110 transition-transform ${bg} ${ring}`}
      aria-label={tip}
    />
  );
}

function isDaySelected(ts: number, filters: TimelineFilters): boolean {
  if (!filters.from || !filters.to) return false;
  const dayMs = 24 * 60 * 60_000;
  return (
    Math.abs(filters.from - ts) < 60_000 &&
    filters.to - filters.from < dayMs * 1.1
  );
}

function TaskRail({ intents }: { intents: IntentRailRow[] }) {
  const active = intents.filter((i) => i.status !== "dormant");
  const dormant = intents.filter((i) => i.status === "dormant").slice(0, 3);
  if (active.length === 0 && dormant.length === 0) return null;
  return (
    <div className="el-raised rounded-lg p-5">
      <div className="text-violet-400 text-[10px] uppercase tracking-wider font-medium mb-3">
        Tasks you've been working on
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {active.slice(0, 6).map((i) => (
          <div
            key={i.intent_id}
            className="rounded border border-violet-500/30 bg-violet-500/10 px-3 py-2"
          >
            <div className="text-foreground text-sm font-medium truncate">
              {i.title || "(unnamed task)"}
            </div>
            <div className="t-tertiary text-[11px] mt-1">
              {i.source === "agent_marker"
                ? "from your stated goals"
                : "inferred from file patterns"}{" "}
              · {(i.confidence * 100).toFixed(0)}% confidence · last active{" "}
              {fmtElapsed(Date.now() - i.last_active_at)}
            </div>
          </div>
        ))}
      </div>
      {dormant.length > 0 && (
        <div className="mt-3 t-tertiary text-[11px]">
          Older tasks ({dormant.length}):{" "}
          {dormant.map((d) => d.title || "(unnamed)").join(" · ")}
        </div>
      )}
    </div>
  );
}

// ── Activity list + pagination ─────────────────────────────────────────────

function ActivityList({
  turns,
  markersByTurn,
  filters,
  totalTurns,
  totalPages,
  onPageChange,
  onTurnClick,
  selectedTurnId,
  isFetching,
}: {
  turns: TurnRow[];
  markersByTurn: Map<string, MarkerRow[]>;
  filters: TimelineFilters;
  totalTurns: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  onTurnClick: (turnId: string) => void;
  selectedTurnId: string | null;
  isFetching: boolean;
}) {
  const compact = filters.density === "compact";
  return (
    <div className="space-y-3">
      <div className="el-raised rounded-lg p-5 border-l-4 border-fuchsia-500/60">
        <div className="text-fuchsia-400 text-[10px] uppercase tracking-wider font-medium">
          Insights — what we noticed
        </div>
        <div className="t-tertiary text-xs leading-relaxed mt-2 max-w-2xl">
          We'll surface stuck patterns, hot files, and learned conventions here
          as your agent works. Drop a few <code>mark_intent</code> notes to
          speed things up.
        </div>
      </div>

      <div className="flex items-center justify-between text-xs t-tertiary">
        <span>
          {totalTurns === 0
            ? "Nothing matches the current filters yet."
            : `Showing ${turns.length} of ${totalTurns.toLocaleString()} activity moment${totalTurns === 1 ? "" : "s"}`}
        </span>
        <span className="font-mono">
          page {filters.page} / {totalPages}
        </span>
      </div>

      {turns.length === 0 ? (
        <EmptyActivityList isFetching={isFetching} />
      ) : (
        <div
          className={
            compact
              ? "divide-y divide-border-subtle rounded-lg border border-border-subtle overflow-hidden el-raised"
              : "space-y-2"
          }
        >
          {turns.map((t) => (
            <ActivityRow
              key={t.turn_id}
              turn={t}
              markers={markersByTurn.get(t.turn_id) ?? []}
              compact={compact}
              active={selectedTurnId === t.turn_id}
              onClick={() => onTurnClick(t.turn_id)}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <Pagination
          page={filters.page}
          totalPages={totalPages}
          onChange={onPageChange}
        />
      )}
    </div>
  );
}

function EmptyActivityList({ isFetching }: { isFetching: boolean }) {
  return (
    <div className="el-raised rounded-lg p-6 text-sm t-secondary">
      {isFetching ? (
        <span>Loading…</span>
      ) : (
        <>
          Nothing matches the current filters yet. Try{" "}
          <span className="text-foreground">widening the date range</span>,{" "}
          <span className="text-foreground">clearing the search</span>, or{" "}
          <span className="text-foreground">picking "All time"</span>.
        </>
      )}
    </div>
  );
}

function ActivityRow({
  turn,
  markers,
  compact,
  active,
  onClick,
}: {
  turn: TurnRow;
  markers: MarkerRow[];
  compact: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const intentMarker = markers.find((m) => m.type === "mark_intent");
  const decisionCount = markers.filter(
    (m) => m.type === "mark_decision"
  ).length;
  const blockers = markers.filter((m) => m.type === "mark_blocker");
  const resolvedRefs = new Set(
    markers
      .filter((m) => m.type === "mark_resolution")
      .map((m) => m.blocker_ref)
  );
  const openBlockers = blockers.filter((b) => !resolvedRefs.has(b.marker_id));
  const title =
    (intentMarker?.text ?? "").length > 0
      ? (intentMarker?.text ?? "")
      : turn.title && turn.title.length > 0
        ? turn.title
        : `Activity — ${turn.tool_count} tool call${turn.tool_count === 1 ? "" : "s"}`;

  const baseClass = compact
    ? "flex items-center gap-3 px-3 py-2 hover:bg-surface-secondary transition-colors cursor-pointer"
    : "el-raised rounded-lg border border-border-subtle hover:border-violet-500/40 transition-colors cursor-pointer";
  const activeClass = active
    ? compact
      ? "bg-violet-500/15"
      : "border-violet-500/60 bg-violet-500/5"
    : "";

  return (
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
      className={`${baseClass} ${activeClass}`}
    >
      {compact ? (
        <>
          <BoundaryPrecisionPill opened_by={turn.opened_by} small />
          <span className="text-sm text-foreground truncate flex-1">
            {title}
          </span>
          <span className="text-[11px] t-tertiary font-mono shrink-0">
            {fmtDateShort(turn.started_at)} {fmtTime(turn.started_at)}
          </span>
          <span className="text-[11px] t-tertiary shrink-0">
            {turn.tool_count} call{turn.tool_count === 1 ? "" : "s"} ·{" "}
            {turn.edit_count} edit{turn.edit_count === 1 ? "" : "s"}
          </span>
          {openBlockers.length > 0 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/30 shrink-0">
              {openBlockers.length} ⚠
            </span>
          )}
        </>
      ) : (
        <div className="px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <BoundaryPrecisionPill opened_by={turn.opened_by} />
            <span className="text-sm text-foreground font-medium truncate">
              {title}
            </span>
            {decisionCount > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 shrink-0">
                💡 {decisionCount} decision{decisionCount === 1 ? "" : "s"}
              </span>
            )}
            {openBlockers.length > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/30 shrink-0">
                ⚠ {openBlockers.length} unresolved
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 text-xs t-tertiary shrink-0">
            <span>
              {fmtDateShort(turn.started_at)} {fmtTime(turn.started_at)}
            </span>
            <span>{fmtDuration(turn.ended_at - turn.started_at)}</span>
            <span>
              {turn.tool_count} call{turn.tool_count === 1 ? "" : "s"} ·{" "}
              {turn.file_count} file{turn.file_count === 1 ? "" : "s"} ·{" "}
              {turn.edit_count} edit{turn.edit_count === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function BoundaryPrecisionPill({
  opened_by,
  small,
}: {
  opened_by: string;
  small?: boolean;
}) {
  const cls =
    opened_by === "stop_hook" || opened_by === "first_call"
      ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
      : opened_by === "idle_gap"
        ? "text-amber-400 border-amber-500/40 bg-amber-500/10"
        : "t-secondary border-border-subtle bg-surface-secondary";
  const label =
    opened_by === "stop_hook"
      ? "✓ exact"
      : opened_by === "first_call"
        ? "▶ start"
        : opened_by === "idle_gap"
          ? "≈ approx"
          : opened_by;
  const tip =
    opened_by === "stop_hook"
      ? "Boundary confirmed by your agent's stop signal."
      : opened_by === "first_call"
        ? "Beginning of a coding session — exact."
        : opened_by === "idle_gap"
          ? "Inferred from a >20s idle gap — approximate."
          : opened_by;
  return (
    <span
      title={tip}
      className={`${small ? "text-[9px]" : "text-[10px]"} font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${cls} shrink-0`}
    >
      {label}
    </span>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (next: number) => void;
}) {
  const pages = pageButtons(page, totalPages);
  return (
    <div className="flex items-center justify-between gap-2 pt-2">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="rounded-md border border-border-subtle bg-surface-secondary px-3 py-1 text-xs text-foreground hover:bg-surface-secondary/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        ← Newer
      </button>
      <div className="flex items-center gap-1">
        {pages.map(({ key, value: p }) =>
          p === "…" ? (
            <span key={key} className="px-2 t-tertiary text-xs">
              …
            </span>
          ) : (
            <button
              type="button"
              key={key}
              onClick={() => onChange(p)}
              className={`min-w-[28px] rounded-md px-2 py-1 text-xs border border-border-subtle transition-colors ${
                p === page
                  ? "bg-violet-500/30 text-violet-200"
                  : "bg-surface-secondary t-secondary hover:bg-surface-secondary/70"
              }`}
            >
              {p}
            </button>
          )
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="rounded-md border border-border-subtle bg-surface-secondary px-3 py-1 text-xs text-foreground hover:bg-surface-secondary/70 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Older →
      </button>
    </div>
  );
}

function pageButtons(
  page: number,
  totalPages: number
): Array<{ key: string; value: number | "…" }> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => ({
      key: `page-${i + 1}`,
      value: i + 1,
    }));
  }
  const set = new Set<number>([
    1,
    totalPages,
    page,
    page - 1,
    page + 1,
    page - 2,
    page + 2,
  ]);
  const valid = [...set]
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);
  const out: Array<{ key: string; value: number | "…" }> = [];
  for (let i = 0; i < valid.length; i++) {
    const v = valid[i]!;
    if (i > 0 && v - (valid[i - 1] as number) > 1) {
      const prev = valid[i - 1] as number;
      out.push({ key: `ellipsis-${prev}-${v}`, value: "…" });
    }
    out.push({ key: `page-${v}`, value: v });
  }
  return out;
}

// ── Activity detail drawer ─────────────────────────────────────────────────

function ActivityDetailDrawer({
  turn,
  markers,
  episodicByFile,
  onClose,
}: {
  turn: TurnRow;
  markers: MarkerRow[];
  episodicByFile: Map<string, EpisodicFact[]>;
  onClose: () => void;
}) {
  const filesTouched = useMemo(
    () => [
      ...new Set(
        markers
          .map((m) => m.file_path)
          .filter((f) => typeof f === "string" && f.length > 0)
      ),
    ],
    [markers]
  );

  const relatedNarratives = useMemo(() => {
    const out: EpisodicFact[] = [];
    for (const fp of filesTouched) {
      const facts = episodicByFile.get(fp);
      if (facts) out.push(...facts);
    }
    return out.slice(0, 5);
  }, [filesTouched, episodicByFile]);

  return (
    <div
      className="fixed inset-0 z-30 flex justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
    >
      <aside
        className="h-full w-full max-w-md bg-background border-l border-border-subtle shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <div className="sticky top-0 bg-background/90 backdrop-blur border-b border-border-subtle p-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="t-tertiary text-[10px] uppercase tracking-wider font-medium">
              Activity detail
            </div>
            <div className="text-sm text-foreground font-medium mt-1 truncate">
              {turn.title || `(activity ${turn.turn_id.slice(0, 8)})`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-subtle bg-surface-secondary px-2 py-1 t-secondary hover:text-foreground hover:bg-surface-secondary/70 transition-colors"
            aria-label="Close detail panel"
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          <DrawerFacts turn={turn} />
          <DrawerNotes markers={markers} />
          {relatedNarratives.length > 0 && (
            <DrawerNarratives narratives={relatedNarratives} />
          )}
        </div>
      </aside>
    </div>
  );
}

function DrawerFacts({ turn }: { turn: TurnRow }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <Fact label="When it started" value={fmtDateTime(turn.started_at)} />
      <Fact
        label="How long it lasted"
        value={fmtDuration(turn.ended_at - turn.started_at)}
      />
      <Fact label="Tool calls" value={String(turn.tool_count)} />
      <Fact label="Files touched" value={String(turn.file_count)} />
      <Fact label="File edits" value={String(turn.edit_count)} />
      <Fact
        label="Boundary precision"
        value={
          turn.opened_by === "stop_hook"
            ? "Confirmed by agent"
            : turn.opened_by === "first_call"
              ? "Session start"
              : turn.opened_by === "idle_gap"
                ? "Inferred from idle gap"
                : turn.opened_by
        }
      />
      <Fact
        label="Why this ended"
        value={
          turn.closed_reason === "session_end"
            ? "Session shutdown"
            : turn.closed_reason === "idle_gap"
              ? "Long idle gap"
              : turn.closed_reason === "stop_hook"
                ? "Agent stopped"
                : turn.closed_reason
        }
      />
      <Fact
        label="Outcome"
        value={turn.outcome === "unknown" ? "—" : turn.outcome}
      />
      <Fact label="Activity ID" value={turn.turn_id.slice(0, 8)} mono />
      <Fact label="Session" value={turn.session_id.slice(0, 8)} mono />
    </div>
  );
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded border border-border-subtle bg-surface-secondary px-2 py-1.5">
      <div className="t-tertiary text-[10px] uppercase tracking-wider font-medium">
        {label}
      </div>
      <div
        className={`text-foreground mt-0.5 truncate ${mono ? "font-mono" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function DrawerNotes({ markers }: { markers: MarkerRow[] }) {
  if (markers.length === 0) {
    return (
      <div className="t-tertiary text-xs leading-relaxed">
        No notes recorded for this activity. Tip: drop a{" "}
        <code className="t-secondary">mark_intent</code> at the start of your
        next task and a <code className="t-secondary">mark_decision</code> when
        you pick between options — they show up here as a readable trail.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="t-secondary text-[10px] uppercase tracking-wider font-medium">
        Notes from this activity ({markers.length})
      </div>
      {markers.map((m) => {
        const meta = noteMeta(m.type);
        return (
          <div
            key={m.marker_id}
            className="rounded border border-border-subtle bg-surface-secondary px-3 py-2"
          >
            <div className="flex items-center justify-between">
              <span className={`text-[10px] font-mono uppercase ${meta.color}`}>
                {meta.emoji} {meta.label}
              </span>
              <span className="t-tertiary text-[10px] font-mono">
                {fmtTime(m.ts)}
              </span>
            </div>
            <div className="text-xs text-foreground mt-1">{m.text}</div>
            {m.file_path && (
              <div className="t-tertiary text-[11px] font-mono mt-1">
                {m.file_path}
              </div>
            )}
            {m.blocker_ref && (
              <div className="t-tertiary text-[11px] mt-1">
                resolves →{" "}
                <span className="font-mono">{m.blocker_ref.slice(0, 8)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DrawerNarratives({ narratives }: { narratives: EpisodicFact[] }) {
  return (
    <div className="space-y-2">
      <div className="t-secondary text-[10px] uppercase tracking-wider font-medium">
        Recent edits to these files
      </div>
      {narratives.map((n) => {
        const parsed = parseEpisodicNarrative(n.content);
        return (
          <div
            key={n.fact_id}
            className="rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs"
          >
            <div className="text-emerald-400 font-mono text-[10px] uppercase mb-1">
              {n.scope}
            </div>
            {parsed.what && (
              <div className="text-foreground">
                <span className="t-tertiary">What — </span>
                {parsed.what}
              </div>
            )}
            {parsed.why && (
              <div className="t-secondary mt-1">
                <span className="t-tertiary">Why — </span>
                {parsed.why}
              </div>
            )}
            {parsed.how && (
              <div className="t-secondary mt-1">
                <span className="t-tertiary">How — </span>
                {parsed.how}
              </div>
            )}
            {!parsed.what && !parsed.why && !parsed.how && (
              <div className="t-secondary">{n.content}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildTurnsQuery(filters: TimelineFilters): string {
  const p = new URLSearchParams();
  if (filters.from !== undefined) p.set("from", String(filters.from));
  if (filters.to !== undefined) p.set("to", String(filters.to));
  if (filters.session) p.set("session_id", filters.session);
  if (filters.q) p.set("q", filters.q);
  p.set("limit", String(filters.perPage));
  p.set("offset", String((filters.page - 1) * filters.perPage));
  return p.toString();
}

function groupByTurn(markers: MarkerRow[]): Map<string, MarkerRow[]> {
  const m = new Map<string, MarkerRow[]>();
  for (const marker of markers) {
    const list = m.get(marker.turn_id) ?? [];
    list.push(marker);
    m.set(marker.turn_id, list);
  }
  return m;
}
