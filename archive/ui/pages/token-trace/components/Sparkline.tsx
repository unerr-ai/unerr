/**
 * Sparkline — hand-rolled SVG line chart for KPI cards.
 *
 * Tiny by design: no chart library, no axes, no tooltips. Accepts a flat
 * number array and renders a single polyline scaled to the viewBox. If
 * `points` is empty or has only one value, renders nothing — the caller
 * decides whether to leave whitespace or hide the slot.
 *
 * Color matches the KPI card's accent hue via the `stroke` prop (passed
 * a Tailwind text color class on the parent doesn't reach SVG — set
 * `color` on the parent and pass `stroke="currentColor"` instead).
 */

import { useId } from "react";

export function Sparkline({
  points,
  height = 28,
  className = "",
}: {
  points: number[];
  height?: number;
  className?: string;
}) {
  // useId() embeds colons (":r0:") which are invalid inside an SVG url(#…)
  // reference — strip them so the gradient resolves.
  const gradientId = `spark-${useId().replace(/:/g, "")}`;
  if (!points || points.length < 2) {
    return <div style={{ height }} aria-hidden className={className} />;
  }

  const width = 100;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : width;

  const coords = points
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const areaCoords = `0,${height} ${coords} ${width},${height}`;

  return (
    <svg
      aria-hidden
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`block w-full ${className}`}
      style={{ height }}
    >
      <title>Sparkline trend</title>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={areaCoords} fill={`url(#${gradientId})`} />
      <polyline
        points={coords}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
