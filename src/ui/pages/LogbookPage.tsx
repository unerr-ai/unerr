/**
 * Logbook — glance-first activity feed.
 *
 * Goal: a user opens this page and immediately understands what unerr did
 * for them, without having to learn any internal vocabulary
 * (`event_type`, `tokenflow.*`, `session_id`, etc.).
 *
 * Layout
 *   1. Header row — page title + total-count summary for the current view.
 *   2. Filter strip — Date · Agent · Session · Event type. URL-backed so
 *      refresh and share work. Default = today, no other filters set.
 *   3. Counter strip — four lived-unit tiles (kept from the prior page).
 *   4. Collapsible "What unerr did today" narrative — the previous story +
 *      featured-moment cards, demoted to an optional summary.
 *   5. Activity feed — one human-readable sentence per row with an icon
 *      and time. Click any row to expand inline with the technical detail
 *      (agent, session, turn, exact shell command, file path, tokens
 *      saved, etc.). Paginated 25/page.
 *
 * The previous page exposed `event_type` strings and dumped raw JSON
 * metadata in a drill pane. This rewrite hides those internals by default
 * — they're available on row-expand for users who want them.
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { setHashQueryParams, useHashQueryParam } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────

// Fix J — verbatim prompt joined onto the row by the server.
interface PromptForTurn {
  session_id: string;
  turn: number;
  prompt: string | null;
  length: number;
  classified_as: string | null;
  ts: string;
}

interface NamedEvent {
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
  /** Fix J — captured user prompt for this turn (LEFT JOIN on
   *  {session_id, turn}). Null when capture is off or no row exists. */
  prompt?: PromptForTurn | null;
}

interface StoryResponse {
  data: {
    period_label: string;
    story: string;
    honest_zero: boolean;
    featured: NamedEvent | null;
    right_rail: {
      total_events: number;
      by_type: Record<string, number>;
      total_tokens_saved: number;
    };
  };
}

interface TimelineResponse {
  data: NamedEvent[];
  total: number;
  limit: number;
  offset: number;
}

// Fix H — directive-compliance ribbon shape.
interface ComplianceCounter {
  required: number;
  called: number;
  ratio: number;
  consecutive_misses: number;
}

