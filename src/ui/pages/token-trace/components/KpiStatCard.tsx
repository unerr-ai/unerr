/**
 * KpiStatCard — colored-stripe KPI card matching Reasoning Trace's
 * "Big Four" aesthetic. One per primary metric on Token Trace global view.
 *
 * Layout:
 *   [colored top stripe]
 *   LABEL (uppercase, accent hue)
 *   VALUE (3xl, mono, accent hue)
 *   subtitle (xs, secondary)
 *   sparkline (optional, accent hue)
 *
 * The `accent` prop picks one of 4 brand-allowed hues: emerald (success),
 * cyan (data), violet (brand), fuchsia (scale). Each hue carries a
 * coordinated stripe + label + value color via lookup so callers don't
 * juggle 3 Tailwind class strings.
 */

import { Sparkline } from "./Sparkline";

type Accent = "emerald" | "cyan" | "violet" | "fuchsia" | "amber" | "rose";

const ACCENT_STYLES: Record<
  Accent,
  { stripe: string; label: string; value: string; spark: string }
> = {
  emerald: {
    stripe: "border-emerald-500/60",
    label: "text-emerald-400",
    value: "text-emerald-400",
    spark: "text-emerald-400",
  },
  cyan: {
    stripe: "border-cyan-500/60",
    label: "text-cyan-400",
    value: "text-cyan-400",
    spark: "text-cyan-400",
  },
  violet: {
    stripe: "border-violet-500/60",
    label: "text-violet-400",
    value: "text-violet-400",
    spark: "text-violet-400",
  },
  fuchsia: {
    stripe: "border-fuchsia-500/60",
    label: "text-fuchsia-400",
    value: "text-fuchsia-400",
    spark: "text-fuchsia-400",
  },
  amber: {
    stripe: "border-amber-500/60",
    label: "text-amber-400",
    value: "text-amber-400",
    spark: "text-amber-400",
  },
  rose: {
    stripe: "border-rose-500/60",
    label: "text-rose-400",
    value: "text-rose-400",
    spark: "text-rose-400",
  },
};

export function KpiStatCard({
  label,
  value,
  subtitle,
  accent,
  hint,
  sparklinePoints,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  accent: Accent;
  hint?: string;
  sparklinePoints?: number[];
}) {
  const s = ACCENT_STYLES[accent];
  const hasSpark = sparklinePoints && sparklinePoints.length >= 2;

  return (
    <div
      className={`el-raised rounded-lg p-5 border-t-2 ${s.stripe}`}
      title={hint}
    >
      <p
        className={`${s.label} text-[10px] uppercase tracking-wider font-medium`}
      >
        {label}
      </p>
      <p
        className={`text-3xl font-bold font-mono ${s.value} mt-2 tabular-nums`}
      >
        {value}
      </p>
      {subtitle && <p className="t-secondary text-xs mt-1">{subtitle}</p>}
      {hasSpark && (
        <div className={`mt-3 ${s.spark}`}>
          <Sparkline points={sparklinePoints} height={28} />
        </div>
      )}
    </div>
  );
}
