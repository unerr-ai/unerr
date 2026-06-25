import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────

interface FactRow {
  fact_id: string;
  fact_type: string;
  scope: string;
  subject: string;
  content: string;
  base_confidence: number;
  effective_confidence: number;
  reinforcement_count: number;
  created_at: number;
  last_reinforced_at: number;
  source: string;
  // Richer provenance/state fields from /api/facts-v2 (M1 merge). Optional so
  // any consumer that pre-dates the merge keeps compiling.
  source_quote?: string | null;
  applies_to?: string[];
  last_contradicted_at?: number;
  disabled?: boolean;
  drift?: boolean;
}

// /api/facts-v2/list response — the richer Sidekick Memory API the merged
// Project Memory page standardizes on (M1). Rows are a superset of the legacy
// /api/facts shape, adding source_quote / applies_to / disabled / drift.
interface FactsResponse {
  data: FactRow[];
  total: number;
}

interface HealthResponse {
  total: number;
  active: number;
  decayed: number;
  by_type: Record<string, number>;
  avg_confidence: number;
}

// /api/facts-v2/injection-preview response (M4). Mirrors exactly what unerr
// injects when an agent touches `file` — built from the same recallForFile +
// getEntityKeysForFile path the live injector uses, so the preview never lies.
interface InjectionPreviewResponse {
  file: string | null;
  // The verbatim strings the agent receives, e.g. "[convention] no fs writes".
  injected: string[];
  facts: {
    fact_id: string;
    fact_type: string;
    scope: string;
    subject: string;
    content: string;
    source: string;
    effective_confidence: number;
  }[];
  entity_keys: string[];
  // False in parse/standalone mode where the file→entity resolver is unwired;
  // the preview then covers file-scope + project-negative facts only.
  resolver_available: boolean;
  message?: string;
}

// ── Human-friendly mapping ──────────────────────────────────────────

const CATEGORY_META: Record<
  string,
  {
    label: string;
    icon: string;
    color: string;
    emptyMsg: string;
    description: string;
  }
> = {
  semantic: {
    label: "Conventions your code follows",
    icon: "◆",
    color: "violet",
    description:
      "Patterns unerr detected in your codebase — naming styles, import order, file structure",
    emptyMsg:
      "No conventions detected yet. unerr discovers these as it indexes your project.",
  },
  procedural: {
    label: "Files you work on most",
    icon: "⚡",
    color: "cyan",
    description:
      "The files your agent keeps coming back to — unerr prioritizes these in context",
    emptyMsg:
      "Not enough data yet. After a few sessions, unerr will spot your most-touched files.",
  },
  negative: {
    label: "Mistakes to avoid",
    icon: "✗",
    color: "red",
    description:
      "Things that went wrong before — unerr warns your agent so it doesn't repeat them",
    emptyMsg: "No past mistakes recorded. That's a good thing.",
  },
  episodic: {
    label: "Change outcomes",
    icon: "◎",
    color: "amber",
    description:
      "Which changes stuck and which got reverted — so your agent knows what works",
    emptyMsg: "No change history tracked yet.",
  },
  convention: {
    label: "Rules you've taught unerr",
    icon: "▸",
    color: "emerald",
    description:
      "Rules you explicitly told unerr to remember — these override everything else",
    emptyMsg:
      'No rules taught yet. Tell your agent "remember: always use camelCase" and unerr will enforce it.',
  },
};

function humanizeContent(fact: FactRow): string {
  // Strip the jargon prefixes and make content readable
  let c = fact.content;
  // "Naming convention: camelCase functions (96% confidence, 1625 entities)"
  // → "camelCase functions — 1625 entities follow this pattern"
  c = c.replace(/^Naming convention:\s*/, "");
  c = c.replace(/^Structure pattern:\s*/, "");
  c = c.replace(/^Import convention:\s*/, "");
  c = c.replace(/^Convention:\s*/, "");
  // Remove the "(X% confidence, Y entities)" suffix — we show confidence visually
  c = c.replace(/\s*\(\d+%\s*confidence(?:,\s*\d+\s*entities?)?\)/, "");
  // "src/file.ts is accessed in 85% of sessions (hot file)" → "Accessed in 85% of sessions"
  if (fact.fact_type === "procedural" && c.includes("is accessed in")) {
    const match = c.match(/is accessed in (\d+)% of sessions/);
    if (match) return `Accessed in ${match[1]}% of your coding sessions`;
  }
  if (fact.fact_type === "procedural" && c.includes("revert rate")) {
    const match = c.match(/has a (\d+)% revert rate/);
    if (match)
      return `${match[1]}% of changes here get reverted — handle with care`;
  }
  return c;
}

