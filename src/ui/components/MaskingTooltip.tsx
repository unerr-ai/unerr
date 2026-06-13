/**
 * Sprint P2-6: "Why was this masked" tooltip + quick unmask action.
 *
 * Renders as a popover anchored to masked-tool indicators. Shows:
 *   - The family this tool belongs to
 *   - The classifier score and threshold that caused masking
 *   - Reasons (signals that did/didn't fire)
 *   - One-click "Unmask <family>" button
 */

import { fetchJson } from "@/lib/api";
import { useState } from "react";

export interface MaskingReason {
  family: string;
  score: number;
  threshold: number;
  reasons: string[];
  turnNumber: number;
}

interface MaskingTooltipProps {
  reason: MaskingReason;
  onUnmask?: (family: string) => void;
}

export function MaskingTooltip({ reason, onUnmask }: MaskingTooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [unmasking, setUnmasking] = useState(false);

  const scorePct = Math.round(reason.score * 100);
  const thresholdPct = Math.round(reason.threshold * 100);
  const gap = thresholdPct - scorePct;

  async function handleUnmask() {
    setUnmasking(true);
    try {
      await fetchJson(`/api/router/unmask/${reason.family}`, {
        method: "POST",
      });
      onUnmask?.(reason.family);
    } finally {
      setUnmasking(false);
      setIsOpen(false);
    }
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
        title="Why was this masked?"
      >
        <svg
          className="h-3 w-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21"
          />
        </svg>
        masked
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl text-left">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-zinc-200">Why Masked</h4>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-zinc-500 hover:text-zinc-300 text-xs"
            >
              ✕
            </button>
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <span className="text-zinc-500">Family:</span>{" "}
              <span className="font-mono text-zinc-200">{reason.family}</span>
            </div>

            <div>
              <span className="text-zinc-500">Score:</span>{" "}
              <span className="font-mono text-red-400 tabular-nums">
                {scorePct}%
              </span>
              <span className="text-zinc-600 mx-1">|</span>
              <span className="text-zinc-500">Threshold:</span>{" "}
              <span className="font-mono text-amber-400 tabular-nums">
                {thresholdPct}%
              </span>
              <span className="text-zinc-600 ml-2">(gap: {gap}pt)</span>
            </div>

            <div className="h-2 w-full rounded-full bg-zinc-800 relative">
              <div
                className="h-2 rounded-full bg-red-500/60"
                style={{ width: `${scorePct}%` }}
              />
              <div
                className="absolute top-0 h-2 w-0.5 bg-amber-400"
                style={{ left: `${thresholdPct}%` }}
              />
            </div>

            {reason.reasons.length > 0 && (
              <div>
                <p className="text-zinc-500 mb-1">Reasons (no signal):</p>
                <ul className="space-y-0.5 text-zinc-400">
                  {reason.reasons.map((r, i) => (
                    <li key={i} className="pl-2 border-l border-zinc-800">
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="text-[10px] text-zinc-600">
              Turn {reason.turnNumber}
            </div>

            <button
              type="button"
              onClick={handleUnmask}
              disabled={unmasking}
              className="w-full rounded border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-400 hover:bg-violet-500/20 disabled:opacity-50 transition-colors"
            >
              {unmasking ? "Unmasking..." : `Unmask ${reason.family}`}
            </button>

            <p className="text-[10px] text-zinc-600">
              Or run:{" "}
              <code className="text-zinc-400">
                unerr router unmask {reason.family}
              </code>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
