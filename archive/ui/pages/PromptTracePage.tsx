/**
 * PromptTrace page — full-trace view for a single prompt turn.
 *
 * Opened with `?session=<id>&turn=<n>`. Shows everything unerr knows about
 * this turn: prompt, events, tool calls, markers, attribution, savings,
 * reasoning, files touched, drift caught, and external transcript.
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { navigateRoute, useHashQueryParam } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AgentBadge } from "./token-trace/components/AgentBadge";
import { Breadcrumb } from "./token-trace/components/Breadcrumb";
import { MechanismPill } from "./token-trace/components/MechanismPill";

// ── Types ──────────────────────────────────────────────────────────────

interface PromptForTurn {
  session_id: string;
  turn: number;
  prompt: string | null;
  length: number;
  classified_as: string | null;
  ts: string;
}

interface TokensUsed {
  input: number;
  output: number;
  cache_create: number;
  cache_read: number;
  total: number;
}

interface NamedEvent {
  event_type: string;
  session_id: string;
  turn: number;
  ts: string;
  agent: string | null;
  tool: string | null;
  entity_key: string | null;
  metadata: Record<string, unknown>;
}

interface AttributionRecall {
  source_quote: string;
  content: string;
}
interface AttributionCapture {
  source_quote: string;
  content: string;
}
interface AttributionDrift {
  file_path: string;
}

interface ToolCallEntry {
  id: string;
  ts: string;
  tool: string;
  args_summary: Record<string, unknown>;
  result_summary: Record<string, unknown>;
  turn_id: string | null;
  correlation_id: string | null;
}

interface MarkerEntry {
  id: string;
  ts: string;
  type: string;
  text: string;
  turn_id: string | null;
  alternatives: string[] | null;
  blocker_ref: string | null;
  file_path: string | null;
}

interface PromptTrace {
  session_id: string;
  turn: number;
  agent: string | null;
  prompt: PromptForTurn | null;
  tokens_saved: number;
  mechanisms: string[];
  tools: string[];
  files: string[];
  drift_caught: number;
  reasoning: {
    noise_removed_pct: number;
    first_call_resolution_rate: number;
    turns_saved: number;
  };
  flag_on: boolean;
  capability: "jsonl" | "sqlite" | null;
  transcript_available: boolean;
  tokens_used: TokensUsed | null;
  events: NamedEvent[];
  attribution: {
    recalls: AttributionRecall[];
    captures: AttributionCapture[];
    drift: AttributionDrift[];
  };
  tool_calls: ToolCallEntry[];
  markers: MarkerEntry[];
}

interface PromptTraceResponse {
  data: PromptTrace;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Last path segment of a file key — `src/commands/install.ts` → `install.ts`. */
function baseName(path: string): string {
  const seg = path.split("/").filter(Boolean);
  return seg[seg.length - 1] ?? path;
}

// ── Sub-components ──────────────────────────────────────────────────────

function StatBlock({
  label,
  value,
  accent,
  hint,
  sub,
}: {
  label: string;
  value: string;
  accent: string;
  hint?: string;
  sub?: string;
}) {
  return (
    <div className="el-raised rounded-lg p-4" title={hint}>
      <p className="t-tertiary text-[10px] uppercase tracking-wider">{label}</p>
      <p className={`mt-1 text-2xl font-bold font-mono tabular-nums ${accent}`}>
        {value}
      </p>
      {sub && <p className="t-tertiary text-[10px] mt-1 leading-snug">{sub}</p>}
    </div>
  );
}

/** The originating prompt block — verbatim quote, capture-off hint, or
 *  "no prompt captured" when the agent never emitted the hook. */
function PromptHeader({ trace }: { trace: PromptTrace }) {
  const p = trace.prompt;
  return (
    <div className="el-raised rounded-lg p-5 border-l-4 border-violet-500/50">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="t-tertiary text-[10px] uppercase tracking-wider">
          Prompt
        </span>
        <span className="t-tertiary text-xs font-mono">turn {trace.turn}</span>
        <AgentBadge name={trace.agent} />
        {p?.classified_as && (
          <span className="rounded-full bg-violet-500/15 text-violet-300 px-2 py-0.5 text-[10px] font-medium">
            {p.classified_as}
          </span>
        )}
      </div>
      {p?.prompt ? (
        <p className="text-foreground text-lg leading-snug italic">
          "{p.prompt}"
        </p>
      ) : p ? (
        <p className="t-secondary text-sm">
          Prompt not captured —{" "}
          <span className="font-mono">
            set <span className="text-amber-400">capture_prompts: true</span> in
            .unerr/config.json
          </span>{" "}
          to record verbatim text ({p.length} chars this turn).
        </p>
      ) : (
        <p className="t-tertiary text-sm">
          No prompt captured for this turn (agent does not emit the
          UserPromptSubmit hook).
        </p>
      )}
    </div>
  );
}

