import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

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
}

interface FactsResponse {
  facts: FactRow[];
  total: number;
  filters: { scope: string; type: string; min_confidence: number };
}

interface HealthResponse {
  total: number;
  active: number;
  decayed: number;
  by_type: Record<string, number>;
  avg_confidence: number;
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
    label: "Coding Patterns",
    icon: "◆",
    color: "violet",
    description: "Conventions your codebase consistently follows",
    emptyMsg:
      "No patterns detected yet. Run a full index to discover conventions.",
  },
  procedural: {
    label: "Hot Files",
    icon: "⚡",
    color: "cyan",
    description: "Files you keep coming back to across sessions",
    emptyMsg:
      "Not enough session data yet. Keep coding — patterns emerge after 3+ sessions.",
  },
  negative: {
    label: "Lessons Learned",
    icon: "✗",
    color: "red",
    description: "Things that went wrong — remembered so you don't repeat them",
    emptyMsg: "No anti-patterns detected. That's a good thing.",
  },
  episodic: {
    label: "Change History",
    icon: "◎",
    color: "amber",
    description: "Changes that survived or were reverted within 24 hours",
    emptyMsg: "No change survival data yet.",
  },
  convention: {
    label: "Explicit Rules",
    icon: "▸",
    color: "emerald",
    description: "Rules you've explicitly told unerr to remember",
    emptyMsg: "No explicit rules recorded. Use record_fact to teach unerr.",
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
  return parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : "";
}

// ── Confidence bar color ────────────────────────────────────────────

function confidenceBarColor(conf: number): string {
  if (conf >= 0.7) return "bg-emerald-400";
  if (conf >= 0.4) return "bg-amber-400";
  return "bg-red-400";
}

function confidenceLabel(conf: number): string {
  if (conf >= 0.7) return "Strong";
  if (conf >= 0.4) return "Moderate";
  return "Fading";
}

// ── Component ───────────────────────────────────────────────────────

