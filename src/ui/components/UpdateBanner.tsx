import { fetchJson } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface VersionInfo {
  available: boolean;
  current: string;
  latest: string;
  behindMinor: number;
  dismissed: boolean;
}

export function UpdateBanner() {
  const [localDismissed, setLocalDismissed] = useState(false);
  const queryClient = useQueryClient();

  const { data } = useQuery<VersionInfo>({
    queryKey: ["version", "check"],
    queryFn: () => fetchJson("/api/daemon/version"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const dismiss = useMutation({
    mutationFn: async (version: string) => {
      await fetch(`/api/daemon/version/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
    },
    onSuccess: () => {
      setLocalDismissed(true);
      queryClient.invalidateQueries({ queryKey: ["version"] });
    },
  });

  if (!data?.available || data.dismissed || localDismissed) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 16px",
        background: "linear-gradient(90deg, #1e293b 0%, #0f172a 100%)",
        borderBottom: "1px solid #334155",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#22D3EE",
            animation: "pulse 2s infinite",
          }}
        />
        <span style={{ color: "#e2e8f0" }}>
          Update available:{" "}
          <span style={{ fontWeight: 600 }}>{data.current}</span>
          {" → "}
          <span style={{ fontWeight: 600, color: "#22D3EE" }}>
            {data.latest}
          </span>
        </span>
        <span style={{ color: "#64748b" }}>
          ({data.behindMinor} minor version{data.behindMinor !== 1 ? "s" : ""}{" "}
          behind)
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <a
          href={`https://github.com/unerr-ai/unerr/releases/tag/v${data.latest}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: "#8B5CF6",
            textDecoration: "none",
            fontSize: 12,
          }}
        >
          Changelog
        </a>
        <code
          style={{
            background: "#1e293b",
            padding: "2px 8px",
            borderRadius: 4,
            color: "#34D399",
            fontSize: 11,
          }}
        >
          unerr daemon update
        </code>
        <button
          type="button"
          onClick={() => dismiss.mutate(data.latest)}
          style={{
            background: "none",
            border: "none",
            color: "#64748b",
            cursor: "pointer",
            padding: "2px 6px",
            borderRadius: 4,
            fontSize: 16,
            lineHeight: 1,
          }}
          title="Dismiss this version"
        >
          ×
        </button>
      </div>
    </div>
  );
}
