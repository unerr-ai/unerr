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
  {
    stripe: string;
    label: string;
    value: string;
    spark: string;
    wash: string;
    glow: string;
  }
> = {
  emerald: {
    stripe: "border-emerald-500/60",
    label: "text-emerald-400",
    value: "text-emerald-400",
    spark: "text-emerald-400",
    wash: "from-emerald-500/[0.07]",
    glow: "hover:shadow-[0_14px_34px_-16px_rgba(52,211,153,0.45)]",
  },
  cyan: {
    stripe: "border-cyan-500/60",
    label: "text-cyan-400",
    value: "text-cyan-400",
    spark: "text-cyan-400",
    wash: "from-cyan-500/[0.07]",
    glow: "hover:shadow-[0_14px_34px_-16px_rgba(34,211,238,0.45)]",
  },
  violet: {
    stripe: "border-violet-500/60",
    label: "text-violet-400",
    value: "text-violet-400",
    spark: "text-violet-400",
    wash: "from-violet-500/[0.07]",
    glow: "hover:shadow-[0_14px_34px_-16px_rgba(139,92,246,0.45)]",
  },
  fuchsia: {
    stripe: "border-fuchsia-500/60",
    label: "text-fuchsia-400",
    value: "text-fuchsia-400",
    spark: "text-fuchsia-400",
    wash: "from-fuchsia-500/[0.07]",
    glow: "hover:shadow-[0_14px_34px_-16px_rgba(217,70,239,0.45)]",
  },
  amber: {
    stripe: "border-amber-500/60",
    label: "text-amber-400",
    value: "text-amber-400",
    spark: "text-amber-400",
    wash: "from-amber-500/[0.07]",
    glow: "hover:shadow-[0_14px_34px_-16px_rgba(251,191,36,0.4)]",
  },
  rose: {
    stripe: "border-rose-500/60",
    label: "text-rose-400",
    value: "text-rose-400",
    spark: "text-rose-400",
    wash: "from-rose-500/[0.07]",
    glow: "hover:shadow-[0_14px_34px_-16px_rgba(251,113,133,0.4)]",
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
      className={`group relative overflow-hidden rounded-lg border-t-2 ${s.stripe} el-raised p-5 transition-all duration-200 hover:-translate-y-0.5 ${s.glow}`}
      title={hint}
    >
      {/* Accent wash — faint top-down tint that intensifies on hover, giving
          the Big Four cards depth without a heavier border or solid fill. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 bg-gradient-to-b ${s.wash} to-transparent opacity-60 transition-opacity duration-200 group-hover:opacity-100`}
      />
      <div className="relative">
        <p
          className={`${s.label} text-[10px] uppercase tracking-wider font-medium`}
        >
          {label}
        </p>
        <p
          className={`text-3xl font-bold font-mono ${s.value} mt-2 tabular-nums tracking-tight`}
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
    </div>
  );
}