export function FactsPage() {
  const qc = useQueryClient();
  const { url, queryKey } = useRepoApi();
  const [showAllFacts, setShowAllFacts] = useState(false);
  const [selectedFact, setSelectedFact] = useState<FactRow | null>(null);

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
          `/api/facts?${new URLSearchParams({ scope: "*", min_confidence: "0", limit: "100" })}`,
        ),
      ),
    refetchInterval: 15_000,
  });

  const reinforceMut = useMutation({
    mutationFn: (factId: string) =>
      fetchJson(url(`/api/facts/${factId}/reinforce`), { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(["facts"]) });
    },
  });

  const dismissMut = useMutation({
    mutationFn: (factId: string) =>
      fetchJson(url(`/api/facts/${factId}`), { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(["facts"]) });
    },
  });

  const health = healthQ.data;
  const facts = factsQ.data?.facts ?? [];

  // Group facts by type
  const grouped = facts.reduce<Record<string, FactRow[]>>((acc, f) => {
    (acc[f.fact_type] ??= []).push(f);
    return acc;
  }, {});

  const semanticFacts = grouped.semantic ?? [];
  const proceduralFacts = grouped.procedural ?? [];
  const negativeFacts = grouped.negative ?? [];
  const episodicFacts = grouped.episodic ?? [];
  const conventionFacts = grouped.convention ?? [];

  const isLoading = healthQ.isLoading || factsQ.isLoading;

  return (
    <div className="flex flex-col gap-8">
      {/* ── Section 1: Knowledge Health Hero ──────────────────────── */}
      <section className="glass-panel rounded-xl p-6">
        <div className="flex items-start gap-6">
          <KnowledgeRing
            score={health?.avg_confidence ?? 0}
            total={health?.total ?? 0}
          />
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-foreground">
              Project Memory
            </h2>
            <p className="mt-1 text-sm t-secondary leading-relaxed">
              unerr learns about your project as you code — detecting patterns,
              tracking which files you revisit, and remembering what went wrong.
              This knowledge gets injected into every tool response to help your
              AI agent make better decisions.
            </p>
            {isLoading ? (
              <div className="mt-4">
                <CardGridSkeleton n={4} />
              </div>
            ) : health ? (
              <div className="mt-4 grid gap-3 grid-cols-2 lg:grid-cols-4">
                <MiniStat
                  label="Total memories"
                  value={health.total}
                  color="text-foreground"
                />
                <MiniStat
                  label="Patterns"
                  value={health.by_type.semantic ?? 0}
                  color="text-violet-400"
                />
                <MiniStat
                  label="Hot files"
                  value={health.by_type.procedural ?? 0}
                  color="text-cyan-400"
                />
                <MiniStat
                  label="Lessons"
                  value={
                    (health.by_type.negative ?? 0) +
                    (health.by_type.episodic ?? 0)
                  }
                  color="text-red-400"
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>

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

      {/* ── All Facts (collapsible raw view) ─────────────────────── */}
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
            {showAllFacts ? "Hide" : "Show"} all {facts.length} raw facts
          </button>
          {showAllFacts && (
            <div className="mt-3 glass-panel rounded-xl p-4 overflow-x-auto custom-scrollbar">
              <table className="w-full min-w-[700px] text-left text-xs">
                <thead>
                  <tr className="border-b border-border-subtle t-tertiary uppercase">
                    <th className="py-2 pr-3 font-medium">Type</th>
                    <th className="py-2 pr-3 font-medium">Subject</th>
                    <th className="py-2 pr-3 font-medium">Content</th>
                    <th className="py-2 pr-3 font-medium">Confidence</th>
                    <th className="py-2 pr-3 font-medium">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.map((f) => (
                    <tr
                      key={f.fact_id}
                      className="border-b border-border-subtle"
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
                        className="py-2 pr-3 max-w-[300px] truncate t-secondary"
                        title={f.content}
                      >
                        {f.content}
                      </td>
                      <td className="py-2 pr-3 font-mono tabular-nums">
                        {(f.effective_confidence * 100).toFixed(0)}%
                      </td>
                      <td className="py-2 pr-3 t-tertiary tabular-nums">
                        {formatAge(f.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
          isPending={reinforceMut.isPending || dismissMut.isPending}
        />
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function KnowledgeRing({ score, total }: { score: number; total: number }) {
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * Math.min(1, score);
  const pctLabel = total === 0 ? "—" : `${Math.round(score * 100)}%`;

  return (
    <div className="relative flex-shrink-0" style={{ width: 88, height: 88 }}>
      <svg viewBox="0 0 88 88" className="w-full h-full">
        <circle
          cx="44"
          cy="44"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          className="text-surface-overlay opacity-40"
        />
        <circle
          cx="44"
          cy="44"
          r={radius}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          strokeDashoffset={circumference * 0.25}
          className="text-violet-400 transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold text-foreground tabular-nums">
          {pctLabel}
        </span>
        <span className="text-[9px] t-tertiary uppercase tracking-wider">
          recall
        </span>
      </div>
    </div>
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
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(renderCard)}
        </div>
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
      className="glass-card rounded-xl p-4 flex flex-col gap-3 cursor-pointer hover:ring-1 hover:ring-violet-500/30 transition-all"
      onClick={onSelect}
    >
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
        <span>{formatAge(fact.created_at)}</span>
        {fact.reinforcement_count > 0 && (
          <span>reinforced {fact.reinforcement_count}x</span>
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
      className="glass-card rounded-xl p-4 flex flex-col gap-3 cursor-pointer hover:ring-1 hover:ring-cyan-500/30 transition-all"
      onClick={onSelect}
    >
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
      className="glass-card rounded-xl p-4 flex flex-col gap-3 border border-red-500/10 cursor-pointer hover:ring-1 hover:ring-red-500/30 transition-all"
      onClick={onSelect}
    >
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
        title="This is still true — strengthen this memory"
      >
        <svg
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
        title="This is wrong — forget this memory"
      >
        <svg
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

// ── Detail Modal ────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, { label: string; description: string }> = {
  convention_detector: {
    label: "Convention Detector",
    description:
      "Automatically detected by analyzing your codebase patterns after indexing",
  },
  session_analysis: {
    label: "Session Analysis",
    description: "Discovered by analyzing patterns across your coding sessions",
  },
  causal_bridge: {
    label: "24h Survival Check",
    description:
      "Tracked whether your changes survived or were reverted within 24 hours",
  },
  negative_knowledge: {
    label: "Revert Detection",
    description:
      "Captured when a change was made and then undone — the approach was wrong",
  },
  agent_explicit: {
    label: "Manually Recorded",
    description: "You or your AI agent explicitly told unerr to remember this",
  },
};

function MemoryDetailModal({
  fact,
  allFacts,
  onClose,
  onReinforce,
  onDismiss,
  isPending,
}: {
  fact: FactRow;
  allFacts: FactRow[];
  onClose: () => void;
  onReinforce: () => void;
  onDismiss: () => void;
  isPending: boolean;
}) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

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
              <p className="text-[10px] uppercase tracking-wide t-tertiary font-medium">
                {categoryLabel}
              </p>
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

          {/* Humanized content */}
          <ModalSection title="Summary">
            <p className="text-sm text-foreground leading-relaxed">
              {humanizeContent(fact)}
            </p>
          </ModalSection>

          {/* Memory strength */}
          <ModalSection title="Memory strength">
            <div className="flex flex-col gap-2">
              <ConfidenceBar confidence={fact.effective_confidence} />
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs mt-1">
                <span className="t-tertiary">Base confidence</span>
                <span className="font-mono tabular-nums text-foreground text-right">
                  {confPct}%
                </span>
                <span className="t-tertiary">Current (after decay)</span>
                <span className="font-mono tabular-nums text-foreground text-right">
                  {effectivePct}%
                </span>
                {decayDelta > 0 && (
                  <>
                    <span className="t-tertiary">Decay</span>
                    <span className="text-amber-400 tabular-nums text-right">
                      -{decayDelta}%
                    </span>
                  </>
                )}
                {fact.reinforcement_count > 0 && (
                  <>
                    <span className="t-tertiary">Reinforcements</span>
                    <span className="text-emerald-400 tabular-nums text-right">
                      {fact.reinforcement_count}x{" "}
                      <span className="text-[10px] t-tertiary">
                        (slows decay)
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </ModalSection>

          {/* Type-specific details */}
          <ModalTypeDetails fact={fact} allFacts={allFacts} />

          {/* Scope & injection */}
          <ModalSection title="How it's used">
            <p className="text-xs t-secondary leading-relaxed">
              When your AI agent reads or modifies files near{" "}
              <span className="font-mono text-foreground">{fact.scope}</span>,
              this memory is automatically injected into the context — the agent
              sees it before writing code.
            </p>
          </ModalSection>

          {/* Source */}
          <ModalSection title="Source">
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
                  <span className="t-tertiary">Last reinforced</span>
                  <span className="t-secondary text-right">
                    {new Date(fact.last_reinforced_at).toLocaleDateString(
                      undefined,
                      {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                    )}
                  </span>
                </>
              )}
            </div>
          </ModalSection>

          {/* Raw content */}
          <ModalSection title="Original data">
            <p className="font-mono text-[11px] t-tertiary leading-relaxed bg-surface-overlay rounded-lg px-3 py-2">
              {fact.content}
            </p>
          </ModalSection>
        </div>

        {/* Footer actions */}
        <div className="sticky bottom-0 flex items-center justify-between gap-3 px-6 py-4 border-t border-border-subtle bg-surface/95 backdrop-blur-sm rounded-b-2xl">
          <span className="text-[10px] t-tertiary">
            ID: {fact.fact_id.slice(0, 8)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors disabled:opacity-30"
              onClick={onReinforce}
              disabled={isPending}
            >
              <svg
                viewBox="0 0 16 16"
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M8 12V4M5 7l3-3 3 3" />
              </svg>
              Still true
            </button>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors disabled:opacity-30"
              onClick={onDismiss}
              disabled={isPending}
            >
              <svg
                viewBox="0 0 16 16"
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
              Forget this
            </button>
          </div>
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
          dirPath(f.subject) === myDir,
      )
      .slice(0, 4);
    const relatedLessons = allFacts.filter(
      (f) =>
        (f.fact_type === "negative" || f.fact_type === "episodic") &&
        f.subject === fact.subject,
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

const TYPE_COLORS: Record<string, string> = {
  procedural: "bg-cyan-500/15 text-cyan-400",
  semantic: "bg-violet-500/15 text-violet-400",
  negative: "bg-red-500/15 text-red-400",
  convention: "bg-emerald-500/15 text-emerald-400",
  episodic: "bg-amber-500/15 text-amber-400",
};

function TypePill({ type }: { type: string }) {
  const color = TYPE_COLORS[type] ?? "bg-surface-overlay text-muted-foreground";
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${color}`}
    >
      {type}
    </span>
  );
}