/** Actual tokens the agent burned — present only when the gated transcript
 *  reader produced data; otherwise renders the enable / unsupported hint. */
function TokensUsedBlock({ trace }: { trace: PromptTrace }) {
  const t = trace.tokens_used;
  if (trace.transcript_available && t) {
    return (
      <div className="el-raised rounded-lg p-5 border-t-2 border-cyan-500/60">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <p className="text-cyan-400 text-[10px] uppercase tracking-wider font-medium">
            Tokens used (actual)
          </p>
          <span className="t-tertiary text-[10px]">
            from {trace.agent ?? "agent"}'s own session log
          </span>
        </div>
        <p className="text-3xl font-bold font-mono text-cyan-400 mt-2">
          {fmt(t.total)}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 t-secondary text-xs font-mono">
          <span>{fmt(t.input)} in</span>
          <span>{fmt(t.output)} out</span>
          <span>{fmt(t.cache_create)} cache-write</span>
          <span>{fmt(t.cache_read)} cache-read</span>
        </div>
      </div>
    );
  }

  // No usage — explain why and how to turn it on.
  const reason = !trace.capability
    ? `${trace.agent ?? "This agent"} has no transcript reader — actual token usage is only available for Claude Code and Cursor.`
    : !trace.flag_on
      ? "Reading the agent's own session log is opt-in."
      : "No matching transcript was found for this prompt.";
  return (
    <div className="el-raised rounded-lg p-5 border-t-2 border-zinc-600/60">
      <p className="t-tertiary text-[10px] uppercase tracking-wider font-medium">
        Tokens used (actual)
      </p>
      <p className="text-2xl font-bold font-mono t-tertiary mt-2">—</p>
      <p className="t-secondary text-xs mt-2 leading-snug">{reason}</p>
      {trace.capability && !trace.flag_on && (
        <p className="t-tertiary text-[10px] mt-1 font-mono leading-snug">
          set read_agent_transcripts: true in .unerr/config.json
        </p>
      )}
    </div>
  );
}

// ── Event description helpers ────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  "tokenflow.shell_compression": "Compressed command output",
  "tokenflow.file_read": "Delivered targeted file content",
  "tokenflow.persistent_memory": "Used stored knowledge",
  "tokenflow.format_encoding": "Encoded response compactly",
  "tokenflow.response_dedup": "Removed duplicate content",
  "tokenflow.context_rot_prevention": "Cleaned stale context",
  "tokenflow.instruction_reinforcement": "Reinforced agent instructions",
  drift_consumed: "Caught file drift",
  stale_edit_prevented: "Prevented stale edit",
  cascade_warning_consumed: "Protected dependent code",
  convention_consumed: "Applied project conventions",
  fact_recalled: "Recalled stored knowledge",
  fact_captured: "Learned new project fact",
  user_prompt_received: "Received prompt",
  presence_ambient_marker: "Active monitoring",
  loop_circuit_breaker_fired: "Stopped a loop",
  auto_doc_generated: "Auto-documented code",
  defuddle_selector_skipped: "Recovered from parse issue",
};

