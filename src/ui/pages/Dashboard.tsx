import { CardGridSkeleton, SkeletonBlock } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { navigateRoute } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

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
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function fmtNum(n: number | undefined | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Session-reach companion to the Turns Earned headline.
 *  Δreach = turns_to_limit_with − turns_to_limit_without — the per-session
 *  ceiling extension, independent of N. Honest for window-billed agents
 *  (Claude Code 5h, Copilot Pro). See `src/tracking/headroom.ts` for math.
 *
 *  Sourced from the `since_install` block — Δreach is a *rate* metric
 *  (depends on avg per-turn cost, not totals), so the lifetime average
 *  is the most stable estimate. Per-window values can swing — today's
 *  small sample with a high compression ratio can produce a larger
 *  Δreach than the lifetime average — which violates the "wider window
 *  = bigger number" intuition the user reads from Turns Earned. One
 *  stable card-level line is the honest presentation. */
function renderReachLine(block: {
  turns_to_limit_with: number;
  turns_to_limit_without: number;
}): ReactNode {
  const gain = Math.max(
    0,
    block.turns_to_limit_with - block.turns_to_limit_without
  );
  if (gain === 0) return null;
  return (
    <div
      className="px-6 pt-3 pb-1 text-sm leading-snug"
      title={`Δreach is a per-session ceiling extension — independent of which window you select. Each session can reach turn ~${fmtNum(block.turns_to_limit_with)} before context exhaustion (vs ~${fmtNum(block.turns_to_limit_without)} without unerr).`}
    >
      <span className="text-violet-300 font-mono font-semibold tabular-nums">
        ↑ +{fmtNum(gain)}
      </span>{" "}
      <span className="t-secondary">reach/session</span>{" "}
      <span className="t-tertiary text-xs">
        · each session reaches turn ~{fmtNum(block.turns_to_limit_with)} (vs ~
        {fmtNum(block.turns_to_limit_without)} without unerr) · stable across
        windows by design
      </span>
    </div>
  );
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

/**
 * Two user-facing buckets the dashboard surfaces side-by-side:
 *
 *  OPTIMIZATIONS — what unerr made smaller (savings from token-flow mechanisms).
 *  PREVENTIONS   — what unerr stopped from happening (behavioral interventions).
 *
 * Labels are deliberately plain-English (no internal class names, no
 * mechanism-jargon like "COMPRESS-class"). Each entry maps an internal
 * event key to the phrase a user would write in their own status update.
 */
const OPTIMIZATION_LABELS: Record<string, string> = {
  shell_compression: "Shell outputs compressed",
  format_encoding: "Wire format compacted",
  file_read: "File reads narrowed",
  fetch_url: "Web pages stripped to content",
  session_dedup: "Duplicate context skipped",
  smart_truncation: "Large outputs trimmed",
  graph_query: "Graph queries served",
  persistent_memory: "Facts auto-recalled",
};

/** Pretty-print an unknown mechanism key (snake_case → Sentence case). */
function prettyKey(key: string): string {
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/* Preventions: each row tells a small story — the active-voice verb of
 * what unerr did (label) followed by a counterfactual of what would have
 * happened without it (description). The user doesn't need to know the
 * internal mechanism name; they need to picture the bad outcome that
 * didn't occur. Per §7 of PERCEPTION_TO_PRESENCE.md, named-event counters
 * earn their place by carrying a description, not just a count. */
const PREVENTION_LABELS: Record<string, string> = {
  graph_query_served: "Skipped grep + file-dump combos",
  full_read_avoided: "Avoided full-file reads",
  loop_broken: "Broke retry loops",
  cascade_guard: "Caught risky cascade edits",
  drift_consumed: "Caught stale-file edits",
  intervention_halted: "Halted risky tool calls",
  intervention_warned: "Flagged risky patterns",
  defuddle_selector_skipped: "Filtered out page chrome",
};

const PREVENTION_DESCRIPTIONS: Record<string, string> = {
  graph_query_served:
    "Without it: agent runs grep + reads several files to answer one structural question.",
  full_read_avoided:
    "Without it: agent loads an entire file when only the outline was needed.",
  loop_broken:
    "Without it: agent retries the same failing operation, burning turns on a dead end.",
  cascade_guard:
    "Without it: high fan-in edits propagate blindly, breaking downstream callers.",
  drift_consumed:
    "Without it: agent edits a stale view of a file, conflicting with newer changes.",
  intervention_halted:
    "Without it: a risky tool call runs unchecked and produces bad state.",
  intervention_warned:
    "Without it: a risky pattern proceeds with no signal to the agent.",
  defuddle_selector_skipped:
    "Without it: page nav, footer, and ads get ingested as if they were content.",
};

/* Per-row hue palette — mirrors TokenFlowPage's MechanismBar so the
 * dashboard's Optimizations / Preventions panels read identically to the
 * Token Trace breakdown. Per-row color diversity lives in the bar + label
 * (data-payload color, brand chart palette tokens). The value column
 * stays text-success across both panels — emerald = "the gain", one
 * column per row, brand status-color used semantically not decoratively. */
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

const FALLBACK_PALETTE: RowPalette = {
  bar: "bg-zinc-500",
  text: "text-zinc-400",
};

function mc(key: string): RowPalette {
  return MECH_COLORS[key] ?? FALLBACK_PALETTE;
}

function mcPrev(key: string): RowPalette {
  return PREVENTION_COLORS[key] ?? FALLBACK_PALETTE;
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/*                                                                    */
/*  Patterns applied (Stripe / Linear / PostHog / Datadog):           */
/*  - KpiStripCell: borderless KPI cell, divider-separated, for       */
/*    headline-metric rows. No nested card chrome.                    */
/*  - BreakdownRow:  PostHog-style row where an accent bar fills the  */
/*    cell background behind the label/value (proportional to the     */
/*    largest sibling). Dense; reads in a glance.                     */
/* ------------------------------------------------------------------ */

function KpiStripCell({
  label,
  value,
  prefix,
  sub,
  accent,
  onClick,
}: {
  label: string;
  value: string;
  /** Optional leading glyph (e.g. "+") rendered in text-success — keeps the
   *  brand "accent on the gain only" rule while the number stays neutral. */
  prefix?: string;
  sub?: string;
  accent?: string;
  onClick?: () => void;
}) {
  const valueClass = accent ?? "text-foreground-emphasis";
  const interactive = !!onClick;
  const className = `flex flex-col gap-1 px-5 py-4 text-left border-l border-border-subtle first:border-l-0 ${
    interactive
      ? "transition-colors hover:bg-surface-overlay/50 focus-visible:bg-surface-overlay/50 focus-visible:outline-none"
      : ""
  }`;
  const inner = (
    <>
      <span className="section-label">{label}</span>
      <span
        className={`font-mono text-3xl font-semibold leading-none tabular-nums ${valueClass}`}
      >
        {prefix ? <span className="text-success">{prefix}</span> : null}
        {value}
      </span>
      {sub ? (
        <span className="t-tertiary text-[11px] leading-snug">{sub}</span>
      ) : null}
    </>
  );
  if (interactive) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {inner}
      </button>
    );
  }
  return <div className={className}>{inner}</div>;
}

/** Horizontal row — Token-Trace MechanismBar pattern verbatim:
 *  label (left, fixed) · track-with-fill (center, flex-1) · values (right, fixed).
 *  Per-row hue comes from `palette` (data-payload color, brand chart tokens).
 *  Primary value is always text-success — emerald = "the gain", one column
 *  per row, brand status-color used semantically (not as panel decoration). */
function BreakdownRow({
  label,
  value,
  valueSecondary,
  pct,
  palette,
}: {
  label: string;
  value: string;
  valueSecondary?: string;
  pct: number;
  palette: RowPalette;
}) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span
        className={`w-48 shrink-0 truncate text-xs font-medium ${palette.text}`}
      >
        {label}
      </span>
      <div className="el-overlay relative h-5 flex-1 overflow-hidden rounded">
        <div
          className={`h-full rounded ${palette.bar} opacity-80`}
          style={{ width: `${Math.max(Math.min(pct, 100), 3)}%` }}
        />
      </div>
      <span className="w-20 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-success">
        {value}
      </span>
      {valueSecondary !== undefined ? (
        <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums t-tertiary">
          {valueSecondary}
        </span>
      ) : null}
    </div>
  );
}

