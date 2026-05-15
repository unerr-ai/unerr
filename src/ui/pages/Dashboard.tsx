import { CardGridSkeleton, SkeletonBlock } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { navigateRoute } from "@/lib/router";
import type { LiveFeedItem } from "@/lib/sse";
import type {
  GraphStatsResponse,
  SessionStatsPayload,
  SystemStatusEnvelope,
} from "@/lib/types";
import { useQuery } from "@tanstack/react-query";

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
    by_mechanism: Record<string, { count: number; tokens_saved: number }>;
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

function formatPayload(data: unknown): string {
  try {
    const s = JSON.stringify(data);
    return s.length > 320 ? `${s.slice(0, 317)}…` : s;
  } catch {
    return String(data);
  }
}

const MECHANISM_LABELS: Record<string, string> = {
  graph_query: "Graph Query",
  shell_compression: "Shell Compression",
  format_encoding: "Format Encoding",
  file_read: "File Read",
  session_dedup: "Session Dedup",
  smart_truncation: "Smart Truncation",
  behavior_automation: "Behavior Automation",
};

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function HeroKpi({
  label,
  value,
  sub,
  color = "text-live",
  large,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  large?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="section-label">{label}</span>
      <span
        className={`mt-1 font-mono font-semibold tabular-nums ${color} ${large ? "text-3xl" : "text-2xl"}`}
      >
        {value}
      </span>
      {sub ? <span className="mt-0.5 t-tertiary text-xs">{sub}</span> : null}
    </div>
  );
}

