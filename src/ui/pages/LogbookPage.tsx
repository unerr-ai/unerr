/**
 * Logbook — prompt-centric activity feed.
 *
 * Redesign: instead of flat per-event rows, the page groups events by
 * {session_id, turn} and surfaces the captured user prompt as the primary
 * entry. Expanding a prompt card reveals the full execution trace: unerr
 * events, token optimization breakdown, attribution, and (when available)
 * the agent's own transcript.
 *
 * Psychology patterns applied:
 *   - Anchoring: dominant "prompts handled" number at the top
 *   - Von Restorff: featured/riskiest event type highlighted per card
 *   - Progressive disclosure: summary → expand → deep-link
 *   - Peak-End Rule: highest-impact card gets a visual accent
 *   - CountUp animation on first data arrival (dopamine hit)
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import {
  navigateRoute,
  setHashQueryParams,
  useHashQueryParam,
} from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────

interface PromptFeedItem {
  session_id: string;
  turn: number;
  prompt: {
    text: string | null;
    length: number;
    classified_as: string | null;
  } | null;
  summary: {
    event_count: number;
    by_type: Record<string, number>;
    tokens_saved: number;
    agents: string[];
    featured_event_type: string | null;
    featured_verb: string | null;
    tool_call_count: number;
    marker_count: number;
  };
  ts_start: string;
  ts_end: string;
}

interface PromptFeedResponse {
  data: PromptFeedItem[];
  total: number;
  limit: number;
  offset: number;
}

interface PromptDetailResponse {
  data: {
    session_id: string;
    turn: number;
    prompt: {
      text: string | null;
      length: number;
      classified_as: string | null;
      ts: string;
    } | null;
    events: Array<{
      event_type: string;
      verb: string;
      object: string;
      agent: string;
      file_path: string | null;
      entity_key: string | null;
      session_id: string;
      turn: number;
      ts: string;
      metadata: Record<string, unknown>;
    }>;
    attribution: {
      recalls: Array<{ content: string; scope?: string }>;
      captures: Array<{ content: string }>;
      drift: Array<{ file_path: string }>;
    } | null;
    token_optimization: {
      total_saved: number;
      mechanisms: Record<string, number>;
    };
    transcript: Array<{
      role: string;
      text: string | null;
      tools: string[] | null;
      files: string[] | null;
      model: string | null;
      tokens_input: number;
      tokens_output: number;
      ts: string;
    }>;
    has_transcript: boolean;
    tool_calls: Array<{
      id: string;
      ts: string;
      tool: string;
      args_summary: Record<string, unknown>;
      result_summary: Record<string, unknown>;
      turn_id: string | null;
      correlation_id: string | null;
    }>;
    markers: Array<{
      id: string;
      ts: string;
      type: string;
      text: string;
      turn_id: string | null;
      alternatives: string[] | null;
      blocker_ref: string | null;
      file_path: string | null;
    }>;
  };
}

interface StoryResponse {
  data: {
    period_label: string;
    story: string;
    honest_zero: boolean;
    featured: unknown | null;
    right_rail: {
      total_events: number;
      by_type: Record<string, number>;
      total_tokens_saved: number;
    };
  };
}

interface FacetsResponse {
  data: {
    agents: { name: string; count: number }[];
    sessions: {
      id: string;
      count: number;
      started_ts: string;
      last_ts: string;
      agent: string;
    }[];
    event_types: { type: string; count: number }[];
    total: number;
  };
}

// ── Constants ────────────────────────────────────────────────────────

const PAGE_SIZE = 20;
const REFETCH_MS = 15_000;

// ── Helpers ──────────────────────────────────────────────────────────

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayBounds(date: string): { from_ts: string; to_ts: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const start = new Date(y, mo, day, 0, 0, 0, 0);
  const end = new Date(y, mo, day + 1, 0, 0, 0, 0);
  return { from_ts: start.toISOString(), to_ts: end.toISOString() };
}

function relTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function timeHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortSession(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function fmtNum(n: number | undefined | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// ── Psychology-driven components ─────────────────────────────────────

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

function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const v = useCountUp(value);
  return <>{format(Math.round(v))}</>;
}

// ── Per-session color coding ─────────────────────────────────────────

const SESSION_PALETTE: { stripe: string; chip: string; bg: string }[] = [
  { stripe: "border-l-violet-400", chip: "bg-violet-500/15 text-violet-200", bg: "bg-violet-500/4" },
  { stripe: "border-l-cyan-400", chip: "bg-cyan-500/15 text-cyan-200", bg: "bg-cyan-500/4" },
  { stripe: "border-l-emerald-400", chip: "bg-emerald-500/15 text-emerald-200", bg: "bg-emerald-500/4" },
  { stripe: "border-l-amber-400", chip: "bg-amber-500/15 text-amber-200", bg: "bg-amber-500/4" },
  { stripe: "border-l-rose-400", chip: "bg-rose-500/15 text-rose-200", bg: "bg-rose-500/4" },
  { stripe: "border-l-sky-400", chip: "bg-sky-500/15 text-sky-200", bg: "bg-sky-500/4" },
  { stripe: "border-l-fuchsia-400", chip: "bg-fuchsia-500/15 text-fuchsia-200", bg: "bg-fuchsia-500/4" },
  { stripe: "border-l-lime-400", chip: "bg-lime-500/15 text-lime-200", bg: "bg-lime-500/4" },
];

function sessionColor(id: string): (typeof SESSION_PALETTE)[number] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return SESSION_PALETTE[Math.abs(h) % SESSION_PALETTE.length]!;
}

// ── Mechanism labels ─────────────────────────────────────────────────

const MECHANISM_LABELS: Record<string, string> = {
  shell_compression: "Shell compressed",
  file_read: "Read trimmed",
  fetch_url: "Fetch cleaned",
  graph_query: "Graph used",
  session_dedup: "Context deduped",
  format_encoding: "Response compacted",
  smart_truncation: "Smart trim",
  behavior_automation: "Automation",
  persistent_memory: "Memory",
};

// ── Event type labels ────────────────────────────────────────────────

const EVENT_TYPE_ICONS: Record<string, string> = {
  // Safety
  stale_edit_prevented: "✦",
  cascade_guard: "✦",
  cascade_warning_consumed: "✓",
  intervention_halted: "✕",
  intervention_warned: "!",
  loop_broken: "⟲",
  // Intelligence
  full_read_avoided: "▥",
  graph_query_served: "◈",
  caller_check_enforced: "⊕",
  drift_consumed: "≈",
  convention_applied: "◇",
  defuddle_selector_skipped: "▤",
  // Memory
  fact_recalled: "❝",
  fact_stored_user_fed: "✎",
  fact_stored_auto: "✎",
  fact_capture_abandoned: "∅",
  cross_session_resume: "↪",
  resume_blockers_surfaced: "⚑",
  cache_hit: "◐",
  confirmation_expired: "◷",
  // Presence
  presence_ambient_marker: "·",
  surface2_emitted: "▸",
  surface2_missed: "▹",
  // Prompt
  user_prompt_received: "▶",
  // Token flow
  shell_compression: "◈",
  file_read: "▥",
  fetch_url: "↗",
  graph_query: "◈",
  session_dedup: "≡",
  format_encoding: "⊞",
  smart_truncation: "▤",
  behavior_automation: "⚙",
  persistent_memory: "❝",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  // ─── Prevented mistakes ────────────────────────────────────────────
  stale_edit_prevented: "Prevented a broken edit",
  cascade_guard: "Protected code that depends on this",
  cascade_warning_consumed: "Agent checked dependent code first",
  intervention_halted: "Blocked a bad tool call",
  intervention_warned: "Flagged a risky operation",
  loop_broken: "Stopped a wasteful retry loop",
  // ─── Smarter code understanding ────────────────────────────────────
  full_read_avoided: "Read only the relevant part",
  graph_query_served: "Answered instantly from code graph",
  caller_check_enforced: "Checked what uses this before editing",
  drift_consumed: "Detected file changed on disk",
  convention_applied: "Enforced your project's style",
  defuddle_selector_skipped: "Handled a web page parsing error",
  // ─── Cross-session memory ──────────────────────────────────────────
  fact_recalled: "Recalled a rule you taught it",
  fact_stored_user_fed: "Remembered your instruction",
  fact_stored_auto: "Noticed a codebase pattern",
  fact_capture_abandoned: "Skipped an uncertain note",
  cross_session_resume: "Continued from last session",
  resume_blockers_surfaced: "Brought forward open issues",
  cache_hit: "Reused a cached result",
  confirmation_expired: "Confirmation timed out",
  // ─── Presence ──────────────────────────────────────────────────────
  user_prompt_received: "Prompt received",
  presence_ambient_marker: "Running quietly",
  surface2_emitted: "Added context to the response",
  surface2_missed: "Context was not added this turn",
  // ─── Token savings ─────────────────────────────────────────────────
  "tokenflow.shell_compression": "Compressed command output",
  "tokenflow.file_read": "Read only what was needed",
  "tokenflow.fetch_url": "Cleaned up a web page",
  "tokenflow.graph_query": "Used code graph instead of reading files",
  "tokenflow.session_dedup": "Skipped info the agent already had",
  "tokenflow.format_encoding": "Made the response more compact",
  "tokenflow.smart_truncation": "Trimmed repetitive output",
  "tokenflow.behavior_automation": "Did a step automatically",
  "tokenflow.persistent_memory": "Loaded from memory",
};

/**
 * Build a contextual, human-readable description for an event using its
 * metadata. Falls back to a static description when metadata is sparse.
 */
