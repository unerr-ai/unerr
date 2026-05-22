/**
 * Breadcrumb — drill-down navigation header for Token Trace.
 * Each item except the last is clickable; the last is the current view.
 */

export function Breadcrumb({
  items,
}: {
  items: Array<{ label: string; onClick?: () => void }>;
}) {
  return (
    <nav className="flex items-center gap-1.5 text-sm mb-5">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={item.label} className="flex items-center gap-1.5">
            {i > 0 && <span className="t-tertiary">›</span>}
            {isLast ? (
              <span className="text-foreground font-medium">{item.label}</span>
            ) : (
              <button
                type="button"
                className="text-violet-400 hover:text-violet-300 transition-colors cursor-pointer"
                onClick={item.onClick}
              >
                {item.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
