/**
 * CROSS_REPO_INTELLIGENCE Sprint 7.1: federate the recall-notes query. After the
 * home proxy recalls its own anchored notes for a prompt, this fans the same
 * prompt out to federated peers and collects the notes THEY hold that are
 * relevant to the workspace — notes anchored to a file/entity the prompt names
 * (a cross-repo reference), plus the peer's workspace-wide (`w:`) notes.
 *
 * A peer's project-wide (`p:`) notes are deliberately dropped here: `p:` is
 * scoped to that repo's own project, not the workspace, so it would be noise in
 * another repo's recall. Workspace-spanning rules belong on the `w:` anchor
 * (Sprint 7.2), which always rides along.
 *
 * Degrades to an empty result on free tier (coordinator refuses), with no
 * coordinator, or on any federation fault — the home recall still stands.
 *
 * @sem domain=federation role=coordinator
 */

import type { FederationCoordinator } from "./coordinator.js";

/** JSON-RPC `unerr/federated_call` name for the peer-side recall executor. */
export const RECALL_NOTES_PEER_METHOD = "recall_notes_peer";

/** A note surfaced from a peer repo, carrying the owning repo's label. */
export interface FederatedNote {
  note_id: string;
  kind: string;
  anchor_type: string;
  anchor_value: string;
  polarity: string;
  content: string;
  created_at: number;
  reinforcement_count: number;
  anchor_missing: boolean;
  conflict_group_id: string;
  /** repoId of the peer that holds this note — labels it as cross-repo. */
  repo: string;
}

/** Outcome of a federated recall fan-out. */
export interface FederatedRecallResult {
  /** Peer notes relevant to the workspace, labeled by repo. */
  notes: FederatedNote[];
  /** True when ≥1 peer was unreachable — the peer-note set may be incomplete. */
  partial: boolean;
  /** True when the daemon refused workspace scope (free tier) — home-only. */
  refused: boolean;
}

/** Minimal shape of a peer's `recall_notes_peer` reply. */
interface PeerRecallReply {
  notes?: unknown[];
}

/** Narrow one raw peer-note object to the fields the home surfaces, dropping
 *  `p:` (peer-project-scoped) notes — only `w:` and anchor-matched notes cross. */
function toFederatedNote(raw: unknown, repo: string): FederatedNote | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  const anchor_type = typeof n.anchor_type === "string" ? n.anchor_type : "";
  if (anchor_type === "p") return null; // peer's project-wide note — not workspace
  if (typeof n.note_id !== "string" || typeof n.content !== "string")
    return null;
  return {
    note_id: n.note_id,
    kind: typeof n.kind === "string" ? n.kind : "fct",
    anchor_type,
    anchor_value: typeof n.anchor_value === "string" ? n.anchor_value : "",
    polarity: typeof n.polarity === "string" ? n.polarity : "~",
    content: n.content,
    created_at: typeof n.created_at === "number" ? n.created_at : 0,
    reinforcement_count:
      typeof n.reinforcement_count === "number" ? n.reinforcement_count : 0,
    anchor_missing: n.anchor_missing === true,
    conflict_group_id:
      typeof n.conflict_group_id === "string" ? n.conflict_group_id : "",
    repo,
  };
}

/**
 * Fan a recall query out to every federated peer and collect the notes they
 * hold for this prompt, labeled by repo. Returns `{notes:[], partial:false,
 * refused:false}` when there are no peers / nothing relevant. Never throws.
 */
export async function federateRecallNotes(opts: {
  prompt: string;
  coordinator: FederationCoordinator | null;
  homeRepo: string;
}): Promise<FederatedRecallResult> {
  const { prompt, coordinator, homeRepo } = opts;
  if (!coordinator || !prompt) {
    return { notes: [], partial: false, refused: false };
  }
  try {
    const fan = await coordinator.fanOut({
      homeRepo,
      toolName: RECALL_NOTES_PEER_METHOD,
      args: { prompt },
    });
    if (fan.refused) return { notes: [], partial: false, refused: true };

    const notes: FederatedNote[] = [];
    for (const r of fan.results) {
      const reply = r.result as PeerRecallReply | null;
      const raw = Array.isArray(reply?.notes) ? reply.notes : [];
      for (const item of raw) {
        const note = toFederatedNote(item, r.repoId);
        if (note) notes.push(note);
      }
    }
    return { notes, partial: fan.partial, refused: false };
  } catch {
    return { notes: [], partial: false, refused: false };
  }
}
