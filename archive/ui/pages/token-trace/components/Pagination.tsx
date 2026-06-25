/**
 * Pagination — prev/next controls for paginated lists.
 */

export function Pagination({
  total,
  limit,
  offset,
  onPageChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onPageChange: (newOffset: number) => void;
}) {
  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between px-1 py-2">
      <span className="t-tertiary text-xs tabular-nums">
        {offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={currentPage <= 1}
          className="rounded-md border border-border-subtle bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-border-subtle disabled:hover:bg-white/[0.03]"
          onClick={() => onPageChange(Math.max(0, offset - limit))}
        >
          ‹ Prev
        </button>
        <span className="t-secondary text-xs px-2 font-mono tabular-nums">
          {currentPage}/{totalPages}
        </span>
        <button
          type="button"
          disabled={currentPage >= totalPages}
          className="rounded-md border border-border-subtle bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-border-subtle disabled:hover:bg-white/[0.03]"
          onClick={() => onPageChange(offset + limit)}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}
