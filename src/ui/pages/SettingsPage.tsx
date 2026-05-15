import { SkeletonBlock } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import type { SystemConfigEnvelope, SystemStatusEnvelope } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

// ── Helpers ──────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
    case "ready":
      return "bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.5)]";
    case "indexing":
      return "bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.5)]";
    default:
      return "bg-red-500 shadow-[0_0_8px_rgba(248,113,113,0.5)]";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "running":
    case "ready":
      return "Operational";
    case "indexing":
      return "Indexing";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium t-tertiary hover:text-foreground hover:el-raised transition-all"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <svg
          aria-hidden="true"
          className="h-3 w-3 text-emerald-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 13l4 4L19 7"
          />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          className="h-3 w-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
      )}
    </button>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  color = "violet",
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: "violet" | "cyan" | "emerald" | "amber";
}) {
  const ringMap = {
    violet: "ring-violet-500/20",
    cyan: "ring-cyan-500/20",
    emerald: "ring-emerald-500/20",
    amber: "ring-amber-500/20",
  };
  const textMap = {
    violet: "text-violet-400",
    cyan: "text-cyan-400",
    emerald: "text-emerald-400",
    amber: "text-amber-400",
  };
  return (
    <div className={`glass-card rounded-lg p-4 ring-1 ${ringMap[color]}`}>
      <p className="t-tertiary text-[11px] uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-2xl font-mono font-bold ${textMap[color]}`}>
        {value}
      </p>
      {sub && <p className="mt-0.5 t-tertiary text-xs">{sub}</p>}
    </div>
  );
}

// ── Detail Row ───────────────────────────────────────────────────────

function DetailRow({
  label,
  value,
  mono = true,
  copyable = false,
}: {
  label: string;
  value: string | number | undefined;
  mono?: boolean;
  copyable?: boolean;
}) {
  const display = value ?? "—";
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-border-subtle/50 last:border-0">
      <dt className="t-secondary text-sm shrink-0">{label}</dt>
      <dd
        className={`text-right text-xs text-foreground ${mono ? "font-mono" : ""} flex items-center`}
      >
        <span className="break-all">{display}</span>
        {copyable && typeof display === "string" && (
          <CopyButton value={display} />
        )}
      </dd>
    </div>
  );
}

// ── Skill Pill ───────────────────────────────────────────────────────

