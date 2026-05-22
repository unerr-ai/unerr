/**
 * Sidekick Memory — Phase 3 Sprint 11.
 *
 * Lists every fact unerr is holding for the user, split by
 * `source: user_fed` vs auto-detected sources. User-fed facts show the
 * verbatim source quote and the list of paths/entities they apply to.
 * Edit / disable / reinforce / dismiss actions per fact; drift badge on
 * facts that reference modified files.
 *
 * Additive: the existing Project Memory (FactsPage) keeps reading
 * `/api/facts`. This page reads from `/api/facts-v2` and never touches
 * the existing reader's data shape.
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useRepoApi } from "@/lib/repo-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

interface FactRow {
  fact_id: string;
  fact_type: string;
  scope: string;
  subject: string;
  content: string;
  source: string;
  source_quote: string | null;
  applies_to: string[];
  base_confidence: number;
  effective_confidence: number;
  reinforcement_count: number;
  created_at: number;
  last_reinforced_at: number;
  disabled: boolean;
  drift: boolean;
}

interface ListResponse {
  data: FactRow[];
  total: number;
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function FactCard({
  fact,
  onEdit,
  onDisable,
  onReinforce,
  onDelete,
  isEditing,
  draft,
  onDraftChange,
  onEditCancel,
  onEditSave,
}: {
  fact: FactRow;
  onEdit: () => void;
  onDisable: () => void;
  onReinforce: () => void;
  onDelete: () => void;
  isEditing: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
}) {
  return (
    <article
      className={`rounded-xl border p-4 transition-colors ${
        fact.disabled
          ? "border-border-subtle/40 bg-surface/40 opacity-60"
          : "border-border-subtle bg-surface"
      }`}
    >
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-surface-elevated px-2 py-0.5 font-mono text-text-secondary">
          {fact.fact_type}
        </span>
        {fact.source === "user_fed" ? (
          <span className="rounded-full bg-violet-500/20 px-2 py-0.5 font-medium text-violet-200">
            user-fed
          </span>
        ) : (
          <span className="rounded-full bg-cyan-500/15 px-2 py-0.5 font-medium text-cyan-200">
            {fact.source.replace(/_/g, " ")}
          </span>
        )}
        {fact.drift ? (
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 font-medium text-amber-200">
            may be stale
          </span>
        ) : null}
        {fact.disabled ? (
          <span className="rounded-full bg-red-500/20 px-2 py-0.5 font-medium text-red-200">
            disabled
          </span>
        ) : null}
        <span className="ml-auto text-text-tertiary">
          {relTime(fact.last_reinforced_at)}
        </span>
      </header>

      {isEditing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            className="w-full rounded-md border border-border-subtle bg-surface-elevated p-2 font-mono text-sm text-text"
            rows={3}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onEditSave}
              className="rounded-md bg-violet-500/30 px-3 py-1 text-xs font-medium text-violet-100 hover:bg-violet-500/40"
            >
              Save
            </button>
            <button
              type="button"
              onClick={onEditCancel}
              className="rounded-md bg-surface-elevated px-3 py-1 text-xs text-text-secondary hover:bg-surface-elevated/80"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-text">{fact.content}</p>
      )}

      {fact.source_quote ? (
        <blockquote className="mt-3 border-l-2 border-violet-400/40 pl-3 text-xs italic text-text-secondary">
          “{fact.source_quote}”
        </blockquote>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-tertiary sm:grid-cols-3">
        <div>
          <dt>Scope</dt>
          <dd className="font-mono text-text-secondary">{fact.scope}</dd>
        </div>
        <div>
          <dt>Subject</dt>
          <dd className="font-mono text-text-secondary">{fact.subject}</dd>
        </div>
        <div>
          <dt>Effective conf.</dt>
          <dd className="font-mono text-text-secondary">
            {fact.effective_confidence.toFixed(2)}
          </dd>
        </div>
        {fact.applies_to.length > 0 ? (
          <div className="col-span-2 sm:col-span-3">
            <dt>Applies to</dt>
            <dd className="flex flex-wrap gap-1 font-mono text-text-secondary">
              {fact.applies_to.map((t) => (
                <code
                  key={t}
                  className="rounded bg-surface-elevated px-1.5 py-0.5"
                >
                  {t}
                </code>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>

      {!isEditing ? (
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md bg-surface-elevated px-2 py-1 text-text-secondary hover:bg-surface-elevated/80"
          >
            Edit
          </button>
          {fact.disabled ? (
            <button
              type="button"
              onClick={onReinforce}
              className="rounded-md bg-emerald-500/20 px-2 py-1 text-emerald-200 hover:bg-emerald-500/30"
            >
              Re-enable
            </button>
          ) : (
            <button
              type="button"
              onClick={onDisable}
              className="rounded-md bg-amber-500/20 px-2 py-1 text-amber-200 hover:bg-amber-500/30"
            >
              Disable
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto rounded-md bg-red-500/20 px-2 py-1 text-red-200 hover:bg-red-500/30"
          >
            Delete
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function SidekickMemoryPage() {
  const qc = useQueryClient();
  const { url, queryKey } = useRepoApi();
  const [filter, setFilter] = useState<"user_fed" | "auto" | "all">("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");

  const listQ = useQuery({
    queryKey: queryKey(["sidekick", "list", filter]),
    queryFn: () =>
      fetchJson<ListResponse>(url(`/api/facts-v2/list?source=${filter}`)),
    refetchInterval: 15_000,
  });

  const editMut = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      fetchJson(url(`/api/facts-v2/${id}`), {
        method: "PATCH",
        body: JSON.stringify({ content }),
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(["sidekick"]) }),
  });

  const disableMut = useMutation({
    mutationFn: (id: string) =>
      fetchJson(url(`/api/facts-v2/${id}/disable`), { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(["sidekick"]) }),
  });

  const reinforceMut = useMutation({
    mutationFn: (id: string) =>
      fetchJson(url(`/api/facts-v2/${id}/reinforce`), { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(["sidekick"]) }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      fetchJson(url(`/api/facts-v2/${id}`), { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(["sidekick"]) }),
  });

  const facts = listQ.data?.data ?? [];

  const { userFed, auto } = useMemo(() => {
    const u: FactRow[] = [];
    const a: FactRow[] = [];
    for (const f of facts) {
      if (f.source === "user_fed") u.push(f);
      else a.push(f);
    }
    u.sort((x, y) => y.last_reinforced_at - x.last_reinforced_at);
    a.sort((x, y) => y.effective_confidence - x.effective_confidence);
    return { userFed: u, auto: a };
  }, [facts]);

  if (listQ.isLoading) {
    return <CardGridSkeleton count={4} />;
  }

  const renderCard = (f: FactRow) => (
    <FactCard
      key={f.fact_id}
      fact={f}
      isEditing={editingId === f.fact_id}
      draft={draft}
      onDraftChange={setDraft}
      onEdit={() => {
        setEditingId(f.fact_id);
        setDraft(f.content);
      }}
      onEditCancel={() => {
        setEditingId(null);
        setDraft("");
      }}
      onEditSave={() => {
        if (!editingId) return;
        editMut.mutate({ id: editingId, content: draft });
        setEditingId(null);
        setDraft("");
      }}
      onDisable={() => disableMut.mutate(f.fact_id)}
      onReinforce={() => reinforceMut.mutate(f.fact_id)}
      onDelete={() => {
        if (
          window.confirm(
            `Delete this fact?\n\n"${f.content}"\n\nThis cannot be undone.`
          )
        ) {
          deleteMut.mutate(f.fact_id);
        }
      }}
    />
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-2">
        {(["all", "user_fed", "auto"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f
                ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/40"
                : "bg-surface text-text-secondary ring-1 ring-border-subtle hover:bg-surface-elevated"
            }`}
          >
            {f === "all"
              ? "All sources"
              : f === "user_fed"
                ? "User-fed"
                : "Auto-detected"}
          </button>
        ))}
        <span className="ml-auto text-xs text-text-tertiary">
          {facts.length} {facts.length === 1 ? "fact" : "facts"}
        </span>
      </header>

      {filter !== "auto" && userFed.length > 0 ? (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            User-fed memories · {userFed.length}
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {userFed.map(renderCard)}
          </div>
        </section>
      ) : null}

      {filter !== "user_fed" && auto.length > 0 ? (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            Auto-detected · {auto.length}
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {auto.map(renderCard)}
          </div>
        </section>
      ) : null}

      {facts.length === 0 ? (
        <p className="rounded-xl border border-border-subtle bg-surface p-6 text-sm italic text-text-tertiary">
          No memories yet — unerr will start learning as you code. Say "unerr,
          remember …" to teach it explicitly.
        </p>
      ) : null}
    </div>
  );
}
