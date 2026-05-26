import { CardGridSkeleton, SkeletonBlock } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { navigateRoute } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Token Flow API types (mirrors /api/token-flow/global response)    */
/* ------------------------------------------------------------------ */

type TokenFlowGlobalResponse = {
  data: {
    total_sessions: number;
    total_turns: number;
    total_tokens_without: number;
    total_tokens_with: number;
    total_tokens_saved: number;
    total_context_avoided: number;
    efficiency_pct: number;
    event_count: number;
    by_mechanism: Record<
      string,
      { event_count: number; tokens_saved: number; pct_of_total?: number }
    >;
  };
  _meta: { latency_ms?: number };
};

type TokenFlowSession = {
  session_id: string;
  event_count: number;
  total_saved: number;
  total_turns: number;
  avg_context_reduction: number;
  mechanisms: string[];
  agent_name: string;
  first_ts: string;
  last_ts: string;
};

type TokenFlowSessionsResponse = {
  data: TokenFlowSession[];
  _meta: { total: number; latency_ms?: number };
};

/* ------------------------------------------------------------------ */
/*  Directive-compliance diagnostics (mirrors /api/logbook/compliance) */
/*  Relocated here from "What unerr did" — these are unerr's own       */
/*  protocol self-checks, not user-facing outcomes.                    */
/* ------------------------------------------------------------------ */

type ComplianceCounter = {
  required: number;
  called: number;
  ratio: number;
  consecutive_misses: number;
};

type ComplianceResponse = {
  data: {
    surface2: ComplianceCounter;
    surface3: ComplianceCounter;
    mark_intent: ComplianceCounter;
    skill: ComplianceCounter;
    runtime_joins: {
      memory_to_graph: number;
      graph_to_drift: number;
      three_way: number;
      total: number;
    };
  };
};

/* ------------------------------------------------------------------ */
/*  Additive aspect sections — reasoning, memory, activity, code      */
/*  health. These pull from the same endpoints the dedicated pages    */
/*  use (reasoning-quality, facts, timeline, intelligence) so the     */
/*  Dashboard surfaces the non-token aspects unerr already tracks.    */
/* ------------------------------------------------------------------ */

// /api/reasoning-quality/global → { data: metrics | null }. Percentages are
// 0–100 (rendered "{x}%"); prevention_score is a raw count; multipliers ×.
type ReasoningGlobalResponse = {
  data: {
    noise_removed_pct: number;
    first_call_resolution_rate: number;
    prevention_score: number;
    reasoning_quality_multiplier: number;
    blast_radius_warnings: number;
    convention_injections: number;
    circuit_breaker_activations: number;
    facts_surfaced: number;
    facts_recalled: number;
    facts_recorded: number;
    memory_effectiveness_pct: number;
    memory_signals_fired: number;
    memory_verdicts_total: number;
    resume_hits: number;
  } | null;
};

// /api/facts/health → UNWRAPPED object (no { data } envelope).
type FactsHealthResponse = {
  total: number;
  active: number;
  decayed: number;
  by_type: Record<string, number>;
  avg_confidence: number; // 0–1
};

type IntentRow = {
  intent_id: string;
  title: string;
  status: string; // "active" | "dormant"
  confidence: number;
  last_active_at: number;
  source: string;
};
type IntentsResponse = { data: IntentRow[] };

type ResumeResponse = {
  data: {
    open_threads: {
      marker_id: string;
      text: string;
      file_path: string;
      ts: number;
    }[];
  } | null;
};

type TurnsCountResponse = { data: unknown[]; total: number };

type InsightsResponse = {
  data: {
    healthGrade: string; // "A"–"F"
    healthScore: number; // 0–100
    blastRadiusCoverage: number; // %
    riskDistribution: { high: number; medium: number; low: number };
    bottlenecks: unknown[];
  } | null;
};

