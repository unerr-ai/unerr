/**
 * Token Trace — shared types, constants, helpers.
 *
 * Extracted from TokenFlowPage.tsx so the page can be split into smaller
 * view + component files without each piece duplicating these primitives.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface MechanismSummary {
  tokens_saved: number;
  tokens_delivered: number;
  event_count: number;
  pct_of_total: number;
}

export interface GlobalResponse {
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

export interface SessionListEntry {
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

export interface SessionListResponse {
  data: SessionListEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface EventsResponse {
  data: TokenFlowEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface SessionSummaryResponse {
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

export interface TokenFlowEvent {
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

export interface CumulativeTurn {
  turn: number;
  tools: string[];
  tokens_saved_this_turn: number;
  cumulative_tokens_saved: number;
  context_avoided: number;
  mechanisms_this_turn: Record<string, number>;
  cumulative_by_mechanism: Record<string, number>;
  event_count: number;
}

export interface CumulativeResponse {
  data: CumulativeTurn[];
  total_turns: number;
  total_saved: number;
  avg_context_reduction: number;
  peak_context_reduction: number;
  total_context_avoided: number;
}

// ── Constants ────────────────────────────────────────────────────────

// Per-mechanism colors. `graph_query` and `file_read` are the
// code-intelligence tier (graph-served slices vs full reads); the rest are
// output-compression. Behavior interventions (loop-broken, cascade-guard,
// …) remain PREVENT-class counters in the Preventions pane — they have no
// counterfactual byte count, so they're not in this savings map.
export const MECH_COLORS: Record<
  string,
  { bg: string; text: string; bar: string; ring: string }
> = {
  graph_query: {
    bg: "bg-violet-500/20",
    text: "text-violet-300",
    bar: "bg-violet-500",
    ring: "ring-violet-500/40",
  },
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

export const ALL_MECHANISMS = [
  "graph_query",
  "file_read",
  "shell_compression",
  "format_encoding",
  "session_dedup",
  "smart_truncation",
  "fetch_url",
];

// ── Origin tiers — the spine of the Token Trace differentiation ──────
//
// Every saved token comes from one of two origins:
//
//   • code-intelligence — graph queries + graph-guided reads. unerr keeps
//     a live map of the repo, so it serves the right slice instead of raw
//     bytes. No text-only optimizer has a code graph, so this tier is
//     structurally unique — not a feature competitors lack, a capability
//     they cannot have without indexing the codebase.
//   • output-compression — trimming the bytes of tool output (shell, web
//     fetch, format encoding, dedup, truncation). Real savings, but
//     table-stakes: any proxy can compress a payload. This is the
//     category every token tool already competes in.
//
// The contrast is the message. We never name a competitor — we name the
// category ("output compression") as the frame of reference, then show
// the work that only repo-understanding can do (category-design framing,
// Lochhead / Dunford).
export const INTELLIGENCE_MECHANISMS = new Set(["graph_query", "file_read"]);

export interface MechanismTier {
  key: "intelligence" | "compression";
  tokens: number;
  events: number;
  entries: Array<[string, MechanismSummary]>;
}

/**
 * Partition a by-mechanism map into the two origin tiers. The split is
 * exhaustive — compression is *everything* that isn't graph / graph-guided
 * reads — so the two tiers always sum to the original total. Nothing is
 * cherry-picked or dropped.
 */
export function splitMechanismsByTier(
  byMechanism: Record<string, MechanismSummary>
): { intelligence: MechanismTier; compression: MechanismTier; total: number } {
  const intelligence: MechanismTier = {
    key: "intelligence",
    tokens: 0,
    events: 0,
    entries: [],
  };
  const compression: MechanismTier = {
    key: "compression",
    tokens: 0,
    events: 0,
    entries: [],
  };
  for (const [mech, data] of Object.entries(byMechanism)) {
    const tier = INTELLIGENCE_MECHANISMS.has(mech) ? intelligence : compression;
    tier.tokens += data.tokens_saved;
    tier.events += data.event_count;
    tier.entries.push([mech, data]);
  }
  const byTokens = (
    a: [string, MechanismSummary],
    b: [string, MechanismSummary]
  ) => b[1].tokens_saved - a[1].tokens_saved;
  intelligence.entries.sort(byTokens);
  compression.entries.sort(byTokens);
  return {
    intelligence,
    compression,
    total: intelligence.tokens + compression.tokens,
  };
}

