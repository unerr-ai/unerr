/**
 * MCP Router — the single intelligent endpoint in front of every MCP tool
 * in the agent's space. This page answers one question at a glance: "what is
 * the router doing for me?"
 *
 * It is built server-first. Today the bus carries one server (`unerr`), but
 * every record already carries a `server` field, so the per-server view
 * populates automatically as `unerr enable mcp-router` consolidates the
 * agent's other MCP servers behind this endpoint.
 *
 * All figures are real telemetry read from .unerr/router/metrics.jsonl
 * (current session) plus the rotated daily archives — surfaced via
 * /api/router/{status,sessions,recent}.
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

// ── Wire types (match src/server/routes/router.ts) ──────────────────

interface ProxiedServer {
  name: string;
  alias: string;
  sourceAgent: string;
}

interface StatusResponse {
  data: {
    enabled: boolean;
    enabledAt?: string;
    proxiedServers: ProxiedServer[];
    session: {
      totalCalls: number;
      totalTokensSaved: number;
      totalTokensIn: number;
      softRefuseCount: number;
      unlockCount: number;
      efficiency: number; // already a percentage (0–100)
    } | null;
  };
}

interface SessionSummary {
  sessionId: string;
  totalCalls: number;
  totalTokensSaved: number;
  totalTokensIn: number;
  softRefuseCount: number;
  unlockCount: number;
  efficiency: number;
  firstCallTs: string;
  lastCallTs: string;
  topTools: { name: string; count: number }[];
  outcomeBreakdown: {
    executed: number;
    softRefused: number;
    passthroughDegraded: number;
    childError: number;
  };
  avgLatencyMs: number;
}

interface SessionsResponse {
  data: { sessions: SessionSummary[] };
}

interface RecentRecord {
  toolName: string;
  originalToolName?: string;
  server?: string;
  outcome: string;
  wasMasked?: boolean;
  tokensIn: number;
  tokensSaved: number;
  latencyMs: { total: number };
  unlocks?: string[];
  ts: string;
}

interface RecentResponse {
  data: { records: RecentRecord[] };
}

// ── Formatting ──────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  let abs = Math.abs(n);
  if (abs < 1_000) return `${sign}${Math.round(abs).toLocaleString()}`;
  // Scale through K / M / B / T, rolling over at 1,000 so 999,999 reads
  // "1M" not "1000.0K". Works for 0 → trillions.
  const units = ["K", "M", "B", "T"] as const;
  let u = -1;
  do {
    abs /= 1_000;
    u++;
  } while (abs >= 999.95 && u < units.length - 1);
  return `${sign}${abs.toFixed(1).replace(/\.0$/, "")}${units[u]}`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Count-up so the hero figures land with a little life on first paint. */
