/**
 * CROSS_REPO_INTELLIGENCE Sprint 8.1: surface a peer repo's conventions when the
 * home agent reads a file that lives in a federated sibling. The implicit path
 * route (Sprint 3) already serves the foreign file's content from the owning
 * peer, but that content rides `executeRaw`, which bypasses the home's
 * convention-injection step — so a cross-repo read used to arrive with no
 * conventions at all. The owning peer attaches its own conventions for the file
 * here, labeled by repo, so the home surfaces them as `ur|fct` lines.
 *
 */

import type { IntelligenceSignal } from "../signal-scorer.js";

/** Tools whose foreign-path route carries the owning peer's file conventions. */
export const PEER_CONVENTION_FILE_METHODS: ReadonlySet<string> = new Set([
  "file_read",
  "file_outline",
]);

/** One convention the owning peer holds for the routed file. */
export interface PeerConvention {
  id: string;
  name: string;
  adherence_pct: number;
  rule: string;
}

/**
 * Federated `content` shape the peer returns for a path-routed file tool: the
 * raw tool output the home surfaces as-is, plus the peer's conventions for the
 * file. The home unwraps `content` and lifts `peer_conventions` into signals.
 */
export interface RoutedFileContent {
  content: unknown;
  peer_conventions: PeerConvention[];
}

/** Narrow an unknown federated reply to the {content, peer_conventions} wrapper. */
export function isRoutedFileContent(v: unknown): v is RoutedFileContent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return "content" in o && Array.isArray(o.peer_conventions);
}

/**
 * Turn a peer's conventions into `_context.signals` entries, each naming the
 * owning repo so the agent reads them as cross-repo facts ("svc follows …").
 * `type:"context"` renders as `ur|fct` (the fct bucket) on the wire — the same
 * tag the home's own convention injections use. Relevance/confidence track the
 * peer's measured adherence so a stronger convention outranks a weaker one.
 */
export function peerConventionSignals(
  conventions: readonly PeerConvention[],
  repoLabel: string
): IntelligenceSignal[] {
  return conventions.map((c) => {
    const weight = Math.max(0, Math.min(1, c.adherence_pct / 100));
    const actionability = 0.6;
    return {
      type: "context" as const,
      content: `${repoLabel} follows "${c.name}" (${c.adherence_pct}% adherence)`,
      action: c.rule,
      actionability,
      relevance: weight,
      confidence: weight,
      composite_score: actionability ** 1.5 * weight * weight,
      source: "graph" as const,
    };
  });
}
