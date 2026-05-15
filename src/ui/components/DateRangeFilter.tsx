import { type DateRange, DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { useEffect, useRef, useState } from "react";

const PRESETS: { label: string; days: number | null }[] = [
  { label: "Today", days: 0 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "All time", days: null },
];

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function DateRangeFilter({
  fromTs,
  toTs,
  onChange,
}: {
  fromTs: string;
  toTs: string;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected: DateRange | undefined =
    fromTs || toTs
      ? {
          from: fromTs ? new Date(fromTs) : undefined,
          to: toTs ? new Date(toTs) : undefined,
        }
      : undefined;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleRangeSelect = (range: DateRange | undefined) => {
    if (!range) {
      onChange("", "");
      return;
    }
    const from = range.from
      ? new Date(
          range.from.getFullYear(),
          range.from.getMonth(),
          range.from.getDate(),
          0,
          0,
          0
        ).toISOString()
      : "";
    const to = range.to
      ? new Date(
          range.to.getFullYear(),
          range.to.getMonth(),
          range.to.getDate(),
          23,
          59,
          59
        ).toISOString()
      : "";
    onChange(from, to);
  };

  const applyPreset = (days: number | null) => {
    if (days === null) {
      onChange("", "");
    } else {
      const end = new Date();
      const start =
        days === 0
          ? new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0)
          : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      onChange(start.toISOString(), end.toISOString());
    }
    setOpen(false);
  };

  const displayLabel =
    selected?.from || selected?.to
      ? `${selected.from ? fmtDate(selected.from) : "..."} — ${selected.to ? fmtDate(selected.to) : "..."}`
      : "All time";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 bg-surface-secondary border border-border-subtle rounded-lg px-3 py-1.5 text-xs text-foreground hover:border-violet-500/50 transition-colors"
      >
        <svg
          aria-hidden="true"
          className="w-3.5 h-3.5 t-tertiary shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <span className="font-mono">{displayLabel}</span>
        {(fromTs || toTs) && (
          <span
            className="t-tertiary hover:text-foreground ml-1 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onChange("", "");
            }}
          >
            &times;
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 z-50 border border-border-subtle rounded-xl shadow-2xl bg-[#18181b] p-4 flex gap-4">
          {/* Presets */}
          <div className="flex flex-col gap-0.5 border-r border-border-subtle pr-4 min-w-[120px]">
            <span className="t-tertiary text-[10px] uppercase tracking-wider mb-2 px-2">
              Quick select
            </span>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p.days)}
                className="text-left text-xs px-2 py-1.5 rounded-md hover:bg-violet-500/10 hover:text-violet-300 text-foreground transition-colors whitespace-nowrap"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Calendar */}
          <div className="rdp-dark">
            <DayPicker
              mode="range"
              selected={selected}
              onSelect={handleRangeSelect}
              disabled={{ after: new Date() }}
              numberOfMonths={1}
              showOutsideDays
              classNames={{
                root: "text-foreground text-xs",
                months: "flex gap-4",
                month_caption: "flex items-center justify-center py-1 mb-1",
                caption_label: "text-xs font-medium text-foreground",
                nav: "flex items-center",
                button_previous:
                  "absolute left-1 top-2.5 h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-surface-secondary t-tertiary hover:text-foreground transition-colors",
                button_next:
                  "absolute right-1 top-2.5 h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-surface-secondary t-tertiary hover:text-foreground transition-colors",
                weekdays: "flex",
                weekday:
                  "w-9 text-center t-tertiary text-[10px] font-medium py-1",
                week: "flex",
                day: "h-9 w-9 text-center",
                day_button:
                  "h-8 w-8 rounded-md text-xs inline-flex items-center justify-center transition-colors hover:bg-surface-secondary cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed",
                selected: "!bg-violet-500 !text-white font-medium rounded-md",
                range_start:
                  "!bg-violet-500 !text-white font-medium rounded-l-md rounded-r-none",
                range_end:
                  "!bg-violet-500 !text-white font-medium rounded-r-md rounded-l-none",
                range_middle: "!bg-violet-500/20 !text-violet-300 rounded-none",
                today: "ring-1 ring-violet-500/50 rounded-md",
                outside: "opacity-40",
                disabled: "opacity-30 cursor-not-allowed",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
