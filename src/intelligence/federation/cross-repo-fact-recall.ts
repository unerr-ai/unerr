/**
 * CROSS_REPO_INTELLIGENCE Sprint 7.4: federate the recall-facts query through
 * the temporal fact store. After the home proxy recalls its own facts for a
 * scope, this fans the same scope out to federated peers and collects the facts
 * THEY hold that matter cross-repo — a peer's facts about its own entities and
 * conventions, which the home references when it edits across the workspace.
 *
 * A peer's `project`-scoped facts are deliberately dropped: `project` scope is
 * that repo's own project, not the workspace, so it would be noise in another
 * repo's recall — the same cut the note path makes for `p:` anchors (Sprint 7.1).
 *
 * Degrades to an empty result on free tier (coordinator refuses), with no
 * coordinator, or on any federation fault — the home recall still stands.
 *
 * @sem domain=federation role=coordinator
 */

import type { FederationCoordinator } from "./coordinator.js";

/** JSON-RPC `unerr/federated_call` name for the peer-side fact-recall executor. */
export const RECALL_FACTS_PEER_METHOD = "recall_facts_peer";

/** A fact surfaced from a peer repo, carrying the owning repo's label. */
export interface FederatedFact {
  fact_id: string;
  fact_type: string;
  scope: string;
  subject: string;
  content: string;
  effective_confidence: number;
  reinforcement_count: number;
  source: string;
  /** repoId of the peer that holds this fact — labels it as cross-repo. */
  repo: string;
}

/** Outcome of a federated fact-recall fan-out. */
export interface FederatedFactRecallResult {
  /** Peer facts relevant to the workspace, labeled by repo. */
  facts: FederatedFact[];
  /** True when ≥1 peer was unreachable — the peer-fact set may be incomplete. */
  partial: boolean;
  /** True when the daemon refused workspace scope (free tier) — home-only. */
  refused: boolean;
}

/** Minimal shape of a peer's `recall_facts_peer` reply. */
interface PeerFactReply {
  facts?: unknown[];
}

/** Narrow one raw peer-fact object to the fields the home surfaces, dropping
 *  `project`-scoped facts — only entity/file-scoped facts cross the boundary. */
function toFederatedFact(raw: unknown, repo: string): FederatedFact | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const scope = typeof f.scope === "string" ? f.scope : "";
  if (scope === "project") return null; // peer's project-wide fact — not workspace
  if (typeof f.fact_id !== "string" || typeof f.content !== "string") {
    return null;
  }
  return {
    fact_id: f.fact_id,
    fact_type: typeof f.fact_type === "string" ? f.fact_type : "semantic",
    scope,
    subject: typeof f.subject === "string" ? f.subject : "",
    content: f.content,
    effective_confidence:
      typeof f.effective_confidence === "number" ? f.effective_confidence : 0,
    reinforcement_count:
      typeof f.reinforcement_count === "number" ? f.reinforcement_count : 0,
    source: typeof f.source === "string" ? f.source : "inferred",
    repo,
  };
}

/**
 * Fan a fact-recall query out to every federated peer and collect the facts
 * they hold for this scope, labeled by repo. Returns `{facts:[], partial:false,
 * refused:false}` when there are no peers / nothing relevant. Never throws.
 */
export async function federateRecallFacts(opts: {
  scope: string;
  factType?: string;
  minConfidence?: number;
  coordinator: FederationCoordinator | null;
  homeRepo: string;
}): Promise<FederatedFactRecallResult> {
  const { scope, factType, minConfidence, coordinator, homeRepo } = opts;
  if (!coordinator || !scope) {
    return { facts: [], partial: false, refused: false };
  }
  try {
    const fan = await coordinator.fanOut({
      homeRepo,
      toolName: RECALL_FACTS_PEER_METHOD,
      args: {
        scope,
        ...(factType ? { fact_type: factType } : {}),
        ...(typeof minConfidence === "number"
          ? { min_confidence: minConfidence }
          : {}),
      },
    });
    if (fan.refused) return { facts: [], partial: false, refused: true };

    const facts: FederatedFact[] = [];
    for (const r of fan.results) {
      const reply = r.result as PeerFactReply | null;
      const raw = Array.isArray(reply?.facts) ? reply.facts : [];
      for (const item of raw) {
        const fact = toFederatedFact(item, r.repoId);
        if (fact) facts.push(fact);
      }
    }
    return { facts, partial: fan.partial, refused: false };
  } catch {
    return { facts: [], partial: false, refused: false };
  }
}
