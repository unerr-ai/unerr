/**
 * SavingsTrend — full-width stacked-area chart for tokens saved over time.
 *
 * Hand-rolled SVG: no chart library dep. Each mechanism contributes a
 * coloured stack layer; per-mechanism hues come from MECH_COLORS so the
 * chart matches the breakdown bars below it. Hovering a bucket surfaces
 * a vertical guide + per-mechanism breakdown in a tooltip overlay.
 *
 * Data shape (from GET /api/token-flow/series):
 *   { data: [{ ts, by_mechanism: {mech: tokens}, total_saved }] }
 */

import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ALL_MECHANISMS, MECH_COLORS, fmt } from "../shared";

interface SeriesBucket {
  ts: string;
  by_mechanism: Record<string, number>;
  total_saved: number;
}

interface SeriesResponse {
  data: SeriesBucket[];
  bucket: "hour" | "day";
}

// Lift the bar fill colour for each mechanism into a hex value so we can
// drive `<rect fill="…">` directly instead of fighting Tailwind class
// scoping inside SVG.
const FILL_HEX: Record<string, string> = {
  shell_compression: "#06b6d4", // cyan-500
  format_encoding: "#f59e0b", // amber-500
  session_dedup: "#10b981", // emerald-500
  smart_truncation: "#3b82f6", // blue-500
  file_read: "#6366f1", // indigo-500
  fetch_url: "#14b8a6", // teal-500
};
const FALLBACK_FILL = "#a1a1aa"; // zinc-400

function fillFor(mech: string): string {
  return FILL_HEX[mech] ?? FALLBACK_FILL;
}