/** Human label for a mechanism key (graph_query → "graph query"). */
export function mechLabel(mech: string): string {
  return mech.replace(/_/g, " ");
}

// Prevention event types (PREVENT-class). Each one is a discrete named
// count surfaced in the Preventions pane. The legend lives next to
// the pane so users can read what each counter means.
export const BEHAVIOR_EVENT_LABELS: Record<string, string> = {
  graph_query_served: "Graph query served",
  full_read_avoided: "Full file read avoided",
  loop_broken: "Retry loop broken",
  cascade_guard: "Cascade guard fired",
  drift_consumed: "Drift signal consumed",
  intervention_halted: "Behavior intervention halted",
  intervention_warned: "Behavior warning emitted",
  defuddle_selector_skipped: "Defuddle selector skipped",
};

export const BEHAVIOR_EVENT_DESCRIPTIONS: Record<string, string> = {
  graph_query_served:
    "Agent's graph-tool call (search_code, get_references, …) was served from the local graph instead of grep + N file reads.",
  full_read_avoided:
    "file_outline / get_file delivered a structural summary instead of a full file read.",
  loop_broken:
    "Circuit breaker halted a retry loop the agent was about to enter on the same entity.",
  cascade_guard:
    "A high fan-in edit was gated by the cascade guard before propagating.",
  drift_consumed:
    "A drift signal (`ur|ctx`) was consumed — agent re-read the file before editing.",
  intervention_halted:
    "A pre-tool-use behavior halted a tool call before it ran.",
  intervention_warned:
    "A behavior emitted a warning but allowed the call to proceed.",
  defuddle_selector_skipped:
    "fetch_url's Defuddle extractor hit a non-fatal selector-parse error (nwsapi rejected a `:has()`/Tailwind arbitrary-value selector). First occurrence per signature is logged once; subsequent occurrences are counted only.",
};

// ── Helpers ──────────────────────────────────────────────────────────

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function mc(mechanism: string) {
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
export function describeEvent(evt: TokenFlowEvent): string {
  const d = evt.detail;
  if (!d) return evt.tool ?? "token rescue";

  if (d.command) {
    const cmd = String(d.command);
    return cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd;
  }

  if (d.optimization) {
    return String(d.optimization);
  }

  if (d.counterfactual && d.counterfactual !== "generic file exploration") {
    return String(d.counterfactual);
  }
  if (d.format) {
    return `${evt.tool ?? "query"} → ${d.format} format`;
  }

  return evt.tool ?? "token rescue";
}

/** Human-readable summary label for an entire turn (group of events) */
export function describeTurn(events: TokenFlowEvent[]): {
  label: string;
  subtitle: string;
} {
  if (events.length === 0) return { label: "Empty turn", subtitle: "" };

  const tools = [
    ...new Set(events.map((e) => e.tool).filter(Boolean)),
  ] as string[];
  const mechs = [...new Set(events.map((e) => e.mechanism))];

  const shellEvt = events.find((e) => e.detail?.command);
  if (shellEvt) {
    const cmd = String(shellEvt.detail?.command);
    const short = cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd;
    return {
      label: short,
      subtitle: `shell → ${events.length} rescue${events.length > 1 ? "s" : ""}`,
    };
  }

  const fileEvt = events.find((e) => e.detail?.optimization);
  if (fileEvt) {
    const opt = String(fileEvt.detail?.optimization);
    const extra = events.length > 1 ? ` +${events.length - 1} more` : "";
    return { label: opt, subtitle: tools.join(", ") + extra };
  }

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
