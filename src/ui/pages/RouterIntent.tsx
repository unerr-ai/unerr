/**
 * Sprint P2-6: Intent-decision viewer.
 *
 * Per-call view showing:
 *   - Family scores from the intent classifier
 *   - Reasoning (why each family scored as it did)
 *   - Mask decisions (exposed vs masked, with reasons)
 *   - Intent shift detection
 */

import { CardGridSkeleton } from "@/components/ui/Skeleton";
import { fetchJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

interface IntentScore {
  family: string;
  score: number;
  exposed: boolean;
  sticky: boolean;
  reasons: string[];
  thresholdApplied: number;
}

interface IntentResponse {
  data: {
    turnNumber: number;
    intentShifted: boolean;
    newlyExposedFamilies: string[];
    scores: IntentScore[];
    multiDomain: boolean;
    latencyMs: number;
    maskedFamilies: string[];
    exposedFamilies: string[];
  } | null;
}

function ScoreBar({ score, threshold }: { score: number; threshold: number }) {
  const pct = Math.min(100, Math.round(score * 100));
  const threshPct = Math.round(threshold * 100);
  const isAbove = score >= threshold;

  return (
    <div className="relative h-3 w-full rounded-full bg-zinc-800">
      <div
        className={`h-3 rounded-full transition-all ${isAbove ? "bg-emerald-500" : "bg-zinc-600"}`}
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute top-0 h-3 w-0.5 bg-amber-400"
        style={{ left: `${threshPct}%` }}
        title={`Threshold: ${threshPct}%`}
      />
    </div>
  );
}

export function RouterIntentPage() {
  const [selectedTurn, setSelectedTurn] = useState(0);

  const { data, isLoading } = useQuery<IntentResponse>({
    queryKey: ["router-intent", selectedTurn],
    queryFn: () => fetchJson(`/api/router/intent/${selectedTurn}`),
  });

  if (isLoading) return <CardGridSkeleton count={3} />;

  const intent = data?.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">Intent Decisions</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSelectedTurn(Math.max(0, selectedTurn - 1))}
            className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            ← Prev
          </button>
          <span className="text-xs text-zinc-400 font-mono tabular-nums">Turn {selectedTurn}</span>
          <button
            onClick={() => setSelectedTurn(selectedTurn + 1)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Next →
          </button>
        </div>
      </div>

      {!intent ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center text-sm text-zinc-400">
          No intent data for turn {selectedTurn}
        </div>
      ) : (
        <>
          {/* Status badges */}
          <div className="flex items-center gap-3">
            {intent.intentShifted && (
              <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-400">
                Intent Shifted
              </span>
            )}
            {intent.multiDomain && (
              <span className="inline-flex items-center rounded-full bg-violet-500/15 px-2.5 py-0.5 text-xs font-medium text-violet-400">
                Multi-Domain
              </span>
            )}
            <span className="text-xs text-zinc-500 font-mono tabular-nums">
              {intent.latencyMs.toFixed(2)}ms
            </span>
          </div>

          {/* Newly exposed */}
          {intent.newlyExposedFamilies.length > 0 && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-xs text-emerald-400">
                Newly exposed: {intent.newlyExposedFamilies.map((f) => <span key={f} className="font-mono mx-1">{f}</span>)}
              </p>
            </div>
          )}

          {/* Score table */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                  <th className="px-4 py-2 text-left">Family</th>
                  <th className="px-4 py-2 text-left">Score</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-left">Reasons</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {intent.scores.map((s) => (
                  <tr key={s.family} className={`${s.exposed ? "" : "opacity-50"}`}>
                    <td className="px-4 py-3 font-mono text-xs">{s.family}</td>
                    <td className="px-4 py-3 w-40">
                      <ScoreBar score={s.score} threshold={s.thresholdApplied} />
                      <span className="text-[10px] text-zinc-500 tabular-nums">{(s.score * 100).toFixed(0)}%</span>
                    </td>
                    <td className="px-4 py-3">
                      {s.exposed ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          <span className="text-xs text-emerald-400">exposed</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
                          <span className="text-xs text-zinc-500">masked</span>
                        </span>
                      )}
                      {s.sticky && <span className="ml-2 text-[10px] text-amber-400">sticky</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-400 max-w-xs truncate">
                      {s.reasons.join("; ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