function describeEvent(ev: NamedEvent): string {
  const meta = ev.metadata ?? {};
  const file =
    typeof meta.file_path === "string"
      ? meta.file_path
      : typeof meta.file === "string"
        ? meta.file
        : ev.entity_key;

  switch (ev.event_type) {
    case "tokenflow.shell_compression": {
      const cmd = typeof meta.command === "string" ? meta.command : null;
      return cmd
        ? `Compressed output of "${trunc(cmd, 60)}"`
        : "Compressed a long command output";
    }
    case "tokenflow.file_read":
      return file
        ? `Delivered only the relevant lines from ${trunc(file, 50)}`
        : "Delivered targeted file content";
    case "tokenflow.persistent_memory":
      return "Used stored project knowledge instead of re-reading files";
    case "tokenflow.format_encoding":
      return "Encoded the response compactly to save tokens";
    case "tokenflow.response_dedup":
      return "Removed duplicate information the agent already had";
    case "tokenflow.context_rot_prevention":
      return "Cleaned stale context that would have confused the agent";
    case "tokenflow.instruction_reinforcement":
      return "Reinforced agent instructions to keep it on track";
    case "drift_consumed":
      return file
        ? `Caught that ${trunc(file, 50)} changed since last read`
        : "Caught a file change the agent hadn't seen";
    case "stale_edit_prevented":
      return file
        ? `Stopped the agent from overwriting changes in ${trunc(file, 50)}`
        : "Prevented the agent from overwriting new changes";
    case "cascade_warning_consumed":
      return file
        ? `Warned about code that depends on ${trunc(file, 50)}`
        : "Warned about downstream code dependencies";
    case "convention_consumed":
      return file
        ? `Applied project conventions for ${trunc(file, 50)}`
        : "Applied project coding conventions";
    case "fact_recalled": {
      const content =
        typeof meta.content === "string"
          ? meta.content
          : typeof meta.source_quote === "string"
            ? meta.source_quote
            : null;
      return content
        ? `Recalled: "${trunc(content)}"`
        : "Recalled stored project knowledge";
    }
    case "fact_captured": {
      const content =
        typeof meta.content === "string"
          ? meta.content
          : typeof meta.source_quote === "string"
            ? meta.source_quote
            : null;
      return content
        ? `Learned: "${trunc(content)}"`
        : "Learned a new project fact";
    }
    case "loop_circuit_breaker_fired":
      return "Detected and stopped a repetitive agent loop";
    default:
      return EVENT_LABELS[ev.event_type] ?? ev.event_type.replace(/_/g, " ");
  }
}