type GraphStatsResponse = {
  data: {
    entityCount: number;
    fileCount: number;
    communityCount: number;
    driftCount: number;
  } | null;
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function fmtNum(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  let abs = Math.abs(n);
  // Under 1k: show the exact count (e.g. 932 → "932").
  if (abs < 1_000) return `${sign}${Math.round(abs).toLocaleString()}`;
  // Scale through K / M / B / T, rolling over when rounding hits 1,000 so
  // 999,999 reads "1M" (never "1000.0K"). Works for 0 → trillions.
  const units = ["K", "M", "B", "T"] as const;
  let u = -1;
  do {
    abs /= 1_000;
    u++;
  } while (abs >= 999.95 && u < units.length - 1);
  return `${sign}${abs.toFixed(1).replace(/\.0$/, "")}${units[u]}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Pretty-print an unknown mechanism key (snake_case → Sentence case). */
function prettyKey(key: string): string {
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/* Per-row hue palette — mirrors TokenFlowPage's MechanismBar so the
 * prevention cards read identically to the Token Trace breakdown.
 * Per-row color diversity lives in the bar + label (data-payload color,
 * brand chart palette tokens). */
type RowPalette = { bar: string; text: string };

const MECH_COLORS: Record<string, RowPalette> = {
  shell_compression: { bar: "bg-cyan-500", text: "text-cyan-400" },
  format_encoding: { bar: "bg-amber-500", text: "text-amber-400" },
  session_dedup: { bar: "bg-emerald-500", text: "text-emerald-400" },
  smart_truncation: { bar: "bg-blue-500", text: "text-blue-400" },
  file_read: { bar: "bg-indigo-500", text: "text-indigo-400" },
  fetch_url: { bar: "bg-teal-500", text: "text-teal-400" },
  graph_query: { bar: "bg-violet-500", text: "text-violet-400" },
  persistent_memory: { bar: "bg-fuchsia-500", text: "text-fuchsia-400" },
};

const PREVENTION_COLORS: Record<string, RowPalette> = {
  graph_query_served: { bar: "bg-violet-500", text: "text-violet-400" },
  full_read_avoided: { bar: "bg-indigo-500", text: "text-indigo-400" },
  loop_broken: { bar: "bg-rose-500", text: "text-rose-400" },
  cascade_guard: { bar: "bg-amber-500", text: "text-amber-400" },
  drift_consumed: { bar: "bg-cyan-500", text: "text-cyan-400" },
  intervention_halted: { bar: "bg-rose-500", text: "text-rose-400" },
  intervention_warned: { bar: "bg-amber-500", text: "text-amber-400" },
  defuddle_selector_skipped: { bar: "bg-teal-500", text: "text-teal-400" },
};

/* Memory / store / resume event hues — completes the palette for the
 * prevention band so memory-related actions (recalled notes, saved facts)
 * read with their own color rather than fallback gray. */
const ACTION_COLORS: Record<string, RowPalette> = {
  fact_recalled: { bar: "bg-fuchsia-500", text: "text-fuchsia-400" },
  fact_stored_user_fed: { bar: "bg-emerald-500", text: "text-emerald-400" },
  fact_stored_auto: { bar: "bg-teal-500", text: "text-teal-400" },
  caller_check_enforced: { bar: "bg-sky-500", text: "text-sky-400" },
  stale_edit_prevented: { bar: "bg-cyan-500", text: "text-cyan-400" },
  cascade_warning_consumed: { bar: "bg-amber-500", text: "text-amber-400" },
  convention_applied: { bar: "bg-blue-500", text: "text-blue-400" },
  cross_session_resume: { bar: "bg-violet-500", text: "text-violet-400" },
  resume_blockers_surfaced: { bar: "bg-rose-500", text: "text-rose-400" },
  cache_hit: { bar: "bg-lime-500", text: "text-lime-400" },
};

function mcAction(key: string): RowPalette {
  return (
    PREVENTION_COLORS[key] ??
    ACTION_COLORS[key] ??
    MECH_COLORS[key] ?? {
      bar: "bg-violet-500",
      text: "text-violet-400",
    }
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components (Stripe / Linear / PostHog / Datadog patterns)     */
/* ------------------------------------------------------------------ */

/** Accessible info tooltip. Hover OR keyboard-focus reveals plain-text
 *  explanation; Esc dismisses; `role="tooltip"` + `aria-describedby` link
 *  it to the trigger. Per the tooltip-UX research (USWDS, UX Design World):
 *  tooltips appear on focus as well as hover, carry <150 chars, and are
 *  never the ONLY source of essential info — these explain, they don't
 *  gate any task. */
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

/** Animate a number 0 → target once on first data arrival (easeOutCubic).
 *  Respects `prefers-reduced-motion` and only runs once per mount — refetch
 *  updates snap to the new value rather than re-animating. Count-up is the
 *  research-backed "wow beat" that fights change-blindness (Smashing 2025). */
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

/** Count-up wrapper — formats the animated value each frame. `format`
 *  receives a rounded integer so K/M abbreviations stay clean mid-animation. */
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

/** Internal event types hidden from the prevention grid — these are unerr's
 *  own protocol signals, not user-visible outcomes. */
const HIDDEN_DASHBOARD_EVENTS = new Set([
  "user_prompt_received",
  "surface2_emitted",
  "surface2_missed",
  "surface4a_emitted",
  "presence_ambient_marker",
  "fact_capture_abandoned",
  "confirmation_expired",
]);

/** Prevention-focused phrasing for dashboard cards. `label` is the what
 *  (shown next to the count); `desc` is the counterfactual on hover (what
 *  would have gone wrong without unerr). */
const ACTION_PHRASING: Record<string, { label: string; desc: string }> = {
  graph_query_served: {
    label: "unnecessary file reads prevented",
    desc: "The agent found the answer in one graph query instead of reading 5-15 files with grep. Each lookup saved multiple turns of trial-and-error.",
  },
  full_read_avoided: {
    label: "large file dumps prevented",
    desc: "Only the relevant lines were sent instead of the entire file. Without unerr: the agent loads thousands of lines when it only needed a few.",
  },
  fact_recalled: {
    label: "re-explanations prevented",
    desc: "unerr remembered notes from your earlier sessions and surfaced them at the right moment, so the agent didn't ask you to repeat yourself.",
  },
  loop_broken: {
    label: "retry loops stopped",
    desc: "The agent was stuck in a loop, retrying the same failing operation. unerr detected the pattern and broke the cycle before more turns were wasted.",
  },
  cascade_guard: {
    label: "breaking changes caught",
    desc: "The agent was about to edit code that many other files depend on. unerr flagged the risk so the change didn't silently break downstream code.",
  },
  drift_consumed: {
    label: "stale file edits prevented",
    desc: "The file had changed since the agent last read it. unerr caught this so the agent didn't overwrite newer changes with an outdated version.",
  },
  intervention_halted: {
    label: "dangerous operations blocked",
    desc: "A risky tool call was stopped before it could run. Without unerr: the operation would have executed unchecked and potentially corrupted state.",
  },
  intervention_warned: {
    label: "risky patterns flagged early",
    desc: "unerr spotted a risky pattern and warned the agent before it committed. Without the warning: the agent would have proceeded blindly.",
  },
  defuddle_selector_skipped: {
    label: "web page noise filtered out",
    desc: "Navigation menus, footers, and ads were stripped from fetched web pages so only the actual content reached the agent.",
  },
  fact_stored_user_fed: {
    label: "rules saved for future sessions",
    desc: "Rules you told the agent were saved permanently. Next session, the agent will already know these without you having to repeat them.",
  },
  fact_stored_auto: {
    label: "code patterns learned",
    desc: "unerr noticed a convention in your codebase and stored it. Future edits will follow this pattern automatically.",
  },
  caller_check_enforced: {
    label: "blind edits prevented",
    desc: "unerr checked who calls this code before allowing the edit. Without it: changes would land without knowing what else they break.",
  },
  stale_edit_prevented: {
    label: "overwrites of new changes stopped",
    desc: "The agent tried to edit a file that was modified after it was last read. unerr stopped the edit to prevent overwriting your recent work.",
  },
  cascade_warning_consumed: {
    label: "downstream breaks prevented",
    desc: "Code that depends on the edited file was identified and the agent was warned before making changes that would ripple through.",
  },
  convention_applied: {
    label: "style violations prevented",
    desc: "Project conventions (naming, imports, structure) were applied automatically, so new code matched your existing style from the start.",
  },
  cross_session_resume: {
    label: "cold-start sessions prevented",
    desc: "Context from your last session was restored, so the agent picked up where it left off instead of starting from scratch.",
  },
  resume_blockers_surfaced: {
    label: "forgotten blockers resurfaced",
    desc: "Unresolved problems from a previous session were brought forward so they didn't fall through the cracks.",
  },
  cache_hit: {
    label: "redundant computations skipped",
    desc: "A previously computed answer was served from cache instead of being recomputed, saving time and tokens.",
  },
};

function actionPhrasing(key: string): { label: string; desc: string } {
  return (
    ACTION_PHRASING[key] ?? {
      label: `${prettyKey(key).toLowerCase()} handled`,
      desc: "An issue unerr caught and handled so the agent didn't have to retry or undo it.",
    }
  );
}

/** Prevention card: big count + plain-English label, with the counterfactual
 *  revealed on hover/focus (keeps the grid dense while "what would have gone
 *  wrong" stays one hover away). */
function ActionCard({
  count,
  label,
  desc,
  palette,
}: {
  count: string;
  label: string;
  desc: string;
  palette: RowPalette;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="el-raised relative cursor-default overflow-visible rounded-lg p-3.5 pl-4"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <div
        aria-hidden
        className={`absolute inset-y-0 left-0 w-1 rounded-l-lg ${palette.bar} opacity-80`}
      />
      <button
        type="button"
        aria-expanded={open}
        className="block w-full text-left focus-visible:outline-none"
      >
        <span
          className={`font-mono text-2xl font-bold leading-none tabular-nums ${palette.text}`}
        >
          {count}
        </span>
        <span className="mt-1 block text-[11px] leading-snug text-foreground-emphasis">
          {label}
        </span>
      </button>
      {open ? (
        <span
          role="tooltip"
          className="absolute inset-x-0 top-full z-30 mt-1 rounded-lg border border-border-subtle bg-background px-3 py-2 text-left text-[11px] leading-snug t-secondary shadow-xl"
        >
          {desc}
        </span>
      ) : null}
    </div>
  );
}

/** Section header for the additive aspect sections — title + one-line blurb
 *  on the left, optional "details →" drill-down link on the right (progressive
 *  disclosure: summary here, full breakdown on the dedicated page). */
function SectionHead({
  title,
  blurb,
  onMore,
  moreLabel,
}: {
  title: string;
  blurb: string;
  onMore?: () => void;
  moreLabel?: string;
}) {
  return (
    <header className="mb-4 flex items-baseline justify-between gap-3">
      <div>
        <h2 className="section-label text-violet-500">{title}</h2>
        <p className="mt-0.5 t-tertiary text-[11px] leading-snug">{blurb}</p>
      </div>
      {onMore ? (
        <button
          type="button"
          onClick={onMore}
          className="shrink-0 text-xs text-violet-400 transition-colors hover:text-violet-300"
        >
          {moreLabel ?? "Details →"}
        </button>
      ) : null}
    </header>
  );
}

/* ── Aspect panel anatomy ──────────────────────────────────────────
 *  Shared layout for the four non-token aspect sections (Reasoning,
 *  Memory, Activity, Code Health). Research-grounded:
 *  - ONE focal metric rendered largest, left, with a micro-visual —
 *    "summary first, detail later" reduces time-to-insight and matches
 *    the F-pattern scan (nastengraph "Anatomy of the KPI Card";
 *    FanRuan; Devfinity "Psychology of Dashboards").
 *  - A radial progress ring is the focal visual for single percentages:
 *    it reads goal-attainment "at a glance" where precise comparison
 *    isn't the job (Domo / ChartEngine on radial gauges).
 *  - Supporting stats sit in a divider-separated strip at smaller size —
 *    consistent anatomy across all four so there's no per-card learning
 *    curve (nastengraph: uniform alignment + associative color).
 *  Every aspect section is built from these three primitives so they
 *  share one visual language. */

/** Focal radial ring for a single 0–100 percentage. The arc + the centre
 *  number animate together via useCountUp (one rAF source, no CSS-transition
 *  fight). `accent` colors both the arc (currentColor) and the number. */
function RadialStat({
  value,
  label,
  hint,
  accent = "text-emerald-400",
}: {
  value: number | null | undefined;
  label: string;
  hint?: string;
  accent?: string;
}) {
  const target = value == null ? 0 : Math.max(0, Math.min(100, value));
  const animated = useCountUp(target);
  const r = 32;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - animated / 100);
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[76px] w-[76px] shrink-0">
        <svg
          viewBox="0 0 80 80"
          className="h-[76px] w-[76px] -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="40"
            cy="40"
            r={r}
            fill="none"
            strokeWidth="7"
            stroke="currentColor"
            className="text-border-subtle"
            opacity={0.45}
          />
          <circle
            cx="40"
            cy="40"
            r={r}
            fill="none"
            strokeWidth="7"
            strokeLinecap="round"
            stroke="currentColor"
            className={accent}
            strokeDasharray={circ}
            strokeDashoffset={offset}
          />
        </svg>
        <span
          className={`absolute inset-0 flex items-center justify-center font-mono text-lg font-bold tabular-nums ${accent}`}
        >
          {value == null ? "—" : `${Math.round(animated)}%`}
        </span>
      </div>
      <div className="min-w-0">
        <span className="block text-sm font-semibold text-foreground-emphasis">
          {label}
        </span>
        {hint ? (
          <span className="mt-0.5 block t-tertiary text-[11px] leading-snug">
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Focal figure/badge for a lead metric that isn't a percentage — a grade
 *  letter, an "N×" multiplier, or a headline count. Mirrors RadialStat's
 *  footprint (same 76px well, same label/hint block) so the two lead types
 *  align across sibling panels. */
function LeadFigure({
  value,
  label,
  hint,
  accent = "text-violet-300",
  chip = "bg-violet-500/10 ring-violet-500/25",
}: {
  value: ReactNode;
  label: string;
  hint?: string;
  accent?: string;
  chip?: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <div
        className={`flex h-[76px] w-[76px] shrink-0 items-center justify-center rounded-2xl ring-1 ${chip}`}
      >
        <span
          className={`font-mono text-3xl font-bold leading-none tabular-nums ${accent}`}
        >
          {value}
        </span>
      </div>
      <div className="min-w-0">
        <span className="block text-sm font-semibold text-foreground-emphasis">
          {label}
        </span>
        {hint ? (
          <span className="mt-0.5 block t-tertiary text-[11px] leading-snug">
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Compact support row — label + plain-English hint on the left, mono value
 *  on the right. Divider-separated stack; smaller than the lead by design
 *  (typographic hierarchy: largest = focal, medium = name, small = context). */
function SupportRow({
  label,
  value,
  hint,
  accent = "text-foreground",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <div className="min-w-0">
        <span className="block text-sm text-foreground">{label}</span>
        {hint ? (
          <span className="block t-tertiary text-[11px] leading-snug">
            {hint}
          </span>
        ) : null}
      </div>
      <span
        className={`shrink-0 font-mono text-lg font-semibold tabular-nums ${accent}`}
      >
        {value}
      </span>
    </div>
  );
}

/** One aspect section: SectionHead + (focal lead | support strip) + optional
 *  footer (e.g. the in-flight task list). The shared shell every non-token
 *  aspect renders through, guaranteeing identical UX across the four. */
function AspectPanel({
  title,
  blurb,
  onMore,
  lead,
  support,
  footer,
}: {
  title: string;
  blurb: string;
  onMore?: () => void;
  lead: ReactNode;
  support: {
    label: string;
    value: ReactNode;
    hint?: string;
    accent?: string;
  }[];
  footer?: ReactNode;
}) {
  return (
    <section className="glass-panel rounded-xl p-5">
      <SectionHead title={title} blurb={blurb} onMore={onMore} />
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-7">
        <div className="sm:w-[15.5rem] sm:shrink-0">{lead}</div>
        <div className="flex-1 sm:border-l sm:border-border-subtle sm:pl-7">
          <div className="divide-y divide-border-subtle/60">
            {support.map((s) => (
              <SupportRow
                key={s.label}
                label={s.label}
                value={s.value}
                hint={s.hint}
                accent={s.accent}
              />
            ))}
          </div>
        </div>
      </div>
      {footer}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Dashboard                                                         */
/* ------------------------------------------------------------------ */

export function Dashboard() {
  const { url, queryKey } = useRepoApi();

  /* --- data --- */
  const tokenFlowQ = useQuery({
    queryKey: queryKey(["token-flow", "global"]),
    queryFn: () =>
      fetchJson<TokenFlowGlobalResponse>(url("/api/token-flow/global")),
  });

  const headroomQ = useQuery({
    queryKey: queryKey(["token-flow", "headroom"]),
    queryFn: () =>
      fetchJson<{
        data: Record<
          "today" | "this_week" | "since_install",
          {
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
        >;
        _meta: { latency_ms: number; context_limit: number };
      }>(url("/api/token-flow/headroom")),
    refetchInterval: 30_000,
  });

  const sessionsQ = useQuery({
    queryKey: queryKey(["token-flow", "sessions-recent"]),
    queryFn: () =>
      fetchJson<TokenFlowSessionsResponse>(
        url("/api/token-flow/sessions?limit=8&offset=0")
      ),
  });

  const behaviorEventsQ = useQuery({
    queryKey: queryKey(["behavior-events", "global"]),
    queryFn: () =>
      fetchJson<{
        data: {
          total_sessions: number;
          counts: {
            by_type: Record<string, number>;
            by_tool: Record<string, number>;
            total: number;
          };
        };
      }>(url("/api/behavior-events/global")),
    refetchInterval: 10_000,
  });

  const complianceQ = useQuery({
    queryKey: queryKey(["logbook", "compliance", "dashboard"]),
    queryFn: () =>
      fetchJson<ComplianceResponse>(url("/api/logbook/compliance")),
    refetchInterval: 30_000,
  });

  /* --- additive aspect data (reasoning, memory, activity, code health) --- */
  const reasoningQ = useQuery({
    queryKey: queryKey(["reasoning-quality", "global", "dashboard"]),
    queryFn: () =>
      fetchJson<ReasoningGlobalResponse>(url("/api/reasoning-quality/global")),
    refetchInterval: 30_000,
  });
  const factsHealthQ = useQuery({
    queryKey: queryKey(["facts", "health", "dashboard"]),
    queryFn: () => fetchJson<FactsHealthResponse>(url("/api/facts/health")),
    refetchInterval: 30_000,
  });
  const intentsQ = useQuery({
    queryKey: queryKey(["timeline", "intents", "dashboard"]),
    queryFn: () =>
      fetchJson<IntentsResponse>(url("/api/timeline/intents?limit=10")),
    refetchInterval: 30_000,
  });
  const resumeQ = useQuery({
    queryKey: queryKey(["timeline", "resume", "dashboard"]),
    queryFn: () => fetchJson<ResumeResponse>(url("/api/timeline/resume")),
    refetchInterval: 30_000,
  });
  const turnsCountQ = useQuery({
    queryKey: queryKey(["timeline", "turns", "count", "dashboard"]),
    queryFn: () =>
      fetchJson<TurnsCountResponse>(url("/api/timeline/turns?limit=1")),
    refetchInterval: 30_000,
  });
  const insightsQ = useQuery({
    queryKey: queryKey(["intelligence", "insights", "dashboard"]),
    queryFn: () =>
      fetchJson<InsightsResponse>(url("/api/intelligence/insights")),
  });
  const graphStatsQ = useQuery({
    queryKey: queryKey(["intelligence", "graph-stats", "dashboard"]),
    queryFn: () =>
      fetchJson<GraphStatsResponse>(url("/api/intelligence/graph-stats")),
  });

  const tf = tokenFlowQ.data?.data;
  const sessions = sessionsQ.data?.data ?? [];
  const headroom = headroomQ.data?.data;
  const headroomLoading = headroomQ.isLoading && headroom === undefined;

  /* Cross-layer protection counts — memory + graph + drift landing on the
   * same entity. Phrased in user terms: "your stored notes helped protect
   * against N code changes" rather than internal jargon. */
  const runtimeJoins = complianceQ.data?.data?.runtime_joins;
  const joinParts: string[] = [];
  if (runtimeJoins) {
    const m = runtimeJoins.memory_to_graph;
    const g = runtimeJoins.graph_to_drift;
    const t = runtimeJoins.three_way;
    if (m > 0)
      joinParts.push(
        `${m} stored ${m === 1 ? "note" : "notes"} used to protect ${m === 1 ? "a code change" : "code changes"}`
      );
    if (g > 0)
      joinParts.push(
        `${g} file ${g === 1 ? "change" : "changes"} caught by checking code structure`
      );
    if (t > 0)
      joinParts.push(
        `${t} ${t === 1 ? "issue" : "issues"} caught by combining all three layers`
      );
  }

  /* Additive aspects — derived values. `pct()` formats a 0–100 number as
   * "{n}%" (or "—" when absent). Reasoning + memory share the
   * reasoning-quality payload; memory also pulls fact-store health. */
  const pct = (n: number | undefined | null): string =>
    n == null ? "—" : `${Math.round(n)}%`;
  const rq = reasoningQ.data?.data;
  const fh = factsHealthQ.data;
  const intents = intentsQ.data?.data ?? [];
  const activeTasks = intents.filter((i) => i.status === "active");
  const openThreads = resumeQ.data?.data?.open_threads ?? [];
  const activityMoments = turnsCountQ.data?.total ?? 0;
  const insights = insightsQ.data?.data;
  const graphStats = graphStatsQ.data?.data;
  const factsByType = fh?.by_type ?? {};
  const lessonsCount =
    (factsByType.negative ?? 0) + (factsByType.episodic ?? 0);
  const gradeAccent = (grade: string | undefined): string => {
    if (!grade) return "text-foreground";
    const g = grade[0]?.toUpperCase();
    if (g === "A" || g === "B") return "text-success";
    if (g === "C" || g === "D") return "text-warning";
    return "text-error";
  };
  /* Matching ring/chip tint for the grade badge so the lead well carries the
   * same A=good→F=bad semantics as the letter color (associative color). */
  const gradeChip = (grade: string | undefined): string => {
    if (!grade) return "bg-violet-500/10 ring-violet-500/25";
    const g = grade[0]?.toUpperCase();
    if (g === "A" || g === "B") return "bg-emerald-500/10 ring-emerald-500/30";
    if (g === "C" || g === "D") return "bg-amber-500/10 ring-amber-500/30";
    return "bg-rose-500/10 ring-rose-500/30";
  };

  const compoundMultiplier =
    tf && tf.total_tokens_saved > 0
      ? (tf.total_context_avoided / tf.total_tokens_saved).toFixed(1)
      : null;

  /* Mistakes prevented — user-facing behavior events, filtered to exclude
   * internal protocol signals. Sorted by volume, top 8 shown as cards.
   * The count IS the measure; the counterfactual rides along on hover. */
  const actionsRaw = behaviorEventsQ.data?.data.counts.by_type ?? {};
  const actions = Object.entries(actionsRaw)
    .filter(([type, n]) => n > 0 && !HIDDEN_DASHBOARD_EVENTS.has(type))
    .sort(([, a], [, b]) => b - a);
  const actionsTotal = actions.reduce((s, [, n]) => s + n, 0);
  const topActions = actions.slice(0, 8);

  // Step 2 of the honest-headroom migration: the headroom number divides
  // saved tokens by an unobserved-overhead-clamped per-turn token count (see
  // `DEFAULT_UNOBSERVED_OVERHEAD_TOKENS`). It can still inflate when the
  // session is very young or extremely compression-heavy. If any window's
  // earned turns exceed 2× the turns actually observed, we treat the
  // ratio as not-yet-calibrated and surface a "still calibrating" notice
  // instead. The named-event counter strip on /logbook is the headline
  // when this gate trips.
  const headroomImplausible =
    !!headroom &&
    [headroom.today, headroom.this_week, headroom.since_install].some(
      (b) => b.turns_observed > 0 && b.headroom_turns > b.turns_observed * 2
    );

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      {/* ============================================================
       *  IMPACT HERO (Spotlight) — one dominant number (Turns Earned)
       *  with tokens-saved + rescue-rate as supporting stats and
       *  today/week/compounding as context chips. Count-up animated on
       *  first load; explanations live behind hover InfoTips (no verbose
       *  prose at the top of the dashboard). Replaces the stacked
       *  Turns-Earned + Tokens-Saved cards. Per UXPin/Equals: lead with
       *  the largest number top-left, supporting stats smaller.
       * ============================================================ */}
      <section className="glass-panel overflow-hidden rounded-xl p-6">
        <header className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="section-label text-violet-500">Impact</h2>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-wider t-tertiary">
              Since install
            </span>
            <button
              type="button"
              onClick={() => navigateRoute("token-trace")}
              className="shrink-0 text-xs text-violet-400 transition-colors hover:text-violet-300"
            >
              Breakdown →
            </button>
          </div>
        </header>

        {headroomLoading && !tf ? (
          <CardGridSkeleton n={3} />
        ) : (
          <>
            <div className="flex flex-col gap-7 sm:flex-row sm:items-end sm:gap-12">
              {/* Dominant — turns earned */}
              <div className="min-w-0">
                {headroom && !headroomImplausible ? (
                  <>
                    <span className="block font-mono text-6xl font-bold leading-none tracking-tight text-success tabular-nums">
                      <CountUp
                        value={headroom.since_install.headroom_turns}
                        format={(n) => `+${fmtNum(n)}`}
                      />
                    </span>
                    <span className="mt-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider t-tertiary">
                      turns earned
                      <InfoTip
                        label="What turns earned means"
                        text="Extra turns of session headroom unerr earned you — the unit compression-only tools can't measure. Counts as extra prompts within your request quota (credit-billed agents) or extra context room before a window exhausts (window-billed agents)."
                      />
                    </span>
                  </>
                ) : headroomImplausible ? (
                  <div className="max-w-sm">
                    <span className="block font-mono text-4xl font-bold leading-none text-warning tabular-nums">
                      calibrating
                    </span>
                    <p className="mt-2 t-tertiary text-[11px] leading-snug">
                      Turns earned needs a few more sessions to stabilise — the
                      exact counts below are honest in the meantime.
                    </p>
                  </div>
                ) : (
                  <>
                    <span className="block font-mono text-6xl font-bold leading-none text-muted-foreground tabular-nums">
                      —
                    </span>
                    <span className="mt-2 block text-[11px] font-medium uppercase tracking-wider t-tertiary">
                      no turns earned yet
                    </span>
                  </>
                )}
              </div>

              {/* Supporting — tokens saved (rescue-rate % removed: its
               *  span differs from graphify/RTK's identically-labelled
               *  percentage and was confusing users). */}
              {tf ? (
                <div className="flex gap-9 sm:gap-12 sm:pb-1">
                  <div>
                    <span className="block font-mono text-3xl font-bold leading-none text-foreground-emphasis tabular-nums">
                      <CountUp value={tf.total_tokens_saved} format={fmtNum} />
                    </span>
                    <span className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider t-tertiary">
                      tokens saved
                      <InfoTip
                        label="What tokens saved means"
                        text="Raw bytes unerr kept out of the agent's context — counted on operations it handled (file reads, web fetches, shell output, dedup). Not whole-turn savings."
                      />
                    </span>
                  </div>
                  <div>
                    <span className="block font-mono text-3xl font-bold leading-none text-cyan-400 tabular-nums">
                      <CountUp
                        value={tf.total_context_avoided}
                        format={fmtNum}
                      />
                    </span>
                    <span className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider t-tertiary">
                      context avoided
                      <InfoTip
                        label="What context avoided means"
                        text="Downstream work unerr kept the agent from ever doing — re-reads, re-searches and retries it never had to issue."
                      />
                    </span>
                  </div>
                </div>
              ) : null}

              {/* Where your savings come from — the category-design contrast.
               *  We concede output compression (what every token tool does)
               *  and OWN code-graph intelligence (only unerr keeps a
               *  persistent map of the repo, so it knows what to read and
               *  what to skip). Compression is the commodity ~20%;
               *  understanding the code is the ~80% no text-compressor can
               *  touch — surfaced as turns earned, not just tokens. Tiers are
               *  EXHAUSTIVE (compression = everything that isn't graph or
               *  graph-guided reads), so nothing is cherry-picked. Turns are
               *  estimated from each tier's share of tokens saved. */}
              {tf && headroom && !headroomImplausible ? (
                <div className="min-w-0 sm:flex-1 sm:self-stretch sm:border-l sm:border-border-subtle sm:pl-10">
                  <div className="flex h-full flex-col justify-center">
                    <span className="mb-4 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider t-tertiary">
                      Where your savings come from
                      <InfoTip
                        label="Where your savings come from"
                        text="Token tools compress text. unerr also understands your code — a persistent graph of the repo means it knows what to read and what to skip. Compression is the commodity; code-intelligence is unerr-only. Turns are estimated from each tier's share of tokens saved."
                      />
                    </span>
                    {(() => {
                      const total = tf.total_tokens_saved || 1;
                      const perTurn =
                        headroom.since_install.headroom_turns / total;
                      // Code-intelligence = graph queries + graph-guided
                      // targeted reads. Compression = the exhaustive
                      // remainder (shell, format, truncation, dedup, fetch).
                      const intel =
                        (tf.by_mechanism.graph_query?.tokens_saved ?? 0) +
                        (tf.by_mechanism.file_read?.tokens_saved ?? 0);
                      const compress = Math.max(
                        0,
                        tf.total_tokens_saved - intel
                      );
                      const intelPct = Math.round((intel / total) * 100);
                      const tiers = [
                        {
                          key: "compress",
                          title: "Text compression",
                          sub: "what every token tool does",
                          tokens: compress,
                          primary: false,
                          bar: "bg-zinc-500/70",
                          tokenAccent: "t-secondary",
                          barH: "h-1.5",
                        },
                        {
                          key: "intel",
                          title: "Understanding your code",
                          sub: "graph + graph-guided reads — only unerr",
                          tokens: intel,
                          primary: true,
                          bar: "bg-gradient-to-r from-violet-500 to-emerald-400",
                          tokenAccent: "text-emerald-300",
                          barH: "h-2.5",
                        },
                      ];
                      return (
                        <>
                          <div className="space-y-4">
                            {tiers.map((t) => (
                              <div key={t.key}>
                                <div className="flex items-baseline justify-between gap-3">
                                  <div className="min-w-0">
                                    <span
                                      className={`block text-sm font-semibold ${t.primary ? "text-foreground-emphasis" : "text-foreground"}`}
                                    >
                                      {t.title}
                                    </span>
                                    <span className="block text-[11px] leading-tight t-tertiary">
                                      {t.sub}
                                    </span>
                                  </div>
                                  <div className="shrink-0 text-right font-mono tabular-nums">
                                    <span
                                      className={`block text-sm font-semibold ${t.tokenAccent}`}
                                    >
                                      {fmtNum(t.tokens)} tok
                                    </span>
                                    <span className="block text-[11px] t-tertiary">
                                      ~{fmtNum(t.tokens * perTurn)} turns
                                    </span>
                                  </div>
                                </div>
                                <div
                                  className={`mt-1.5 overflow-hidden rounded-full bg-surface-overlay ${t.barH}`}
                                >
                                  <div
                                    className={`h-full rounded-full ${t.bar}`}
                                    style={{
                                      width: `${(t.tokens / total) * 100}%`,
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                          <p className="mt-4 border-t border-border-subtle pt-3 text-[11px] leading-snug t-secondary">
                            <span className="font-semibold text-emerald-300">
                              {intelPct}%
                            </span>{" "}
                            of every token unerr saves comes from{" "}
                            <span className="text-foreground">
                              understanding your code
                            </span>{" "}
                            — not compressing text.
                          </p>
                        </>
                      );
                    })()}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Context chips — today / this week / compounding / avoided */}
            {(headroom && !headroomImplausible) || tf ? (
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-subtle pt-4 text-sm t-secondary">
                {headroom && !headroomImplausible ? (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        navigateRoute("token-trace", { window: "today" })
                      }
                      className="inline-flex items-baseline gap-1.5 transition-colors hover:text-foreground"
                    >
                      <span className="font-mono text-base font-semibold tabular-nums text-success">
                        ▲ +{fmtNum(headroom.today.headroom_turns)}
                      </span>
                      today
                    </button>
                    <span className="t-tertiary">·</span>
                    <button
                      type="button"
                      onClick={() =>
                        navigateRoute("token-trace", { window: "this_week" })
                      }
                      className="inline-flex items-baseline gap-1.5 transition-colors hover:text-foreground"
                    >
                      <span className="font-mono text-base font-semibold tabular-nums text-success">
                        ▲ +{fmtNum(headroom.this_week.headroom_turns)}
                      </span>
                      this week
                    </button>
                  </>
                ) : null}
                {tf && compoundMultiplier ? (
                  <>
                    <span className="t-tertiary">·</span>
                    <span className="inline-flex items-baseline gap-1.5">
                      <span className="font-mono text-base font-semibold tabular-nums text-fuchsia-400">
                        {compoundMultiplier}×
                      </span>
                      context compounding
                      <InfoTip
                        label="What compounding means"
                        text="Context avoided per token saved — how much downstream work each rescued token prevented."
                      />
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* ============================================================
       *  MISTAKES PREVENTED — prevention-focused cards showing what unerr
       *  caught before it reached the user's code. Each card shows a count
       *  + user-friendly label; hover reveals the counterfactual (what
       *  would have gone wrong). Internal protocol events are filtered out.
       * ============================================================ */}
      <section className="glass-panel rounded-xl p-5">
        <header className="mb-4 flex items-baseline justify-between gap-3">
          <div>
            <h2 className="section-label text-violet-500">
              Mistakes prevented
            </h2>
            <p className="mt-0.5 t-tertiary text-[11px] leading-snug">
              Problems unerr caught before they reached your code — hover any
              card to see what would have gone wrong.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="font-mono text-[10px] uppercase tracking-wider t-tertiary">
              {fmtNum(actionsTotal)} caught
            </span>
            <button
              type="button"
              onClick={() => navigateRoute("logbook")}
              className="text-xs text-violet-400 transition-colors hover:text-violet-300"
            >
              Full log →
            </button>
          </div>
        </header>

        {/* Cross-layer protection — unerr combining memory + code graph + drift */}
        {joinParts.length > 0 ? (
          <div className="mb-4 rounded-lg border border-violet-500/30 bg-violet-500/5 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span aria-hidden="true" className="text-fuchsia-400">
                ⚡
              </span>
              <span className="font-medium text-foreground-emphasis">
                Cross-layer protection
              </span>
              <span className="t-tertiary">—</span>
              <span className="t-secondary">{joinParts.join(" · ")}</span>
            </div>
            <p className="mt-1 text-[11px] leading-snug t-tertiary">
              unerr combined what it remembers about your project, the live code
              structure, and file-change detection to catch issues that no
              single tool could spot alone.
            </p>
          </div>
        ) : null}

        {behaviorEventsQ.isLoading && topActions.length === 0 ? (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            <SkeletonBlock className="h-20 w-full" />
            <SkeletonBlock className="h-20 w-full" />
            <SkeletonBlock className="h-20 w-full" />
            <SkeletonBlock className="h-20 w-full" />
          </div>
        ) : topActions.length === 0 ? (
          <p className="t-tertiary text-sm">
            Nothing recorded yet — unerr starts tracking as soon as your agent
            calls a tool.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {topActions.map(([type, n]) => {
              const p = actionPhrasing(type);
              return (
                <ActionCard
                  key={type}
                  count={fmtNum(n)}
                  label={p.label}
                  desc={p.desc}
                  palette={mcAction(type)}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* ============================================================
       *  REASONING QUALITY — the non-token aspect: how much cleaner and
       *  more first-try-correct unerr made the agent's reasoning. Summary
       *  here; full per-session breakdown on the Reasoning Trace page.
       * ============================================================ */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <AspectPanel
          title="Reasoning Quality"
          blurb="How much cleaner and more first-try-correct unerr made the agent's reasoning"
          onMore={() => navigateRoute("reasoning")}
          lead={
            <RadialStat
              value={rq?.first_call_resolution_rate}
              label="Found first try"
              hint="answered in one lookup — no grep loops"
              accent="text-cyan-400"
            />
          }
          support={[
            {
              label: "Cleaner context",
              value: pct(rq?.noise_removed_pct),
              hint: "noise removed before the agent read it",
              accent: "text-emerald-400",
            },
            {
              label: "Fewer breakages",
              value: rq?.prevention_score ?? "—",
              hint: rq
                ? `${fmtNum(rq.blast_radius_warnings)} warns · ${fmtNum(rq.convention_injections)} hints`
                : "blast-radius + convention guards",
              accent: "text-amber-400",
            },
            {
              label: "Quality multiplier",
              value: rq
                ? `${rq.reasoning_quality_multiplier.toFixed(1)}×`
                : "—",
              hint: "overall reasoning lift",
              accent: "text-violet-300",
            },
          ]}
        />

        {/* ============================================================
         *  MEMORY — recalls & rememberances. What unerr remembered and how
         *  often those memories were surfaced and load-bearing. Summary
         *  here; full fact store on the Project Memory page.
         * ============================================================ */}
        <AspectPanel
          title="Memory · Recalls & Rememberances"
          blurb="What unerr remembered, how often it resurfaced, and whether it was load-bearing"
          onMore={() => navigateRoute("facts")}
          lead={
            <RadialStat
              value={rq?.memory_effectiveness_pct}
              label="Memory effectiveness"
              hint={
                rq
                  ? `${fmtNum(rq.memory_signals_fired)} fired · ${fmtNum(rq.memory_verdicts_total)} verdicts`
                  : "share of recalled memories that proved load-bearing"
              }
              accent="text-emerald-400"
            />
          }
          support={[
            {
              label: "Memories stored",
              value: fmtNum(fh?.total),
              hint: fh
                ? `${fmtNum(factsByType.semantic ?? 0)} patterns · ${fmtNum(factsByType.procedural ?? 0)} hot files · ${fmtNum(lessonsCount)} lessons`
                : "patterns, hot files, lessons",
              accent: "text-violet-300",
            },
            {
              label: "Recalled",
              value: fmtNum(rq?.facts_recalled),
              hint: "stored facts re-surfaced to the agent",
              accent: "text-cyan-400",
            },
            {
              label: "Avg confidence",
              value: pct((fh?.avg_confidence ?? 0) * 100),
              hint: "mean confidence across live memories",
              accent: "text-fuchsia-300",
            },
          ]}
        />

        {/* ============================================================
         *  ACTIVITY & TASKS — what's in flight: open intents (tasks in
         *  progress), unresolved blockers, total activity moments. Summary
         *  here; full timeline + heatmap on the Activity page.
         * ============================================================ */}
        <AspectPanel
          title="Activity & Tasks"
          blurb="What's in flight across sessions — open tasks, unresolved blockers, activity volume"
          onMore={() => navigateRoute("activity")}
          lead={
            <LeadFigure
              value={fmtNum(activeTasks.length)}
              label="Tasks in progress"
              hint="open intents still being worked across sessions"
              accent="text-cyan-400"
              chip="bg-cyan-500/10 ring-cyan-500/25"
            />
          }
          support={[
            {
              label: "Unresolved issues",
              value: fmtNum(openThreads.length),
              hint: "blockers without a resolution yet",
              accent:
                openThreads.length > 0 ? "text-amber-400" : "text-foreground",
            },
            {
              label: "Activity moments",
              value: fmtNum(activityMoments),
              hint: "turns unerr has observed",
              accent: "text-violet-300",
            },
          ]}
          footer={
            activeTasks.length > 0 ? (
              <ul className="mt-4 space-y-1.5 border-t border-border-subtle pt-4">
                {activeTasks.slice(0, 4).map((t) => (
                  <li
                    key={t.intent_id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span
                      className="inline-block size-1.5 shrink-0 rounded-full bg-cyan-400"
                      aria-hidden="true"
                    />
                    <span className="truncate text-foreground">{t.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] t-tertiary">
                      {timeAgo(new Date(t.last_active_at).toISOString())}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null
          }
        />

        {/* ============================================================
         *  CODE HEALTH & RISK — the state of the codebase unerr is
         *  reasoning over: health grade, test reach, risk hotspots,
         *  bottlenecks. Summary here; full map on Code Intelligence.
         * ============================================================ */}
        <AspectPanel
          title="Code Health & Risk"
          blurb="The state of the codebase unerr reasons over — grade, test reach, risk"
          onMore={() => navigateRoute("graph")}
          lead={
            <LeadFigure
              value={insights?.healthGrade ?? "—"}
              label="Health grade"
              hint={
                insights
                  ? `architecture score ${insights.healthScore}/100`
                  : "A–F architecture grade"
              }
              accent={gradeAccent(insights?.healthGrade)}
              chip={gradeChip(insights?.healthGrade)}
            />
          }
          support={[
            {
              label: "Tested reach",
              value: pct(insights?.blastRadiusCoverage),
              hint: "of blast radius covered by tests",
              accent: "text-emerald-400",
            },
            {
              label: "High-risk files",
              value: fmtNum(insights?.riskDistribution?.high),
              hint: graphStats
                ? `${fmtNum(graphStats.entityCount)} entities · ${fmtNum(graphStats.communityCount)} modules`
                : "entities flagged high-risk",
              accent:
                (insights?.riskDistribution?.high ?? 0) > 0
                  ? "text-error"
                  : "text-foreground",
            },
            {
              label: "Chokepoints",
              value: fmtNum(insights?.bottlenecks?.length),
              hint: graphStats
                ? `${fmtNum(graphStats.driftCount)} files drifted locally`
                : "high fan-in bottlenecks",
              accent: "text-amber-400",
            },
          ]}
        />
      </div>

      {/* ============================================================
       *  RECENT SESSIONS — proper table (Stripe / Datadog pattern).
       * ============================================================ */}
      <section className="glass-panel overflow-hidden rounded-xl">
        <header className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="section-label text-violet-500">Recent Sessions</h2>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs t-tertiary">
              {sessionsQ.data?._meta.total ?? "—"} total
            </span>
            <button
              type="button"
              onClick={() => navigateRoute("token-trace")}
              className="text-xs text-violet-400 transition-colors hover:text-violet-300"
            >
              All sessions →
            </button>
          </div>
        </header>

        {sessionsQ.isLoading ? (
          <div className="space-y-2 px-5 pb-4">
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="px-5 pb-5 t-tertiary text-sm">
            No sessions recorded yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-t border-border-subtle bg-surface-overlay/40 text-left">
                <th className="px-5 py-2 font-medium uppercase tracking-wider t-tertiary text-[10px]">
                  Agent
                </th>
                <th className="px-2 py-2 font-medium uppercase tracking-wider t-tertiary text-[10px]">
                  Session
                </th>
                <th className="px-2 py-2 font-medium uppercase tracking-wider t-tertiary text-[10px]">
                  When
                </th>
                <th className="px-2 py-2 text-right font-medium uppercase tracking-wider t-tertiary text-[10px]">
                  Turns
                </th>
                <th className="px-2 py-2 text-right font-medium uppercase tracking-wider t-tertiary text-[10px]">
                  Events
                </th>
                <th className="px-5 py-2 text-right font-medium uppercase tracking-wider t-tertiary text-[10px]">
                  Saved
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {sessions.map((s) => (
                <tr
                  key={s.session_id}
                  className="transition-colors hover:bg-surface-overlay/30"
                >
                  <td className="px-5 py-2.5 truncate text-foreground">
                    {s.agent_name || "Unknown Agent"}
                  </td>
                  <td className="px-2 py-2.5 font-mono text-[11px] text-violet-300">
                    {s.session_id.length > 10
                      ? `${s.session_id.slice(0, 10)}…`
                      : s.session_id}
                  </td>
                  <td className="px-2 py-2.5 t-tertiary text-xs">
                    {timeAgo(s.last_ts)}
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono tabular-nums t-secondary">
                    {s.total_turns}
                  </td>
                  <td className="px-2 py-2.5 text-right font-mono tabular-nums t-secondary">
                    {s.event_count}
                  </td>
                  <td className="px-5 py-2.5 text-right font-mono text-success tabular-nums">
                    {fmtNum(s.total_saved)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {tokenFlowQ.error && (
        <p className="text-error text-sm">
          Some requests failed. Ensure the unerr proxy is running.
        </p>
      )}
    </div>
  );
}