function SkillPill({ name }: { name: string }) {
  // Extract a friendly label from skill names like "unerr-audit", "unerr-blame"
  const label = name.replace(/^unerr-/, "");
  const colorMap: Record<string, string> = {
    audit: "bg-violet-500/15 text-violet-400 ring-violet-500/30",
    blame: "bg-cyan-500/15 text-cyan-400 ring-cyan-500/30",
    test: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
    lint: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
    commit: "bg-violet-500/15 text-violet-400 ring-violet-500/30",
    "review-pr": "bg-cyan-500/15 text-cyan-400 ring-cyan-500/30",
  };
  const style =
    colorMap[label] ?? "bg-violet-500/10 text-violet-400 ring-violet-500/20";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ${style}`}
    >
      <svg
        aria-hidden="true"
        className="h-2.5 w-2.5"
        fill="currentColor"
        viewBox="0 0 8 8"
      >
        <circle cx="4" cy="4" r="3" />
      </svg>
      {name}
    </span>
  );
}

// ── Config Key-Value ─────────────────────────────────────────────────

function ConfigSection({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config);
  if (entries.length === 0) {
    return (
      <p className="t-tertiary text-sm italic">No configuration entries.</p>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map(([key, val]) => {
        const display =
          typeof val === "object" && val !== null
            ? JSON.stringify(val, null, 2)
            : String(val ?? "—");
        const isComplex = typeof val === "object" && val !== null;

        return (
          <div
            key={key}
            className={`rounded-lg border border-border-subtle/50 p-3 ${isComplex ? "" : "flex items-baseline justify-between gap-4"}`}
          >
            <span className="text-sm font-medium text-foreground">{key}</span>
            {isComplex ? (
              <pre className="mt-2 custom-scrollbar max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-black/20 p-2.5 font-mono text-xs leading-relaxed t-secondary">
                {display}
              </pre>
            ) : (
              <span className="font-mono text-xs t-secondary">{display}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

export function SettingsPage() {
  const { url, queryKey } = useRepoApi();
  const statusQ = useQuery({
    queryKey: queryKey(["system", "status"]),
    queryFn: () => fetchJson<SystemStatusEnvelope>(url("/api/system/status")),
    refetchInterval: 5000,
  });

  const configQ = useQuery({
    queryKey: queryKey(["system", "config"]),
    queryFn: () => fetchJson<SystemConfigEnvelope>(url("/api/system/config")),
  });

  const st = statusQ.data?.data;
  const cfg = configQ.data?.data;

  const isLoading = statusQ.isLoading || configQ.isLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <SkeletonBlock key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
        <div className="flex flex-col gap-6 lg:flex-row">
          <SkeletonBlock className="h-72 flex-1 rounded-xl" />
          <SkeletonBlock className="h-72 flex-1 rounded-xl" />
        </div>
      </div>
    );
  }

  if (statusQ.isError && configQ.isError) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="glass-panel rounded-xl p-8 text-center max-w-md">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15">
            <svg
              aria-hidden="true"
              className="h-6 w-6 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          <h3 className="text-foreground font-medium">Connection Error</h3>
          <p className="mt-2 t-secondary text-sm">
            Unable to reach the unerr proxy. Ensure the process is running.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ── Hero: Status Banner ──────────────────────────────────────── */}
      <div className="glass-panel rounded-xl p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-violet-500/15 ring-1 ring-violet-500/30">
              <svg
                aria-hidden="true"
                className="h-5 w-5 text-violet-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-lg font-semibold text-foreground">
                  Process Instance
                </h2>
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${st ? statusColor(st.status) : "bg-gray-500"}`}
                />
                <span className="text-sm font-medium text-foreground">
                  {st ? statusLabel(st.status) : "Unknown"}
                </span>
              </div>
              <p className="mt-0.5 t-tertiary text-xs font-mono">
                PID {st?.pid ?? "—"} · {st?.mode ?? "—"} mode · port{" "}
                {st?.dashboard_port ?? "—"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {st?.ide && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-400 ring-1 ring-cyan-500/20">
                <svg
                  aria-hidden="true"
                  className="h-3 w-3"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" />
                </svg>
                {st.ide}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/10 px-3 py-1 text-xs font-medium text-violet-400 ring-1 ring-violet-500/20">
              Uptime: {st ? formatUptime(st.uptime_s) : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* ── KPI Row ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KpiCard
          label="Graph Entities"
          value={st ? formatNumber(st.graph.entities) : "—"}
          sub={st ? `${formatNumber(st.graph.edges)} edges` : undefined}
          color="violet"
        />
        <KpiCard
          label="Rules Active"
          value={st?.graph.rules ?? "—"}
          sub="conventions & patterns"
          color="cyan"
        />
        <KpiCard
          label="Tool Calls"
          value={st ? formatNumber(st.session.tool_calls) : "—"}
          sub="this session"
          color="emerald"
        />
        <KpiCard
          label="Tokens Saved"
          value={st ? formatNumber(st.session.tokens_saved) : "—"}
          sub={
            st?.session.violations_caught
              ? `${st.session.violations_caught} violations caught`
              : "via compression"
          }
          color="amber"
        />
      </div>

      {/* ── Two-Column: Process Details + Skills ─────────────────────── */}
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Process Details */}
        <section className="flex-1 glass-panel rounded-xl p-5">
          <h2 className="section-label text-violet-500 flex items-center gap-2">
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
              />
            </svg>
            Process Details
          </h2>
          {statusQ.isError ? (
            <p className="mt-4 text-error text-sm">Could not reach proxy.</p>
          ) : (
            <dl className="mt-4">
              <DetailRow
                label="Status"
                value={st ? statusLabel(st.status) : undefined}
                mono={false}
              />
              <DetailRow label="Process ID" value={st?.pid} copyable />
              <DetailRow label="Mode" value={st?.mode} />
              <DetailRow label="Dashboard Port" value={st?.dashboard_port} />
              <DetailRow label="IDE" value={st?.ide || "None detected"} />
              <DetailRow
                label="Uptime"
                value={st ? formatUptime(st.uptime_s) : undefined}
              />
              <DetailRow label="Working Directory" value={st?.cwd} copyable />
              <DetailRow
                label="Session Started"
                value={
                  st?.session.started_at
                    ? new Date(st.session.started_at).toLocaleString()
                    : undefined
                }
              />
            </dl>
          )}
        </section>

        {/* Installed Skills */}
        <section className="flex-1 glass-panel rounded-xl p-5">
          <h2 className="section-label text-cyan-500 flex items-center gap-2">
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            Installed Skills
          </h2>
          <p className="mt-1 t-tertiary text-xs">
            Agent skills installed in this repository via{" "}
            <span className="font-mono">unerr install</span>.
          </p>
          {configQ.isError ? (
            <p className="mt-4 text-error text-sm">Could not load config.</p>
          ) : cfg?.skills_installed?.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {cfg.skills_installed.map((s) => (
                <SkillPill key={s} name={s} />
              ))}
            </div>
          ) : (
            <div className="mt-6 flex flex-col items-center py-6 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 ring-1 ring-amber-500/20">
                <svg
                  aria-hidden="true"
                  className="h-5 w-5 text-amber-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <p className="text-sm text-foreground">No skills installed</p>
              <p className="mt-1 t-tertiary text-xs max-w-[240px]">
                Run{" "}
                <code className="font-mono text-violet-400">
                  unerr install &lt;agent&gt;
                </code>{" "}
                to install skills for your IDE.
              </p>
            </div>
          )}

          {/* Graph Stats Summary */}
          <div className="mt-6 border-t border-border-subtle/50 pt-5">
            <h3 className="section-label text-violet-500 flex items-center gap-2">
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
                />
              </svg>
              Graph Intelligence
            </h3>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-violet-500/5 p-3 text-center ring-1 ring-violet-500/10">
                <p className="text-xl font-mono font-bold text-violet-400">
                  {st ? formatNumber(st.graph.entities) : "—"}
                </p>
                <p className="t-tertiary text-[10px] uppercase tracking-wide">
                  Entities
                </p>
              </div>
              <div className="rounded-lg bg-cyan-500/5 p-3 text-center ring-1 ring-cyan-500/10">
                <p className="text-xl font-mono font-bold text-cyan-400">
                  {st ? formatNumber(st.graph.edges) : "—"}
                </p>
                <p className="t-tertiary text-[10px] uppercase tracking-wide">
                  Edges
                </p>
              </div>
              <div className="rounded-lg bg-emerald-500/5 p-3 text-center ring-1 ring-emerald-500/10">
                <p className="text-xl font-mono font-bold text-emerald-400">
                  {st?.graph.rules ?? "—"}
                </p>
                <p className="t-tertiary text-[10px] uppercase tracking-wide">
                  Rules
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ── Repository Configuration ─────────────────────────────────── */}
      <section className="glass-panel rounded-xl p-5">
        <div className="flex items-center justify-between">
          <h2 className="section-label text-emerald-500 flex items-center gap-2">
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            Repository Configuration
          </h2>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-mono text-emerald-400 ring-1 ring-emerald-500/20">
            .unerr/config.json
          </span>
        </div>
        <p className="mt-1 t-tertiary text-xs">
          Per-repository configuration. Edit{" "}
          <code className="font-mono text-emerald-400">.unerr/config.json</code>{" "}
          directly to modify settings.
        </p>
        <div className="mt-4">
          {configQ.isError ? (
            <p className="text-error text-sm">Could not load configuration.</p>
          ) : (
            <ConfigSection config={cfg?.repo_config ?? {}} />
          )}
        </div>
      </section>

      {/* ── Session Performance ───────────────────────────────────────── */}
      <section className="glass-panel rounded-xl p-5">
        <h2 className="section-label text-amber-500 flex items-center gap-2">
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
            />
          </svg>
          Session Performance
        </h2>
        <p className="mt-1 t-tertiary text-xs">
          Live metrics for the current proxy session. Resets when the process
          restarts.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-lg border border-border-subtle/50 p-3">
            <p className="t-tertiary text-[10px] uppercase tracking-wide">
              Tool Calls
            </p>
            <p className="mt-1 text-xl font-mono font-bold text-foreground">
              {st ? formatNumber(st.session.tool_calls) : "—"}
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle/50 p-3">
            <p className="t-tertiary text-[10px] uppercase tracking-wide">
              Tokens Saved
            </p>
            <p className="mt-1 text-xl font-mono font-bold text-foreground">
              {st ? formatNumber(st.session.tokens_saved) : "—"}
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle/50 p-3">
            <p className="t-tertiary text-[10px] uppercase tracking-wide">
              Violations
            </p>
            <p className="mt-1 text-xl font-mono font-bold text-foreground">
              {st?.session.violations_caught ?? "—"}
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle/50 p-3">
            <p className="t-tertiary text-[10px] uppercase tracking-wide">
              Session Start
            </p>
            <p className="mt-1 text-xs font-mono text-foreground leading-relaxed">
              {st?.session.started_at
                ? new Date(st.session.started_at).toLocaleTimeString()
                : "—"}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
