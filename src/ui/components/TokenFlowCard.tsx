/**
 * Layer 10 TF-D.4: Token Flow headline card + mechanism breakdown.
 *
 * Shows: total tokens saved, efficiency %, tokens delivered,
 * and a horizontal bar chart of savings by mechanism.
 */

interface MechanismRow {
  mechanism: string;
  tokens_saved: number;
  tokens_delivered: number;
  event_count: number;
  pct_of_total: number;
}

interface TokenFlowCardProps {
  totalSaved: number;
  totalDelivered: number;
  efficiencyPct: number;
  totalTurns: number;
  mechanisms: MechanismRow[];
  topTurn?: {
    turn: number;
    tool: string;
    tokens_saved: number;
    primary_mechanism: string;
  };
}

const MECH_COLORS: Record<string, string> = {
  graph_query: "bg-violet-500",
  shell_compression: "bg-cyan-500",
  format_encoding: "bg-blue-500",
  smart_truncation: "bg-amber-500",
  session_dedup: "bg-emerald-500",
  file_read: "bg-indigo-500",
  behavior_automation: "bg-rose-500",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function MechanismBar({ row }: { row: MechanismRow }) {
  const color = MECH_COLORS[row.mechanism] ?? "bg-zinc-500";
  const barWidth = Math.max(2, Math.round(row.pct_of_total));

  return (
    <div className="flex items-center gap-3 py-1">
      <span className="t-secondary w-40 shrink-0 text-xs font-mono truncate">
        {row.mechanism}
      </span>
      <div className="flex h-5 flex-1 items-center gap-2">
        <div className="relative h-full flex-1 rounded bg-surface-secondary">
          <div
            className={`absolute inset-y-0 left-0 rounded ${color} opacity-80`}
            style={{ width: `${barWidth}%` }}
          />
        </div>
        <span className="t-primary w-14 shrink-0 text-right text-xs font-medium">
          {formatTokens(row.tokens_saved)}
        </span>
        <span className="t-tertiary w-10 shrink-0 text-right text-xs">
          {row.pct_of_total}%
        </span>
      </div>
    </div>
  );
}

export function TokenFlowCard({
  totalSaved,
  totalDelivered,
  efficiencyPct,
  totalTurns,
  mechanisms,
  topTurn,
}: TokenFlowCardProps) {
  return (
    <div className="space-y-6">
      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="el-raised rounded-lg p-4">
          <p className="t-tertiary text-xs uppercase tracking-wider">
            Tokens Saved
          </p>
          <p className="mt-1 text-2xl font-bold text-success">
            {formatTokens(totalSaved)}
          </p>
        </div>
        <div className="el-raised rounded-lg p-4">
          <p className="t-tertiary text-xs uppercase tracking-wider">
            Delivered
          </p>
          <p className="mt-1 text-2xl font-bold text-foreground">
            {formatTokens(totalDelivered)}
          </p>
        </div>
        <div className="el-raised rounded-lg p-4">
          <p className="t-tertiary text-xs uppercase tracking-wider">
            Efficiency
          </p>
          <p className="mt-1 text-2xl font-bold text-success">
            {efficiencyPct}%
          </p>
        </div>
        <div className="el-raised rounded-lg p-4">
          <p className="t-tertiary text-xs uppercase tracking-wider">
            Tool Calls
          </p>
          <p className="mt-1 text-2xl font-bold text-foreground">
            {totalTurns}
          </p>
        </div>
      </div>

      {/* Mechanism breakdown */}
      {mechanisms.length > 0 && (
        <div className="el-raised rounded-lg p-4">
          <h3 className="t-secondary mb-3 text-sm font-medium">
            Savings by Mechanism
          </h3>
          <div className="space-y-0.5">
            {mechanisms
              .sort((a, b) => b.tokens_saved - a.tokens_saved)
              .map((m) => (
                <MechanismBar key={m.mechanism} row={m} />
              ))}
          </div>
        </div>
      )}

      {/* Most efficient turn */}
      {topTurn && (
        <div className="el-raised rounded-lg p-4">
          <h3 className="t-secondary mb-1 text-sm font-medium">
            Most Efficient Turn
          </h3>
          <p className="t-primary text-sm">
            <span className="font-mono font-medium">
              #{topTurn.turn} {topTurn.tool}
            </span>
            {" — "}
            <span className="text-success font-medium">
              {formatTokens(topTurn.tokens_saved)} saved
            </span>
            {" via "}
            <span className="t-secondary">{topTurn.primary_mechanism}</span>
          </p>
        </div>
      )}
    </div>
  );
}