function formatAge(createdAt: number): string {
  const ms = Date.now() - createdAt;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function shortPath(subject: string): string {
  // "src/proxy/mcp-server.ts" → "mcp-server.ts"
  const parts = subject.split("/");
  return parts.length > 1 ? parts[parts.length - 1]! : subject;
}

function dirPath(subject: string): string {
  // "src/proxy/mcp-server.ts" → "src/proxy/"
  const parts = subject.split("/");
  return parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : "";
}

// ── Confidence bar color ────────────────────────────────────────────

function confidenceBarColor(conf: number): string {
  if (conf >= 0.7) return "bg-emerald-400";
  if (conf >= 0.4) return "bg-amber-400";
  return "bg-red-400";
}

function confidenceLabel(conf: number): string {
  if (conf >= 0.7) return "High certainty";
  if (conf >= 0.4) return "Likely true";
  return "Needs review";
}

// ── Component ───────────────────────────────────────────────────────

export function FactsPage() {
  const qc = useQueryClient();
  const { url, queryKey } = useRepoApi();
  const [showAllFacts, setShowAllFacts] = useState(false);
  const [selectedFact, setSelectedFact] = useState<FactRow | null>(null);
  // "All memories" manage-view filters (M3).
  const [manageSearch, setManageSearch] = useState("");
  const [manageSource, setManageSource] = useState<"all" | "user_fed" | "auto">(
    "all"
  );
  const [manageStatus, setManageStatus] = useState<
    "all" | "active" | "disabled" | "drifting"
  >("all");
  const [managePage, setManagePage] = useState(0);

  const healthQ = useQuery({
    queryKey: queryKey(["facts", "health"]),
    queryFn: () => fetchJson<HealthResponse>(url("/api/facts/health")),
    refetchInterval: 30_000,
  });

  const factsQ = useQuery({
    queryKey: queryKey(["facts", "list", "all"]),
    queryFn: () =>
      fetchJson<FactsResponse>(
        url(
          `/api/facts-v2/list?${new URLSearchParams({ source: "all", min_confidence: "0" })}`
        )
      ),
    refetchInterval: 15_000,
  });

  const reinforceMut = useMutation({
    mutationFn: (factId: string) =>
      fetchJson(url(`/api/facts-v2/${factId}/reinforce`), { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(["facts"]) });
    },
  });

  const dismissMut = useMutation({
    mutationFn: (factId: string) =>
      fetchJson(url(`/api/facts-v2/${factId}`), { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(["facts"]) });
    },
  });

  // Folded in from Sidekick Memory (M2): inline content edit + disable.
  // Re-enable reuses reinforceMut (restores confidence above the disabled
  // threshold), matching the facts-v2 route semantics.
  const editMut = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      fetchJson(url(`/api/facts-v2/${id}`), {
        method: "PATCH",
        body: JSON.stringify({ content }),
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(["facts"]) });
    },
  });

  const disableMut = useMutation({
    mutationFn: (factId: string) =>
      fetchJson(url(`/api/facts-v2/${factId}/disable`), { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(["facts"]) });
    },
  });

  const health = healthQ.data;
  const facts = factsQ.data?.data ?? [];

  // Curated categories show active memories only; disabled ones live in the
  // "All memories" manage view below (M3).
  const activeFacts = facts.filter((f) => !f.disabled);

  // Group active facts by type
  const grouped = activeFacts.reduce<Record<string, FactRow[]>>((acc, f) => {
    const key = f.fact_type;
    let bucket = acc[key];
    if (!bucket) {
      bucket = [];
      acc[key] = bucket;
    }
    bucket.push(f);
    return acc;
  }, {});

  // "All memories" manage view — full inventory incl. disabled, filterable.
  const manageQuery = manageSearch.trim().toLowerCase();
  const allManageFacts = useMemo(
    () =>
      facts.filter((f) => {
        if (manageSource === "user_fed" && f.source !== "user_fed")
          return false;
        if (manageSource === "auto" && f.source === "user_fed") return false;
        if (manageStatus === "active" && f.disabled) return false;
        if (manageStatus === "disabled" && !f.disabled) return false;
        if (manageStatus === "drifting" && !f.drift) return false;
        if (
          manageQuery &&
          !`${f.subject} ${f.content} ${f.source_quote ?? ""}`
            .toLowerCase()
            .includes(manageQuery)
        )
          return false;
        return true;
      }),
    [facts, manageSource, manageStatus, manageQuery]
  );
  const managePageCount = Math.max(
    1,
    Math.ceil(allManageFacts.length / TABLE_ROWS_PER_PAGE)
  );
  const safeManagePage = Math.min(managePage, managePageCount - 1);
  const manageFacts = allManageFacts.slice(
    safeManagePage * TABLE_ROWS_PER_PAGE,
    (safeManagePage + 1) * TABLE_ROWS_PER_PAGE
  );

  const semanticFacts = grouped.semantic ?? [];
  const proceduralFacts = grouped.procedural ?? [];
  const negativeFacts = grouped.negative ?? [];
  const episodicFacts = grouped.episodic ?? [];
  const conventionFacts = grouped.convention ?? [];

  const isLoading = healthQ.isLoading || factsQ.isLoading;

  return (
    <div className="flex flex-col gap-8">
      {/* ── Section 1: What unerr knows ────────────────────────── */}
      <section className="el-raised rounded-lg p-6 border-l-4 border-violet-500/60">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="flex-1 min-w-0">
            <h2 className="text-foreground font-semibold text-base">
              What unerr has learned about your project
            </h2>
            <p className="t-tertiary text-xs mt-1 max-w-xl leading-relaxed">
              unerr watches how you code — which files you keep editing, what
              conventions your codebase follows, and what went wrong before.
              Every piece of knowledge here is automatically given to your AI
              agent so it makes fewer mistakes.
            </p>
          </div>
          {!isLoading && health && health.total > 0 && (
            <div className="text-right shrink-0">
              <p className="text-violet-400 font-mono font-bold text-4xl">
                {health.total}
              </p>
              <p className="t-tertiary text-[10px] mt-1">things remembered</p>
            </div>
          )}
        </div>
        {isLoading ? (
          <div className="mt-4">
            <CardGridSkeleton n={4} />
          </div>
        ) : health ? (
          <div className="mt-4 grid gap-3 grid-cols-2 lg:grid-cols-4">
            <MiniStat
              label="Rules you taught"
              value={health.by_type.convention ?? 0}
              color="text-emerald-400"
            />
            <MiniStat
              label="Conventions found"
              value={health.by_type.semantic ?? 0}
              color="text-violet-400"
            />
            <MiniStat
              label="Frequently edited files"
              value={health.by_type.procedural ?? 0}
              color="text-cyan-400"
            />
            <MiniStat
              label="Mistakes to avoid"
              value={
                (health.by_type.negative ?? 0) + (health.by_type.episodic ?? 0)
              }
              color="text-red-400"
            />
          </div>
        ) : null}
      </section>

      {/* ── Try it — see what your agent sees ──────────────────── */}
      <InjectionPreviewPanel
        onSelectFactId={(id) => {
          const f = facts.find((x) => x.fact_id === id);
          if (f) setSelectedFact(f);
        }}
      />

      {/* ── Section 2: Explicit Rules (convention) ───────────────── */}
      <CategorySection
        meta={CATEGORY_META.convention!}
        facts={conventionFacts}
        renderCard={(f) => (
          <PatternCard
            key={f.fact_id}
            fact={f}
            onSelect={() => setSelectedFact(f)}
            onReinforce={() => reinforceMut.mutate(f.fact_id)}
            onDismiss={() => dismissMut.mutate(f.fact_id)}
            isPending={reinforceMut.isPending || dismissMut.isPending}
          />
        )}
        isLoading={isLoading}
      />

      {/* ── Section 3: Lessons Learned (negative + episodic) ────── */}
      <CategorySection
        meta={CATEGORY_META.negative!}
        facts={[...negativeFacts, ...episodicFacts]}
        renderCard={(f) => (
          <LessonCard
            key={f.fact_id}
            fact={f}
            onSelect={() => setSelectedFact(f)}
            onReinforce={() => reinforceMut.mutate(f.fact_id)}
            onDismiss={() => dismissMut.mutate(f.fact_id)}
            isPending={reinforceMut.isPending || dismissMut.isPending}
          />
        )}
        isLoading={isLoading}
      />

      {/* ── Section 4: Coding Patterns (semantic) ────────────────── */}
      <CategorySection
        meta={CATEGORY_META.semantic!}
        facts={semanticFacts}
        renderCard={(f) => (
          <PatternCard
            key={f.fact_id}
            fact={f}
            onSelect={() => setSelectedFact(f)}
            onReinforce={() => reinforceMut.mutate(f.fact_id)}
            onDismiss={() => dismissMut.mutate(f.fact_id)}
            isPending={reinforceMut.isPending || dismissMut.isPending}
          />
        )}
        isLoading={isLoading}
      />

      {/* ── Section 5: Hot Files (procedural) ────────────────────── */}
      <CategorySection
        meta={CATEGORY_META.procedural!}
        facts={proceduralFacts}
        renderCard={(f) => (
          <HotFileCard
            key={f.fact_id}
            fact={f}
            onSelect={() => setSelectedFact(f)}
            onReinforce={() => reinforceMut.mutate(f.fact_id)}
            onDismiss={() => dismissMut.mutate(f.fact_id)}
            isPending={reinforceMut.isPending || dismissMut.isPending}
          />
        )}
        isLoading={isLoading}
      />

      {/* ── All memories (manage view) ───────────────────────────── */}
      {facts.length > 0 && (
        <section>
          <button
            type="button"
            className="flex items-center gap-2 text-xs t-tertiary hover:text-foreground transition-colors"
            onClick={() => setShowAllFacts(!showAllFacts)}
          >
            <span
              className="transition-transform"
              style={{
                transform: showAllFacts ? "rotate(90deg)" : "rotate(0deg)",
              }}
            >
              ▸
            </span>
            {showAllFacts ? "Hide" : "Show"} all {facts.length} memories
          </button>
          {showAllFacts && (
            <div className="mt-3 flex flex-col gap-3">
              {/* Filter / segment bar */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="search"
                  value={manageSearch}
                  onChange={(e) => {
                    setManageSearch(e.target.value);
                    setManagePage(0);
                  }}
                  placeholder="Search memories…"
                  className="flex-1 min-w-[160px] rounded-lg border border-border-subtle bg-surface-overlay px-3 py-1.5 text-xs text-foreground placeholder:t-tertiary"
                />
                <SegmentGroup
                  value={manageSource}
                  onChange={(v) => {
                    setManageSource(v);
                    setManagePage(0);
                  }}
                  options={[
                    ["all", "All"],
                    ["user_fed", "Your rules"],
                    ["auto", "Auto-learned"],
                  ]}
                />
                <SegmentGroup
                  value={manageStatus}
                  onChange={(v) => {
                    setManageStatus(v);
                    setManagePage(0);
                  }}
                  options={[
                    ["all", "Any status"],
                    ["active", "Active"],
                    ["disabled", "Turned off"],
                    ["drifting", "Possibly outdated"],
                  ]}
                />
              </div>

              <div className="glass-panel rounded-xl p-4 overflow-x-auto custom-scrollbar">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-border-subtle t-tertiary uppercase">
                      <th className="py-2 pr-3 font-medium">Kind</th>
                      <th className="py-2 pr-3 font-medium">About</th>
                      <th className="py-2 pr-3 font-medium">
                        What unerr remembers
                      </th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                      <th className="py-2 pr-3 font-medium">Certainty</th>
                      <th className="py-2 pr-3 font-medium">Learned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manageFacts.map((f) => (
                      <tr
                        key={f.fact_id}
                        className="border-b border-border-subtle cursor-pointer hover:bg-surface-overlay/40 transition-colors"
                        onClick={() => setSelectedFact(f)}
                      >
                        <td className="py-2 pr-3">
                          <TypePill type={f.fact_type} />
                        </td>
                        <td
                          className="py-2 pr-3 font-mono max-w-[160px] truncate"
                          title={f.subject}
                        >
                          {f.subject}
                        </td>
                        <td
                          className="py-2 pr-3 max-w-[280px] truncate t-secondary"
                          title={f.content}
                        >
                          {f.content}
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex gap-1">
                            {f.drift && (
                              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
                                outdated
                              </span>
                            )}
                            {f.disabled ? (
                              <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[9px] font-medium text-red-300">
                                off
                              </span>
                            ) : (
                              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300">
                                active
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 pr-3 font-mono tabular-nums">
                          {(f.effective_confidence * 100).toFixed(0)}%
                        </td>
                        <td className="py-2 pr-3 t-tertiary tabular-nums">
                          {formatAge(f.created_at)}
                        </td>
                      </tr>
                    ))}
                    {manageFacts.length === 0 && (
                      <tr>
                        <td
                          colSpan={6}
                          className="py-6 text-center t-tertiary italic"
                        >
                          No memories match these filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Table pagination */}
              {allManageFacts.length > TABLE_ROWS_PER_PAGE && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-[10px] t-tertiary tabular-nums">
                    {safeManagePage * TABLE_ROWS_PER_PAGE + 1}–
                    {Math.min(
                      (safeManagePage + 1) * TABLE_ROWS_PER_PAGE,
                      allManageFacts.length
                    )}{" "}
                    of {allManageFacts.length}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={safeManagePage === 0}
                      onClick={() => setManagePage((p) => Math.max(0, p - 1))}
                      className="rounded-md px-2 py-1 text-[11px] font-medium t-secondary bg-surface-overlay hover:text-foreground transition-colors disabled:opacity-30"
                    >
                      ← Prev
                    </button>
                    <span className="flex items-center px-2 text-[10px] t-tertiary tabular-nums">
                      {safeManagePage + 1} / {managePageCount}
                    </span>
                    <button
                      type="button"
                      disabled={safeManagePage >= managePageCount - 1}
                      onClick={() =>
                        setManagePage((p) =>
                          Math.min(managePageCount - 1, p + 1)
                        )
                      }
                      className="rounded-md px-2 py-1 text-[11px] font-medium t-secondary bg-surface-overlay hover:text-foreground transition-colors disabled:opacity-30"
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Detail Modal ────────────────────────────────────────── */}
      {selectedFact && (
        <MemoryDetailModal
          fact={selectedFact}
          allFacts={facts}
          onClose={() => setSelectedFact(null)}
          onReinforce={() => {
            reinforceMut.mutate(selectedFact.fact_id);
            setSelectedFact(null);
          }}
          onDismiss={() => {
            dismissMut.mutate(selectedFact.fact_id);
            setSelectedFact(null);
          }}
          onEdit={(content) => {
            editMut.mutate({ id: selectedFact.fact_id, content });
            setSelectedFact(null);
          }}
          onDisable={() => {
            disableMut.mutate(selectedFact.fact_id);
            setSelectedFact(null);
          }}
          isPending={
            reinforceMut.isPending ||
            dismissMut.isPending ||
            editMut.isPending ||
            disableMut.isPending
          }
        />
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

// Injection preview by file (M4). Enter a file path → see the EXACT memory
// unerr attaches when an agent touches that file. Read-only: the route reuses
// the live injector's recallForFile + entity-key resolver, so nothing here
// changes the proxy/MCP execution path.
function InjectionPreviewPanel({
  onSelectFactId,
}: {
  onSelectFactId: (factId: string) => void;
}) {
  const { url, queryKey } = useRepoApi();
  const [fileInput, setFileInput] = useState("");
  const [submittedFile, setSubmittedFile] = useState("");

  const previewQ = useQuery({
    queryKey: queryKey(["facts", "injection-preview", submittedFile]),
    queryFn: () =>
      fetchJson<InjectionPreviewResponse>(
        url(
          `/api/facts-v2/injection-preview?${new URLSearchParams({ file: submittedFile })}`
        )
      ),
    enabled: submittedFile.length > 0,
  });

  const preview = previewQ.data;

  return (
    <section className="glass-panel rounded-xl p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            Try it — see what your agent sees
          </h2>
          <p className="mt-1 text-sm t-secondary leading-relaxed">
            Type any file path to preview the exact knowledge unerr gives your
            agent when it works on that file. This is the real thing, not a
            simulation.
          </p>
        </div>
      </div>

      <form
        className="mt-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmittedFile(fileInput.trim());
        }}
      >
        <input
          type="text"
          value={fileInput}
          onChange={(e) => setFileInput(e.target.value)}
          placeholder="src/proxy/proxy.ts"
          spellCheck={false}
          className="flex-1 min-w-[220px] rounded-lg border border-border-subtle bg-surface-overlay px-3 py-1.5 font-mono text-xs text-foreground placeholder:t-tertiary"
        />
        <button
          type="submit"
          disabled={fileInput.trim().length === 0}
          className="rounded-lg border border-border-subtle bg-surface-overlay px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-overlay/60 disabled:opacity-40"
        >
          Preview
        </button>
      </form>

      {submittedFile.length > 0 && (
        <div className="mt-4">
          {previewQ.isLoading ? (
            <p className="text-xs t-tertiary italic">Resolving memories…</p>
          ) : previewQ.isError ? (
            <p className="text-xs text-red-300">
              Could not load injection preview for{" "}
              <span className="font-mono">{submittedFile}</span>.
            </p>
          ) : preview ? (
            preview.injected.length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-surface-overlay/40 p-4">
                <p className="text-xs t-secondary">
                  unerr doesn't have any knowledge about{" "}
                  <span className="font-mono t-tertiary">{submittedFile}</span>{" "}
                  yet. As you work on this file, unerr will learn its
                  conventions, track changes, and remember past issues.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {/* The verbatim block the agent's context receives. */}
                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest t-tertiary">
                    What your agent sees when it opens this file
                  </p>
                  <pre className="overflow-x-auto custom-scrollbar rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 font-mono text-[11px] leading-relaxed text-violet-100 whitespace-pre-wrap">
                    {preview.injected.join("\n")}
                  </pre>
                </div>

                {/* Clickable source rows → existing detail modal. */}
                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest t-tertiary">
                    Knowledge sources ({preview.facts.length})
                  </p>
                  <div className="flex flex-col gap-1">
                    {preview.facts.map((f) => (
                      <button
                        key={f.fact_id}
                        type="button"
                        onClick={() => onSelectFactId(f.fact_id)}
                        className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-overlay/40 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-overlay/70"
                      >
                        <TypePill type={f.fact_type} />
                        <span
                          className="flex-1 min-w-0 truncate t-secondary"
                          title={f.content}
                        >
                          {f.content}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Transparency footer: scope resolution + degraded mode. */}
                <p className="text-[10px] t-tertiary">
                  {preview.resolver_available
                    ? `Found ${preview.entity_keys.length} function${
                        preview.entity_keys.length === 1 ? "" : "s"
                      } in this file with relevant knowledge.`
                    : "Showing file-level and project-wide knowledge only."}
                </p>
              </div>
            )
          ) : null}
        </div>
      )}
    </section>
  );
}

function MiniStat({
  label,
  value,
  color,
}: { label: string; value: number; color: string }) {
  return (
    <div className="glass-card rounded-lg px-3 py-2.5">
      <p className="text-[10px] t-tertiary uppercase tracking-wide font-medium">
        {label}
      </p>
      <p className={`text-xl font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

/** Compact segmented toggle used by the "All memories" manage filter bar. */
function SegmentGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="flex gap-0.5 rounded-lg bg-surface-overlay p-0.5">
      {options.map(([val, label]) => (
        <button
          key={val}
          type="button"
          onClick={() => onChange(val)}
          className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
            value === val
              ? "bg-violet-500/25 text-violet-200"
              : "t-tertiary hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const CARDS_PER_PAGE = 6;
const TABLE_ROWS_PER_PAGE = 15;

function CategorySection({
  meta,
  facts,
  renderCard,
  isLoading,
}: {
  meta: (typeof CATEGORY_META)[string];
  facts: FactRow[];
  renderCard: (f: FactRow) => React.ReactNode;
  isLoading: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(CARDS_PER_PAGE);

  if (isLoading) {
    return (
      <section>
        <h2 className="section-label text-violet-500">{meta.label}</h2>
        <div className="mt-3">
          <CardGridSkeleton n={3} />
        </div>
      </section>
    );
  }

  const shown = facts.slice(0, visibleCount);
  const remaining = facts.length - visibleCount;
  const hasMore = remaining > 0;
  const isExpanded = visibleCount >= facts.length;

  return (
    <section>
      <div className="flex items-baseline gap-3">
        <h2
          className="section-label"
          style={{ color: `var(--color-${meta.color}-400, currentColor)` }}
        >
          <span className="mr-1.5 opacity-60">{meta.icon}</span>
          {meta.label}
        </h2>
        {facts.length > 0 && (
          <span className="text-[10px] t-tertiary tabular-nums">
            {facts.length}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs t-tertiary">{meta.description}</p>
      {facts.length === 0 ? (
        <p className="mt-4 text-sm t-tertiary italic">{meta.emptyMsg}</p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map(renderCard)}
          </div>
          {(hasMore || isExpanded) && facts.length > CARDS_PER_PAGE && (
            <div className="mt-3 flex justify-center">
              {hasMore ? (
                <button
                  type="button"
                  onClick={() =>
                    setVisibleCount((c) =>
                      Math.min(c + CARDS_PER_PAGE, facts.length)
                    )
                  }
                  className="rounded-lg border border-border-subtle bg-surface-overlay px-4 py-1.5 text-xs font-medium t-secondary hover:text-foreground transition-colors"
                >
                  Show {Math.min(remaining, CARDS_PER_PAGE)} more of {remaining}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setVisibleCount(CARDS_PER_PAGE)}
                  className="rounded-lg border border-border-subtle bg-surface-overlay px-4 py-1.5 text-xs font-medium t-tertiary hover:text-foreground transition-colors"
                >
                  Show less
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PatternCard({
  fact,
  onSelect,
  onReinforce,
  onDismiss,
  isPending,
}: {
  fact: FactRow;
  onSelect: () => void;
  onReinforce: () => void;
  onDismiss: () => void;
  isPending: boolean;
}) {
  const content = humanizeContent(fact);
  const conf = fact.effective_confidence;

  return (
    <div
      className={`glass-card rounded-xl p-4 flex flex-col gap-3 cursor-pointer hover:ring-1 hover:ring-violet-500/30 transition-all ${fact.disabled ? "opacity-60" : ""}`}
      onClick={onSelect}
    >
      <DriftDisabledBadges fact={fact} />
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground leading-snug truncate">
          {fact.subject}
        </h3>
        <CardActions
          onReinforce={onReinforce}
          onDismiss={onDismiss}
          isPending={isPending}
        />
      </div>
      <p className="text-xs t-secondary leading-relaxed">{content}</p>
      <ConfidenceBar confidence={conf} />
      <div className="flex items-center justify-between text-[10px] t-tertiary">
        <span>Learned {formatAge(fact.created_at)}</span>
        {fact.reinforcement_count > 0 && (
          <span>
            Confirmed {fact.reinforcement_count} time
            {fact.reinforcement_count === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}

function HotFileCard({
  fact,
  onSelect,
  onReinforce,
  onDismiss,
  isPending,
}: {
  fact: FactRow;
  onSelect: () => void;
  onReinforce: () => void;
  onDismiss: () => void;
  isPending: boolean;
}) {
  const content = humanizeContent(fact);
  const pctMatch = fact.content.match(/(\d+)% of sessions/);
  const sessionPct = pctMatch ? Number.parseInt(pctMatch[1]!, 10) : 0;

  return (
    <div
      className={`glass-card rounded-xl p-4 flex flex-col gap-3 cursor-pointer hover:ring-1 hover:ring-cyan-500/30 transition-all ${fact.disabled ? "opacity-60" : ""}`}
      onClick={onSelect}
    >
      <DriftDisabledBadges fact={fact} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            className="text-sm font-medium text-foreground truncate"
            title={fact.subject}
          >
            {shortPath(fact.subject)}
          </h3>
          <p
            className="text-[10px] font-mono t-tertiary truncate"
            title={fact.subject}
          >
            {dirPath(fact.subject)}
          </p>
        </div>
        <CardActions
          onReinforce={onReinforce}
          onDismiss={onDismiss}
          isPending={isPending}
        />
      </div>
      <p className="text-xs t-secondary">{content}</p>
      {sessionPct > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
            <div
              className="h-full rounded-full bg-cyan-400 transition-all duration-500"
              style={{ width: `${sessionPct}%` }}
            />
          </div>
          <span className="text-[10px] font-mono text-cyan-400 tabular-nums">
            {sessionPct}%
          </span>
        </div>
      )}
      <div className="text-[10px] t-tertiary">{formatAge(fact.created_at)}</div>
    </div>
  );
}

function LessonCard({
  fact,
  onSelect,
  onReinforce,
  onDismiss,
  isPending,
}: {
  fact: FactRow;
  onSelect: () => void;
  onReinforce: () => void;
  onDismiss: () => void;
  isPending: boolean;
}) {
  const content = humanizeContent(fact);
  const isReverted = fact.content.includes("reverted");

  return (
    <div
      className={`glass-card rounded-xl p-4 flex flex-col gap-3 border border-red-500/10 cursor-pointer hover:ring-1 hover:ring-red-500/30 transition-all ${fact.disabled ? "opacity-60" : ""}`}
      onClick={onSelect}
    >
      <DriftDisabledBadges fact={fact} />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold bg-red-500/15 text-red-400 flex-shrink-0">
            {isReverted ? "↩" : "!"}
          </span>
          <h3
            className="text-sm font-medium text-foreground truncate"
            title={fact.subject}
          >
            {shortPath(fact.subject)}
          </h3>
        </div>
        <CardActions
          onReinforce={onReinforce}
          onDismiss={onDismiss}
          isPending={isPending}
        />
      </div>
      <p className="text-xs t-secondary leading-relaxed">{content}</p>
      <ConfidenceBar confidence={fact.effective_confidence} />
    </div>
  );
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 rounded-full bg-surface-overlay overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${confidenceBarColor(confidence)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={`text-[10px] tabular-nums ${pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-red-400"}`}
      >
        {confidenceLabel(confidence)}
      </span>
    </div>
  );
}

function CardActions({
  onReinforce,
  onDismiss,
  isPending,
}: {
  onReinforce: () => void;
  onDismiss: () => void;
  isPending: boolean;
}) {
  return (
    <div className="flex gap-1 flex-shrink-0">
      <button
        type="button"
        className="rounded-md p-1 text-xs text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-30"
        onClick={onReinforce}
        disabled={isPending}
        title="This is still true — confirm this"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M8 12V4M5 7l3-3 3 3" />
        </svg>
      </button>
      <button
        type="button"
        className="rounded-md p-1 text-xs text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30"
        onClick={onDismiss}
        disabled={isPending}
        title="This is wrong — remove it"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

/** Glance-level state pills folded in from Sidekick Memory — surfaced on
 *  every card so drift / disabled is visible without opening the detail. */
function DriftDisabledBadges({ fact }: { fact: FactRow }) {
  if (!fact.drift && !fact.disabled) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {fact.drift && (
        <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
          possibly outdated
        </span>
      )}
      {fact.disabled && (
        <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[9px] font-medium text-red-300">
          turned off
        </span>
      )}
    </div>
  );
}

// ── Detail Modal ────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, { label: string; description: string }> = {
  convention_detector: {
    label: "Learned from your code",
    description:
      "unerr analyzed your codebase and found this pattern used consistently",
  },
  session_analysis: {
    label: "Learned from your sessions",
    description:
      "Discovered by watching which files and patterns you work with across sessions",
  },
  causal_bridge: {
    label: "Learned from change outcomes",
    description:
      "unerr tracked whether this change survived or was reverted within 24 hours",
  },
  negative_knowledge: {
    label: "Learned from a mistake",
    description:
      "A change was made and then undone — unerr captured this so the same mistake isn't repeated",
  },
  agent_explicit: {
    label: "You told unerr",
    description: "You or your AI agent explicitly asked unerr to remember this",
  },
  user_fed: {
    label: "You told unerr",
    description: "You explicitly asked unerr to remember this rule",
  },
};

function MemoryDetailModal({
  fact,
  allFacts,
  onClose,
  onReinforce,
  onDismiss,
  onEdit,
  onDisable,
  isPending,
}: {
  fact: FactRow;
  allFacts: FactRow[];
  onClose: () => void;
  onReinforce: () => void;
  onDismiss: () => void;
  onEdit: (content: string) => void;
  onDisable: () => void;
  isPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.content);

  // Close on Escape — but only when not mid-edit, so Escape cancels the
  // edit first rather than discarding an in-progress draft.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editing) setEditing(false);
      else onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, editing]);

  const meta = CATEGORY_META[fact.fact_type];
  const categoryLabel = meta?.label ?? fact.fact_type;
  const categoryIcon = meta?.icon ?? "?";
  const categoryColor = meta?.color ?? "violet";

  const confPct = Math.round(fact.base_confidence * 100);
  const effectivePct = Math.round(fact.effective_confidence * 100);
  const decayDelta = confPct - effectivePct;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative glass-panel rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto custom-scrollbar shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-6 py-4 border-b border-border-subtle bg-surface/95 backdrop-blur-sm rounded-t-2xl">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="flex items-center justify-center w-8 h-8 rounded-lg text-sm font-bold"
              style={{
                background: `var(--color-${categoryColor}-500, #8B5CF6)1a`,
                color: `var(--color-${categoryColor}-400, #8B5CF6)`,
              }}
            >
              {categoryIcon}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-[10px] uppercase tracking-wide t-tertiary font-medium">
                  {categoryLabel}
                </p>
                {fact.drift && (
                  <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
                    possibly outdated
                  </span>
                )}
                {fact.disabled && (
                  <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[9px] font-medium text-red-300">
                    turned off
                  </span>
                )}
              </div>
              <h3
                className="text-sm font-semibold text-foreground truncate"
                title={fact.subject}
              >
                {fact.subject}
              </h3>
            </div>
          </div>
          <button
            type="button"
            className="flex-shrink-0 rounded-lg p-1.5 t-tertiary hover:text-foreground hover:bg-surface-overlay transition-colors"
            onClick={onClose}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 flex flex-col gap-5">
          {/* What this means — type-specific explanation */}
          <ModalSection title="What this means">
            <ModalExplanation fact={fact} />
          </ModalSection>

          {/* Humanized content — inline-editable (folded in from Sidekick) */}
          <ModalSection title="Summary">
            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-border-subtle bg-surface-overlay p-2.5 font-mono text-xs text-foreground"
              />
            ) : (
              <p className="text-sm text-foreground leading-relaxed">
                {humanizeContent(fact)}
              </p>
            )}
          </ModalSection>

          {/* What you said */}
          {fact.source_quote ? (
            <ModalSection title="What you said">
              <blockquote className="border-l-2 border-violet-400/40 pl-3 text-xs italic t-secondary leading-relaxed">
                "{fact.source_quote}"
              </blockquote>
            </ModalSection>
          ) : null}

          {/* How certain */}
          <ModalSection title="How certain is this?">
            <div className="flex flex-col gap-2">
              <ConfidenceBar confidence={fact.effective_confidence} />
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs mt-1">
                <span className="t-tertiary">Certainty</span>
                <span className="font-mono tabular-nums text-foreground text-right">
                  {effectivePct}%
                </span>
                {decayDelta > 0 && (
                  <>
                    <span className="t-tertiary">Faded over time</span>
                    <span className="text-amber-400 tabular-nums text-right">
                      -{decayDelta}%
                    </span>
                  </>
                )}
                {fact.reinforcement_count > 0 && (
                  <>
                    <span className="t-tertiary">Times confirmed</span>
                    <span className="text-emerald-400 tabular-nums text-right">
                      {fact.reinforcement_count}
                    </span>
                  </>
                )}
              </div>
            </div>
          </ModalSection>

          {/* Type-specific details */}
          <ModalTypeDetails fact={fact} allFacts={allFacts} />

          {/* Where this applies */}
          <ModalSection title="Where this applies">
            <p className="text-xs t-secondary leading-relaxed">
              When your agent works on files near{" "}
              <span className="font-mono text-foreground">{fact.scope}</span>,
              unerr automatically shares this knowledge — the agent sees it
              before making changes.
            </p>
            {fact.applies_to && fact.applies_to.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {fact.applies_to.map((t) => (
                  <code
                    key={t}
                    className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px] font-mono t-secondary"
                  >
                    {t}
                  </code>
                ))}
              </div>
            )}
          </ModalSection>

          {/* How this was learned */}
          <ModalSection title="How this was learned">
            {(() => {
              const info = SOURCE_LABELS[fact.source] ?? {
                label: fact.source,
                description: "Automatically generated",
              };
              return (
                <div className="flex items-start gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400/60 mt-1.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-foreground">
                      {info.label}
                    </p>
                    <p className="text-[10px] t-tertiary mt-0.5">
                      {info.description}
                    </p>
                  </div>
                </div>
              );
            })()}
          </ModalSection>

          {/* Timestamps */}
          <ModalSection title="Timeline">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <span className="t-tertiary">First detected</span>
              <span className="t-secondary text-right">
                {new Date(fact.created_at).toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              {fact.last_reinforced_at > fact.created_at && (
                <>
                  <span className="t-tertiary">Last confirmed</span>
                  <span className="t-secondary text-right">
                    {new Date(fact.last_reinforced_at).toLocaleDateString(
                      undefined,
                      {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }
                    )}
                  </span>
                </>
              )}
            </div>
          </ModalSection>
        </div>

        {/* Footer actions — unified controls folded in from Sidekick Memory:
            Edit · Reinforce/Re-enable · Disable · Forget. */}
        <div className="sticky bottom-0 flex items-center justify-between gap-3 px-6 py-4 border-t border-border-subtle bg-surface/95 backdrop-blur-sm rounded-b-2xl">
          <span className="text-[10px] t-tertiary" />
          {/* spacer */}
          {editing ? (
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-violet-300 bg-violet-500/15 hover:bg-violet-500/25 transition-colors disabled:opacity-30"
                onClick={() => onEdit(draft)}
                disabled={isPending || draft.trim().length === 0}
              >
                Save
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-xs font-medium t-secondary bg-surface-overlay hover:opacity-80 transition-opacity"
                onClick={() => {
                  setEditing(false);
                  setDraft(fact.content);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-xs font-medium t-secondary bg-surface-overlay hover:opacity-80 transition-opacity disabled:opacity-30"
                onClick={() => setEditing(true)}
                disabled={isPending}
              >
                Edit
              </button>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors disabled:opacity-30"
                onClick={onReinforce}
                disabled={isPending}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M8 12V4M5 7l3-3 3 3" />
                </svg>
                {fact.disabled ? "Turn back on" : "Still true"}
              </button>
              {!fact.disabled && (
                <button
                  type="button"
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-30"
                  onClick={onDisable}
                  disabled={isPending}
                >
                  Turn off
                </button>
              )}
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors disabled:opacity-30"
                onClick={onDismiss}
                disabled={isPending}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
                Forget
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ModalSection({
  title,
  children,
}: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide t-tertiary">
        {title}
      </span>
      {children}
    </div>
  );
}

/** Type-specific plain-English explanation */
function ModalExplanation({ fact }: { fact: FactRow }) {
  if (fact.fact_type === "semantic") {
    return (
      <p className="text-xs t-secondary leading-relaxed">
        unerr detected that your codebase consistently follows this pattern.
        When your AI agent modifies code in{" "}
        <span className="font-mono text-violet-400">{fact.scope}</span>, this
        convention is automatically surfaced so it doesn't accidentally break
        the pattern.
      </p>
    );
  }
  if (fact.fact_type === "procedural") {
    return (
      <p className="text-xs t-secondary leading-relaxed">
        You keep coming back to this file across coding sessions. unerr
        prioritizes it in context so your AI agent understands this is central
        to your workflow.
      </p>
    );
  }
  if (fact.fact_type === "negative" || fact.fact_type === "episodic") {
    const isReverted = fact.content.includes("reverted");
    const isCausalBridge = fact.source === "causal_bridge";
    const isSessionAnalysis = fact.source === "session_analysis";
    const isNegativeKnowledge = fact.source === "negative_knowledge";
    if (isReverted && isCausalBridge) {
      return (
        <p className="text-xs t-secondary leading-relaxed">
          A change was made to{" "}
          <span className="font-mono text-red-400">{fact.subject}</span> but it
          was reverted within 24 hours — the approach didn't work out. unerr
          remembers this so your AI agent avoids the same mistake.
        </p>
      );
    }
    if (!isReverted && isCausalBridge) {
      return (
        <p className="text-xs t-secondary leading-relaxed">
          A change to{" "}
          <span className="font-mono text-amber-400">{fact.subject}</span>{" "}
          survived past the 24-hour window and shipped. This is tracked as a
          successful change.
        </p>
      );
    }
    if (isNegativeKnowledge) {
      return (
        <p className="text-xs t-secondary leading-relaxed">
          The file{" "}
          <span className="font-mono text-red-400">{fact.subject}</span> was
          modified and then reverted — the approach was incorrect. unerr
          captured this as a lesson so the same mistake isn't repeated.
        </p>
      );
    }
    if (isSessionAnalysis) {
      return (
        <p className="text-xs t-secondary leading-relaxed">
          Changes to{" "}
          <span className="font-mono text-red-400">{fact.subject}</span>{" "}
          frequently get reverted across multiple sessions. This file may have
          tricky edge cases or dependencies that make changes fragile.
        </p>
      );
    }
    return (
      <p className="text-xs t-secondary leading-relaxed">
        Something went wrong with{" "}
        <span className="font-mono text-red-400">{fact.subject}</span>. This
        lesson is surfaced when your AI agent works in this area.
      </p>
    );
  }
  if (fact.fact_type === "convention") {
    return (
      <p className="text-xs t-secondary leading-relaxed">
        This is a rule you or your AI agent explicitly recorded. It's injected
        whenever the agent works in{" "}
        <span className="font-mono text-emerald-400">{fact.scope}</span>.
      </p>
    );
  }
  return <p className="text-xs t-secondary leading-relaxed">{fact.content}</p>;
}

/** Type-specific additional detail sections */
function ModalTypeDetails({
  fact,
  allFacts,
}: { fact: FactRow; allFacts: FactRow[] }) {
  if (fact.fact_type === "semantic") {
    const entityMatch = fact.content.match(/(\d+)\s*entit/);
    const entityCount = entityMatch ? entityMatch[1] : null;
    if (!entityCount) return null;
    return (
      <ModalSection title="How widespread">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold text-violet-400 tabular-nums">
            {entityCount}
          </span>
          <span className="text-xs t-secondary">
            entities in your codebase follow this convention
          </span>
        </div>
      </ModalSection>
    );
  }

  if (fact.fact_type === "procedural") {
    const pctMatch = fact.content.match(/(\d+)% of sessions/);
    const sessionPct = pctMatch ? Number.parseInt(pctMatch[1]!, 10) : 0;
    const revertMatch = fact.content.match(/(\d+)% revert rate/);
    const revertPct = revertMatch ? Number.parseInt(revertMatch[1]!, 10) : 0;

    const myDir = dirPath(fact.subject);
    const coModified = allFacts
      .filter(
        (f) =>
          f.fact_id !== fact.fact_id &&
          f.fact_type === "procedural" &&
          dirPath(f.subject) === myDir
      )
      .slice(0, 4);
    const relatedLessons = allFacts.filter(
      (f) =>
        (f.fact_type === "negative" || f.fact_type === "episodic") &&
        f.subject === fact.subject
    );

    return (
      <>
        {(sessionPct > 0 || revertPct > 0) && (
          <ModalSection title="Session frequency">
            <div className="flex flex-col gap-2.5">
              {sessionPct > 0 && (
                <div className="flex items-center gap-3">
                  <div className="w-36 h-2.5 rounded-full bg-surface-overlay overflow-hidden">
                    <div
                      className="h-full rounded-full bg-cyan-400"
                      style={{ width: `${sessionPct}%` }}
                    />
                  </div>
                  <span className="text-xs text-cyan-400 font-semibold tabular-nums">
                    {sessionPct}%
                  </span>
                  <span className="text-[10px] t-tertiary">of sessions</span>
                </div>
              )}
              {revertPct > 0 && (
                <div className="flex items-center gap-3">
                  <div className="w-36 h-2.5 rounded-full bg-surface-overlay overflow-hidden">
                    <div
                      className="h-full rounded-full bg-red-400"
                      style={{ width: `${revertPct}%` }}
                    />
                  </div>
                  <span className="text-xs text-red-400 font-semibold tabular-nums">
                    {revertPct}%
                  </span>
                  <span className="text-[10px] t-tertiary">revert rate</span>
                </div>
              )}
            </div>
          </ModalSection>
        )}
        {coModified.length > 0 && (
          <ModalSection title="Often changed together">
            <div className="flex flex-wrap gap-1.5">
              {coModified.map((f) => (
                <span
                  key={f.fact_id}
                  className="inline-flex items-center rounded-md bg-surface-overlay px-2 py-0.5 text-[10px] font-mono t-secondary"
                >
                  {shortPath(f.subject)}
                </span>
              ))}
            </div>
          </ModalSection>
        )}
        {relatedLessons.length > 0 && (
          <ModalSection title="Known issues with this file">
            <div className="flex flex-col gap-1.5">
              {relatedLessons.map((f) => (
                <div key={f.fact_id} className="flex items-start gap-2 text-xs">
                  <span className="text-red-400 flex-shrink-0 mt-0.5">!</span>
                  <span className="t-secondary">{humanizeContent(f)}</span>
                </div>
              ))}
            </div>
          </ModalSection>
        )}
      </>
    );
  }

  if (fact.fact_type === "negative" || fact.fact_type === "episodic") {
    return (
      <ModalSection title="Affected code">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-red-400">{fact.subject}</span>
          {fact.scope !== fact.subject && (
            <span className="text-[10px] t-tertiary">in {fact.scope}</span>
          )}
        </div>
      </ModalSection>
    );
  }

  return null;
}

// ── Type pill for raw table ─────────────────────────────────────────

const TYPE_STYLES: Record<string, { color: string; label: string }> = {
  procedural: { color: "bg-cyan-500/15 text-cyan-400", label: "frequent file" },
  semantic: { color: "bg-violet-500/15 text-violet-400", label: "convention" },
  negative: { color: "bg-red-500/15 text-red-400", label: "lesson" },
  convention: {
    color: "bg-emerald-500/15 text-emerald-400",
    label: "your rule",
  },
  episodic: {
    color: "bg-amber-500/15 text-amber-400",
    label: "change outcome",
  },
};

function TypePill({ type }: { type: string }) {
  const style = TYPE_STYLES[type] ?? {
    color: "bg-surface-overlay text-muted-foreground",
    label: type,
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${style.color}`}
    >
      {style.label}
    </span>
  );
}