interface ComplianceResponse {
  data: {
    surface2: ComplianceCounter;
    surface3: ComplianceCounter;
    mark_intent: ComplianceCounter;
    skill: ComplianceCounter;
    surface4: ComplianceCounter;
    runtime_joins: {
      memory_to_graph: number;
      graph_to_drift: number;
      three_way: number;
      total: number;
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

const PAGE_SIZE = 25;
const REFETCH_MS = 15_000;

// ── Date / number / string helpers ───────────────────────────────────

/** YYYY-MM-DD in the user's local timezone. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** ISO bounds (local-midnight → next-local-midnight) for a YYYY-MM-DD. */
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

/** Friendly relative-time string ("just now", "4m ago", "2h ago"). */
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

function timeHHMMSS(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shortSession(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function fmtNum(n: number | undefined | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** Defensive metadata accessor — never throws on missing keys. */
function meta<T = unknown>(ev: NamedEvent, path: string): T | undefined {
  let cur: unknown = ev.metadata;
  for (const seg of path.split(".")) {
    if (cur && typeof cur === "object" && seg in (cur as object)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur as T | undefined;
}

// ── Counter strip (kept from prior design) ────────────────────────────

const FEATURED_COUNTERS: { type: string; label: string }[] = [
  { type: "stale_edit_prevented", label: "Stale edits caught" },
  { type: "full_read_avoided", label: "Reads avoided" },
  { type: "fact_recalled", label: "Facts surfaced" },
  { type: "loop_broken", label: "Retry loops stopped" },
];

const COUNTER_FALLBACKS: { type: string; label: string }[] = [
  { type: "intervention_halted", label: "Calls halted" },
  { type: "graph_query_served", label: "Graph queries served" },
  { type: "convention_applied", label: "Conventions applied" },
  { type: "cache_hit", label: "Cache hits" },
  { type: "fact_stored_user_fed", label: "Memories stored" },
];

function pickCounters(
  byType: Record<string, number>
): { label: string; count: number }[] {
  const out: { label: string; count: number }[] = [];
  const seen = new Set<string>();
  for (const f of FEATURED_COUNTERS) {
    const c = byType[f.type] ?? 0;
    out.push({ label: f.label, count: c });
    seen.add(f.type);
    if (out.length === 4) return out;
  }
  for (const f of COUNTER_FALLBACKS) {
    if (seen.has(f.type)) continue;
    const c = byType[f.type] ?? 0;
    if (c > 0) out.push({ label: f.label, count: c });
    if (out.length === 4) return out;
  }
  return out;
}

// ── Cognitive translation tables ──────────────────────────────────────
//
// Persistent-memory events are emitted by PersistenceEffectivenessTracker
// (src/tracking/persistence-effectiveness.ts) and carry a (kind, verdict)
// pair instead of human prose. We translate the cartesian product here so
// every row reads like something a non-internals user can understand.

/** What KIND of memory signal fired. */
const PERSIST_KIND_NOUN: Record<string, string> = {
  fact_injected: "a remembered fact",
  fact_recalled: "a recalled fact",
  fact_recorded: "a new fact",
  convention_injected: "a project convention",
  resume_injected: "a thread of prior work",
  negative_warned: "a known anti-pattern",
};

/** Friendly graph-tool names — what each unerr MCP graph call actually
 *  does for the user, phrased in their language not ours. */
const GRAPH_TOOL_PHRASE: Record<string, string> = {
  search_code: "searched the project for a symbol",
  get_references: "looked up callers / callees in the project graph",
  get_entity: "looked up a function or class signature",
  file_read: "read a file with project context attached",
  file_outline: "scanned a file's structure",
  get_imports: "traced imports across modules",
  get_critical_nodes: "ranked the project's hot files",
  get_test_coverage: "looked up which tests cover an entity",
  get_project_stats: "pulled project-wide stats",
  recall_facts: "recalled stored project facts",
  fetch_url: "fetched and cleaned a web page",
  file_connections: "mapped a file's import neighborhood",
  get_cross_boundary_links: "found cross-module couplings",
};

// ── Event narrator: NamedEvent → glance-friendly row ──────────────────

type Tone = "catch" | "save" | "remember" | "guard" | "serve" | "note";

interface Narration {
  /** Single glyph that gives the row shape at a glance. Single-char
   *  Unicode preferred over emoji so it sits cleanly in the row leading. */
  icon: string;
  /** One-line, past-tense, plain-English summary. Tokens like file paths
   *  are rendered with monospaced inline `<code>` blocks. */
  sentence: ReactNode;
  /** Plain-text version for screen readers / fallback. */
  brief: string;
  tone: Tone;
  /** Short type chip ("read · saved", "shell · compressed"). Not the
   *  internal event_type string — that's only shown on row-expand. */
  chip: string;
}

/** Render a path as a clipped inline mono code block — basename is bold
 *  and the leading directories collapse if there's no room. */
function pathCode(path: string): ReactNode {
  return (
    <code
      title={path}
      className="rounded bg-muted/80 px-1.5 py-0.5 font-mono text-[0.78rem] text-foreground"
    >
      {basename(path)}
    </code>
  );
}

function inlineCode(text: string): ReactNode {
  return (
    <code className="rounded bg-muted/80 px-1.5 py-0.5 font-mono text-[0.78rem] text-foreground">
      {text}
    </code>
  );
}

function narrate(ev: NamedEvent): Narration {
  const file = ev.file_path;
  const entity = ev.entity_key;
  const tokensSaved = meta<number>(ev, "tokens_saved") ?? 0;

  // Token-flow synthetic events — these dominate raw count, so we phrase
  // them as savings the agent didn't have to pay for.
  if (ev.event_type.startsWith("tokenflow.")) {
    const mechanism = ev.event_type.slice("tokenflow.".length);
    switch (mechanism) {
      case "shell_compression": {
        const cmd =
          meta<string>(ev, "detail.command") ?? meta<string>(ev, "command");
        return {
          icon: "▤",
          tone: "save",
          chip: "shell · compressed",
          brief: cmd
            ? `Compressed \`${cmd}\` output — saved ${fmtNum(tokensSaved)} tokens`
            : `Compressed shell output — saved ${fmtNum(tokensSaved)} tokens`,
          sentence: (
            <>
              Compressed shell output
              {cmd ? <> for {inlineCode(cmd)}</> : null}
              {tokensSaved > 0 ? (
                <span className="t-secondary">
                  {" "}
                  — saved {fmtNum(tokensSaved)} tokens
                </span>
              ) : null}
            </>
          ),
        };
      }
      case "file_read": {
        const f = meta<string>(ev, "detail.file_path") ?? file ?? undefined;
        return {
          icon: "▥",
          tone: "save",
          chip: "read · trimmed",
          brief: f
            ? `Trimmed a read of ${f} — saved ${fmtNum(tokensSaved)} tokens`
            : `Trimmed a file read — saved ${fmtNum(tokensSaved)} tokens`,
          sentence: (
            <>
              Trimmed a file read
              {f ? <> of {pathCode(f)}</> : null}
              {tokensSaved > 0 ? (
                <span className="t-secondary">
                  {" "}
                  — saved {fmtNum(tokensSaved)} tokens
                </span>
              ) : null}
            </>
          ),
        };
      }
      case "fetch_url": {
        const url = meta<string>(ev, "detail.url");
        return {
          icon: "◯",
          tone: "save",
          chip: "fetch · cleaned",
          brief: url
            ? `Cleaned ${url} via Defuddle — saved ${fmtNum(tokensSaved)} tokens`
            : `Cleaned a fetched page — saved ${fmtNum(tokensSaved)} tokens`,
          sentence: (
            <>
              Cleaned a fetched page
              {url ? <> {inlineCode(url)}</> : null}
              {tokensSaved > 0 ? (
                <span className="t-secondary">
                  {" "}
                  — saved {fmtNum(tokensSaved)} tokens
                </span>
              ) : null}
            </>
          ),
        };
      }
      case "graph_query": {
        const tool = meta<string>(ev, "tool");
        const phrase = tool ? GRAPH_TOOL_PHRASE[tool] : undefined;
        const friendly =
          phrase ?? "used the project graph instead of a file read";
        return {
          icon: "◈",
          tone: "save",
          chip: "graph · used",
          brief: tool
            ? `Used ${tool} instead of a file read — saved ${fmtNum(tokensSaved)} tokens`
            : `Used the project graph — saved ${fmtNum(tokensSaved)} tokens`,
          sentence: (
            <>
              {friendly.charAt(0).toUpperCase() + friendly.slice(1)}
              {tool ? <> using {inlineCode(tool)}</> : null}
              {tokensSaved > 0 ? (
                <span className="t-secondary">
                  {" "}
                  — saved {fmtNum(tokensSaved)} tokens vs reading the file
                </span>
              ) : null}
            </>
          ),
        };
      }
      case "session_dedup": {
        return {
          icon: "↻",
          tone: "save",
          chip: "context · deduplicated",
          brief: `Skipped context the agent already had this session — saved ${fmtNum(tokensSaved)} tokens`,
          sentence: (
            <>
              Skipped re-sending context the agent already had this session
              {tokensSaved > 0 ? (
                <span className="t-secondary">
                  {" "}
                  — saved {fmtNum(tokensSaved)} tokens
                </span>
              ) : null}
            </>
          ),
        };
      }
      case "format_encoding": {
        return {
          icon: "▦",
          tone: "save",
          chip: "response · compacted",
          brief: `Compacted a response into a smaller format — saved ${fmtNum(tokensSaved)} tokens`,
          sentence: (
            <>
              Compacted a response into a tighter format
              {tokensSaved > 0 ? (
                <span className="t-secondary">
                  {" "}
                  — saved {fmtNum(tokensSaved)} tokens
                </span>
              ) : null}
            </>
          ),
        };
      }
      case "smart_truncation": {
        return {
          icon: "✂",
          tone: "save",
          chip: "response · trimmed",
          brief: `Trimmed irrelevant parts of a response — saved ${fmtNum(tokensSaved)} tokens`,
          sentence: (
            <>
              Trimmed irrelevant parts of a response before sending it back
              {tokensSaved > 0 ? (
                <span className="t-secondary">
                  {" "}
                  — saved {fmtNum(tokensSaved)} tokens
                </span>
              ) : null}
            </>
          ),
        };
      }
      case "behavior_automation": {
        const behavior =
          meta<string>(ev, "detail.behavior") ??
          meta<string>(ev, "detail.name") ??
          meta<string>(ev, "tool");
        return {
          icon: "◆",
          tone: "serve",
          chip: "automation · ran",
          brief: behavior
            ? `An automated behavior ran (${behavior})`
            : "An automated behavior ran on the agent's behalf",
          sentence: behavior ? (
            <>
              Ran an automated behavior:{" "}
              <span className="text-foreground">
                {behavior.replace(/_/g, " ")}
              </span>{" "}
              so the agent didn't have to ask
            </>
          ) : (
            <>Ran an automated behavior so the agent didn't have to ask</>
          ),
        };
      }
      case "persistent_memory": {
        // PersistenceEffectivenessTracker emits these; detail carries
        // (kind, verdict). Translate the pair into one plain-English line.
        // signal_id is internal — never surface it.
        const kind = meta<string>(ev, "detail.kind") ?? "";
        const verdict = meta<string>(ev, "detail.verdict") ?? "fired";
        const noun = PERSIST_KIND_NOUN[kind] ?? "a remembered signal";
        let sentenceNode: ReactNode;
        let brief: string;
        let tone: Tone = "remember";
        let chip = "memory · surfaced";
        switch (verdict) {
          case "acted_on":
            sentenceNode = <>The agent acted on {noun} unerr had surfaced</>;
            brief = `The agent acted on ${noun} unerr had surfaced`;
            chip = "memory · acted on";
            tone = "save";
            break;
          case "reinforced":
            sentenceNode = <>Reinforced {noun} — the agent saw it again</>;
            brief = `Reinforced ${noun}`;
            chip = "memory · reinforced";
            tone = "remember";
            break;
          case "corrected":
            sentenceNode = (
              <>
                {noun} conflicted with what the agent was about to do — flagged
                for review
              </>
            );
            brief = `${noun} conflicted with the edit — flagged for review`;
            chip = "memory · conflict";
            tone = "guard";
            break;
          case "caught":
            sentenceNode = <>Prevented a repeat of {noun}</>;
            brief = `Prevented a repeat of ${noun}`;
            chip = "anti-pattern · caught";
            tone = "catch";
            break;
          case "ignored":
            sentenceNode = (
              <>Reminded the agent of {noun} — but they edited around it</>
            );
            brief = `Reminded the agent of ${noun}, no action taken`;
            chip = "memory · ignored";
            tone = "note";
            break;
          default: {
            // "fired" or any new verdict — phrasing depends on kind.
            const verb =
              kind === "fact_recorded"
                ? "Captured"
                : kind === "resume_injected"
                  ? "Restored"
                  : kind === "convention_injected"
                    ? "Reminded the agent of"
                    : kind === "negative_warned"
                      ? "Warned the agent about"
                      : "Reminded the agent of";
            sentenceNode = (
              <>
                {verb} {noun}
              </>
            );
            brief = `${verb} ${noun}`;
            chip =
              kind === "negative_warned"
                ? "anti-pattern · warned"
                : kind === "fact_recorded"
                  ? "memory · captured"
                  : "memory · surfaced";
            tone = kind === "negative_warned" ? "guard" : "remember";
          }
        }
        return { icon: "✎", tone, chip, brief, sentence: sentenceNode };
      }
      default: {
        // Unknown mechanism — keep tone neutral and DO NOT show the raw
        // mechanism string. Frame the sentence around the actual outcome.
        return {
          icon: "◆",
          tone: "save",
          chip: "behind the scenes",
          brief:
            tokensSaved > 0
              ? `unerr saved ${fmtNum(tokensSaved)} tokens behind the scenes`
              : "unerr did something behind the scenes",
          sentence: (
            <>
              unerr made a quiet improvement behind the scenes
              {tokensSaved > 0 ? (
                <span className="t-secondary">
                  {" "}
                  — saved {fmtNum(tokensSaved)} tokens
                </span>
              ) : null}
            </>
          ),
        };
      }
    }
  }

  // Behavior events — the "catches" the agent would have stumbled into.
  switch (ev.event_type) {
    case "stale_edit_prevented":
      return {
        icon: "✦",
        tone: "catch",
        chip: "edit · stopped",
        brief: file ? `Caught a stale edit on ${file}` : "Caught a stale edit",
        sentence: (
          <>
            Caught a stale edit
            {file ? <> on {pathCode(file)}</> : null}
            {entity ? (
              <span className="t-secondary"> ({inlineCode(entity)})</span>
            ) : null}
          </>
        ),
      };
    case "cascade_guard":
      return {
        icon: "✦",
        tone: "catch",
        chip: "cascade · guarded",
        brief: "Guarded a cascading edit",
        sentence: (
          <>
            Guarded a cascading edit
            {file ? <> rooted at {pathCode(file)}</> : null}
          </>
        ),
      };
    case "cascade_warning_consumed":
      return {
        icon: "⌁",
        tone: "guard",
        chip: "cascade · co-modified",
        brief: "Agent co-modified related files after a cascade warning",
        sentence: (
          <>Got the agent to co-modify related files after a cascade warning</>
        ),
      };
    case "intervention_halted": {
      const tool = meta<string>(ev, "tool");
      return {
        icon: "✕",
        tone: "catch",
        chip: "call · halted",
        brief: tool
          ? `Halted a risky call to ${tool}`
          : "Halted a risky tool call",
        sentence: (
          <>
            Stopped a risky tool call
            {tool ? <> to {inlineCode(tool)}</> : null}
          </>
        ),
      };
    }
    case "intervention_warned": {
      const tool = meta<string>(ev, "tool");
      return {
        icon: "!",
        tone: "guard",
        chip: "call · warned",
        brief: tool
          ? `Warned before a call to ${tool}`
          : "Warned before a risky call",
        sentence: (
          <>
            Warned before a risky call
            {tool ? <> to {inlineCode(tool)}</> : null}
          </>
        ),
      };
    }
    case "loop_broken":
      return {
        icon: "⟲",
        tone: "catch",
        chip: "loop · broken",
        brief: entity
          ? `Broke a retry loop on ${entity}`
          : "Broke a retry loop",
        sentence: (
          <>
            Broke a retry loop
            {entity ? <> on {inlineCode(entity)}</> : null}
            {!entity && file ? <> on {pathCode(file)}</> : null}
          </>
        ),
      };
    case "full_read_avoided": {
      const agent = ev.agent && ev.agent !== "unknown" ? ev.agent : "the agent";
      return {
        icon: "▥",
        tone: "save",
        chip: "read · avoided",
        brief: file
          ? `Saved ${agent} from re-reading ${file}`
          : `Saved ${agent} from a full file read`,
        sentence: (
          <>
            Saved <span className="text-foreground">{agent}</span> from
            re-reading
            {file ? <> {pathCode(file)}</> : <> a file</>}
          </>
        ),
      };
    }
    case "graph_query_served":
      return {
        icon: "◈",
        tone: "serve",
        chip: "graph · served",
        brief: entity
          ? `Served a graph query for ${entity}`
          : "Served a graph query",
        sentence: (
          <>
            Served a graph query
            {entity ? <> for {inlineCode(entity)}</> : null}
          </>
        ),
      };
    case "fact_recalled": {
      const quote =
        meta<string>(ev, "detail.source_quote") ??
        meta<string>(ev, "detail.content") ??
        meta<string>(ev, "detail.fact_quote");
      return {
        icon: "❝",
        tone: "remember",
        chip: "memory · recalled",
        brief: quote
          ? `Reminded the agent: "${quote}"`
          : "Surfaced a remembered fact",
        sentence: quote ? (
          <>
            Reminded the agent:{" "}
            <span className="text-foreground">"{quote}"</span>
          </>
        ) : (
          <>Surfaced a remembered fact</>
        ),
      };
    }
    case "fact_stored_user_fed": {
      const quote = meta<string>(ev, "detail.source_quote");
      return {
        icon: "✎",
        tone: "remember",
        chip: "memory · stored",
        brief: quote
          ? `Remembered: "${quote}"`
          : "Stored a new user-fed memory",
        sentence: quote ? (
          <>
            Remembered <span className="text-foreground">"{quote}"</span> for
            next time
          </>
        ) : (
          <>Stored a new memory you told me to keep</>
        ),
      };
    }
    case "fact_stored_auto":
      return {
        icon: "✎",
        tone: "remember",
        chip: "convention · learned",
        brief: "Learned a new project convention",
        sentence: <>Picked up a new project convention from the code</>,
      };
    case "convention_applied":
      return {
        icon: "◇",
        tone: "serve",
        chip: "convention · applied",
        brief: "Applied a project convention",
        sentence: (
          <>
            Applied a project convention
            {file ? <> on {pathCode(file)}</> : null}
          </>
        ),
      };
    case "caller_check_enforced":
      return {
        icon: "⊕",
        tone: "guard",
        chip: "callers · checked",
        brief: entity
          ? `Made the agent check callers of ${entity} first`
          : "Made the agent check callers first",
        sentence: (
          <>
            Made the agent check callers
            {entity ? <> of {inlineCode(entity)}</> : null} before editing
          </>
        ),
      };
    case "drift_consumed":
      return {
        icon: "≈",
        tone: "guard",
        chip: "drift · surfaced",
        brief: file ? `Surfaced drift on ${file}` : "Surfaced a drift signal",
        sentence: (
          <>
            Surfaced drift
            {file ? <> on {pathCode(file)}</> : null} so the agent could re-read
          </>
        ),
      };
    case "cross_session_resume":
      return {
        icon: "↪",
        tone: "remember",
        chip: "session · resumed",
        brief: "Resumed a thread from a prior session",
        sentence: (
          <>
            Resumed a thread of work from a prior session without re-discovery
          </>
        ),
      };
    case "cache_hit":
      return {
        icon: "◐",
        tone: "save",
        chip: "cache · hit",
        brief: "Served a cached result",
        sentence: <>Served a cached result instead of recomputing</>,
      };
    case "fact_capture_abandoned":
      return {
        icon: "·",
        tone: "note",
        chip: "memory · abandoned",
        brief: "Abandoned an ambiguous capture",
        sentence: <>Abandoned an ambiguous memory capture</>,
      };
    case "confirmation_expired":
      return {
        icon: "·",
        tone: "note",
        chip: "confirm · expired",
        brief: "A confirmation prompt expired",
        sentence: <>A confirmation prompt expired before it was answered</>,
      };
    case "defuddle_selector_skipped":
      return {
        icon: "·",
        tone: "note",
        chip: "fetch · selector",
        brief: "Skipped a Defuddle selector",
        sentence: <>Skipped a Defuddle selector that didn't match</>,
      };
    default:
      return {
        icon: "·",
        tone: "note",
        chip: ev.event_type.replace(/_/g, " "),
        brief: `${ev.verb} ${ev.object}`,
        sentence: (
          <>
            {ev.verb} {ev.object}
            {file ? <> · {pathCode(file)}</> : null}
          </>
        ),
      };
  }
}

const TONE_DOT_CLASS: Record<Tone, string> = {
  catch: "bg-grade-f", // red — high-emotion catches
  guard: "bg-grade-c", // amber — softer guards/warns
  save: "bg-grade-a", // emerald — savings
  remember: "bg-violet-500", // violet — memory
  serve: "bg-live", // cyan — passive serves
  note: "bg-border-strong", // grey — quiet notes
};

// ── Inline detail panel (type-specific) ───────────────────────────────

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-24 shrink-0 text-[10px] uppercase tracking-[0.12em] t-tertiary">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words text-sm text-foreground">
        {value}
      </dd>
    </div>
  );
}

function CommonRows({ ev }: { ev: NamedEvent }) {
  return (
    <>
      <DetailRow
        label="When"
        value={
          <>
            <span className="font-mono tabular-nums">{timeHHMMSS(ev.ts)}</span>
            <span className="ml-2 t-tertiary">· {relTime(ev.ts)}</span>
          </>
        }
      />
      <DetailRow
        label="Agent"
        value={<span className="font-mono text-foreground">{ev.agent}</span>}
      />
      <DetailRow
        label="Session"
        value={
          <span className="font-mono text-foreground">{ev.session_id}</span>
        }
      />
      <DetailRow
        label="Turn"
        value={<span className="font-mono tabular-nums">{ev.turn || "—"}</span>}
      />
      {ev.file_path ? (
        <DetailRow
          label="File"
          value={
            <code className="break-all rounded bg-muted/80 px-1.5 py-0.5 font-mono text-xs">
              {ev.file_path}
            </code>
          }
        />
      ) : null}
      {ev.entity_key ? (
        <DetailRow
          label="Entity"
          value={
            <code className="break-all rounded bg-muted/80 px-1.5 py-0.5 font-mono text-xs">
              {ev.entity_key}
            </code>
          }
        />
      ) : null}
    </>
  );
}

function ShellDetail({ ev }: { ev: NamedEvent }) {
  const cmd =
    meta<string>(ev, "detail.command") ?? meta<string>(ev, "command") ?? "";
  const bytesBefore =
    meta<number>(ev, "detail.bytes_before") ?? meta<number>(ev, "bytes_before");
  const bytesAfter =
    meta<number>(ev, "detail.bytes_after") ?? meta<number>(ev, "bytes_after");
  const tokensWithout = meta<number>(ev, "tokens_without");
  const tokensWith = meta<number>(ev, "tokens_with");
  const tokensSaved = meta<number>(ev, "tokens_saved");
  return (
    <>
      {cmd ? (
        <div className="console-panel">
          <div className="console-header">
            <span className="font-mono text-[11px] t-tertiary">$ command</span>
          </div>
          <div className="console-body">
            <code className="break-all">$ {cmd}</code>
          </div>
        </div>
      ) : null}
      <dl className="space-y-1.5">
        {tokensWithout != null && tokensWith != null ? (
          <DetailRow
            label="Tokens"
            value={
              <>
                <span className="font-mono tabular-nums">
                  {fmtNum(tokensWithout)}
                </span>
                <span className="t-tertiary"> → </span>
                <span className="font-mono tabular-nums text-foreground">
                  {fmtNum(tokensWith)}
                </span>
                {tokensSaved != null ? (
                  <span className="ml-2 font-mono text-grade-a">
                    (saved {fmtNum(tokensSaved)})
                  </span>
                ) : null}
              </>
            }
          />
        ) : null}
        {bytesBefore != null && bytesAfter != null ? (
          <DetailRow
            label="Bytes"
            value={
              <>
                <span className="font-mono tabular-nums">
                  {fmtBytes(bytesBefore)}
                </span>
                <span className="t-tertiary"> → </span>
                <span className="font-mono tabular-nums text-foreground">
                  {fmtBytes(bytesAfter)}
                </span>
              </>
            }
          />
        ) : null}
        <CommonRows ev={ev} />
      </dl>
    </>
  );
}

function FileReadDetail({ ev }: { ev: NamedEvent }) {
  const tokensSaved = meta<number>(ev, "tokens_saved");
  const tokensWithout = meta<number>(ev, "tokens_without");
  const tokensWith = meta<number>(ev, "tokens_with");
  const responseBytes = meta<number>(ev, "response_bytes");
  const tool = meta<string>(ev, "tool");
  return (
    <dl className="space-y-1.5">
      {tool ? <DetailRow label="Tool" value={inlineCode(tool)} /> : null}
      {tokensSaved != null ? (
        <DetailRow
          label="Tokens"
          value={
            tokensWithout != null && tokensWith != null ? (
              <>
                <span className="font-mono tabular-nums">
                  {fmtNum(tokensWithout)}
                </span>
                <span className="t-tertiary"> → </span>
                <span className="font-mono tabular-nums text-foreground">
                  {fmtNum(tokensWith)}
                </span>
                <span className="ml-2 font-mono text-grade-a">
                  (saved {fmtNum(tokensSaved)})
                </span>
              </>
            ) : (
              <span className="font-mono text-grade-a">
                saved {fmtNum(tokensSaved)}
              </span>
            )
          }
        />
      ) : null}
      {responseBytes != null ? (
        <DetailRow
          label="Response"
          value={
            <span className="font-mono tabular-nums">
              {fmtBytes(responseBytes)}
            </span>
          }
        />
      ) : null}
      <CommonRows ev={ev} />
    </dl>
  );
}

function FactDetail({ ev }: { ev: NamedEvent }) {
  const quote =
    meta<string>(ev, "detail.source_quote") ??
    meta<string>(ev, "detail.content") ??
    meta<string>(ev, "detail.fact_quote");
  const confidence = meta<number>(ev, "detail.confidence");
  const factType = meta<string>(ev, "detail.fact_type");
  return (
    <dl className="space-y-1.5">
      {quote ? (
        <DetailRow
          label="Memory"
          value={
            <blockquote className="rounded-md border-l-2 border-violet-500/60 bg-muted/40 px-3 py-2 text-sm italic text-foreground">
              "{quote}"
            </blockquote>
          }
        />
      ) : null}
      {factType ? <DetailRow label="Kind" value={factType} /> : null}
      {confidence != null ? (
        <DetailRow
          label="Confidence"
          value={
            <span className="font-mono tabular-nums">
              {(confidence * 100).toFixed(0)}%
            </span>
          }
        />
      ) : null}
      <CommonRows ev={ev} />
    </dl>
  );
}

function FetchUrlDetail({ ev }: { ev: NamedEvent }) {
  const url = meta<string>(ev, "detail.url");
  const tokensSaved = meta<number>(ev, "tokens_saved");
  const bytesBefore = meta<number>(ev, "detail.bytes_before");
  const bytesAfter = meta<number>(ev, "detail.bytes_after");
  return (
    <dl className="space-y-1.5">
      {url ? (
        <DetailRow
          label="URL"
          value={
            <code className="break-all rounded bg-muted/80 px-1.5 py-0.5 font-mono text-xs">
              {url}
            </code>
          }
        />
      ) : null}
      {bytesBefore != null && bytesAfter != null ? (
        <DetailRow
          label="Bytes"
          value={
            <>
              <span className="font-mono tabular-nums">
                {fmtBytes(bytesBefore)}
              </span>
              <span className="t-tertiary"> → </span>
              <span className="font-mono tabular-nums text-foreground">
                {fmtBytes(bytesAfter)}
              </span>
            </>
          }
        />
      ) : null}
      {tokensSaved != null ? (
        <DetailRow
          label="Tokens saved"
          value={
            <span className="font-mono text-grade-a tabular-nums">
              {fmtNum(tokensSaved)}
            </span>
          }
        />
      ) : null}
      <CommonRows ev={ev} />
    </dl>
  );
}

function InterventionDetail({ ev }: { ev: NamedEvent }) {
  const tool = meta<string>(ev, "tool");
  const reason =
    meta<string>(ev, "detail.reason") ?? meta<string>(ev, "detail.message");
  return (
    <dl className="space-y-1.5">
      {tool ? <DetailRow label="Tool" value={inlineCode(tool)} /> : null}
      {reason ? <DetailRow label="Reason" value={reason} /> : null}
      <CommonRows ev={ev} />
    </dl>
  );
}

// ── Cognitive detail components ──────────────────────────────────────
//
// These renderers exist so the expanded view of a row reads like prose,
// not a JSON dump. Each is responsible for translating the (mechanism,
// detail.*) tuple into outcomes a non-internals user can grasp without
// having to learn what `kind`, `verdict`, or `mechanism` mean.

/** Prose lede shown at the top of every cognitive detail panel — one
 *  short paragraph that restates what happened in plain English so the
 *  reader doesn't have to scan rows to grasp the gist. */
function CognitiveLede({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <p className="mb-3 text-sm leading-relaxed text-foreground">{children}</p>
  );
}

/** Outcome row — for facts/metrics worth surfacing in plain English. */
function OutcomeRow({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  tone?: "neutral" | "save" | "guard" | "catch";
}) {
  const toneClass =
    tone === "save"
      ? "text-grade-a"
      : tone === "guard"
        ? "text-grade-c"
        : tone === "catch"
          ? "text-grade-f"
          : "text-foreground";
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-28 shrink-0 text-[11px] t-secondary">{label}</dt>
      <dd className={`min-w-0 flex-1 text-sm ${toneClass}`}>{value}</dd>
    </div>
  );
}

function PersistentMemoryDetail({ ev }: { ev: NamedEvent }) {
  const kind = meta<string>(ev, "detail.kind") ?? "";
  const verdict = meta<string>(ev, "detail.verdict") ?? "fired";
  const reinforcements = meta<number>(ev, "detail.reinforcements") ?? 0;
  const corrections = meta<number>(ev, "detail.corrections") ?? 0;
  const edits = meta<number>(ev, "detail.edits") ?? 0;
  const quote =
    meta<string>(ev, "detail.source_quote") ??
    meta<string>(ev, "detail.content") ??
    meta<string>(ev, "detail.fact_quote");
  const noun = PERSIST_KIND_NOUN[kind] ?? "a remembered signal";

  // What kind of memory does the user understand this as?
  const kindBlurb: Record<string, string> = {
    fact_injected:
      "A fact you'd previously taught unerr was surfaced into the agent's context for this turn.",
    fact_recalled:
      "A fact unerr remembered about this project was recalled and shown to the agent.",
    fact_recorded:
      "unerr captured a new fact from this turn so it can surface next time.",
    convention_injected:
      "A project convention unerr had learned was reminded to the agent.",
    resume_injected:
      "An in-flight thread of work from a prior session was restored so the agent didn't have to rediscover it.",
    negative_warned:
      "An anti-pattern unerr knows hurt before was flagged to the agent.",
  };

  // What does the verdict say about how it landed?
  const verdictBlurb: Record<string, ReactNode> = {
    acted_on: (
      <>
        The agent <span className="text-grade-a">acted on</span> what unerr
        surfaced — the reminder changed what they did this turn.
      </>
    ),
    reinforced: (
      <>
        The agent saw {noun} again and unerr reinforced it — this memory is
        compounding rather than fading.
      </>
    ),
    corrected: (
      <>
        {noun} <span className="text-grade-c">conflicted</span> with what the
        agent was about to do — flagged for you to confirm or override.
      </>
    ),
    caught: (
      <>
        unerr <span className="text-grade-f">prevented</span> a repeat of a
        known anti-pattern before the agent could trip into it again.
      </>
    ),
    ignored: (
      <>
        The reminder was delivered, but the agent edited around it. Worth a look
        if this was the wrong call.
      </>
    ),
    fired: <>unerr surfaced {noun} into the agent's context for this turn.</>,
  };

  return (
    <>
      <CognitiveLede>
        {verdictBlurb[verdict] ?? verdictBlurb.fired}
      </CognitiveLede>
      <dl className="space-y-1.5">
        <OutcomeRow
          label="What unerr did"
          value={
            kindBlurb[kind] ??
            "Surfaced a remembered signal into the agent's context."
          }
        />
        {quote ? (
          <OutcomeRow
            label="The memory"
            value={
              <blockquote className="rounded-md border-l-2 border-violet-500/60 bg-muted/40 px-3 py-2 text-sm italic text-foreground">
                "{quote}"
              </blockquote>
            }
          />
        ) : null}
        {reinforcements > 0 ? (
          <OutcomeRow
            label="Reinforced"
            tone="save"
            value={`${reinforcements} ${reinforcements === 1 ? "time" : "times"} this turn`}
          />
        ) : null}
        {corrections > 0 ? (
          <OutcomeRow
            label="Conflicts"
            tone="guard"
            value={`${corrections} ${corrections === 1 ? "edit conflicted" : "edits conflicted"} with this memory`}
          />
        ) : null}
        {edits > 0 ? (
          <OutcomeRow
            label="Edits touched"
            value={`${edits} ${edits === 1 ? "file edit" : "file edits"} were shaped by this memory`}
          />
        ) : null}
        <CommonRows ev={ev} />
      </dl>
    </>
  );
}

function GraphQueryDetail({ ev }: { ev: NamedEvent }) {
  const tool = meta<string>(ev, "tool");
  const phrase = tool ? GRAPH_TOOL_PHRASE[tool] : undefined;
  const tokensSaved = meta<number>(ev, "tokens_saved");
  const tokensWithout = meta<number>(ev, "tokens_without");
  const tokensWith = meta<number>(ev, "tokens_with");
  const responseBytes = meta<number>(ev, "response_bytes");
  const friendly =
    phrase ?? "used the project graph to answer the agent's question";
  return (
    <>
      <CognitiveLede>
        Instead of having the agent open a file (which would have shipped the
        whole thing into context), unerr {friendly}
        {tool ? <> via {inlineCode(tool)}</> : null} and returned just the slice
        that mattered.
      </CognitiveLede>
      <dl className="space-y-1.5">
        {tokensSaved != null && tokensSaved > 0 ? (
          <OutcomeRow
            label="Tokens saved"
            tone="save"
            value={
              tokensWithout != null && tokensWith != null ? (
                <>
                  <span className="font-mono tabular-nums text-foreground">
                    {fmtNum(tokensWithout)}
                  </span>
                  <span className="t-tertiary"> → </span>
                  <span className="font-mono tabular-nums text-foreground">
                    {fmtNum(tokensWith)}
                  </span>
                  <span className="ml-2 font-mono">
                    (kept {fmtNum(tokensSaved)} out of context)
                  </span>
                </>
              ) : (
                <span className="font-mono">
                  kept {fmtNum(tokensSaved)} tokens out of the agent's context
                </span>
              )
            }
          />
        ) : null}
        {responseBytes != null ? (
          <OutcomeRow
            label="Slice size"
            value={
              <span className="font-mono tabular-nums">
                {fmtBytes(responseBytes)} returned to the agent
              </span>
            }
          />
        ) : null}
        <CommonRows ev={ev} />
      </dl>
    </>
  );
}

function BehaviorAutomationDetail({ ev }: { ev: NamedEvent }) {
  const behavior =
    meta<string>(ev, "detail.behavior") ??
    meta<string>(ev, "detail.name") ??
    meta<string>(ev, "tool");
  const friendly = behavior ? behavior.replace(/_/g, " ") : null;
  const BEHAVIOR_BLURB: Record<string, string> = {
    auto_doc:
      "Added or updated documentation for changed code so future readers don't have to reverse-engineer intent.",
    cascade_guard:
      "Watched for changes that would have rippled across related files and reminded the agent to co-modify them.",
    convention_writer:
      "Wrote a newly-learned project convention into the persistent fact store.",
    drift_writer:
      "Re-indexed a file whose contents had drifted since the agent last saw it.",
    intent_capturer:
      "Captured a short statement of the agent's intent so the next turn has clean session context.",
  };
  const blurb = behavior
    ? (BEHAVIOR_BLURB[behavior] ??
      `An automation named ${friendly} ran on the agent's behalf so they didn't have to ask.`)
    : "An automation ran on the agent's behalf so they didn't have to ask.";
  return (
    <>
      <CognitiveLede>{blurb}</CognitiveLede>
      <dl className="space-y-1.5">
        {friendly ? <OutcomeRow label="Automation" value={friendly} /> : null}
        <CommonRows ev={ev} />
      </dl>
    </>
  );
}

function DedupDetail({ ev }: { ev: NamedEvent }) {
  const tokensSaved = meta<number>(ev, "tokens_saved");
  return (
    <>
      <CognitiveLede>
        The agent had already received this context earlier in the session.
        Re-sending it would have wasted tokens with no new information, so unerr
        quietly skipped the duplicate.
      </CognitiveLede>
      <dl className="space-y-1.5">
        {tokensSaved != null && tokensSaved > 0 ? (
          <OutcomeRow
            label="Tokens saved"
            tone="save"
            value={
              <span className="font-mono tabular-nums">
                {fmtNum(tokensSaved)} kept out of the next prompt
              </span>
            }
          />
        ) : null}
        <CommonRows ev={ev} />
      </dl>
    </>
  );
}

/** Curated friendly-label map for fields that ARE worth surfacing in
 *  the generic detail view. Anything not in this allowlist is dropped —
 *  the goal is to never expose internal fields like signal_id, kind,
 *  verdict, mechanism, etc. to the user. */
const GENERIC_FIELD_LABELS: Record<string, string> = {
  reason: "Reason",
  message: "Note",
  tool: "Tool",
  url: "URL",
  fact_type: "Fact kind",
  confidence: "Confidence",
};

function GenericDetail({ ev }: { ev: NamedEvent }) {
  // Pull the detail subobject (most events nest extras under `detail`).
  const detail = (ev.metadata?.detail ?? {}) as Record<string, unknown>;
  const friendlyEntries = Object.entries(detail).flatMap<
    [string, string, unknown]
  >(([k, v]) => {
    const label = GENERIC_FIELD_LABELS[k];
    if (!label) return [];
    if (v == null || v === "") return [];
    return [[k, label, v]];
  });
  return (
    <dl className="space-y-1.5">
      <CommonRows ev={ev} />
      {friendlyEntries.map(([k, label, v]) => (
        <DetailRow
          key={k}
          label={label}
          value={
            k === "confidence" && typeof v === "number" ? (
              <span className="font-mono tabular-nums">
                {(v * 100).toFixed(0)}%
              </span>
            ) : typeof v === "string" || typeof v === "number" ? (
              String(v)
            ) : (
              JSON.stringify(v)
            )
          }
        />
      ))}
    </dl>
  );
}

function EventDetail({ ev }: { ev: NamedEvent }) {
  if (ev.event_type === "tokenflow.shell_compression")
    return <ShellDetail ev={ev} />;
  if (
    ev.event_type === "tokenflow.file_read" ||
    ev.event_type === "full_read_avoided"
  )
    return <FileReadDetail ev={ev} />;
  if (
    ev.event_type === "tokenflow.graph_query" ||
    ev.event_type === "graph_query_served"
  )
    return <GraphQueryDetail ev={ev} />;
  if (
    ev.event_type === "fact_recalled" ||
    ev.event_type === "fact_stored_user_fed" ||
    ev.event_type === "fact_stored_auto"
  )
    return <FactDetail ev={ev} />;
  if (ev.event_type === "tokenflow.fetch_url")
    return <FetchUrlDetail ev={ev} />;
  if (
    ev.event_type === "intervention_halted" ||
    ev.event_type === "intervention_warned"
  )
    return <InterventionDetail ev={ev} />;
  if (ev.event_type === "tokenflow.persistent_memory")
    return <PersistentMemoryDetail ev={ev} />;
  if (ev.event_type === "tokenflow.behavior_automation")
    return <BehaviorAutomationDetail ev={ev} />;
  if (ev.event_type === "tokenflow.session_dedup")
    return <DedupDetail ev={ev} />;
  return <GenericDetail ev={ev} />;
}

// ── Activity row ─────────────────────────────────────────────────────

// Shared column widths used by both the header and every row so the
// columns line up vertically without a CSS grid. Tailwind classes are
// inlined here (rather than templated) so the JIT picks them up.
const COL_AGENT = "w-32 shrink-0";
const COL_SESSION = "w-24 shrink-0";
const COL_TURN = "w-12 shrink-0 text-right";
const COL_TIME = "w-16 shrink-0 text-right";

/** Column header bar — same widths as ActivityRow so columns align. Hidden
 *  on narrow viewports where columns wrap into a sub-row under the sentence. */
function ActivityHeader() {
  const cls =
    "text-[10px] font-semibold uppercase tracking-[0.12em] t-tertiary";
  return (
    <div className="hidden items-center gap-3 border-b border-border-subtle bg-muted/30 px-3 py-2 md:flex">
      {/* dot + icon column (44px = size-2 + gap + size-6) */}
      <span className="w-10 shrink-0" aria-hidden="true" />
      <span className={`min-w-0 flex-1 ${cls}`}>What unerr did</span>
      <span className={`${COL_AGENT} ${cls}`}>Agent</span>
      <span className={`${COL_SESSION} ${cls}`}>Session</span>
      <span className={`${COL_TURN} ${cls}`}>Turn</span>
      <span className={`${COL_TIME} ${cls}`}>Time</span>
      {/* chevron column (≈14px) */}
      <span className="w-4 shrink-0" aria-hidden="true" />
    </div>
  );
}

function ActivityRow({
  ev,
  expanded,
  onToggle,
}: {
  ev: NamedEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const n = useMemo(() => narrate(ev), [ev]);
  const agentLabel = ev.agent && ev.agent !== "unknown" ? ev.agent : "—";
  return (
    <li className="border-b border-border-subtle last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className={`group flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/40 ${
          expanded ? "bg-muted/30" : ""
        }`}
        aria-expanded={expanded}
        aria-label={`${n.brief} · agent ${agentLabel} · session ${shortSession(ev.session_id)} · turn ${ev.turn}`}
      >
        <span className="flex w-10 shrink-0 items-center gap-2">
          <span
            className={`inline-block size-2 rounded-full ${TONE_DOT_CLASS[n.tone]}`}
            aria-hidden="true"
          />
          <span
            className="inline-flex size-6 items-center justify-center text-foreground"
            aria-hidden="true"
          >
            {n.icon}
          </span>
        </span>

        {/* Sentence + (mobile-only) meta sub-row */}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground">{n.sentence}</span>
          {/* Fix J — italicized verbatim prompt below the sentence. Only
              renders when capture is on AND a row exists; otherwise omits
              entirely (the drill view carries the "enable capture" hint
              so we don't repeat it on every timeline row). */}
          {ev.prompt && ev.prompt.prompt ? (
            <span
              className="mt-0.5 block truncate text-[11px] italic t-tertiary"
              title={ev.prompt.prompt}
            >
              “{ev.prompt.prompt}”
            </span>
          ) : null}
          {/* Mobile fallback — columns collapse beneath the sentence so
              agent/session/turn are still always visible. */}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono tabular-nums t-tertiary md:hidden">
            <span className="text-foreground/80">{agentLabel}</span>
            <span className="t-ghost">·</span>
            <span title={ev.session_id}>{shortSession(ev.session_id)}</span>
            <span className="t-ghost">·</span>
            <span>turn {ev.turn || "—"}</span>
            <span className="t-ghost">·</span>
            <span title={ev.ts}>{timeHHMM(ev.ts)}</span>
          </span>
        </span>

        {/* Desktop columns — always rendered, hidden below md */}
        <span
          className={`${COL_AGENT} hidden truncate font-mono text-xs text-foreground md:block`}
          title={ev.agent}
        >
          {agentLabel}
        </span>
        <span
          className={`${COL_SESSION} hidden font-mono text-xs t-secondary md:block`}
          title={ev.session_id}
        >
          {shortSession(ev.session_id)}
        </span>
        <span
          className={`${COL_TURN} hidden font-mono text-xs tabular-nums t-secondary md:block`}
        >
          {ev.turn || "—"}
        </span>
        <span className={`${COL_TIME} hidden md:block`}>
          <span
            className="block font-mono text-xs tabular-nums text-foreground"
            title={ev.ts}
          >
            {timeHHMM(ev.ts)}
          </span>
          <span className="block text-[10px] t-tertiary">{relTime(ev.ts)}</span>
        </span>

        <span
          className={`w-4 shrink-0 t-tertiary transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        >
          ›
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border-subtle bg-muted/20 px-3 py-3 sm:px-12">
          <EventDetail ev={ev} />
        </div>
      ) : null}
    </li>
  );
}

// ── Filter strip ─────────────────────────────────────────────────────

function FilterStrip({
  date,
  agent,
  sessionId,
  eventType,
  facets,
  onChange,
  onReset,
  isDefault,
}: {
  date: string;
  agent: string;
  sessionId: string;
  eventType: string;
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        <div>
          <label htmlFor="lb-type" className={labelCls}>
            What kind
          </label>
          <select
            id="lb-type"
            value={eventType}
            onChange={(e) =>
              onChange({ type: e.target.value || null, page: null })
            }
            className={inputCls}
          >
            <option value="">Any kind</option>
            {facets?.event_types.map((t) => {
              // Show the friendly chip name from narrate(); fall back to
              // event_type with underscores spaced.
              const friendly = t.type.startsWith("tokenflow.")
                ? `Token saved · ${t.type.slice("tokenflow.".length).replace(/_/g, " ")}`
                : t.type.replace(/_/g, " ");
              return (
                <option key={t.type} value={t.type}>
                  {friendly} ({t.count})
                </option>
              );
            })}
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

// ── Pagination ───────────────────────────────────────────────────────

function Pagination({
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
  const pageNums: (number | "…")[] = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || (i >= cur - 1 && i <= cur + 1)) {
      pageNums.push(i);
    } else if (pageNums[pageNums.length - 1] !== "…") {
      pageNums.push("…");
    }
  }
  const from = (cur - 1) * pageSize + 1;
  const to = Math.min(cur * pageSize, total);
  const btn =
    "rounded-md px-2.5 py-1 font-mono text-xs tabular-nums transition-colors";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-3 py-3">
      <span className="text-xs t-secondary">
        Showing{" "}
        <span className="font-mono tabular-nums text-foreground">
          {from}–{to}
        </span>{" "}
        of{" "}
        <span className="font-mono tabular-nums text-foreground">
          {fmtNum(total)}
        </span>
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
        {pageNums.map((p, i) => {
          if (p === "…") {
            // Stable key from the neighbouring page numbers — each gap
            // sits between unique numeric anchors, so this is collision-free.
            const prev = pageNums[i - 1];
            const next = pageNums[i + 1];
            return (
              <span
                key={`gap-${prev}-${next}`}
                className="px-1 font-mono text-xs t-tertiary"
              >
                …
              </span>
            );
          }
          return (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={`${btn} ${
                p === cur
                  ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/40"
                  : "t-secondary hover:bg-muted hover:text-foreground"
              }`}
              aria-current={p === cur ? "page" : undefined}
            >
              {p}
            </button>
          );
        })}
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

  // URL-backed filter state. Defaults: date=today, no agent/session/type
  // filters, page=1. Refresh + share preserve the view.
  const dateParam = useHashQueryParam("date");
  const agentParam = useHashQueryParam("agent");
  const sessionParam = useHashQueryParam("session");
  const typeParam = useHashQueryParam("type");
  const pageParam = useHashQueryParam("page");

  const date = dateParam || todayLocal();
  const agent = agentParam || "";
  const sessionId = sessionParam || "";
  const eventType = typeParam || "";
  const page = Math.max(1, Number(pageParam ?? 1) || 1);
  const isDefault =
    !dateParam &&
    !agentParam &&
    !sessionParam &&
    !typeParam &&
    (!pageParam || pageParam === "1");

  const bounds = useMemo(() => dayBounds(date), [date]);
  const [storyOpen, setStoryOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  // Fix H — compliance ribbon (Surface 2/3/mark_intent/skill).
  const complianceQ = useQuery({
    queryKey: queryKey([
      "logbook",
      "compliance",
      bounds?.from_ts ?? "",
      bounds?.to_ts ?? "",
      agent,
      sessionId,
    ]),
    queryFn: () =>
      fetchJson<ComplianceResponse>(
        url(`/api/logbook/compliance?${sharedFilter.toString()}`)
      ),
    refetchInterval: REFETCH_MS,
  });
  const compliance = complianceQ.data?.data;

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

  const timelineQ = useQuery({
    queryKey: queryKey([
      "logbook",
      "timeline",
      bounds?.from_ts ?? "",
      bounds?.to_ts ?? "",
      agent,
      sessionId,
      eventType,
      page,
    ]),
    queryFn: () => {
      const qs = new URLSearchParams(sharedFilter);
      if (eventType) qs.set("event_type", eventType);
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String((page - 1) * PAGE_SIZE));
      return fetchJson<TimelineResponse>(
        url(`/api/logbook/timeline?${qs.toString()}`)
      );
    },
    refetchInterval: REFETCH_MS,
  });

  // Reset expansion when the page changes or the filter shifts.
  useEffect(() => {
    setExpandedId(null);
  }, []);

  const story = storyQ.data?.data;
  const facets = facetsQ.data?.data;
  const timeline = timelineQ.data?.data ?? [];
  const total = timelineQ.data?.total ?? 0;

  const counters = story ? pickCounters(story.right_rail.by_type) : [];
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
    setExpandedId(null);
  };

  const resetFilters = () => {
    setHashQueryParams({
      date: null,
      agent: null,
      session: null,
      type: null,
      page: null,
    });
    setExpandedId(null);
  };

  const setPage = (next: number) => {
    setHashQueryParams({ page: next > 1 ? String(next) : null });
    setExpandedId(null);
    if (typeof window !== "undefined")
      window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (storyQ.isLoading && timelineQ.isLoading) {
    return (
      <div className="space-y-6">
        <CardGridSkeleton count={3} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
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
            {total === 1 ? "thing" : "things"} unerr did for you
          </p>
        </div>
      </header>

      {/* Filter strip */}
      <FilterStrip
        date={date}
        agent={agent}
        sessionId={sessionId}
        eventType={eventType}
        facets={facets}
        onChange={updateFilters}
        onReset={resetFilters}
        isDefault={isDefault}
      />

      {/* Counter strip */}
      {counters.length > 0 ? (
        <section
          aria-label="At-a-glance counters"
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          {counters.map((c) => (
            <div key={c.label} className="info-card">
              <div className="info-card-label">{c.label}</div>
              <div className="info-card-value font-mono tabular-nums text-lg text-foreground">
                {fmtNum(c.count)}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {/* Fix L — cross-tier runtime joins row. Renders ABOVE the
          compliance grid because joins are the highest-leverage
          positioning artefact (§12). Visible only when total>0 so the
          row stays out of the way on join-free windows. */}
      {compliance && compliance.runtime_joins.total > 0 ? (
        <section
          aria-label="Cross-tier runtime joins"
          className="rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3"
        >
          <div className="flex items-center gap-2 text-sm">
            <span aria-hidden="true">⚡</span>
            <span className="font-medium text-foreground">unerr runtime</span>
            <span className="t-tertiary">·</span>
            <span className="font-mono tabular-nums text-foreground">
              memory→graph {compliance.runtime_joins.memory_to_graph}
            </span>
            <span className="t-tertiary">·</span>
            <span className="font-mono tabular-nums text-foreground">
              graph→drift {compliance.runtime_joins.graph_to_drift}
            </span>
            <span className="t-tertiary">·</span>
            <span className="font-mono tabular-nums text-foreground">
              three-way {compliance.runtime_joins.three_way}
            </span>
          </div>
          <div className="mt-1 text-[11px] t-tertiary">
            joins point tools cannot produce — per-repo runtime context
          </div>
        </section>
      ) : null}

      {/* Fix H — directive compliance ribbon */}
      {compliance ? (
        <section
          aria-label="Directive compliance"
          className="grid grid-cols-2 gap-3 sm:grid-cols-5"
        >
          {(
            [
              ["Surface 2", compliance.surface2],
              ["Surface 3", compliance.surface3],
              ["Surface 4", compliance.surface4],
              ["mark_intent", compliance.mark_intent],
              ["Skill invoke", compliance.skill],
            ] as const
          ).map(([label, c]) => (
            <div key={label} className="info-card">
              <div className="info-card-label">{label}</div>
              <div className="info-card-value font-mono tabular-nums text-lg text-foreground">
                {Math.round(c.ratio * 100)}%
              </div>
              <div className="text-xs t-tertiary">
                {c.called} / {c.required}
                {c.consecutive_misses > 0 ? (
                  <span className="ml-2 text-amber-400">
                    {c.consecutive_misses}× miss streak
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {/* Collapsible story summary */}
      {story && !story.honest_zero ? (
        <section className="rounded-xl border border-border-subtle bg-card">
          <button
            type="button"
            onClick={() => setStoryOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left"
            aria-expanded={storyOpen}
          >
            <span className="text-xs uppercase tracking-[0.12em] t-tertiary">
              Story · {story.period_label}
            </span>
            <span className="flex items-center gap-2 text-xs t-secondary">
              {storyOpen ? "Hide" : "Show"} summary
              <span
                className={`t-tertiary transition-transform ${storyOpen ? "rotate-90" : ""}`}
                aria-hidden="true"
              >
                ›
              </span>
            </span>
          </button>
          {storyOpen ? (
            <div className="border-t border-border-subtle px-5 py-4">
              <p className="text-base leading-relaxed text-foreground">
                {story.story}
              </p>
              {story.featured ? (
                <div className="mt-4 rounded-lg border border-border-subtle bg-muted/30 p-3 text-sm">
                  <div className="mb-1 text-[10px] uppercase tracking-[0.12em] t-tertiary">
                    Featured moment · {timeHHMM(story.featured.ts)}
                  </div>
                  <div className="text-foreground">
                    {narrate(story.featured).sentence}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Activity feed */}
      <section className="overflow-hidden rounded-xl border border-border-subtle bg-card">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
          <h2 className="font-grotesk text-xs font-semibold uppercase tracking-[0.12em] t-tertiary">
            Activity
          </h2>
          <span className="font-mono text-[10px] tabular-nums t-tertiary">
            {timelineQ.isFetching ? "syncing…" : `live · ${REFETCH_MS / 1000}s`}
          </span>
        </div>
        {timelineQ.isLoading ? (
          <div className="p-6">
            <CardGridSkeleton count={5} />
          </div>
        ) : timeline.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <p className="text-sm t-secondary">
              {story?.honest_zero
                ? "unerr was quiet — nothing to replay for this view."
                : "No events match these filters."}
            </p>
            {!isDefault ? (
              <button
                type="button"
                onClick={resetFilters}
                className="text-xs text-violet-300 hover:text-violet-200 hover:underline"
              >
                Reset to today
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <ActivityHeader />
            <ol>
              {timeline.map((ev, i) => {
                const id = `${ev.ts}-${ev.session_id}-${ev.event_type}-${i}`;
                return (
                  <ActivityRow
                    key={id}
                    ev={ev}
                    expanded={expandedId === id}
                    onToggle={() =>
                      setExpandedId((cur) => (cur === id ? null : id))
                    }
                  />
                );
              })}
            </ol>
            <Pagination
              page={page}
              total={total}
              pageSize={PAGE_SIZE}
              onChange={setPage}
            />
          </>
        )}
      </section>
    </div>
  );
}