/** Prevention card — incident-receipt layout (no bar chart).
 *  Per-mechanism colored left stripe acts as a category tab; large
 *  per-mechanism colored count anchors the eye; label + counterfactual
 *  carry the story. Stacks vertically on mobile, two-up on md+ screens.
 *  Designed for relative-magnitude indifference: every prevention matters
 *  on its own, not in comparison to siblings. */
function PreventionCard({
  label,
  description,
  count,
  palette,
}: {
  label: string;
  description: string;
  count: string;
  palette: RowPalette;
}) {
  return (
    <div className="glass-card relative overflow-hidden rounded-lg p-4 pl-5">
      <div
        aria-hidden
        className={`absolute inset-y-0 left-0 w-1 ${palette.bar} opacity-80`}
      />
      <div className="flex items-baseline gap-3">
        <span
          className={`font-mono text-2xl font-bold leading-none tabular-nums ${palette.text}`}
        >
          {count}
        </span>
        <span className="text-sm font-medium text-foreground-emphasis">
          {label}
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-snug t-tertiary">{description}</p>
    </div>
  );
}

/** Column-header row above BreakdownRow rows. Widths align with the row's
 *  value columns (label w-48, track flex-1, primary w-20, secondary w-24). */
function BreakdownHeader({
  primary,
  secondary,
}: {
  primary: string;
  secondary?: string;
}) {
  return (
    <div className="flex items-baseline gap-3 pb-1.5 text-[10px] font-medium uppercase tracking-wider t-tertiary">
      <span className="w-48 shrink-0">&nbsp;</span>
      <span className="flex-1" />
      <span className="w-20 shrink-0 text-right">{primary}</span>
      {secondary !== undefined ? (
        <span className="w-24 shrink-0 text-right">{secondary}</span>
      ) : null}
    </div>
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

  const tf = tokenFlowQ.data?.data;
  const sessions = sessionsQ.data?.data ?? [];
  const headroom = headroomQ.data?.data;
  const headroomLoading = headroomQ.isLoading && headroom === undefined;

  const compoundMultiplier =
    tf && tf.total_tokens_saved > 0
      ? (tf.total_context_avoided / tf.total_tokens_saved).toFixed(1)
      : null;

  /* Optimizations — attributed portions of the lifetime "turns earned"
   * headline. Per §10.1 the formula `turns_earned = Σs / δ̄_eff` is linear
   * in tokens_saved, so each mechanism's share of total turns earned =
   * (mech.tokens_saved / total.tokens_saved) × total.turns_earned.
   * One number per row, same unit as the headline. */
  const totalSavedTokens = tf?.total_tokens_saved ?? 0;
  const totalTurnsEarned = headroom?.since_install.headroom_turns ?? 0;
  const optimizations = tf
    ? Object.entries(tf.by_mechanism)
        .filter(([, v]) => v.tokens_saved > 0)
        .sort((a, b) => b[1].tokens_saved - a[1].tokens_saved)
        .map(([key, v]) => {
          const turns =
            totalSavedTokens > 0
              ? (v.tokens_saved / totalSavedTokens) * totalTurnsEarned
              : 0;
          return { key, turns, tokensSaved: v.tokens_saved };
        })
    : [];
  const maxOptTurns =
    optimizations.length > 0 ? optimizations[0].turns || 1 : 1;

  /* Preventions — behavioral interventions, count-only (no counterfactual
   * token estimate is honest here per §10 — the count IS the measure). */
  const preventionsRaw = behaviorEventsQ.data?.data.counts.by_type ?? {};
  const preventions = Object.entries(preventionsRaw)
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a);

  const heroLoading = tokenFlowQ.isLoading && tf === undefined;

  // Step 2 of the honest-headroom migration: the headroom number divides
  // saved tokens by an unobserved-overhead-clamped per-turn cost (see
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
       *  CARD 1 — Turns Earned (the flagship "+N turns" metric).
       *  Three windows side-by-side. This is the unit RTK and other
       *  compression-only tools cannot produce.
       * ============================================================ */}
      <section className="glass-panel overflow-hidden rounded-xl">
        <header className="flex items-end justify-between gap-4 px-6 pt-5">
          <div>
            <h2 className="section-label text-violet-500">Turns Earned</h2>
            <p className="mt-0.5 t-tertiary text-[11px] leading-snug">
              Extra turns of session headroom unerr produced — the unit
              compression-only tools can't measure.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigateRoute("token-trace")}
            className="shrink-0 text-xs text-violet-400 transition-colors hover:text-violet-300"
          >
            Breakdown →
          </button>
        </header>

        {headroomLoading ? (
          <div className="px-6 py-5">
            <CardGridSkeleton n={3} />
          </div>
        ) : headroom && headroomImplausible ? (
          <div className="px-6 py-5">
            <p className="t-secondary text-sm leading-snug">
              Headroom is still calibrating — the ratio between saved tokens and
              the slice of per-turn cost unerr can measure looks larger than
              your actual usage. Run a few more sessions and the number will
              stabilise.
            </p>
            <p className="mt-2 t-tertiary text-xs leading-snug">
              In the meantime, the named-event counters on{" "}
              <button
                type="button"
                onClick={() => navigateRoute("logbook")}
                className="text-violet-300 underline decoration-dotted hover:text-violet-200"
              >
                Logbook
              </button>{" "}
              are the honest headline — each one is a countable event you can
              check against your own session memory.
            </p>
          </div>
        ) : headroom ? (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3">
            <KpiStripCell
              label="Today"
              value={`+${fmtNum(headroom.today.headroom_turns)}`}
              sub={`over ${headroom.today.turns_observed} turns observed`}
              accent="text-success"
              onClick={() => navigateRoute("token-trace", { window: "today" })}
            />
            <KpiStripCell
              label="This Week"
              value={`+${fmtNum(headroom.this_week.headroom_turns)}`}
              sub={`over ${headroom.this_week.turns_observed} turns observed`}
              accent="text-success"
              onClick={() =>
                navigateRoute("token-trace", { window: "this_week" })
              }
            />
            <KpiStripCell
              label="Since Install"
              value={`+${fmtNum(headroom.since_install.headroom_turns)}`}
              sub={`over ${headroom.since_install.turns_observed} turns observed`}
              accent="text-success"
              onClick={() =>
                navigateRoute("token-trace", {
                  window: "since_install",
                })
              }
            />
          </div>
        ) : (
          <p className="px-6 py-5 t-tertiary text-sm">
            No turns earned yet — start a session and unerr will begin tracking.
          </p>
        )}
        {headroom && !headroomImplausible
          ? renderReachLine(headroom.since_install)
          : null}
        {headroom && !headroomImplausible ? (
          <p className="px-6 pb-4 pt-1 t-tertiary text-[10px] leading-snug max-w-3xl">
            <span className="text-emerald-300/80">Turns Earned</span> is
            usage-cumulative (changes per window) — applies to credit-billed
            agents (Cursor fast-requests, API spend) where each unit is an extra
            prompt you didn't pay for.{" "}
            <span className="text-violet-300/80">Reach/session</span> is a
            per-session ceiling derived from your install-lifetime average —
            stable across windows by design — and applies to window-billed
            agents (Claude Code 5-hour windows, Copilot Pro caps) where each
            unit is one more turn of context room before a session exhausts the
            context limit. One of the two holds for your agent's billing model.
          </p>
        ) : null}
      </section>

      {/* ============================================================
       *  PREVENTIONS — what unerr stopped from happening. Positioned
       *  here (right after the gain headline) so the user reads the
       *  "+turns earned" KPI and immediately sees the bad outcomes
       *  that didn't happen — the qualitative receipts. Each row
       *  pairs an active-voice verb (what unerr did) with a
       *  counterfactual subtitle (what would have happened).
       * ============================================================ */}
      <section className="glass-panel rounded-xl p-5">
        <header className="mb-4 flex items-baseline justify-between gap-3">
          <div>
            <h2 className="section-label text-violet-500">Preventions</h2>
            <p className="mt-0.5 t-tertiary text-[11px] leading-snug">
              Bad outcomes unerr stopped before they could happen
            </p>
          </div>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider t-tertiary">
            Since install
          </span>
        </header>
        {behaviorEventsQ.isLoading && preventions.length === 0 ? (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <SkeletonBlock className="h-24 w-full" />
            <SkeletonBlock className="h-24 w-full" />
            <SkeletonBlock className="h-24 w-full" />
            <SkeletonBlock className="h-24 w-full" />
          </div>
        ) : preventions.length === 0 ? (
          <p className="t-tertiary text-sm">No preventions recorded yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {preventions.map(([type, n]) => (
              <PreventionCard
                key={type}
                label={PREVENTION_LABELS[type] ?? prettyKey(type)}
                description={
                  PREVENTION_DESCRIPTIONS[type] ??
                  "An intervention that the agent did not need to retry or undo."
                }
                count={`${fmtNum(n)}×`}
                palette={mcPrev(type)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ============================================================
       *  CARD 2 — Tokens Saved (the underlying byte-level math).
       *  Reframed from "Token Reduction" → "Tokens Saved": the user
       *  reads this as bytes unerr rescued from the agent's context,
       *  not as a generic improvement metric. Protective framing
       *  (saved / kept out / rescued) over optimization framing
       *  (reduced / smaller / improved).
       * ============================================================ */}
      {tf ? (
        <section className="glass-panel overflow-hidden rounded-xl">
          <header className="flex items-end justify-between gap-4 px-6 pt-5">
            <div>
              <h2 className="section-label text-violet-500">Tokens Saved</h2>
              <p className="mt-0.5 t-tertiary text-[11px] leading-snug">
                Bytes unerr kept out of the agent's context before they could
                weigh it down — counted on operations unerr handled (file reads,
                web fetches, shell output, dedup). Not whole-turn savings.
              </p>
            </div>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider t-tertiary">
              Since install
            </span>
          </header>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4">
            <KpiStripCell
              label="Tokens saved"
              value={fmtNum(tf.total_tokens_saved)}
              sub="raw bytes kept out of agent context"
              accent="text-success"
            />
            <KpiStripCell
              label="Context avoided"
              value={fmtNum(tf.total_context_avoided)}
              sub="work the agent never had to do"
              accent="text-cyan-400"
            />
            <KpiStripCell
              label="Rescue rate"
              value={`${tf.efficiency_pct.toFixed(1)}%`}
              sub="share of would-be context kept out"
              accent="text-violet-400"
            />
            <KpiStripCell
              label="Compounding"
              value={compoundMultiplier ? `${compoundMultiplier}×` : "—"}
              sub="context avoided per token saved"
              accent="text-fuchsia-400"
            />
          </div>
        </section>
      ) : null}

      {/* ============================================================
       *  RECEIPTS — Per-mechanism breakdown of WHERE the tokens were
       *  saved. Companion to Card 2's aggregate "Tokens Saved" headline.
       *  Each row uses Token Trace's horizontal MechanismBar pattern:
       *  label · track · values. Section headings use brand violet for
       *  consistency with Turns Earned / Tokens Saved / Recent Sessions
       *  above.
       * ============================================================ */}
      <section className="glass-panel rounded-xl p-5">
        <header className="mb-4 flex items-baseline justify-between gap-3">
          <div>
            <h2 className="section-label text-violet-500">Savings Breakdown</h2>
            <p className="mt-0.5 t-tertiary text-[11px] leading-snug">
              Where the rescued tokens came from
            </p>
          </div>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider t-tertiary">
            Since install
          </span>
        </header>
        {heroLoading ? (
          <div className="space-y-2">
            <SkeletonBlock className="h-7 w-full" />
            <SkeletonBlock className="h-7 w-full" />
            <SkeletonBlock className="h-7 w-full" />
          </div>
        ) : optimizations.length === 0 ? (
          <p className="t-tertiary text-sm">No tokens saved yet.</p>
        ) : (
          <div>
            <BreakdownHeader primary="Turns earned" secondary="Tokens saved" />
            <div className="space-y-0.5">
              {optimizations.map(({ key, turns, tokensSaved }) => (
                <BreakdownRow
                  key={key}
                  label={OPTIMIZATION_LABELS[key] ?? prettyKey(key)}
                  value={`+${fmtNum(Math.round(turns))}`}
                  valueSecondary={fmtNum(tokensSaved)}
                  pct={(turns / maxOptTurns) * 100}
                  palette={mc(key)}
                />
              ))}
            </div>
          </div>
        )}
      </section>

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