function describeEvent(
  eventType: string,
  meta: Record<string, unknown>
): string {
  const tool = typeof meta.tool === "string" ? meta.tool : null;
  const file =
    typeof meta.file_path === "string"
      ? meta.file_path.split("/").pop()
      : typeof meta.file === "string"
        ? meta.file.split("/").pop()
        : typeof meta.path === "string"
          ? meta.path.split("/").pop()
          : null;
  const content =
    typeof meta.top_content === "string"
      ? meta.top_content
      : typeof meta.content === "string"
        ? meta.content
        : typeof meta.fact_content === "string"
          ? meta.fact_content
          : null;

  const trunc = (s: string, max = 80) =>
    s.length > max ? `${s.slice(0, max)}…` : s;

  switch (eventType) {
    // ─── Token savings ───────────────────────────────────────────────
    case "tokenflow.shell_compression": {
      const cmd = typeof meta.command === "string" ? meta.command : null;
      if (cmd) return `Compressed the output of "${trunc(cmd, 60)}" so the agent sees a concise version`;
      return "Compressed a long command output so the agent doesn't waste tokens reading it";
    }
    case "tokenflow.file_read": {
      const lines = typeof meta.total_lines === "number" ? meta.total_lines : null;
      if (file && lines) return `Only sent the relevant part of ${file} (${lines}-line file) instead of the whole thing`;
      if (file) return `Sent only the relevant section of ${file} instead of the entire file`;
      return "Sent only the relevant section instead of the full file";
    }
    case "tokenflow.graph_query":
      if (tool) return `Answered the ${tool} question from the code graph — no file reading needed`;
      return "Answered from the code graph — saved the agent from reading files one by one";
    case "tokenflow.format_encoding":
      if (tool) return `Made the ${tool} response smaller so it uses fewer tokens`;
      return "Made the response smaller so it uses fewer tokens";
    case "tokenflow.fetch_url":
      return "Stripped navigation, ads, and boilerplate from a web page before sending it to the agent";
    case "tokenflow.session_dedup":
      return "The agent already had this information — skipped sending it again";
    case "tokenflow.smart_truncation":
      return "Trimmed repetitive or boilerplate content from a long output";
    case "tokenflow.behavior_automation":
      return "Performed a maintenance step automatically so the agent didn't have to";
    case "tokenflow.persistent_memory": {
      const verdict = typeof meta.verdict === "string" ? meta.verdict : null;
      if (verdict === "acted_on") return "Loaded a note from memory — the agent used it in its work";
      if (verdict === "reinforced") return "Re-surfaced a note from memory — it's still relevant";
      if (verdict === "ignored") return "Loaded a note from memory, but the agent didn't use it this time";
      return "Loaded stored notes from memory instead of the agent having to re-learn them";
    }

    // ─── Prevented mistakes ──────────────────────────────────────────
    case "stale_edit_prevented":
      if (file) return `Stopped the agent from editing ${file} because the file had changed since it was last read`;
      return "Stopped the agent from editing a file that had been modified — avoided overwriting new changes";
    case "cascade_guard":
      if (file) return `Other code depends on ${file} — warned the agent before editing to prevent breakage`;
      return "Warned the agent that other code depends on what it was about to change";
    case "cascade_warning_consumed":
      return "The agent read the dependency warning and adjusted its approach before editing";
    case "intervention_halted":
      if (tool) return `Blocked the ${tool} call because it was going in the wrong direction`;
      return "Blocked a tool call that would have taken the agent off track";
    case "intervention_warned":
      if (tool) return `Warned the agent that the ${tool} call looked risky — it adjusted its approach`;
      return "Warned the agent about a risky operation — it adjusted its approach";
    case "loop_broken":
      return "The agent was retrying the same thing — unerr broke the loop before it wasted more tokens";

    // ─── Smarter code understanding ──────────────────────────────────
    case "full_read_avoided":
      if (file) return `Sent only the relevant part of ${file} instead of the entire file`;
      return "Sent a focused section instead of dumping the full file into context";
    case "graph_query_served":
      if (tool) return `Answered a ${tool} question instantly from the code graph`;
      return "Answered a code question instantly from the code graph — no file reading needed";
    case "caller_check_enforced":
      if (file) return `Made the agent check what other code uses ${file} before making changes`;
      return "Made the agent check what other code depends on this before editing";
    case "drift_consumed":
      if (file) return `Noticed ${file} was modified on disk and told the agent to re-read it before editing`;
      return "A file was modified on disk — told the agent to re-read it before editing";
    case "convention_applied":
      if (content) return `Applied your project rule: "${trunc(content)}"`;
      return "Applied your project's naming and style conventions to the generated code";

    // ─── Memory ──────────────────────────────────────────────────────
    case "fact_recalled": {
      const count = typeof meta.count === "number" ? meta.count : 1;
      if (content && count > 1) return `Recalled ${count} stored notes — top one: "${trunc(content)}"`;
      if (content) return `Recalled: "${trunc(content)}"`;
      return `Recalled ${count} ${count === 1 ? "note" : "notes"} that you taught unerr in a previous session`;
    }
    case "fact_stored_user_fed": {
      const quote = typeof meta.source_quote === "string" ? meta.source_quote : null;
      if (quote) return `You said: "${trunc(quote)}" — saved for future sessions`;
      if (content) return `Saved for future sessions: "${trunc(content)}"`;
      return "Saved a rule you told unerr to remember — it will apply in future sessions";
    }
    case "fact_stored_auto":
      if (content) return `Noticed a pattern and saved it: "${trunc(content)}"`;
      return "Noticed a pattern in your codebase and saved it for future use";
    case "fact_capture_abandoned":
      return "Decided not to save a note — it wasn't clear enough to be reliable";
    case "cross_session_resume":
      return "Picked up where the last session left off — didn't need to re-learn your codebase";
    case "resume_blockers_surfaced": {
      const bCount = typeof meta.count === "number" ? meta.count : 1;
      return `Brought forward ${bCount} unresolved ${bCount === 1 ? "issue" : "issues"} from the previous session so nothing gets lost`;
    }
    case "cache_hit":
      if (tool) return `Reused a cached ${tool} result — no need to recompute`;
      return "Reused a cached result instead of doing the same work again";
    case "confirmation_expired":
      return "Asked you a question, but it went unanswered and timed out";

    // ─── Presence ────────────────────────────────────────────────────
    case "presence_ambient_marker":
      return "Nothing to report this turn — unerr was running quietly in the background";
    case "surface2_emitted":
      return "Added relevant notes, conventions, and warnings to the agent's response";
    case "surface2_missed":
      return "Was supposed to add context to the response but didn't fire this turn";
    case "defuddle_selector_skipped":
      return "Ran into an issue parsing a web page but recovered gracefully — no data was lost";

    default:
      return "";
  }
}