function useCountUp(target: number, durationMs = 850): number {
  const [v, setV] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      setV(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return v;
}

function CountUp({ value }: { value: number }) {
  const v = useCountUp(value);
  return <>{fmtNum(v)}</>;
}

// ── Shared bits ─────────────────────────────────────────────────────

function SupportFigure({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: number;
  accent: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="section-label">{label}</span>
      <span
        className={`font-mono text-2xl font-semibold tabular-nums ${accent}`}
      >
        <CountUp value={value} />
      </span>
      {hint ? <span className="t-tertiary text-xs">{hint}</span> : null}
    </div>
  );
}

function MeterBar({
  segments,
}: {
  segments: { value: number; cls: string; label: string }[];
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-overlay">
      {segments.map((seg) =>
        seg.value > 0 ? (
          <div
            key={seg.label}
            className={seg.cls}
            style={{ width: `${(seg.value / total) * 100}%` }}
            title={`${seg.label}: ${seg.value}`}
          />
        ) : null
      )}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const cls =
    outcome === "executed"
      ? "bg-success/15 text-success"
      : outcome === "soft_refused"
        ? "bg-warning/15 text-warning"
        : "bg-error/15 text-error";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {outcome.replace(/_/g, " ")}
    </span>
  );
}

// ── Page ────────────────────────────────────────────────────────────

export function RouterStatusPage() {
  const statusQ = useQuery({
    queryKey: ["router", "status"],
    queryFn: () => fetchJson<StatusResponse>("/api/router/status"),
    refetchInterval: 5_000,
  });
  const sessionsQ = useQuery({
    queryKey: ["router", "sessions"],
    queryFn: () => fetchJson<SessionsResponse>("/api/router/sessions"),
    refetchInterval: 15_000,
    enabled: statusQ.data?.data?.enabled === true,
  });
  const recentQ = useQuery({
    queryKey: ["router", "recent"],
    queryFn: () => fetchJson<RecentResponse>("/api/router/recent?limit=100"),
    refetchInterval: 4_000,
    enabled: statusQ.data?.data?.enabled === true,
  });

  const sessions = sessionsQ.data?.data?.sessions ?? [];
  const recent = recentQ.data?.data?.records ?? [];

  // ── Lifetime aggregate (sum across every recorded session) ──────────
  const life = useMemo(() => {
    const acc = {
      calls: 0,
      saved: 0,
      tokensIn: 0,
      refused: 0,
      unlocks: 0,
      latencySum: 0,
      days: new Set<string>(),
    };
    for (const s of sessions) {
      acc.calls += s.totalCalls;
      acc.saved += s.totalTokensSaved;
      acc.tokensIn += s.totalTokensIn;
      acc.refused += s.softRefuseCount;
      acc.unlocks += s.unlockCount;
      acc.latencySum += s.avgLatencyMs * s.totalCalls;
      acc.days.add(s.lastCallTs.slice(0, 10));
    }
    return {
      ...acc,
      avgLatency: acc.calls > 0 ? acc.latencySum / acc.calls : 0,
      sessionCount: sessions.length,
      dayCount: acc.days.size,
    };
  }, [sessions]);

  // ── Per-server view (the next-week vision, grounded in the `server`
  //    field every record already carries) ────────────────────────────
  const servers = useMemo(() => {
    const map = new Map<
      string,
      {
        server: string;
        calls: number;
        saved: number;
        refused: number;
        latencySum: number;
        tools: Set<string>;
      }
    >();
    for (const r of recent) {
      const key = r.server ?? "unerr";
      let e = map.get(key);
      if (!e) {
        e = {
          server: key,
          calls: 0,
          saved: 0,
          refused: 0,
          latencySum: 0,
          tools: new Set(),
        };
        map.set(key, e);
      }
      e.calls++;
      e.saved += r.tokensSaved;
      if (r.outcome === "soft_refused") e.refused++;
      e.latencySum += r.latencyMs.total;
      e.tools.add(r.originalToolName ?? r.toolName);
    }
    return [...map.values()].sort((a, b) => b.calls - a.calls);
  }, [recent]);

  // ── Tool leaderboard (merge topTools across sessions) ───────────────
  const topTools = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      for (const t of s.topTools) {
        counts.set(t.name, (counts.get(t.name) ?? 0) + t.count);
      }
    }
    const arr = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }));
    const max = arr[0]?.count ?? 1;
    return { arr, max };
  }, [sessions]);

  // ── Daily routing trend (real — 5 days of rotated archives) ─────────
  const daily = useMemo(() => {
    const byDay = new Map<string, { calls: number; saved: number }>();
    for (const s of sessions) {
      const day = s.lastCallTs.slice(0, 10);
      const e = byDay.get(day) ?? { calls: 0, saved: 0 };
      e.calls += s.totalCalls;
      e.saved += s.totalTokensSaved;
      byDay.set(day, e);
    }
    const arr = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-14)
      .map(([day, v]) => ({ day, ...v }));
    const max = Math.max(1, ...arr.map((d) => d.calls));
    return { arr, max };
  }, [sessions]);

  const outcomeTotals = useMemo(() => {
    const o = { executed: 0, softRefused: 0, degraded: 0, error: 0 };
    for (const s of sessions) {
      o.executed += s.outcomeBreakdown.executed;
      o.softRefused += s.outcomeBreakdown.softRefused;
      o.degraded += s.outcomeBreakdown.passthroughDegraded;
      o.error += s.outcomeBreakdown.childError;
    }
    return o;
  }, [sessions]);

  if (statusQ.isLoading) return <CardGridSkeleton />;
  const status = statusQ.data?.data;
  if (!status) return <CardGridSkeleton />;

  if (!status.enabled) {
    return (
      <div className="card p-8 text-center">
        <div className="mb-4 text-4xl">⏸</div>
        <h2 className="mb-2 text-xl font-semibold">MCP Router is idle</h2>
        <p className="t-secondary mx-auto max-w-md">
          The gateway records every tool dispatch the moment your agent
          connects. If you are seeing this, no session has routed a call yet —
          run a tool and it will light up.
        </p>
      </div>
    );
  }

  const session = status.session;
  const serverCount = Math.max(servers.length, 1);
  const headlineCalls =
    life.calls > 0 ? life.calls : (session?.totalCalls ?? 0);
  const headlineSaved =
    life.saved > 0 ? life.saved : (session?.totalTokensSaved ?? 0);
  const headlineRefused =
    life.refused > 0 ? life.refused : (session?.softRefuseCount ?? 0);
  const headlineUnlocks =
    life.unlocks > 0 ? life.unlocks : (session?.unlockCount ?? 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">MCP Router</h2>
          <p className="t-secondary text-sm">
            One endpoint in front of{" "}
            <span className="font-mono text-foreground-emphasis">
              {serverCount}
            </span>{" "}
            MCP server{serverCount === 1 ? "" : "s"} ·{" "}
            {life.dayCount > 0 ? `${life.dayCount}-day` : "live"} history
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-success/15 px-3 py-1 text-sm font-medium text-success">
          <span className="h-2 w-2 animate-pulse rounded-full bg-success shadow-[0_0_6px_rgba(52,211,153,0.7)]" />
          Routing live
        </span>
      </div>

      {/* Hero — the router's headline value */}
      <section className="glass-panel rounded-xl p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <div className="sm:w-72">
            <span className="section-label">Tool calls routed</span>
            <div className="mt-1 font-mono text-6xl font-semibold leading-none tabular-nums text-foreground-emphasis">
              <CountUp value={headlineCalls} />
            </div>
            <p className="t-tertiary mt-2 text-xs">
              every call your agent made — classified, gated, and forwarded in
              under 5&nbsp;ms each
            </p>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-5 border-t border-border-subtle pt-5 sm:grid-cols-3 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
            <SupportFigure
              label="Tokens saved"
              value={headlineSaved}
              accent="text-emerald-400"
              hint={`of ${fmtNum(life.tokensIn || (session?.totalTokensIn ?? 0))} seen`}
            />
            <SupportFigure
              label="Wasteful calls blocked"
              value={headlineRefused}
              accent="text-amber-400"
              hint="soft-refused before forwarding"
            />
            <SupportFigure
              label="Tools unlocked"
              value={headlineUnlocks}
              accent="text-cyan-400"
              hint="surfaced as your pattern earned them"
            />
            <SupportFigure
              label="Avg latency"
              value={Math.round(life.avgLatency || (session ? 0 : 0))}
              accent="text-foreground-emphasis"
              hint="ms per routed call"
            />
            <SupportFigure
              label="Sessions"
              value={life.sessionCount}
              accent="text-foreground-emphasis"
              hint={`over ${life.dayCount} day${life.dayCount === 1 ? "" : "s"}`}
            />
            <SupportFigure
              label="Servers"
              value={serverCount}
              accent="text-fuchsia-400"
              hint="on the bus"
            />
          </div>
        </div>
      </section>

      {/* Servers on the bus — server-first, built to grow */}
      <section className="glass-panel rounded-xl p-5">
        <div className="mb-1 flex items-center justify-between">
          <span className="section-label">Servers on the bus</span>
          <span className="t-tertiary text-xs">last 100 calls</span>
        </div>
        <p className="t-tertiary mb-4 text-xs">
          Each MCP server routed through this endpoint, with the traffic it
          drove. Connect more with{" "}
          <code className="rounded bg-surface-overlay px-1 py-0.5 font-mono text-[11px]">
            unerr enable mcp-router
          </code>{" "}
          and they appear here automatically.
        </p>
        <div className="space-y-3">
          {servers.map((s) => (
            <div
              key={s.server}
              className="rounded-lg border border-border-subtle bg-surface-overlay/40 p-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_4px_rgba(52,211,153,0.6)]" />
                  <span className="font-medium">{s.server}</span>
                  <span className="t-tertiary text-xs">
                    {s.tools.size} tool{s.tools.size === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm tabular-nums">
                  <span className="font-mono">{fmtNum(s.calls)} calls</span>
                  <span className="font-mono text-emerald-400">
                    +{fmtNum(s.saved)} tok
                  </span>
                  <span className="font-mono t-tertiary">
                    {Math.round(s.latencySum / Math.max(1, s.calls))}ms
                  </span>
                </div>
              </div>
              <div className="mt-2">
                <MeterBar
                  segments={[
                    {
                      value: s.calls - s.refused,
                      cls: "bg-success",
                      label: "executed",
                    },
                    {
                      value: s.refused,
                      cls: "bg-warning",
                      label: "soft-refused",
                    },
                  ]}
                />
              </div>
            </div>
          ))}
          <div className="rounded-lg border border-dashed border-border-subtle p-3 text-center">
            <span className="t-tertiary text-xs">
              + your other MCP servers land here once consolidated
            </span>
          </div>
        </div>
      </section>

      {/* Routing health + Tool leaderboard */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Outcomes */}
        <section className="glass-panel rounded-xl p-5">
          <span className="section-label">Routing outcomes</span>
          <p className="t-tertiary mb-4 mt-1 text-xs">
            What the gateway did with each call it saw.
          </p>
          {(() => {
            const total =
              outcomeTotals.executed +
                outcomeTotals.softRefused +
                outcomeTotals.degraded +
                outcomeTotals.error || 1;
            const pct = (n: number) => Math.round((n / total) * 100);
            return (
              <>
                <MeterBar
                  segments={[
                    {
                      value: outcomeTotals.executed,
                      cls: "bg-success",
                      label: "executed",
                    },
                    {
                      value: outcomeTotals.softRefused,
                      cls: "bg-warning",
                      label: "soft-refused",
                    },
                    {
                      value: outcomeTotals.degraded,
                      cls: "bg-cyan-500",
                      label: "degraded",
                    },
                    {
                      value: outcomeTotals.error,
                      cls: "bg-error",
                      label: "error",
                    },
                  ]}
                />
                <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="t-secondary">Executed</span>
                    <span className="font-mono tabular-nums text-success">
                      {outcomeTotals.executed} · {pct(outcomeTotals.executed)}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="t-secondary">Soft-refused</span>
                    <span className="font-mono tabular-nums text-warning">
                      {outcomeTotals.softRefused} ·{" "}
                      {pct(outcomeTotals.softRefused)}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="t-secondary">Degraded</span>
                    <span className="font-mono tabular-nums t-tertiary">
                      {outcomeTotals.degraded}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="t-secondary">Errors</span>
                    <span className="font-mono tabular-nums t-tertiary">
                      {outcomeTotals.error}
                    </span>
                  </div>
                </div>
                {outcomeTotals.softRefused > 0 && (
                  <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
                    <span className="font-medium text-warning">
                      {outcomeTotals.softRefused} wasteful call
                      {outcomeTotals.softRefused === 1 ? "" : "s"} blocked
                    </span>
                    <span className="t-secondary">
                      {" "}
                      — the router refused redundant or low-value calls before
                      they spent tokens.
                    </span>
                  </div>
                )}
              </>
            );
          })()}
        </section>

        {/* Tool leaderboard */}
        <section className="glass-panel rounded-xl p-5">
          <span className="section-label">Most-routed tools</span>
          <p className="t-tertiary mb-4 mt-1 text-xs">
            Where your agent's traffic actually goes.
          </p>
          <div className="space-y-2.5">
            {topTools.arr.map((t) => (
              <div key={t.name} className="flex items-center gap-3">
                <span className="w-40 truncate font-mono text-xs">
                  {t.name}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-overlay">
                  <div
                    className="h-full rounded-full bg-cyan-400/80"
                    style={{ width: `${(t.count / topTools.max) * 100}%` }}
                  />
                </div>
                <span className="w-10 text-right font-mono text-xs tabular-nums t-secondary">
                  {t.count}
                </span>
              </div>
            ))}
            {topTools.arr.length === 0 && (
              <p className="t-tertiary text-sm">No tool calls recorded yet.</p>
            )}
          </div>
        </section>
      </div>

      {/* Daily trend */}
      {daily.arr.length > 1 && (
        <section className="glass-panel rounded-xl p-5">
          <span className="section-label">Routing volume by day</span>
          <div className="mt-4 flex items-end gap-2" style={{ height: 96 }}>
            {daily.arr.map((d) => (
              <div
                key={d.day}
                className="group flex flex-1 flex-col items-center justify-end gap-1"
                title={`${d.day}: ${d.calls} calls · +${fmtNum(d.saved)} tokens`}
              >
                <span className="font-mono text-[10px] tabular-nums t-tertiary opacity-0 transition-opacity group-hover:opacity-100">
                  {d.calls}
                </span>
                <div
                  className="w-full rounded-t bg-fuchsia-500/60 transition-all group-hover:bg-fuchsia-400"
                  style={{ height: `${(d.calls / daily.max) * 76}px` }}
                />
                <span className="font-mono text-[10px] t-tertiary">
                  {d.day.slice(5)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Live feed */}
      {recent.length > 0 && (
        <section className="glass-panel rounded-xl">
          <div className="flex items-center justify-between border-b border-border-subtle p-4">
            <span className="section-label">Live call feed</span>
            <span className="t-tertiary text-xs">
              {recent.length} most recent
            </span>
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-overlay/80 backdrop-blur">
                <tr className="t-tertiary">
                  <th className="px-4 py-2 text-left font-medium">Tool</th>
                  <th className="px-4 py-2 text-left font-medium">Server</th>
                  <th className="px-4 py-2 text-left font-medium">Outcome</th>
                  <th className="px-4 py-2 text-right font-medium">Saved</th>
                  <th className="px-4 py-2 text-right font-medium">Latency</th>
                  <th className="px-4 py-2 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {recent
                  .slice()
                  .reverse()
                  .map((r, i) => (
                    <tr
                      key={`${r.ts}-${i}`}
                      className="hover:bg-surface-overlay/40"
                    >
                      <td className="px-4 py-2 font-mono text-xs">
                        {r.toolName}
                        {r.wasMasked && (
                          <span className="ml-1.5 inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">
                            masked
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 t-tertiary text-xs">
                        {r.server ?? "unerr"}
                      </td>
                      <td className="px-4 py-2">
                        <OutcomeBadge outcome={r.outcome} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-emerald-400">
                        {r.tokensSaved > 0 ? `+${r.tokensSaved}` : "—"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums t-tertiary">
                        {r.latencyMs.total.toFixed(0)}ms
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums t-tertiary">
                        {timeAgo(r.ts)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