function trunc(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const EVENT_ICONS: Record<string, string> = {
  "tokenflow.shell_compression": "📦",
  "tokenflow.file_read": "📄",
  "tokenflow.persistent_memory": "🧠",
  "tokenflow.format_encoding": "🗜️",
  "tokenflow.response_dedup": "♻️",
  "tokenflow.context_rot_prevention": "🧹",
  "tokenflow.instruction_reinforcement": "📋",
  drift_consumed: "🔄",
  stale_edit_prevented: "🛡️",
  cascade_warning_consumed: "⚠️",
  convention_consumed: "📐",
  fact_recalled: "💡",
  fact_captured: "📝",
  user_prompt_received: "💬",
  presence_ambient_marker: "👁️",
  loop_circuit_breaker_fired: "🔴",
  auto_doc_generated: "📖",
};

// Tool call categories for coloring
const TOOL_CATEGORIES: Record<string, { color: string; label: string }> = {
  search_code: { color: "text-cyan-400", label: "Search" },
  file_read: { color: "text-blue-400", label: "Read" },
  file_outline: { color: "text-blue-400", label: "Read" },
  get_entity: { color: "text-blue-400", label: "Read" },
  get_references: { color: "text-purple-400", label: "Graph" },
  get_imports: { color: "text-purple-400", label: "Graph" },
  get_critical_nodes: { color: "text-purple-400", label: "Graph" },
  get_conventions: { color: "text-indigo-400", label: "Conventions" },
  get_rules: { color: "text-indigo-400", label: "Conventions" },
  recall_facts: { color: "text-amber-400", label: "Memory" },
  unerr_recall_notes: { color: "text-amber-400", label: "Memory" },
  unerr_remember: { color: "text-amber-400", label: "Memory" },
  record_fact: { color: "text-amber-400", label: "Memory" },
  unerr_turn_summary: { color: "text-emerald-400", label: "Summary" },
};

const MARKER_STYLES: Record<
  string,
  { icon: string; color: string; label: string }
> = {
  mark_intent: { icon: "🎯", color: "text-violet-400", label: "Intent" },
  mark_decision: { icon: "⚖️", color: "text-cyan-400", label: "Decision" },
  mark_blocker: { icon: "🚧", color: "text-amber-400", label: "Blocker" },
  mark_resolution: {
    icon: "✅",
    color: "text-emerald-400",
    label: "Resolution",
  },
};

// ── Section components ─────────────────────────────────────────────────

function AttributionSection({
  attribution,
}: {
  attribution: PromptTrace["attribution"];
}) {
  const recalls = attribution?.recalls ?? [];
  const captures = attribution?.captures ?? [];
  const drift = attribution?.drift ?? [];
  const total = recalls.length + captures.length + drift.length;
  if (total === 0) return null;

  return (
    <div className="el-raised rounded-lg p-5">
      <h3 className="t-secondary text-xs font-medium uppercase tracking-wider mb-3">
        Memory activity
      </h3>
      <div className="space-y-2">
        {recalls.map((r, i) => (
          <div key={`recall-${i}`} className="flex items-start gap-2 text-sm">
            <span className="text-amber-400 shrink-0">💡</span>
            <div>
              <span className="text-amber-400 text-xs font-medium">
                Recalled
              </span>
              <p className="t-secondary text-xs mt-0.5 leading-snug">
                {trunc(r.content || r.source_quote, 120)}
              </p>
            </div>
          </div>
        ))}
        {captures.map((c, i) => (
          <div key={`capture-${i}`} className="flex items-start gap-2 text-sm">
            <span className="text-emerald-400 shrink-0">📝</span>
            <div>
              <span className="text-emerald-400 text-xs font-medium">
                Learned
              </span>
              <p className="t-secondary text-xs mt-0.5 leading-snug">
                {trunc(c.content || c.source_quote, 120)}
              </p>
            </div>
          </div>
        ))}
        {drift.map((d, i) => (
          <div key={`drift-${i}`} className="flex items-start gap-2 text-sm">
            <span className="text-red-400 shrink-0">🔄</span>
            <div>
              <span className="text-red-400 text-xs font-medium">
                Drift caught
              </span>
              <p className="font-mono text-xs t-secondary mt-0.5">
                {d.file_path}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventsSection({ events }: { events: NamedEvent[] }) {
  const visible = events.filter(
    (e) =>
      e.event_type !== "user_prompt_received" &&
      e.event_type !== "presence_ambient_marker"
  );
  if (visible.length === 0) return null;

  return (
    <div className="el-raised rounded-lg p-5">
      <h3 className="t-secondary text-xs font-medium uppercase tracking-wider mb-3">
        What happened ({visible.length} event{visible.length === 1 ? "" : "s"})
      </h3>
      <div className="space-y-2">
        {visible.map((ev, i) => {
          const icon = EVENT_ICONS[ev.event_type] ?? "•";
          const saved = ev.event_type.startsWith("tokenflow.")
            ? (ev.metadata as { tokens_saved?: number }).tokens_saved
            : null;
          return (
            <div key={i} className="flex items-start gap-2 group">
              <span className="shrink-0 text-sm">{icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-foreground text-xs leading-snug">
                  {describeEvent(ev)}
                </p>
                {saved != null && saved > 0 && (
                  <span className="text-emerald-400/70 text-[10px] font-mono">
                    saved {fmt(saved)} tokens
                  </span>
                )}
              </div>
              <span className="t-tertiary text-[10px] font-mono shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                {new Date(ev.ts).toLocaleTimeString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolCallsSection({ toolCalls }: { toolCalls: ToolCallEntry[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (toolCalls.length === 0) return null;

  return (
    <div className="el-raised rounded-lg p-5">
      <h3 className="t-secondary text-xs font-medium uppercase tracking-wider mb-3">
        Agent queries to unerr ({toolCalls.length})
      </h3>
      <div className="space-y-1.5">
        {toolCalls.map((tc) => {
          const cat = TOOL_CATEGORIES[tc.tool] ?? {
            color: "t-secondary",
            label: "Tool",
          };
          const isOpen = expanded === tc.id;
          return (
            <div key={tc.id} className="rounded border border-border-subtle/30">
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-secondary/50 transition-colors"
                onClick={() => setExpanded(isOpen ? null : tc.id)}
              >
                <span
                  className={`text-[10px] font-medium uppercase tracking-wider ${cat.color}`}
                >
                  {cat.label}
                </span>
                <span className="font-mono text-xs text-foreground">
                  {tc.tool}
                </span>
                <span className="flex-1" />
                <span className="t-tertiary text-[10px] font-mono">
                  {new Date(tc.ts).toLocaleTimeString()}
                </span>
                <span className="t-tertiary text-[10px]">
                  {isOpen ? "▾" : "▸"}
                </span>
              </button>
              {isOpen && (
                <div className="px-3 pb-2 space-y-1.5 border-t border-border-subtle/20">
                  {Object.keys(tc.args_summary).length > 0 && (
                    <div className="mt-1.5">
                      <p className="t-tertiary text-[10px] uppercase tracking-wider mb-0.5">
                        Args
                      </p>
                      <pre className="text-[11px] font-mono t-secondary whitespace-pre-wrap break-all bg-surface-secondary/30 rounded p-1.5">
                        {summarizeObj(tc.args_summary)}
                      </pre>
                    </div>
                  )}
                  {Object.keys(tc.result_summary).length > 0 && (
                    <div>
                      <p className="t-tertiary text-[10px] uppercase tracking-wider mb-0.5">
                        Result
                      </p>
                      <pre className="text-[11px] font-mono t-secondary whitespace-pre-wrap break-all bg-surface-secondary/30 rounded p-1.5">
                        {summarizeObj(tc.result_summary)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MarkersSection({ markers }: { markers: MarkerEntry[] }) {
  if (markers.length === 0) return null;

  return (
    <div className="el-raised rounded-lg p-5">
      <h3 className="t-secondary text-xs font-medium uppercase tracking-wider mb-3">
        Session markers ({markers.length})
      </h3>
      <div className="space-y-2">
        {markers.map((m) => {
          const style = MARKER_STYLES[m.type] ?? {
            icon: "📌",
            color: "t-secondary",
            label: m.type,
          };
          return (
            <div key={m.id} className="flex items-start gap-2">
              <span className="shrink-0">{style.icon}</span>
              <div className="flex-1 min-w-0">
                <span
                  className={`text-[10px] font-medium uppercase tracking-wider ${style.color}`}
                >
                  {style.label}
                </span>
                <p className="text-foreground text-xs leading-snug mt-0.5">
                  {m.text}
                </p>
                {m.alternatives && m.alternatives.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.alternatives.map((alt, i) => (
                      <span
                        key={i}
                        className="text-[10px] t-tertiary bg-surface-secondary rounded px-1.5 py-0.5"
                      >
                        alt: {alt}
                      </span>
                    ))}
                  </div>
                )}
                {m.file_path && (
                  <p className="font-mono text-[10px] t-tertiary mt-0.5">
                    {m.file_path}
                  </p>
                )}
              </div>
              <span className="t-tertiary text-[10px] font-mono shrink-0">
                {new Date(m.ts).toLocaleTimeString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function summarizeObj(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const val =
      typeof v === "string"
        ? trunc(v, 100)
        : typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : JSON.stringify(v).slice(0, 100);
    parts.push(`${k}: ${val}`);
  }
  return parts.join("\n") || "(empty)";
}

// ── Page ─────────────────────────────────────────────────────────────────

export function PromptTracePage() {
  const { url, queryKey } = useRepoApi();
  const session = useHashQueryParam("session");
  const turnParam = useHashQueryParam("turn");
  const turn = Number(turnParam);
  const valid = !!session && Number.isInteger(turn) && turn >= 0;

  const traceQ = useQuery({
    queryKey: queryKey(["prompt-trace", session, turnParam]),
    queryFn: () =>
      fetchJson<PromptTraceResponse>(
        url(`/api/prompt-trace/${encodeURIComponent(session ?? "")}/${turn}`)
      ),
    enabled: valid,
    refetchInterval: 5_000,
  });

  if (!valid) {
    return (
      <div className="el-raised rounded-lg p-10 text-center">
        <p className="t-secondary text-lg">No prompt selected</p>
        <p className="t-tertiary mt-2 text-sm">
          Open a prompt trace from{" "}
          <button
            type="button"
            className="text-violet-400 hover:text-violet-300 transition-colors"
            onClick={() => navigateRoute("logbook")}
          >
            What unerr did
          </button>{" "}
          or the Activity timeline.
        </p>
      </div>
    );
  }

  const crumbs = [
    { label: "What unerr did", onClick: () => navigateRoute("logbook") },
    { label: `Prompt · turn ${turn}` },
  ];

  if (traceQ.isLoading) {
    return (
      <div>
        <Breadcrumb items={crumbs} />
        <CardGridSkeleton n={4} />
      </div>
    );
  }

  const trace = traceQ.data?.data;
  if (!trace) {
    return (
      <div>
        <Breadcrumb items={crumbs} />
        <div className="el-raised rounded-lg p-8 text-center">
          <p className="t-secondary">
            No trace for session {session?.slice(0, 12)} · turn {turn}
          </p>
        </div>
      </div>
    );
  }

  const r = trace.reasoning;
  const events = trace.events ?? [];
  const attribution = trace.attribution ?? {
    recalls: [],
    captures: [],
    drift: [],
  };
  const toolCalls = trace.tool_calls ?? [];
  const markers = trace.markers ?? [];

  const totalActivity = events.length + toolCalls.length + markers.length;

  return (
    <div className="space-y-5">
      <Breadcrumb items={crumbs} />

      <PromptHeader trace={trace} />

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatBlock
          label="Tokens saved"
          value={fmt(trace.tokens_saved)}
          accent="text-emerald-400"
          hint="Tokens unerr kept out of context this turn."
          sub={
            trace.mechanisms.length > 0
              ? `${trace.mechanisms.length} mechanism${trace.mechanisms.length === 1 ? "" : "s"}`
              : undefined
          }
        />
        <StatBlock
          label="Noise removed"
          value={`${r.noise_removed_pct}%`}
          accent="text-violet-400"
          hint="Noise removed from context (graph-backed vs grep/glob)."
          sub={
            r.first_call_resolution_rate >= 50
              ? "found first try ✓"
              : `${r.first_call_resolution_rate}% first-try`
          }
        />
        <StatBlock
          label="Turns saved"
          value={`~${r.turns_saved}`}
          accent="text-cyan-400"
          hint="Estimated agent turns saved by unerr's precision."
        />
        <StatBlock
          label="Activity"
          value={String(totalActivity)}
          accent="text-foreground"
          hint="Total events, tool queries, and markers this turn."
          sub={`${events.length} events · ${toolCalls.length} queries · ${markers.length} markers`}
        />
      </div>

      {/* ── Tokens used (external) ── */}
      <TokensUsedBlock trace={trace} />

      {/* ── Attribution (recalls / captures / drift) ── */}
      <AttributionSection attribution={attribution} />

      {/* ── Events ── */}
      <EventsSection events={events} />

      {/* ── Tool calls ── */}
      <ToolCallsSection toolCalls={toolCalls} />

      {/* ── Markers ── */}
      <MarkersSection markers={markers} />

      {/* ── Mechanisms ── */}
      {trace.mechanisms.length > 0 && (
        <div className="el-raised rounded-lg p-5">
          <h3 className="t-secondary text-xs font-medium uppercase tracking-wider mb-3">
            Savings mechanisms
          </h3>
          <div className="flex flex-wrap gap-2">
            {trace.mechanisms.map((m) => (
              <MechanismPill key={m} mechanism={m} />
            ))}
          </div>
        </div>
      )}

      {/* ── Files + drift ── */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="el-raised rounded-lg p-5">
          <h3 className="t-secondary text-xs font-medium uppercase tracking-wider mb-3">
            Files touched ({trace.files.length})
          </h3>
          {trace.files.length === 0 ? (
            <p className="t-tertiary text-xs">No files touched this turn.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {trace.files.map((f) => (
                <span
                  key={f}
                  className="inline-flex items-center rounded bg-surface-secondary px-2 py-0.5 font-mono text-[11px] text-foreground"
                  title={f}
                >
                  {baseName(f)}
                </span>
              ))}
            </div>
          )}
          {trace.tools.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border-subtle/50">
              <p className="t-tertiary text-[10px] uppercase tracking-wider mb-1.5">
                Tools used
              </p>
              <div className="flex flex-wrap gap-1.5">
                {trace.tools.map((t) => (
                  <span key={t} className="font-mono text-[11px] t-secondary">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="el-raised rounded-lg p-5">
          <h3 className="t-secondary text-xs font-medium uppercase tracking-wider mb-3">
            Breakages caught
          </h3>
          {trace.drift_caught > 0 ? (
            <p className="text-amber-400 font-mono text-2xl font-bold">
              {trace.drift_caught}
              <span className="t-secondary text-xs font-normal ml-2">
                stale-edit / drift catch
                {trace.drift_caught === 1 ? "" : "es"}
              </span>
            </p>
          ) : (
            <p className="t-tertiary text-xs">
              No drift or stale-edit catches this turn.
            </p>
          )}
        </div>
      </div>

      {/* ── Deep-links ── */}
      <div className="el-raised rounded-lg p-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs">
        <button
          type="button"
          className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
          onClick={() =>
            navigateRoute("token-trace", {
              session: trace.session_id,
              turn: String(trace.turn),
            })
          }
        >
          See token-by-token in Token Trace →
        </button>
        <button
          type="button"
          className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
          onClick={() =>
            navigateRoute("reasoning", { session: trace.session_id })
          }
        >
          See reasoning detail in Reasoning Trace →
        </button>
      </div>
    </div>
  );
}