// ── Tone mapping ─────────────────────────────────────────────────────

type Tone = "catch" | "save" | "remember" | "guard" | "serve" | "note";

const FEATURED_TONE: Record<string, Tone> = {
  // Catches — things that would have gone wrong without unerr
  stale_edit_prevented: "catch",
  cascade_guard: "catch",
  intervention_halted: "catch",
  loop_broken: "catch",
  // Guards — proactive warnings that steered the agent
  intervention_warned: "guard",
  cascade_warning_consumed: "guard",
  caller_check_enforced: "guard",
  drift_consumed: "guard",
  defuddle_selector_skipped: "guard",
  surface2_missed: "guard",
  // Memory — cross-session intelligence
  fact_recalled: "remember",
  fact_stored_user_fed: "remember",
  fact_stored_auto: "remember",
  cross_session_resume: "remember",
  resume_blockers_surfaced: "remember",
  // Savings — tokens and time saved
  full_read_avoided: "save",
  cache_hit: "save",
  // Serving — intelligence delivered
  graph_query_served: "serve",
  convention_applied: "serve",
  surface2_emitted: "serve",
};

const TONE_COLORS: Record<Tone, string> = {
  catch: "text-red-400",
  guard: "text-amber-400",
  save: "text-emerald-400",
  remember: "text-violet-400",
  serve: "text-cyan-400",
  note: "text-zinc-400",
};

const TONE_BG: Record<Tone, string> = {
  catch: "bg-red-500/10 border-red-500/20",
  guard: "bg-amber-500/10 border-amber-500/20",
  save: "bg-emerald-500/10 border-emerald-500/20",
  remember: "bg-violet-500/10 border-violet-500/20",
  serve: "bg-cyan-500/10 border-cyan-500/20",
  note: "bg-zinc-500/10 border-zinc-500/20",
};

function toneFor(eventType: string | null): Tone {
  if (!eventType) return "note";
  if (eventType.startsWith("tokenflow.")) return "save";
  return FEATURED_TONE[eventType] ?? "note";
}

// ── Impact Hero ──────────────────────────────────────────────────────

