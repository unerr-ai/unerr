/**
 * Cascade Guard — "what was I protected from."
 *
 * A feed of the pre-edit guard firings, grouped by coding-agent session and
 * the prompt that triggered each one. Every firing expands to the actual
 * evidence: the changed entity, the kind of change, and the named callers that
 * would have broken. The page leads with concrete, inspectable instances (not a
 * bare count), tiers severity by real blast radius, and frames a quiet feed as
 * "active and watching" rather than empty — the design follows the trust
 * research in .internal (lead with the verifiable artifact, don't dramatize the
 * save, never color-only severity).
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

// ── Wire types (match src/server/routes/guard.ts) ───────────────────

interface CallerRef {
  file: string;
  entity: string;
  line: number;
  is_test: boolean;
}

interface CascadeEntity {
  entity: string;
  entity_key: string | null;
  change_type: string;
  total_at_risk: number;
  callers: CallerRef[];
  callers_truncated: number;
}

interface BoundaryBreach {
  source_file: string;
  source_layer: string;
  target_layer: string;
  specifier: string;
}

interface Firing {
  id: number;
  ts: string;
  turn: number;
  type: "cascade_guard" | "boundary_violation_flagged";
  file_path: string | null;
  entities: CascadeEntity[];
  breaches: BoundaryBreach[];
  max_at_risk: number;
}

interface PromptGroup {
  prompt: string | null;
  prompt_ts: string | null;
  firings: Firing[];
}

interface SessionGroup {
  session_id: string;
  agent: string;
  started_at: string;
  last_at: string;
  firing_count: number;
  prompts: PromptGroup[];
}

interface FiringsResponse {
  data: {
    sessions: SessionGroup[];
    totals: {
      total_firings: number;
      cascade_firings: number;
      boundary_firings: number;
      recent_window: number;
      window_days: number;
    };
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function humanizeChange(change: string): string {
  return change.replace(/_/g, " ");
}

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Severity tier from blast radius. Color is never the only cue — each tier
 *  carries an icon and a word. Loud (red) is reserved for genuinely high
 *  fan-out so the feed doesn't train the reader to mute it. */
function severity(n: number): {
  label: string;
  icon: string;
  text: string;
  chip: string;
} {
  if (n >= 20)
    return {
      label: "high blast radius",
      icon: "▲",
      text: "text-error",
      chip: "bg-error/15 text-error",
    };
  if (n >= 8)
    return {
      label: "elevated",
      icon: "✦",
      text: "text-amber-300",
      chip: "bg-amber-500/15 text-amber-300",
    };
  return {
    label: "contained",
    icon: "✦",
    text: "text-cyan-300",
    chip: "bg-cyan-500/10 text-cyan-300",
  };
}

// ── Page ────────────────────────────────────────────────────────────

