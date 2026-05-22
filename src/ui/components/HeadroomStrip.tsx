/**
 * HeadroomStrip — top-of-page metric row used by Token Trace and
 * Reasoning Trace. Leads with `+N turns earned` (compounded headroom),
 * followed by context-avoided + avg-turn cost. Identical math to the
 * Dashboard hero cards (computeCompoundedHeadroom on the server).
 *
 * The window chips (Today / This week / Since install) only render when
 * `sessionId` is undefined — in session view the strip shows that
 * session's headroom_compounded directly.
 */

import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { useQuery } from "@tanstack/react-query";

export type HeadroomWindow = "today" | "this_week" | "since_install";

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

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function HeadroomStrip({
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

  const turnsEarned = sessionBlock
    ? `+${fmt(sessionBlock.headroom_compounded)}`
    : block
      ? `+${fmt(block.headroom_turns)}`
      : "—";
  const turnsOver = sessionBlock
    ? `${sessionBlock.turn_count} turn${sessionBlock.turn_count === 1 ? "" : "s"}`
    : block
      ? `${block.turns_observed} turn${block.turns_observed === 1 ? "" : "s"}`
      : "no turns";
  const tokensSaved = block ? fmt(block.total_tokens_saved) : "—";
  const avgTurnWithout = block ? fmt(block.avg_turn_tokens_without) : "—";
  const avgTurnWith = block
    ? fmt(Math.max(0, block.avg_turn_tokens_without - block.avg_saved_per_turn))
    : "—";

  // ── Session Reach — the second honest headline (window-billed agents) ──
  // Δreach = turns_to_limit_with − turns_to_limit_without. Independent of
  // N; it's the per-session ceiling extension. Maps to Claude Code's 5h
  // window, Copilot Pro caps, etc., where extra credits cannot be earned
  // but each session can stretch further before context exhaustion.
  //
  // Δreach is a *rate* metric — it depends on avg per-turn cost, not on
  // totals — so per-window values can swing (a small high-r sample today
  // can dwarf the lifetime average). For the global strip we therefore
  // source reach from `since_install` regardless of which window chip is
  // selected. Result: the chips drive Turns Earned (usage-cumulative),
  // and Reach/session stays stable as a per-session ceiling. In session
  // view we use that specific session's own reach numbers (correct, it's
  // already per-session and not a window-averaged rate).
  const reachSource = sessionBlock ?? blocks?.since_install;
  const reachWith = reachSource?.turns_to_limit_with ?? 0;
  const reachWithout = reachSource?.turns_to_limit_without ?? 0;
  const reachGain = Math.max(0, reachWith - reachWithout);
  const reachDisplay = reachSource ? `+${fmt(reachGain)}` : "—";
  const reachTooltip = reachSource
    ? sessionBlock
      ? `This session can reach turn ~${fmt(reachWith)} before context exhaustion (vs ~${fmt(reachWithout)} without unerr).`
      : `Per-session ceiling, derived from your install-lifetime average and stable across windows by design. Each session can reach turn ~${fmt(reachWith)} before context exhaustion (vs ~${fmt(reachWithout)} without unerr).`
    : "Per-session ceiling extension — appears once unerr starts compressing turns.";

  return (
    <section className="el-raised rounded-md py-2 px-4 mb-4 border-l-2 border-emerald-500/60">
      <div className="flex items-center justify-between gap-4 flex-wrap text-sm">
        <div className="flex items-center gap-x-5 gap-y-1 flex-wrap leading-tight">
          <span
            className="inline-flex items-baseline gap-1.5"
            title="Σs / δ̄_eff — extra prompts you didn't pay for. Honest for credit-billed agents (Cursor fast-requests, API metered spend)."
          >
            <span className="text-emerald-300 font-mono font-bold tabular-nums">
              {turnsEarned}
            </span>
            <span className="t-secondary text-xs">
              turns earned{sessionId ? " (session)" : ""}
            </span>
            <span className="t-tertiary text-xs">· over {turnsOver}</span>
          </span>
          <span
            className="inline-flex items-baseline gap-1.5"
            title={reachTooltip}
          >
            <span className="text-violet-300 font-mono font-bold tabular-nums">
              {reachDisplay}
            </span>
            <span className="t-secondary text-xs">reach/session</span>
            <span className="t-tertiary text-xs">
              · up to turn {fmt(reachWith)}
            </span>
          </span>
          <span
            className="inline-flex items-baseline gap-1.5"
            title="Counts tokens unerr removed from the operations it touched (file reads, web fetches, shell output, dedup). Does not include system prompt, tool schemas, conversation history, reasoning, or native Read/Edit calls."
          >
            <span className="text-cyan-400 font-mono font-bold tabular-nums">
              {tokensSaved}
            </span>
            <span className="t-secondary text-xs">tokens saved</span>
            <span className="t-tertiary text-xs">
              · on operations unerr handled
            </span>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-foreground font-mono font-semibold tabular-nums">
              {avgTurnWithout}
            </span>
            <span className="t-secondary text-xs">
              avg turn{" "}
              <span className="t-tertiary">(vs {avgTurnWith} with unerr)</span>
            </span>
          </span>
        </div>

        {!sessionId && (
          <div className="flex items-center gap-1">
            {(["today", "this_week", "since_install"] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => onWindowChange(w)}
                className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                  windowSelected === w
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-surface-secondary t-secondary hover:bg-surface-tertiary"
                }`}
              >
                {w === "today"
                  ? "Today"
                  : w === "this_week"
                    ? "This Week"
                    : "Since Install"}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="t-tertiary text-[10px] leading-snug mt-1.5 max-w-3xl">
        <span className="text-emerald-300/80">Turns earned</span> is
        usage-cumulative (changes with the window chip above) and applies to
        credit-billed agents (Cursor fast-requests, API spend) — extra prompts
        you didn't pay for.{" "}
        <span className="text-violet-300/80">Reach/session</span> is a
        per-session ceiling derived from the lifetime average — stable across
        windows by design — and applies to window-billed agents (Claude Code
        5-hour windows, Copilot Pro caps) — extra turns of context room before a
        single session exhausts the context limit. One of the two holds for your
        agent's billing model.
      </p>
    </section>
  );
}

export function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border-subtle mb-4">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onSelect(t.id)}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            active === t.id
              ? "border-violet-400 text-violet-300"
              : "border-transparent t-secondary hover:text-foreground"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
