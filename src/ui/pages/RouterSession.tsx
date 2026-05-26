/**
 * Sprint P0-6: Router Session Metrics page.
 *
 * Per-session detail view:
 *   - Outcome breakdown (executed, soft-refused, passthrough-degraded, child-error)
 *   - Top tools by call count
 *   - Token savings KPIs
 *   - Average latency
 *   - Session list for navigation
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

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

function fmtNum(n: number): string {
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function OutcomeBar({
  breakdown,
  total,
}: {
  breakdown: SessionSummary["outcomeBreakdown"];
  total: number;
}) {
  if (total === 0) return null;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <div className="flex h-3 rounded-full overflow-hidden bg-muted">
      {breakdown.executed > 0 && (
        <div
          className="bg-success transition-all"
          style={{ width: pct(breakdown.executed) }}
          title={`Executed: ${breakdown.executed}`}
        />
      )}
      {breakdown.softRefused > 0 && (
        <div
          className="bg-warning transition-all"
          style={{ width: pct(breakdown.softRefused) }}
          title={`Soft Refused: ${breakdown.softRefused}`}
        />
      )}
      {breakdown.passthroughDegraded > 0 && (
        <div
          className="bg-amber-600 transition-all"
          style={{ width: pct(breakdown.passthroughDegraded) }}
          title={`Passthrough: ${breakdown.passthroughDegraded}`}
        />
      )}
      {breakdown.childError > 0 && (
        <div
          className="bg-error transition-all"
          style={{ width: pct(breakdown.childError) }}
          title={`Errors: ${breakdown.childError}`}
        />
      )}
    </div>
  );
}

function SessionDetail({ session }: { session: SessionSummary }) {
  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="card p-4">
          <span className="section-label">Calls</span>
          <div className="font-mono text-2xl font-semibold tabular-nums mt-1">
            {fmtNum(session.totalCalls)}
          </div>
        </div>
        <div className="card p-4">
          <span className="section-label">Tokens Saved</span>
          <div className="font-mono text-2xl font-semibold tabular-nums text-live mt-1">
            {fmtNum(session.totalTokensSaved)}
          </div>
          <span className="t-tertiary text-xs">
            of {fmtNum(session.totalTokensIn)} in
          </span>
        </div>
        <div className="card p-4">
          <span className="section-label">Avg Latency</span>
          <div className="font-mono text-2xl font-semibold tabular-nums mt-1">
            {session.avgLatencyMs.toFixed(1)}
            <span className="text-sm t-tertiary ml-1">ms</span>
          </div>
        </div>
        <div className="card p-4">
          <span className="section-label">Efficiency</span>
          <div className="font-mono text-2xl font-semibold tabular-nums text-live mt-1">
            {Math.round(session.efficiency * 100)}%
          </div>
        </div>
      </div>

      {/* Outcome breakdown */}
      <div className="card p-4 space-y-3">
        <h4 className="font-semibold">Outcome Breakdown</h4>
        <OutcomeBar
          breakdown={session.outcomeBreakdown}
          total={session.totalCalls}
        />
        <div className="flex flex-wrap gap-4 text-sm">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-success" />
            Executed: {session.outcomeBreakdown.executed}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-warning" />
            Soft Refused: {session.outcomeBreakdown.softRefused}
          </span>
          {session.outcomeBreakdown.passthroughDegraded > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-600" />
              Passthrough: {session.outcomeBreakdown.passthroughDegraded}
            </span>
          )}
          {session.outcomeBreakdown.childError > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-error" />
              Errors: {session.outcomeBreakdown.childError}
            </span>
          )}
        </div>
      </div>

      {/* Top tools */}
      {session.topTools.length > 0 && (
        <div className="card">
          <div className="p-4 border-b border-border-subtle">
            <h4 className="font-semibold">Top Tools</h4>
          </div>
          <div className="divide-y divide-border-subtle">
            {session.topTools.map((t) => {
              const pct =
                session.totalCalls > 0
                  ? Math.round((t.count / session.totalCalls) * 100)
                  : 0;
              return (
                <div
                  key={t.name}
                  className="flex items-center justify-between px-4 py-2.5"
                >
                  <span className="font-mono text-sm">{t.name}</span>
                  <div className="flex items-center gap-3">
                    <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="tabular-nums text-sm w-8 text-right">
                      {t.count}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function RouterSessionPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sessionsQ = useQuery({
    queryKey: ["router", "sessions"],
    queryFn: () => fetchJson<SessionsResponse>("/api/router/sessions"),
    refetchInterval: 10_000,
  });

  if (sessionsQ.isLoading) return <CardGridSkeleton />;

  const sessions = sessionsQ.data?.data?.sessions ?? [];

  if (sessions.length === 0) {
    return (
      <div className="card p-8 text-center">
        <div className="text-4xl mb-4">📊</div>
        <h2 className="text-xl font-semibold mb-2">No Sessions Yet</h2>
        <p className="t-secondary max-w-md mx-auto">
          Session metrics will appear here once the router processes tool calls.
          Make sure the router is enabled and your IDE is connected.
        </p>
      </div>
    );
  }

  const selected = selectedId
    ? (sessions.find((s) => s.sessionId === selectedId) ?? sessions[0])
    : sessions[0];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <span className="t-secondary text-sm">
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* Session list */}
        <div className="card divide-y divide-border-subtle overflow-hidden">
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => setSelectedId(s.sessionId)}
              className={`w-full px-4 py-3 text-left transition-colors ${
                selected?.sessionId === s.sessionId
                  ? "bg-accent/10 border-l-2 border-accent"
                  : "hover:bg-muted/50 border-l-2 border-transparent"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs truncate max-w-[140px]">
                  {s.sessionId.slice(0, 12)}…
                </span>
                <span className="t-tertiary text-xs">
                  {timeAgo(s.lastCallTs)}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs t-secondary">
                <span>{s.totalCalls} calls</span>
                <span className="text-success">
                  +{fmtNum(s.totalTokensSaved)} tok
                </span>
              </div>
            </button>
          ))}
        </div>

        {/* Session detail */}
        {selected && <SessionDetail session={selected} />}
      </div>
    </div>
  );
}
