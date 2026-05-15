import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

interface WarmStartEvent {
  repo: string;
  label: string;
  status: "started" | "skipped" | "failed" | "aborted";
  ms: number;
  reason?: string;
}

interface WarmStartInfo {
  lastRun: string | null;
  events: WarmStartEvent[];
  config: {
    warmStartBudget: number;
    warmStartIdleDays: number;
    warmStartDelayMs: number;
  };
}

const statusColors: Record<string, string> = {
  started: "#34D399",
  skipped: "#FBBF24",
  failed: "#F87171",
  aborted: "#F87171",
};

const statusIcons: Record<string, string> = {
  started: "✓",
  skipped: "○",
  failed: "✗",
  aborted: "⚠",
};

export function WarmStartPanel() {
  const { data, isLoading } = useQuery<WarmStartInfo>({
    queryKey: ["daemon", "warm-start"],
    queryFn: () => fetchJson("/api/daemon/warm-start"),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div style={{ padding: 16, color: "#94a3b8" }}>
        Loading warm-start info…
      </div>
    );
  }

  if (!data || !data.events || data.events.length === 0) {
    return (
      <div
        style={{
          padding: 20,
          background: "#0f172a",
          borderRadius: 12,
          border: "1px solid #1e293b",
        }}
      >
        <h3 style={{ margin: "0 0 8px", color: "#e2e8f0", fontSize: 14 }}>
          Warm-Start
        </h3>
        <p style={{ color: "#64748b", margin: 0, fontSize: 13 }}>
          No warm-start events yet. Repos will be pre-warmed after daemon boot.
        </p>
        {data?.config && (
          <div style={{ marginTop: 12, fontSize: 12, color: "#475569" }}>
            Budget: {data.config.warmStartBudget} · Idle cutoff:{" "}
            {data.config.warmStartIdleDays}d · Delay:{" "}
            {data.config.warmStartDelayMs}ms
          </div>
        )}
      </div>
    );
  }

  const started = data.events.filter((e) => e.status === "started");
  const skipped = data.events.filter((e) => e.status === "skipped");
  const failed = data.events.filter(
    (e) => e.status === "failed" || e.status === "aborted"
  );
  const totalMs = data.events
    .filter((e) => e.status === "started")
    .reduce((acc, e) => acc + e.ms, 0);

  return (
    <div
      style={{
        padding: 20,
        background: "#0f172a",
        borderRadius: 12,
        border: "1px solid #1e293b",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <h3 style={{ margin: 0, color: "#e2e8f0", fontSize: 14 }}>
          Warm-Start{" "}
          {data.lastRun && (
            <span style={{ color: "#64748b", fontWeight: 400 }}>
              · {data.lastRun}
            </span>
          )}
        </h3>
        <div style={{ fontSize: 12, color: "#64748b" }}>
          {started.length} warmed · {skipped.length} skipped · {totalMs}ms total
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {data.events.map((event, i) => (
          <div
            key={`${event.repo}-${i}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              background: "#1e293b",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <span style={{ color: statusColors[event.status] || "#64748b" }}>
              {statusIcons[event.status] || "·"}
            </span>
            <span style={{ color: "#e2e8f0", flex: 1 }}>{event.label}</span>
            {event.ms > 0 && (
              <span style={{ color: "#64748b", fontSize: 11 }}>
                {event.ms}ms
              </span>
            )}
            {event.reason && (
              <span style={{ color: "#94a3b8", fontSize: 11 }}>
                {event.reason}
              </span>
            )}
          </div>
        ))}
      </div>

      {data.config && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid #1e293b",
            fontSize: 12,
            color: "#475569",
          }}
        >
          Budget: {data.config.warmStartBudget} · Idle cutoff:{" "}
          {data.config.warmStartIdleDays}d · Delay:{" "}
          {data.config.warmStartDelayMs}ms
        </div>
      )}
    </div>
  );
}