export function GuardPage() {
  const { url, queryKey } = useRepoApi();
  const q = useQuery({
    queryKey: queryKey(["guard", "firings"]),
    queryFn: () => fetchJson<FiringsResponse>(url("/api/guard/firings")),
    refetchInterval: 10_000,
  });

  if (q.isLoading) return <CardGridSkeleton />;

  const sessions = q.data?.data?.sessions ?? [];
  const totals = q.data?.data?.totals;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-foreground">Cascade Guard</h1>
        <p className="mt-1 text-sm t-secondary">
          Edits the agent was about to make to widely-used code — caught before
          they could silently break the callers that depend on them. Each firing
          shows the actual callers at risk, so you can check the save yourself.
        </p>
      </header>

      {totals && (
        <div className="mb-6 flex flex-wrap gap-3">
          <Stat
            value={totals.recent_window}
            label={`caught in the last ${totals.window_days} days`}
            accent="text-foreground"
          />
          <Stat
            value={totals.cascade_firings}
            label="breaking-change firings"
            accent="text-amber-300"
          />
          <Stat
            value={totals.boundary_firings}
            label="boundary-breach firings"
            accent="text-violet-300"
          />
          <Stat
            value={totals.total_firings}
            label="recorded all-time (context)"
            accent="t-tertiary"
          />
        </div>
      )}

      {sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-5">
          {sessions.map((s) => (
            <SessionBlock key={s.session_id} session={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  value,
  label,
  accent,
}: {
  value: number;
  label: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-white/3 px-4 py-3">
      <p className={`font-mono text-xl font-semibold tabular-nums ${accent}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] t-secondary">{label}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-border-subtle bg-white/3 px-6 py-10 text-center">
      <p className="text-sm font-medium text-emerald-400">
        Cascade Guard is active and watching.
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm t-secondary">
        Nothing risky has been caught yet. The guard checks every edit the agent
        makes to shared code; an empty feed means no breaking change has been
        attempted — that's the outcome you want.
      </p>
    </div>
  );
}

function SessionBlock({ session }: { session: SessionGroup }) {
  return (
    <section className="rounded-xl border border-border-subtle bg-card">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
            {session.agent}
          </span>
          <span className="font-mono text-[11px] t-tertiary">
            session {session.session_id.slice(0, 8)}
          </span>
        </div>
        <span className="font-mono text-[11px] tabular-nums t-tertiary">
          {session.firing_count} firing
          {session.firing_count === 1 ? "" : "s"} ·{" "}
          {relativeTime(session.last_at)}
        </span>
      </div>
      <div className="divide-y divide-border-subtle">
        {session.prompts.map((p, i) => (
          <PromptBlock key={p.prompt_ts ?? `none-${i}`} group={p} />
        ))}
      </div>
    </section>
  );
}

function PromptBlock({ group }: { group: PromptGroup }) {
  return (
    <div className="px-4 py-3">
      <p className="mb-2 text-[13px] text-foreground/90">
        {group.prompt ? (
          <>
            <span className="t-tertiary">prompt: </span>
            <span className="italic">"{group.prompt}"</span>
          </>
        ) : (
          <span className="t-tertiary italic">No captured prompt</span>
        )}
      </p>
      <div className="space-y-2">
        {group.firings.map((f) => (
          <FiringRow key={f.id} firing={f} />
        ))}
      </div>
    </div>
  );
}

function FiringRow({ firing }: { firing: Firing }) {
  const [open, setOpen] = useState(false);
  const isBoundary = firing.type === "boundary_violation_flagged";
  const sev = severity(firing.max_at_risk);
  const fileLabel = firing.file_path
    ? basename(firing.file_path)
    : "unknown file";

  return (
    <div className="rounded-lg border border-border-subtle bg-white/3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className={`shrink-0 ${isBoundary ? "text-violet-300" : sev.text}`}
        >
          {isBoundary ? "▦" : sev.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-mono text-[12px] text-foreground">
            {isBoundary ? "Boundary breach" : "Blocked edit"} · {fileLabel}
          </span>
          {!isBoundary && firing.entities[0] && (
            <span className="ml-1 font-mono text-[12px] t-secondary">
              {firing.entities[0].entity}()
              {firing.entities.length > 1
                ? ` +${firing.entities.length - 1} more`
                : ""}
            </span>
          )}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
            isBoundary ? "bg-violet-500/15 text-violet-300" : sev.chip
          }`}
        >
          {isBoundary
            ? `${firing.breaches.length} breach${
                firing.breaches.length === 1 ? "" : "es"
              }`
            : `${firing.max_at_risk} callers · ${sev.label}`}
        </span>
        <span className="shrink-0 font-mono text-[10px] t-tertiary">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="border-t border-border-subtle px-3 py-2.5">
          {isBoundary
            ? firing.breaches.map((b) => (
                <div
                  key={`${b.source_file}→${b.target_layer}:${b.specifier}`}
                  className="mb-2 last:mb-0"
                >
                  <p className="font-mono text-[11px] text-foreground/80">
                    {basename(b.source_file)}{" "}
                    <span className="t-tertiary">({b.source_layer})</span>{" "}
                    <span className="text-violet-300">→ {b.target_layer}</span>
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] t-tertiary">
                    imports {b.specifier}
                  </p>
                </div>
              ))
            : firing.entities.map((e, i) => (
                <CascadeDetail
                  key={e.entity_key ?? `${e.entity}-${i}`}
                  entity={e}
                />
              ))}
        </div>
      )}
    </div>
  );
}

function CascadeDetail({ entity }: { entity: CascadeEntity }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="font-mono text-[11px] text-foreground/90">
        {entity.entity}()
        <span className="ml-1.5 t-tertiary">
          {humanizeChange(entity.change_type)}
        </span>
      </p>
      {entity.callers.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {entity.callers.map((c, i) => (
            <li
              key={`${c.file}:${c.line}-${i}`}
              className="font-mono text-[11px] t-secondary"
            >
              <span className="t-tertiary">├ </span>
              {basename(c.file)}:{c.entity}
              {c.is_test && (
                <span className="ml-1 rounded bg-white/5 px-1 text-[9px] t-tertiary">
                  test
                </span>
              )}
            </li>
          ))}
          {entity.callers_truncated > 0 && (
            <li className="font-mono text-[11px] t-tertiary">
              └ +{entity.callers_truncated} more caller
              {entity.callers_truncated === 1 ? "" : "s"}
            </li>
          )}
        </ul>
      ) : (
        <p className="mt-1 font-mono text-[11px] t-tertiary">
          {entity.total_at_risk} caller
          {entity.total_at_risk === 1 ? "" : "s"} at risk (names not recorded
          for this firing)
        </p>
      )}
    </div>
  );
}
