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
      <span className="t-tertiary text-xs">
        {offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={currentPage <= 1}
          className="px-2.5 py-1 rounded text-xs font-medium bg-surface-secondary hover:bg-surface-tertiary disabled:opacity-30 disabled:cursor-not-allowed text-foreground transition-colors"
          onClick={() => onPageChange(Math.max(0, offset - limit))}
        >
          ‹ Prev
        </button>
        <span className="t-secondary text-xs px-2 font-mono">
          {currentPage}/{totalPages}
        </span>
        <button
          type="button"
          disabled={currentPage >= totalPages}
          className="px-2.5 py-1 rounded text-xs font-medium bg-surface-secondary hover:bg-surface-tertiary disabled:opacity-30 disabled:cursor-not-allowed text-foreground transition-colors"
          onClick={() => onPageChange(offset + limit)}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}
