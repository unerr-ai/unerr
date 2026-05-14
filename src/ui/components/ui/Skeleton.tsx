/**
 * Loading skeletons — enterprise-grade pulse blocks with proper elevation.
 */

export function SkeletonBlock({
  className = "",
}: {
  className?: string;
}) {
  return (
    <div
      className={`animate-pulse rounded-md bg-surface-overlay ${className}`}
      aria-hidden="true"
    />
  );
}

const CARD_KEYS = ["c0", "c1", "c2", "c3"] as const;

export function CardGridSkeleton({ n = 4 }: { n?: number }) {
  const keys = CARD_KEYS.slice(0, Math.min(n, CARD_KEYS.length));
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {keys.map((k) => (
        <div key={k} className="glass-card rounded-xl p-4">
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="mt-3 h-8 w-14" />
        </div>
      ))}
    </div>
  );
}

const ROW_KEYS = [
  "r0",
  "r1",
  "r2",
  "r3",
  "r4",
  "r5",
  "r6",
  "r7",
  "r8",
  "r9",
  "r10",
  "r11",
] as const;

export function TextRowSkeleton({ rows = 4 }: { rows?: number }) {
  const keys = ROW_KEYS.slice(0, Math.min(rows, ROW_KEYS.length));
  return (
    <div className="space-y-3 px-4 py-4">
      {keys.map((k) => (
        <SkeletonBlock key={k} className="h-4 w-full max-w-md" />
      ))}
    </div>
  );
}

const COL_KEYS = ["h0", "h1", "h2", "h3", "h4", "h5"] as const;
const TROW_KEYS = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"] as const;

export function TableSkeleton({
  cols = 5,
  rows = 6,
}: {
  cols?: number;
  rows?: number;
}) {
  const colK = COL_KEYS.slice(0, Math.min(cols, COL_KEYS.length));
  const rowK = TROW_KEYS.slice(0, Math.min(rows, TROW_KEYS.length));

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex gap-2 border-b border-border-subtle pb-2">
        {colK.map((k) => (
          <SkeletonBlock key={k} className="h-3 flex-1" />
        ))}
      </div>
      {rowK.map((rk) => (
        <div key={rk} className="mb-2 flex gap-2">
          {colK.map((ck) => (
            <SkeletonBlock key={`${rk}-${ck}`} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