function MechanismBar({
  label,
  tokens,
  maxTokens,
}: {
  label: string;
  tokens: number;
  maxTokens: number;
}) {
  const pct = maxTokens > 0 ? (tokens / maxTokens) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 truncate text-xs t-secondary">
        {label}
      </span>
      <div className="relative h-2 flex-1 rounded-full bg-surface-overlay">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-violet-500/80"
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-xs text-foreground">
        {fmtNum(tokens)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Dashboard                                                         */
/* ------------------------------------------------------------------ */

export function Dashboard({
  sseConnected,
  liveFeed,
  sessionSnapshot,
}: {
  sseConnected: boolean;
  liveFeed: LiveFeedItem[] | undefined;
  sessionSnapshot: SessionStatsPayload | undefined;
}) {
  const { url, queryKey } = useRepoApi();

  /* --- data --- */
  const tokenFlowQ = useQuery({
    queryKey: queryKey(["token-flow", "global"]),
    queryFn: () =>
      fetchJson<TokenFlowGlobalResponse>(url("/api/token-flow/global")),
  });

  const sessionsQ = useQuery({
    queryKey: queryKey(["token-flow", "sessions-recent"]),
    queryFn: () =>
      fetchJson<TokenFlowSessionsResponse>(
        url("/api/token-flow/sessions?limit=5&offset=0")
      ),
  });

  const graphQ = useQuery({
    queryKey: queryKey(["intelligence", "graph-stats"]),
    queryFn: () =>
      fetchJson<GraphStatsResponse>(url("/api/intelligence/graph-stats")),
  });

  const systemQ = useQuery({
    queryKey: queryKey(["system", "status"]),
    queryFn: () => fetchJson<SystemStatusEnvelope>(url("/api/system/status")),
  });

  const factsHealthQ = useQuery({
    queryKey: queryKey(["facts", "health"]),
    queryFn: () =>
      fetchJson<{
        data: {
          total_facts: number;
          by_type: Record<string, number>;
        };
      }>(url("/api/facts/health")),
    staleTime: 30_000,
  });

  const tf = tokenFlowQ.data?.data;
  const graph = graphQ.data?.data;
  const sys = systemQ.data?.data;
  const sessions = sessionsQ.data?.data ?? [];
  const factsHealth = factsHealthQ.data?.data;

  const compoundMultiplier =
    tf && tf.total_tokens_saved > 0
      ? (tf.total_context_avoided / tf.total_tokens_saved).toFixed(1)
      : null;

  /* mechanism breakdown sorted by tokens saved */
  const mechanisms = tf
    ? Object.entries(tf.by_mechanism)
        .filter(([, v]) => v.tokens_saved > 0)
        .sort((a, b) => b[1].tokens_saved - a[1].tokens_saved)
    : [];
  const maxMechTokens =
    mechanisms.length > 0 ? mechanisms[0][1].tokens_saved : 1;

  const heroLoading = tokenFlowQ.isLoading && tf === undefined;

  /* live tool calls from SSE snapshot or REST fallback */
  const toolCalls = sessionSnapshot?.tool_calls ?? sys?.session.tool_calls;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* ========== HERO: Token Optimization ========== */}
      {heroLoading ? (
        <CardGridSkeleton n={4} />
      ) : (
        <section className="glass-panel rounded-xl p-6">
          <div className="flex items-center justify-between">
            <h2 className="section-label text-violet-500">
              Token Optimization
            </h2>
            <button
              type="button"
              onClick={() => navigateRoute("token-trace")}
              className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
            >
              View details →
            </button>
          </div>

          {tf ? (
            <>
              <div className="mt-5 grid grid-cols-2 gap-6 sm:grid-cols-4">
                <HeroKpi
                  label="Tokens Saved"
                  value={fmtNum(tf.total_tokens_saved)}
                  sub={`of ${fmtNum(tf.total_tokens_without)} original`}
                  large
                />
                <HeroKpi
                  label="Context Avoided"
                  value={fmtNum(tf.total_context_avoided)}
                  sub="compounding savings"
                  color="text-cyan-400"
                  large
                />
                <HeroKpi
                  label="Efficiency"
                  value={`${tf.efficiency_pct.toFixed(1)}%`}
                  sub={`${fmtNum(tf.total_tokens_with)} delivered`}
                  color="text-success"
                />
                <HeroKpi
                  label="Compound Multiplier"
                  value={compoundMultiplier ? `${compoundMultiplier}×` : "—"}
                  sub="context avoided ÷ saved"
                  color="text-amber-400"
                />
              </div>

              {/* Mechanism breakdown */}
              {mechanisms.length > 0 ? (
                <div className="mt-6 space-y-2">
                  <span className="t-tertiary text-xs font-medium uppercase tracking-wider">
                    Savings by mechanism
                  </span>
                  <div className="mt-2 space-y-1.5">
                    {mechanisms.map(([key, val]) => (
                      <MechanismBar
                        key={key}
                        label={MECHANISM_LABELS[key] ?? key}
                        tokens={val.tokens_saved}
                        maxTokens={maxMechTokens}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className="mt-4 t-tertiary text-sm">
              No token flow data yet. Use MCP tools to start tracking.
            </p>
          )}
        </section>
      )}

      {/* ========== ROW 2: Recent Sessions + Graph Health ========== */}
      <section className="grid gap-4 lg:grid-cols-5">
        {/* Recent sessions — 3/5 width */}
        <div className="glass-panel rounded-xl p-5 lg:col-span-3">
          <div className="flex items-center justify-between">
            <h2 className="section-label text-violet-500">Recent Sessions</h2>
            <span className="font-mono text-xs t-tertiary">
              {sessionsQ.data?._meta.total ?? "—"} total
            </span>
          </div>

          {sessionsQ.isLoading ? (
            <div className="mt-4 space-y-3">
              <SkeletonBlock className="h-10 w-full" />
              <SkeletonBlock className="h-10 w-full" />
              <SkeletonBlock className="h-10 w-full" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="mt-4 t-tertiary text-sm">No sessions recorded yet.</p>
          ) : (
            <div className="mt-3 divide-y divide-border-subtle">
              {sessions.map((s) => (
                <div
                  key={s.session_id}
                  className="flex items-center gap-4 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {s.agent_name || "Unknown Agent"}
                      </span>
                      <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-400 ring-1 ring-violet-500/20">
                        {s.session_id.length > 8
                          ? `${s.session_id.slice(0, 8)}…`
                          : s.session_id}
                      </span>
                      <span className="shrink-0 t-tertiary text-xs">
                        {timeAgo(s.last_ts)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex gap-3 text-xs t-secondary">
                      <span>{s.total_turns} turns</span>
                      <span>{s.event_count} events</span>
                      <span>
                        {s.mechanisms
                          .slice(0, 3)
                          .map((m) => MECHANISM_LABELS[m] ?? m)
                          .join(", ")}
                      </span>
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-sm text-live tabular-nums">
                    {fmtNum(s.total_saved)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Graph health — 2/5 width */}
        <div className="glass-panel rounded-xl p-5 lg:col-span-2">
          <h2 className="section-label text-violet-500">Code Graph</h2>
          {graphQ.isLoading ? (
            <div className="mt-4 space-y-3">
              <SkeletonBlock className="h-4 w-full" />
              <SkeletonBlock className="h-4 w-3/4" />
              <SkeletonBlock className="h-4 w-1/2" />
            </div>
          ) : (
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="t-secondary">Indexed files</dt>
                <dd className="font-mono text-xs text-foreground">
                  {graph?.fileCount ?? sys?.graph.entities ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="t-secondary">Entities</dt>
                <dd className="font-mono text-xs text-foreground">
                  {graph?.entityCount ?? sys?.graph.entities ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="t-secondary">Edges</dt>
                <dd className="font-mono text-xs text-foreground">
                  {graph?.edgeCount ?? sys?.graph.edges ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="t-secondary">Rules</dt>
                <dd className="font-mono text-xs text-foreground">
                  {graph?.ruleCount ?? sys?.graph.rules ?? "—"}
                </dd>
              </div>
              {graph?.driftCount ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-warning">Drift entries</dt>
                  <dd className="font-mono text-xs text-warning">
                    {graph.driftCount}
                  </dd>
                </div>
              ) : null}
            </dl>
          )}
        </div>
      </section>

      {/* ========== ROW 2.5: Project Intelligence ========== */}
      <section className="glass-panel rounded-xl p-5">
        <div className="flex items-center justify-between">
          <h2 className="section-label text-violet-500">
            Project Intelligence
          </h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => navigateRoute("facts")}
              className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
            >
              View Memory →
            </button>
            <button
              type="button"
              onClick={() => navigateRoute("activity")}
              className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              View Activity →
            </button>
            <button
              type="button"
              onClick={() => navigateRoute("graph")}
              className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              Code Intelligence →
            </button>
          </div>
        </div>

        {factsHealthQ.isLoading ? (
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <SkeletonBlock className="h-14 w-full" />
            <SkeletonBlock className="h-14 w-full" />
            <SkeletonBlock className="h-14 w-full" />
            <SkeletonBlock className="h-14 w-full" />
          </div>
        ) : factsHealth ? (
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <div className="t-tertiary text-xs">Total Facts</div>
              <div className="mt-1 text-lg font-mono text-foreground">
                {factsHealth.total_facts}
              </div>
            </div>
            <div>
              <div className="t-tertiary text-xs">Conventions</div>
              <div className="mt-1 text-lg font-mono text-emerald-400">
                {factsHealth.by_type?.convention ?? 0}
              </div>
            </div>
            <div>
              <div className="t-tertiary text-xs">Session History</div>
              <div className="mt-1 text-lg font-mono text-cyan-400">
                {factsHealth.by_type?.episodic ?? 0}
              </div>
            </div>
            <div>
              <div className="t-tertiary text-xs">Semantic</div>
              <div className="mt-1 text-lg font-mono text-amber-400">
                {factsHealth.by_type?.semantic ?? 0}
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-4 t-tertiary text-sm">
            No intelligence data yet. Facts are auto-detected from coding
            sessions.
          </p>
        )}
      </section>

      {/* ========== ROW 3: System Status + Live Activity ========== */}
      <section className="grid gap-4 lg:grid-cols-5">
        {/* System status — 2/5 */}
        <div className="glass-panel rounded-xl p-5 lg:col-span-2">
          <h2 className="section-label text-violet-500">System</h2>
          {systemQ.isLoading ? (
            <div className="mt-4 space-y-3">
              <SkeletonBlock className="h-4 w-full" />
              <SkeletonBlock className="h-4 w-3/4" />
            </div>
          ) : systemQ.error ? (
            <p className="mt-3 text-error text-sm">
              Could not load system status
            </p>
          ) : (
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="t-secondary">Status</dt>
                <dd className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-1.5 w-1.5 rounded-full ${sseConnected ? "bg-success" : "bg-warning animate-pulse"}`}
                  />
                  <span className="font-mono text-xs text-foreground">
                    {sseConnected ? "Connected" : "Reconnecting"}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="t-secondary">Tool calls</dt>
                <dd className="font-mono text-xs text-foreground">
                  {toolCalls ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="t-secondary">IDE</dt>
                <dd className="truncate font-mono text-xs text-foreground max-w-[10rem]">
                  {sys?.ide ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="t-secondary">Working dir</dt>
                <dd
                  className="truncate font-mono text-xs text-foreground max-w-[10rem]"
                  title={sys?.cwd}
                >
                  {sys?.cwd ?? "—"}
                </dd>
              </div>
              {sys?.uptime_s != null ? (
                <div className="flex justify-between gap-4">
                  <dt className="t-secondary">Uptime</dt>
                  <dd className="font-mono text-xs text-foreground">
                    {sys.uptime_s >= 3600
                      ? `${(sys.uptime_s / 3600).toFixed(1)}h`
                      : `${Math.floor(sys.uptime_s / 60)}m`}
                  </dd>
                </div>
              ) : null}
            </dl>
          )}
        </div>

        {/* Live feed — 3/5 */}
        <div className="glass-panel overflow-hidden rounded-xl lg:col-span-3">
          <div className="border-b border-border-subtle px-5 py-3">
            <h2 className="section-label text-violet-500">Live Feed</h2>
            <p className="mt-0.5 t-tertiary text-xs">
              tool_call · drift · violation · session_stats
            </p>
          </div>
          <div className="custom-scrollbar max-h-[20rem] overflow-auto font-mono text-xs leading-relaxed">
            {(liveFeed?.length ?? 0) === 0 ? (
              <div className="px-5 py-6 t-tertiary">Waiting for events…</div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {liveFeed?.map((row, i) => (
                  <li key={`${row.t}-${i}`} className="px-5 py-2">
                    <span className="t-tertiary">
                      {new Date(row.t).toLocaleTimeString()}
                    </span>{" "}
                    <span className="text-violet-500 font-medium">
                      {row.type}
                    </span>
                    <pre className="mt-0.5 whitespace-pre-wrap break-words t-secondary">
                      {formatPayload(row.data)}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {(tokenFlowQ.error || graphQ.error) && (
        <p className="text-error text-sm">
          Some requests failed. Ensure the unerr proxy is running.
        </p>
      )}
    </div>
  );
}