function ImpactHero({
  totalPrompts,
  totalEvents,
  tokensSaved,
}: {
  totalPrompts: number;
  totalEvents: number;
  tokensSaved: number;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-border-subtle bg-linear-to-br from-violet-950/40 via-card to-card">
      <div className="absolute inset-0 bg-linear-to-r from-violet-500/5 to-transparent" />
      <div className="relative px-6 py-8 sm:px-8">
        {/* Dominant number */}
        <div className="mb-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-violet-300/70">
            Prompts handled
          </p>
          <p className="mt-1 font-grotesk text-5xl font-bold tabular-nums text-foreground">
            <CountUp value={totalPrompts} format={(n) => n.toLocaleString()} />
          </p>
        </div>

        {/* Supporting KPIs */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border-subtle bg-white/3 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
              unerr events
            </p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
              <CountUp value={totalEvents} format={fmtNum} />
            </p>
          </div>
          <div className="rounded-xl border border-border-subtle bg-white/3 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
              Tokens saved
            </p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-emerald-400">
              <CountUp value={tokensSaved} format={fmtNum} />
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Filter strip ─────────────────────────────────────────────────────

function FilterStrip({
  date,
  agent,
  sessionId,
  facets,
  onChange,
  onReset,
  isDefault,
}: {
  date: string;
  agent: string;
  sessionId: string;
  facets: FacetsResponse["data"] | undefined;
  onChange: (patch: Record<string, string | null>) => void;
  onReset: () => void;
  isDefault: boolean;
}) {
  const labelCls = "block text-[10px] uppercase tracking-[0.12em] t-tertiary";
  const inputCls =
    "w-full rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-foreground focus:border-violet-500/60 focus:outline-none focus:ring-1 focus:ring-violet-500/40";
  return (
    <section
      aria-label="Filter logbook"
      className="rounded-xl border border-border-subtle bg-card p-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="lb-date" className={labelCls}>
            Date
          </label>
          <input
            id="lb-date"
            type="date"
            value={date}
            max={todayLocal()}
            onChange={(e) => onChange({ date: e.target.value, page: null })}
            className={`${inputCls} font-mono tabular-nums`}
          />
        </div>
        <div>
          <label htmlFor="lb-agent" className={labelCls}>
            Agent
          </label>
          <select
            id="lb-agent"
            value={agent}
            onChange={(e) =>
              onChange({ agent: e.target.value || null, page: null })
            }
            className={inputCls}
          >
            <option value="">
              All agents{facets ? ` (${facets.total})` : ""}
            </option>
            {facets?.agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} ({a.count})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="lb-session" className={labelCls}>
            Session
          </label>
          <select
            id="lb-session"
            value={sessionId}
            onChange={(e) =>
              onChange({ session: e.target.value || null, page: null })
            }
            className={inputCls}
          >
            <option value="">Any session</option>
            {facets?.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {shortSession(s.id)} · {s.agent} · {timeHHMM(s.started_ts)} (
                {s.count})
              </option>
            ))}
          </select>
        </div>
      </div>
      {!isDefault ? (
        <div className="mt-3 flex items-center justify-end">
          <button
            type="button"
            onClick={onReset}
            className="rounded-md px-2 py-1 text-xs t-secondary hover:bg-muted hover:text-foreground"
          >
            Reset to today
          </button>
        </div>
      ) : null}
    </section>
  );
}

// ── Event type summary chips ─────────────────────────────────────────

const HIDDEN_FROM_PILLS = new Set([
  "user_prompt_received",
  "presence_ambient_marker",
  "surface2_emitted",
  "surface2_missed",
  "defuddle_selector_skipped",
  "confirmation_expired",
]);

function EventTypePills({ byType }: { byType: Record<string, number> }) {
  const entries = Object.entries(byType)
    .filter(([type, count]) => count > 0 && !HIDDEN_FROM_PILLS.has(type))
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([type, count]) => {
        const label =
          EVENT_TYPE_LABELS[type] ??
          type.replace(/^tokenflow\./, "").replace(/_/g, " ");
        const tone = toneFor(type);
        return (
          <span
            key={type}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${TONE_BG[tone]}`}
          >
            <span className={TONE_COLORS[tone]}>
              {EVENT_TYPE_ICONS[type.replace("tokenflow.", "")] ?? "·"}
            </span>
            <span className="text-foreground/80">{count}</span>
            <span className="t-tertiary">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

// ── Prompt Card (collapsed) ──────────────────────────────────────────

function PromptCard({
  item,
  isExpanded,
  onToggle,
  isHighestImpact,
}: {
  item: PromptFeedItem;
  isExpanded: boolean;
  onToggle: () => void;
  isHighestImpact: boolean;
}) {
  const sc = sessionColor(item.session_id);
  const tone = toneFor(item.summary.featured_event_type);
  const promptText = item.prompt?.text;
  const classified = item.prompt?.classified_as;

  return (
    <div
      className={`overflow-hidden rounded-xl border transition-all ${
        isExpanded
          ? "border-violet-500/30 bg-card shadow-lg shadow-violet-500/5"
          : isHighestImpact
            ? "border-violet-500/20 bg-card"
            : "border-border-subtle bg-card hover:border-border-strong"
      }`}
    >
      {/* Card header — clickable */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left"
        aria-expanded={isExpanded}
      >
        <div className={`border-l-2 px-4 py-3.5 sm:px-5 ${sc.stripe}`}>
          {/* Top row: prompt or placeholder + time */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {promptText ? (
                <p className="line-clamp-2 text-sm font-medium leading-relaxed text-foreground">
                  "{promptText}"
                </p>
              ) : (
                <p className="text-sm italic t-tertiary">
                  {item.prompt
                    ? `Prompt (${item.prompt.length} chars) — content not captured`
                    : "Prompt not captured"}
                </p>
              )}

              {/* Classification chip */}
              {classified ? (
                <span className="mt-1.5 inline-block rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-300">
                  {classified}
                </span>
              ) : null}
            </div>

            {/* Time + chevron */}
            <div className="flex shrink-0 items-center gap-2">
              <div className="text-right">
                <span className="block font-mono text-xs tabular-nums text-foreground">
                  {timeHHMM(item.ts_start)}
                </span>
                <span className="block text-[10px] t-tertiary">
                  {relTime(item.ts_start)}
                </span>
              </div>
              <span
                className={`t-tertiary transition-transform ${isExpanded ? "rotate-90" : ""}`}
                aria-hidden="true"
              >
                ›
              </span>
            </div>
          </div>

          {/* Bottom row: metrics + session + event pills */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* Session chip */}
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${sc.chip}`}
              title={item.session_id}
            >
              {shortSession(item.session_id)}
            </span>

            {/* Agent */}
            {item.summary.agents.length > 0 ? (
              <span className="font-mono text-[11px] text-foreground/70">
                {item.summary.agents[0]}
              </span>
            ) : null}

            {/* Turn */}
            <span className="font-mono text-[11px] tabular-nums t-tertiary">
              turn {item.turn}
            </span>

            {/* Divider */}
            <span className="hidden sm:inline t-ghost">·</span>

            {/* Event count + tool calls + tokens saved */}
            <span className="flex items-center gap-2 text-[11px]">
              <span className="font-mono tabular-nums text-foreground/70">
                {item.summary.event_count}{" "}
                {item.summary.event_count === 1 ? "event" : "events"}
              </span>
              {item.summary.tool_call_count > 0 ? (
                <>
                  <span className="t-ghost">·</span>
                  <span className="font-mono tabular-nums text-cyan-300">
                    {item.summary.tool_call_count} tool{" "}
                    {item.summary.tool_call_count === 1 ? "call" : "calls"}
                  </span>
                </>
              ) : null}
              {item.summary.marker_count > 0 ? (
                <>
                  <span className="t-ghost">·</span>
                  <span className="font-mono tabular-nums text-violet-300">
                    {item.summary.marker_count}{" "}
                    {item.summary.marker_count === 1 ? "marker" : "markers"}
                  </span>
                </>
              ) : null}
              {item.summary.tokens_saved > 0 ? (
                <>
                  <span className="t-ghost">·</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    {fmtNum(item.summary.tokens_saved)} saved
                  </span>
                </>
              ) : null}
            </span>

            {/* Featured event accent */}
            {item.summary.featured_verb ? (
              <>
                <span className="hidden sm:inline t-ghost">·</span>
                <span
                  className={`text-[11px] ${TONE_COLORS[tone]}`}
                >
                  {item.summary.featured_verb}
                </span>
              </>
            ) : null}
          </div>

          {/* Event type pills */}
          <div className="mt-2.5">
            <EventTypePills byType={item.summary.by_type} />
          </div>
        </div>
      </button>

      {/* Expanded detail */}
      {isExpanded ? (
        <PromptDetail sessionId={item.session_id} turn={item.turn} />
      ) : null}
    </div>
  );
}

// ── Prompt Detail (expanded) ─────────────────────────────────────────

function PromptDetail({
  sessionId,
  turn,
}: {
  sessionId: string;
  turn: number;
}) {
  const { url, queryKey } = useRepoApi();
  const [activeTab, setActiveTab] = useState<
    "events" | "tool_calls" | "markers" | "transcript" | "tokens"
  >("events");

  const detailQ = useQuery({
    queryKey: queryKey(["logbook", "prompt-detail", sessionId, turn]),
    queryFn: () =>
      fetchJson<PromptDetailResponse>(
        url(`/api/logbook/prompt-detail/${sessionId}/${turn}`)
      ),
  });

  if (detailQ.isLoading) {
    return (
      <div className="border-t border-border-subtle px-5 py-4">
        <CardGridSkeleton count={3} />
      </div>
    );
  }

  const data = detailQ.data?.data;
  if (!data) return null;

  const events = data.events ?? [];
  const transcript = data.transcript ?? [];
  const tokenOpt = data.token_optimization ?? { total_saved: 0, mechanisms: {} };
  const toolCalls = data.tool_calls ?? [];
  const markers = data.markers ?? [];

  const tabs = [
    { id: "events" as const, label: "Events", count: events.length },
    ...(toolCalls.length > 0
      ? [{ id: "tool_calls" as const, label: "Tool Calls", count: toolCalls.length }]
      : []),
    ...(markers.length > 0
      ? [{ id: "markers" as const, label: "Markers", count: markers.length }]
      : []),
    ...(data.has_transcript
      ? [{ id: "transcript" as const, label: "Execution Trace", count: transcript.length }]
      : []),
    ...(tokenOpt.total_saved > 0
      ? [{ id: "tokens" as const, label: "Token Savings", count: Object.keys(tokenOpt.mechanisms).length }]
      : []),
  ];

  return (
    <div className="border-t border-border-subtle">
      {/* Attribution summary */}
      {data.attribution &&
        ((data.attribution.recalls?.length ?? 0) > 0 ||
          (data.attribution.captures?.length ?? 0) > 0 ||
          (data.attribution.drift?.length ?? 0) > 0) ? (
        <div className="border-b border-border-subtle bg-violet-500/4 px-5 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-300/70">
            What unerr contributed
          </p>
          <div className="mt-2 space-y-1">
            {data.attribution.recalls?.map((r, i) => (
              <p key={`recall-${i}`} className="text-xs text-foreground/80">
                <span className="text-violet-400">↳</span> Recalled: "
                {r.content.length > 100
                  ? `${r.content.slice(0, 100)}…`
                  : r.content}
                "
                {r.scope ? (
                  <span className="t-tertiary"> · {r.scope}</span>
                ) : null}
              </p>
            ))}
            {data.attribution.captures?.map((c, i) => (
              <p key={`capture-${i}`} className="text-xs text-foreground/80">
                <span className="text-emerald-400">↳</span> Remembered: "
                {c.content.length > 100
                  ? `${c.content.slice(0, 100)}…`
                  : c.content}
                "
              </p>
            ))}
            {data.attribution.drift?.map((d, i) => (
              <p key={`drift-${i}`} className="text-xs text-foreground/80">
                <span className="text-amber-400">↳</span> Caught drift on{" "}
                <code className="rounded bg-muted/80 px-1 py-0.5 font-mono text-[11px]">
                  {d.file_path}
                </code>
              </p>
            ))}
          </div>
        </div>
      ) : null}

      {/* Tab bar */}
      <div className="flex gap-0 border-b border-border-subtle">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? "border-b-2 border-violet-400 text-foreground"
                : "text-zinc-400 hover:text-foreground"
            }`}
          >
            {tab.label}
            <span className="ml-1.5 rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
              {tab.count}
            </span>
          </button>
        ))}

        {/* Deep-link buttons */}
        <div className="ml-auto flex items-center gap-2 px-3">
          <button
            type="button"
            onClick={() =>
              navigateRoute("activity", { session: sessionId })
            }
            className="rounded px-2 py-1 text-[10px] text-violet-300 transition-colors hover:bg-violet-500/10 hover:text-violet-200"
          >
            Activity →
          </button>
          <button
            type="button"
            onClick={() =>
              navigateRoute("prompt-trace", {
                session: sessionId,
                turn: String(turn),
              })
            }
            className="rounded px-2 py-1 text-[10px] text-violet-300 transition-colors hover:bg-violet-500/10 hover:text-violet-200"
          >
            Prompt Trace →
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="px-5 py-4">
        {activeTab === "events" ? (
          <EventsTab events={events} />
        ) : activeTab === "tool_calls" ? (
          <ToolCallsTab toolCalls={toolCalls} />
        ) : activeTab === "markers" ? (
          <MarkersTab markers={markers} />
        ) : activeTab === "transcript" ? (
          <TranscriptTab transcript={transcript} />
        ) : activeTab === "tokens" ? (
          <TokensTab optimization={tokenOpt} />
        ) : null}
      </div>
    </div>
  );
}

// ── Events Tab ───────────────────────────────────────────────────────

type EventCategory = "catches" | "intelligence" | "memory" | "savings" | "other";

const EVENT_CATEGORY: Record<string, EventCategory> = {
  stale_edit_prevented: "catches",
  cascade_guard: "catches",
  cascade_warning_consumed: "catches",
  intervention_halted: "catches",
  intervention_warned: "catches",
  loop_broken: "catches",
  full_read_avoided: "intelligence",
  graph_query_served: "intelligence",
  caller_check_enforced: "intelligence",
  drift_consumed: "intelligence",
  convention_applied: "intelligence",
  defuddle_selector_skipped: "intelligence",
  fact_recalled: "memory",
  fact_stored_user_fed: "memory",
  fact_stored_auto: "memory",
  cross_session_resume: "memory",
  resume_blockers_surfaced: "memory",
  fact_capture_abandoned: "other",
  cache_hit: "savings",
  confirmation_expired: "other",
  presence_ambient_marker: "other",
  surface2_emitted: "other",
  surface2_missed: "other",
};

const CATEGORY_META: Record<
  EventCategory,
  { label: string; sublabel: string; color: string }
> = {
  catches: {
    label: "Mistakes prevented",
    sublabel: "These would have gone wrong without unerr",
    color: "text-red-400",
  },
  intelligence: {
    label: "Smarter answers",
    sublabel: "Faster and more accurate than reading files one by one",
    color: "text-cyan-400",
  },
  memory: {
    label: "Memory",
    sublabel: "Your rules and patterns, carried across sessions",
    color: "text-violet-400",
  },
  savings: {
    label: "Tokens saved",
    sublabel: "Less wasted context means more room for your actual code",
    color: "text-emerald-400",
  },
  other: { label: "Other activity", sublabel: "", color: "text-zinc-400" },
};

function categorize(eventType: string): EventCategory {
  if (eventType.startsWith("tokenflow.")) return "savings";
  return EVENT_CATEGORY[eventType] ?? "other";
}

function EventRow({
  ev,
  i,
}: {
  ev: PromptDetailResponse["data"]["events"][number];
  i: number;
}) {
  const tone = toneFor(ev.event_type);
  const meta = (ev.metadata ?? {}) as Record<string, unknown>;
  const tokensSaved =
    typeof meta.tokens_saved === "number" ? meta.tokens_saved : undefined;
  const label =
    EVENT_TYPE_LABELS[ev.event_type] ??
    ev.event_type.replace(/^tokenflow\./, "").replace(/_/g, " ");
  const description = describeEvent(ev.event_type, meta);
  return (
    <div
      key={`${ev.ts}-${ev.event_type}-${i}`}
      className="flex items-start gap-3 rounded-lg bg-muted/20 px-3 py-2.5"
    >
      <span
        className={`mt-0.5 shrink-0 text-sm ${TONE_COLORS[tone]}`}
        aria-hidden="true"
      >
        {EVENT_TYPE_ICONS[ev.event_type.replace("tokenflow.", "")] ?? "·"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed t-secondary">
            {description}
          </p>
        ) : null}
        {typeof tokensSaved === "number" && tokensSaved > 0 ? (
          <p className="mt-0.5 font-mono text-[11px] tabular-nums text-emerald-400">
            saved {fmtNum(tokensSaved)} tokens
          </p>
        ) : null}
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums t-tertiary">
        {timeHHMM(ev.ts)}
      </span>
    </div>
  );
}

function EventsTab({
  events,
}: {
  events: PromptDetailResponse["data"]["events"];
}) {
  if (events.length === 0) {
    return (
      <p className="py-4 text-center text-sm t-secondary">
        No events recorded for this prompt.
      </p>
    );
  }

  const filtered = events.filter(
    (ev) => ev.event_type !== "user_prompt_received"
  );
  if (filtered.length === 0) {
    return (
      <p className="py-4 text-center text-sm t-secondary">
        No unerr actions recorded for this prompt.
      </p>
    );
  }

  // Group by category for structured presentation
  const groups = new Map<EventCategory, typeof filtered>();
  for (const ev of filtered) {
    const cat = categorize(ev.event_type);
    const existing = groups.get(cat);
    if (existing) existing.push(ev);
    else groups.set(cat, [ev]);
  }

  // Category display order: catches first (highest value), then
  // intelligence, memory, savings, other
  const order: EventCategory[] = [
    "catches",
    "intelligence",
    "memory",
    "savings",
    "other",
  ];

  // If only one category or few events, skip grouping headers
  if (groups.size <= 1 || filtered.length <= 3) {
    return (
      <div className="space-y-2">
        {filtered.map((ev, i) => (
          <EventRow key={`${ev.ts}-${ev.event_type}-${i}`} ev={ev} i={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {order.map((cat) => {
        const evs = groups.get(cat);
        if (!evs || evs.length === 0) return null;
        const meta = CATEGORY_META[cat];
        return (
          <div key={cat}>
            <div className="mb-2 flex items-baseline gap-2">
              <h4 className={`text-[11px] font-semibold uppercase tracking-widest ${meta.color}`}>
                {meta.label}
              </h4>
              <span className="font-mono text-[10px] tabular-nums t-tertiary">
                {evs.length}
              </span>
              {meta.sublabel ? (
                <span className="text-[10px] t-ghost">— {meta.sublabel}</span>
              ) : null}
            </div>
            <div className="space-y-1.5">
              {evs.map((ev, i) => (
                <EventRow
                  key={`${ev.ts}-${ev.event_type}-${i}`}
                  ev={ev}
                  i={i}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tool Calls Tab ──────────────────────────────────────────────────

const TOOL_CATEGORIES: Record<string, { label: string; color: string }> = {
  search_code:     { label: "Search",      color: "text-cyan-300 bg-cyan-500/10" },
  get_entity:      { label: "Read entity", color: "text-cyan-300 bg-cyan-500/10" },
  get_references:  { label: "References",  color: "text-cyan-300 bg-cyan-500/10" },
  file_read:       { label: "File read",   color: "text-cyan-300 bg-cyan-500/10" },
  file_outline:    { label: "Outline",     color: "text-cyan-300 bg-cyan-500/10" },
  get_imports:     { label: "Imports",     color: "text-cyan-300 bg-cyan-500/10" },
  get_conventions: { label: "Conventions", color: "text-emerald-300 bg-emerald-500/10" },
  get_rules:       { label: "Rules",       color: "text-emerald-300 bg-emerald-500/10" },
  recall_facts:    { label: "Recall facts", color: "text-violet-300 bg-violet-500/10" },
  unerr_recall_notes: { label: "Recall notes", color: "text-violet-300 bg-violet-500/10" },
  unerr_remember:  { label: "Remember",   color: "text-violet-300 bg-violet-500/10" },
  record_fact:     { label: "Record fact", color: "text-violet-300 bg-violet-500/10" },
  unerr_turn_summary: { label: "Turn summary", color: "text-zinc-400 bg-white/5" },
  fetch_url:       { label: "Fetch URL",   color: "text-amber-300 bg-amber-500/10" },
  get_critical_nodes: { label: "Critical nodes", color: "text-rose-300 bg-rose-500/10" },
};

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined || v === "") continue;
    const val = typeof v === "string"
      ? v.length > 60 ? `${v.slice(0, 60)}…` : v
      : JSON.stringify(v);
    parts.push(`${k}: ${val}`);
  }
  return parts.join(", ");
}

function summarizeResult(result: Record<string, unknown>): string | null {
  if ("count" in result && typeof result.count === "number") {
    return `${result.count} result${result.count !== 1 ? "s" : ""}`;
  }
  if ("found" in result) {
    return result.found ? "found" : "not found";
  }
  if ("entity_count" in result && typeof result.entity_count === "number") {
    return `${result.entity_count} entities`;
  }
  const keys = Object.keys(result);
  if (keys.length === 0) return null;
  return keys.slice(0, 3).join(", ");
}

function ToolCallsTab({
  toolCalls,
}: {
  toolCalls: PromptDetailResponse["data"]["tool_calls"];
}) {
  if (toolCalls.length === 0) {
    return (
      <p className="py-4 text-center text-sm t-secondary">
        No tool calls recorded for this session.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {toolCalls.map((call, i) => {
        const cat = TOOL_CATEGORIES[call.tool];
        const label = cat?.label ?? call.tool;
        const pillColor = cat?.color ?? "text-zinc-400 bg-white/5";
        const argStr = summarizeArgs(call.args_summary);
        const resultStr = summarizeResult(call.result_summary);
        return (
          <div
            key={call.id ?? `${call.ts}-${i}`}
            className="flex items-start gap-2.5 rounded-lg bg-muted/20 px-3 py-2"
          >
            <span className="mt-0.5 shrink-0 text-[10px] font-mono tabular-nums t-tertiary">
              {timeHHMM(call.ts)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${pillColor}`}
                >
                  {label}
                </span>
                {resultStr ? (
                  <span className="font-mono text-[10px] tabular-nums text-emerald-400/70">
                    → {resultStr}
                  </span>
                ) : null}
              </div>
              {argStr ? (
                <p className="mt-1 truncate font-mono text-[11px] leading-relaxed t-secondary">
                  {argStr}
                </p>
              ) : null}
            </div>
            {call.correlation_id ? (
              <span
                className="shrink-0 rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] t-tertiary"
                title={`Correlated with ${call.correlation_id}`}
              >
                ⤴
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Markers Tab ─────────────────────────────────────────────────────

const MARKER_STYLES: Record<
  string,
  { icon: string; color: string; label: string }
> = {
  mark_intent:     { icon: "◆", color: "text-violet-400", label: "Intent" },
  mark_decision:   { icon: "⟡", color: "text-cyan-400",   label: "Decision" },
  mark_blocker:    { icon: "⚠", color: "text-amber-400",  label: "Blocker" },
  mark_resolution: { icon: "✓", color: "text-emerald-400", label: "Resolved" },
};

function MarkersTab({
  markers,
}: {
  markers: PromptDetailResponse["data"]["markers"];
}) {
  if (markers.length === 0) {
    return (
      <p className="py-4 text-center text-sm t-secondary">
        No markers recorded for this session.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {markers.map((m, i) => {
        const style = MARKER_STYLES[m.type] ?? {
          icon: "·",
          color: "text-zinc-400",
          label: m.type,
        };
        return (
          <div
            key={m.id ?? `${m.ts}-${i}`}
            className="rounded-lg border border-border-subtle bg-muted/20 px-4 py-3"
          >
            <div className="flex items-start gap-2.5">
              <span className={`mt-0.5 text-sm ${style.color}`}>
                {style.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${style.color} bg-white/5`}
                  >
                    {style.label}
                  </span>
                  <span className="ml-auto font-mono text-[10px] tabular-nums t-tertiary">
                    {timeHHMM(m.ts)}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-foreground">{m.text}</p>
                {m.alternatives ? (
                  <div className="mt-2">
                    <p className="text-[10px] font-medium uppercase tracking-wide t-tertiary">
                      Alternatives considered
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {m.alternatives.map((alt, ai) => (
                        <li
                          key={`alt-${ai}`}
                          className="text-xs t-secondary before:mr-1.5 before:content-['–']"
                        >
                          {alt}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {m.file_path ? (
                  <code className="mt-1 inline-block rounded bg-muted/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground/70">
                    {m.file_path}
                  </code>
                ) : null}
                {m.blocker_ref ? (
                  <p className="mt-1 text-[11px] t-secondary">
                    Resolves blocker{" "}
                    <code className="rounded bg-muted/80 px-1 py-0.5 font-mono text-[10px]">
                      {m.blocker_ref}
                    </code>
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Transcript Tab ───────────────────────────────────────────────────

function TranscriptTab({
  transcript,
}: {
  transcript: PromptDetailResponse["data"]["transcript"];
}) {
  if (transcript.length === 0) {
    return (
      <p className="py-4 text-center text-sm t-secondary">
        No execution trace available for this prompt.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {transcript.map((turn, i) => {
        const isUser = turn.role === "user";
        return (
          <div
            key={`${turn.ts}-${turn.role}-${i}`}
            className={`rounded-lg border px-4 py-3 ${
              isUser
                ? "border-violet-500/20 bg-violet-500/5"
                : "border-border-subtle bg-muted/20"
            }`}
          >
            {/* Header */}
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                  isUser
                    ? "bg-violet-500/20 text-violet-300"
                    : "bg-white/5 text-zinc-400"
                }`}
              >
                {turn.role}
              </span>
              {turn.model ? (
                <span className="font-mono text-[10px] t-tertiary">
                  {turn.model}
                </span>
              ) : null}
              <span className="ml-auto font-mono text-[10px] tabular-nums t-tertiary">
                {timeHHMM(turn.ts)}
              </span>
            </div>

            {/* Text content (truncated) */}
            {turn.text ? (
              <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                {turn.text}
              </p>
            ) : null}

            {/* Tools + files */}
            {(turn.tools && turn.tools.length > 0) ||
            (turn.files && turn.files.length > 0) ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {turn.tools?.map((tool) => (
                  <span
                    key={tool}
                    className="rounded-full bg-cyan-500/10 px-2 py-0.5 font-mono text-[10px] text-cyan-300"
                  >
                    {tool}
                  </span>
                ))}
                {turn.files?.slice(0, 5).map((file) => (
                  <span
                    key={file}
                    className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] t-secondary"
                    title={file}
                  >
                    {file.split("/").pop()}
                  </span>
                ))}
                {turn.files && turn.files.length > 5 ? (
                  <span className="text-[10px] t-tertiary">
                    +{turn.files.length - 5} more
                  </span>
                ) : null}
              </div>
            ) : null}

            {/* Token usage */}
            {turn.tokens_input > 0 || turn.tokens_output > 0 ? (
              <div className="mt-2 flex gap-3 font-mono text-[10px] tabular-nums t-tertiary">
                <span>
                  {fmtNum(turn.tokens_input)} in
                </span>
                <span>
                  {fmtNum(turn.tokens_output)} out
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Tokens Tab ───────────────────────────────────────────────────────

function TokensTab({
  optimization,
}: {
  optimization: PromptDetailResponse["data"]["token_optimization"];
}) {
  const sorted = Object.entries(optimization.mechanisms).sort(
    ([, a], [, b]) => b - a
  );

  return (
    <div className="space-y-4">
      {/* Total */}
      <div className="flex items-baseline gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] t-tertiary">
          Total saved
        </span>
        <span className="font-mono text-2xl font-bold tabular-nums text-emerald-400">
          {fmtNum(optimization.total_saved)}
        </span>
        <span className="text-xs t-tertiary">tokens</span>
      </div>

      {/* Mechanism breakdown */}
      {sorted.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] t-tertiary">
            By mechanism
          </p>
          {sorted.map(([mechanism, saved]) => {
            const pct =
              optimization.total_saved > 0
                ? (saved / optimization.total_saved) * 100
                : 0;
            const label = MECHANISM_LABELS[mechanism] ?? mechanism.replace(/_/g, " ");
            return (
              <div key={mechanism} className="space-y-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-foreground/80">{label}</span>
                  <span className="font-mono text-xs tabular-nums text-foreground">
                    {fmtNum(saved)}{" "}
                    <span className="t-tertiary">({pct.toFixed(0)}%)</span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-white/5">
                  <div
                    className="h-1.5 rounded-full bg-emerald-500/60 transition-all"
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── Pagination ───────────────────────────────────────────────────────

function PaginationBar({
  page,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (next: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const cur = Math.max(1, Math.min(page, pages));
  const from = (cur - 1) * pageSize + 1;
  const to = Math.min(cur * pageSize, total);
  const btn =
    "rounded-md px-2.5 py-1 font-mono text-xs tabular-nums transition-colors";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-card px-4 py-3">
      <span className="text-xs t-secondary">
        Showing{" "}
        <span className="font-mono tabular-nums text-foreground">
          {from}–{to}
        </span>{" "}
        of{" "}
        <span className="font-mono tabular-nums text-foreground">
          {fmtNum(total)}
        </span>{" "}
        prompts
      </span>
      <nav className="flex items-center gap-1" aria-label="Pagination">
        <button
          type="button"
          onClick={() => onChange(cur - 1)}
          disabled={cur === 1}
          className={`${btn} ${
            cur === 1
              ? "t-ghost"
              : "t-secondary hover:bg-muted hover:text-foreground"
          }`}
        >
          ‹ Prev
        </button>
        <span className="px-2 font-mono text-xs tabular-nums text-foreground">
          {cur} / {pages}
        </span>
        <button
          type="button"
          onClick={() => onChange(cur + 1)}
          disabled={cur === pages}
          className={`${btn} ${
            cur === pages
              ? "t-ghost"
              : "t-secondary hover:bg-muted hover:text-foreground"
          }`}
        >
          Next ›
        </button>
      </nav>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

export function LogbookPage() {
  const { url, queryKey } = useRepoApi();

  const dateParam = useHashQueryParam("date");
  const agentParam = useHashQueryParam("agent");
  const sessionParam = useHashQueryParam("session");
  const pageParam = useHashQueryParam("page");

  const date = dateParam || todayLocal();
  const agent = agentParam || "";
  const sessionId = sessionParam || "";
  const page = Math.max(1, Number(pageParam ?? 1) || 1);
  const isDefault =
    !dateParam && !agentParam && !sessionParam && (!pageParam || pageParam === "1");

  const bounds = useMemo(() => dayBounds(date), [date]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const sharedFilter = useMemo(() => {
    const qs = new URLSearchParams();
    if (bounds) {
      qs.set("from_ts", bounds.from_ts);
      qs.set("to_ts", bounds.to_ts);
    }
    if (agent) qs.set("agent", agent);
    if (sessionId) qs.set("session_id", sessionId);
    return qs;
  }, [bounds, agent, sessionId]);

  // Story query — for the ImpactHero counts
  const storyQ = useQuery({
    queryKey: queryKey([
      "logbook",
      "story",
      bounds?.from_ts ?? "",
      bounds?.to_ts ?? "",
      agent,
      sessionId,
    ]),
    queryFn: () =>
      fetchJson<StoryResponse>(
        url(`/api/logbook/story?${sharedFilter.toString()}`)
      ),
    refetchInterval: REFETCH_MS,
  });

  // Facets query — for filter dropdowns
  const facetsQ = useQuery({
    queryKey: queryKey([
      "logbook",
      "facets",
      bounds?.from_ts ?? "",
      bounds?.to_ts ?? "",
    ]),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (bounds) {
        qs.set("from_ts", bounds.from_ts);
        qs.set("to_ts", bounds.to_ts);
      }
      return fetchJson<FacetsResponse>(
        url(`/api/logbook/facets?${qs.toString()}`)
      );
    },
    refetchInterval: REFETCH_MS,
  });

  // Prompt feed — the new prompt-grouped endpoint
  const feedQ = useQuery({
    queryKey: queryKey([
      "logbook",
      "prompt-feed",
      bounds?.from_ts ?? "",
      bounds?.to_ts ?? "",
      agent,
      sessionId,
      page,
    ]),
    queryFn: () => {
      const qs = new URLSearchParams(sharedFilter);
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String((page - 1) * PAGE_SIZE));
      return fetchJson<PromptFeedResponse>(
        url(`/api/logbook/prompt-feed?${qs.toString()}`)
      );
    },
    refetchInterval: REFETCH_MS,
  });

  // Reset expansion on filter change
  useEffect(() => {
    setExpandedKey(null);
  }, [date, agent, sessionId, page]);

  const story = storyQ.data?.data;
  const facets = facetsQ.data?.data;
  const feed = feedQ.data?.data ?? [];
  const total = feedQ.data?.total ?? 0;

  // Find the highest-impact card (most tokens saved) for Von Restorff accent
  const highestImpactKey = useMemo(() => {
    if (feed.length === 0) return null;
    let best = feed[0]!;
    for (const item of feed) {
      if (item.summary.tokens_saved > best.summary.tokens_saved) best = item;
    }
    return `${best.session_id}::${best.turn}`;
  }, [feed]);

  const periodLabel = useMemo(() => {
    if (date === todayLocal()) return "Today";
    const d = new Date(`${date}T00:00:00`);
    if (Number.isNaN(d.getTime())) return date;
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }, [date]);

  const updateFilters = (patch: Record<string, string | null>) => {
    setHashQueryParams(patch);
    setExpandedKey(null);
  };

  const resetFilters = () => {
    setHashQueryParams({
      date: null,
      agent: null,
      session: null,
      page: null,
    });
    setExpandedKey(null);
  };

  const setPage = (next: number) => {
    setHashQueryParams({ page: next > 1 ? String(next) : null });
    setExpandedKey(null);
    if (typeof window !== "undefined")
      window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (storyQ.isLoading && feedQ.isLoading) {
    return (
      <div className="space-y-6">
        <CardGridSkeleton count={3} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header>
        <h1 className="font-grotesk text-xl font-semibold text-foreground">
          What unerr did
        </h1>
        <p className="mt-1 text-sm t-secondary">
          <span className="font-mono tabular-nums text-foreground">
            {periodLabel}
          </span>
          <span className="t-tertiary"> · </span>
          <span className="font-mono tabular-nums text-foreground">
            {fmtNum(total)}
          </span>{" "}
          {total === 1 ? "prompt" : "prompts"} handled
        </p>
      </header>

      {/* Impact Hero */}
      {story ? (
        <ImpactHero
          totalPrompts={total}
          totalEvents={story.right_rail.total_events}
          tokensSaved={story.right_rail.total_tokens_saved}
        />
      ) : null}

      {/* Filter strip */}
      <FilterStrip
        date={date}
        agent={agent}
        sessionId={sessionId}
        facets={facets}
        onChange={updateFilters}
        onReset={resetFilters}
        isDefault={isDefault}
      />

      {/* Prompt feed */}
      <section aria-label="Prompt feed">
        {feedQ.isLoading ? (
          <CardGridSkeleton count={5} />
        ) : feed.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border-subtle bg-card px-6 py-12 text-center">
            <p className="text-3xl" aria-hidden="true">
              ◇
            </p>
            <p className="text-sm t-secondary">
              {story?.honest_zero
                ? "unerr was quiet — nothing to replay for this view."
                : "No prompts match these filters."}
            </p>
            {!isDefault ? (
              <button
                type="button"
                onClick={resetFilters}
                className="mt-1 text-xs text-violet-300 hover:text-violet-200 hover:underline"
              >
                Reset to today
              </button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            {feed.map((item) => {
              const key = `${item.session_id}::${item.turn}`;
              return (
                <PromptCard
                  key={key}
                  item={item}
                  isExpanded={expandedKey === key}
                  onToggle={() =>
                    setExpandedKey((cur) => (cur === key ? null : key))
                  }
                  isHighestImpact={key === highestImpactKey}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Pagination */}
      <PaginationBar
        page={page}
        total={total}
        pageSize={PAGE_SIZE}
        onChange={setPage}
      />
    </div>
  );
}