function fmtBucketLabel(iso: string, bucket: "hour" | "day"): string {
  const d = new Date(iso);
  if (bucket === "hour") {
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
    });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function SavingsTrend({
  fromTs,
  toTs,
  bucket = "day",
}: {
  fromTs?: string;
  toTs?: string;
  bucket?: "hour" | "day";
}) {
  const { url, queryKey } = useRepoApi();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const params = new URLSearchParams();
  if (fromTs) params.set("from_ts", fromTs);
  if (toTs) params.set("to_ts", toTs);
  params.set("bucket", bucket);

  const q = useQuery({
    queryKey: queryKey(["token-flow-series", fromTs ?? "", toTs ?? "", bucket]),
    queryFn: () =>
      fetchJson<SeriesResponse>(
        url(`/api/token-flow/series?${params.toString()}`)
      ),
    refetchInterval: 30_000,
  });

  const buckets = q.data?.data ?? [];

  // Mechanism stack order — fixed so colors stay stable across buckets.
  // Use the canonical ALL_MECHANISMS list, then append any unknown
  // mechanisms that appeared in the data so we never silently drop bytes.
  const stackOrder = useMemo(() => {
    const seen = new Set<string>();
    for (const b of buckets) {
      for (const k of Object.keys(b.by_mechanism)) seen.add(k);
    }
    const ordered = ALL_MECHANISMS.filter((m) => seen.has(m));
    const extras = [...seen].filter((m) => !ALL_MECHANISMS.includes(m));
    return [...ordered, ...extras];
  }, [buckets]);

  const peak = useMemo(
    () => Math.max(0, ...buckets.map((b) => b.total_saved)),
    [buckets]
  );

  if (q.isLoading) {
    return (
      <div className="el-raised rounded-lg p-5">
        <h3 className="t-secondary text-sm font-medium mb-3">Savings Trend</h3>
        <div className="h-48 animate-pulse bg-white/[0.06] rounded" />
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <div className="el-raised rounded-lg p-5">
        <h3 className="t-secondary text-sm font-medium mb-1">Savings Trend</h3>
        <p className="t-tertiary text-xs mb-3">
          Tokens saved per {bucket}, stacked by mechanism.
        </p>
        <p className="t-secondary text-sm py-6 text-center">
          No bucketed savings data yet.
        </p>
      </div>
    );
  }

  // SVG viewport. We use a wide viewBox so the chart scales nicely while
  // letting the bar width grow with the bucket count.
  const VIEW_W = 800;
  const VIEW_H = 200;
  const PAD_L = 36;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 22;
  const innerW = VIEW_W - PAD_L - PAD_R;
  const innerH = VIEW_H - PAD_T - PAD_B;
  const barGap = 2;
  const barW = Math.max(
    1,
    (innerW - (buckets.length - 1) * barGap) / Math.max(1, buckets.length)
  );

  // Axis ticks — 4 evenly spaced y values up to peak.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(peak * f));

  return (
    <div className="el-raised rounded-lg p-5">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h3 className="t-secondary text-sm font-medium">Savings Trend</h3>
        <span className="t-tertiary text-xs">
          {buckets.length} {bucket}
          {buckets.length === 1 ? "" : "s"} · peak {fmt(peak)} tok
        </span>
      </div>
      <p className="t-tertiary text-xs mb-3 leading-snug">
        Tokens saved per {bucket}, stacked by mechanism. Hover a bar for the
        breakdown.
      </p>

      <div className="relative">
        <svg
          aria-label="Savings trend over time"
          role="img"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full h-48"
          preserveAspectRatio="none"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <title>Tokens saved per {bucket}, stacked by mechanism</title>

          {/* Y-axis gridlines + tick labels */}
          {yTicks.map((v, i) => {
            const y = PAD_T + innerH - (i / 4) * innerH;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable 5-tick enumeration; index is the canonical identity
              <g key={`ytick-${i}`}>
                <line
                  x1={PAD_L}
                  x2={VIEW_W - PAD_R}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-border-subtle"
                  strokeWidth={0.5}
                  strokeDasharray={i === 0 ? "" : "2 2"}
                />
                <text
                  x={PAD_L - 4}
                  y={y + 3}
                  textAnchor="end"
                  className="t-tertiary"
                  style={{ fontSize: "9px" }}
                >
                  {fmt(v)}
                </text>
              </g>
            );
          })}

          {/* Stacked bars */}
          {buckets.map((b, i) => {
            const x = PAD_L + i * (barW + barGap);
            let yCursor = PAD_T + innerH;
            const isHover = hoverIdx === i;
            return (
              <g
                key={b.ts}
                onMouseEnter={() => setHoverIdx(i)}
                style={{ cursor: "pointer" }}
              >
                {stackOrder.map((mech) => {
                  const saved = b.by_mechanism[mech] ?? 0;
                  if (saved <= 0) return null;
                  const h = peak > 0 ? (saved / peak) * innerH : 0;
                  yCursor -= h;
                  return (
                    <rect
                      key={mech}
                      x={x}
                      y={yCursor}
                      width={barW}
                      height={h}
                      fill={fillFor(mech)}
                      opacity={isHover ? 1 : 0.85}
                    />
                  );
                })}
                {/* Invisible hit-target spanning the full column height */}
                <rect
                  x={x}
                  y={PAD_T}
                  width={barW}
                  height={innerH}
                  fill="transparent"
                />
              </g>
            );
          })}

          {/* X-axis: show first, middle, last labels */}
          {[0, Math.floor(buckets.length / 2), buckets.length - 1]
            .filter((idx, i, arr) => arr.indexOf(idx) === i)
            .map((idx) => {
              const b = buckets[idx];
              if (!b) return null;
              const x = PAD_L + idx * (barW + barGap) + barW / 2;
              return (
                <text
                  key={b.ts}
                  x={x}
                  y={VIEW_H - 6}
                  textAnchor="middle"
                  className="t-tertiary"
                  style={{ fontSize: "9px" }}
                >
                  {fmtBucketLabel(b.ts, bucket)}
                </text>
              );
            })}
        </svg>

        {/* Tooltip */}
        {hoverIdx !== null && buckets[hoverIdx] && (
          <div className="absolute top-2 right-2 el-raised rounded-md p-3 text-xs shadow-lg max-w-[220px] pointer-events-none">
            <p className="t-secondary text-[10px] uppercase tracking-wider mb-1">
              {fmtBucketLabel(buckets[hoverIdx].ts, bucket)}
            </p>
            <p className="text-success font-mono font-bold tabular-nums mb-2">
              {fmt(buckets[hoverIdx].total_saved)} tok
            </p>
            <div className="space-y-1">
              {stackOrder
                .map((mech) => ({
                  mech,
                  saved: buckets[hoverIdx]?.by_mechanism[mech] ?? 0,
                }))
                .filter((row) => row.saved > 0)
                .sort((a, b) => b.saved - a.saved)
                .map(({ mech, saved }) => (
                  <div
                    key={mech}
                    className="flex items-center gap-2 tabular-nums"
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-sm shrink-0"
                      style={{ backgroundColor: fillFor(mech) }}
                    />
                    <span
                      className={`${MECH_COLORS[mech]?.text ?? "text-zinc-400"} flex-1 truncate`}
                    >
                      {mech.replace(/_/g, " ")}
                    </span>
                    <span className="font-mono t-secondary">{fmt(saved)}</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3 text-[10px]">
        {stackOrder.map((mech) => (
          <span key={mech} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-sm"
              style={{ backgroundColor: fillFor(mech) }}
            />
            <span
              className={`${MECH_COLORS[mech]?.text ?? "text-zinc-400"} truncate`}
            >
              {mech.replace(/_/g, " ")}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
