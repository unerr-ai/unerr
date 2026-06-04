/**
 * Two consolidated MCP tools — see ACTIVE_COGNITION_REASON_LAYER.md §6.
 *
 *   unerr_recall_notes — read tool, dispatches by input shape (prompt
 *   vs anchors) into NotesStore.recallByPrompt / recallByAnchors.
 *
 *   unerr_remember — write tool, dispatches by `type` field
 *   (note | cochange | move_anchor | promote_to_claude_md) into
 *   NotesStore.upsertNote / upsertCoChange / moveAnchor (and into the
 *   CLAUDE.md mirror writer for the promote path; see notes-promote.ts).
 *
 * Action-dispatch keeps the MCP tool count flat — two registered names
 * instead of five — so the cognitive-load budget on every agent's
 * tools/list stays under the practical limit (~26-30 tools). See §6.1
 * for the rationale.
 *
 * These wrappers stay thin: input validation, dispatch, and result
 * envelope only. All semantics live in NotesStore.
 */

import { promoteNotesToClaudeMd } from "../../intelligence/claude-md-mirror.js";
import type { NotesStore, StoredNote } from "../../intelligence/notes-store.js";
import { setPendingTopicShift } from "../../intelligence/topic-shift.js";

export interface RecallNotesInput {
  /** Discriminator. Defaults to "anchors" when omitted (and anchors[] is set). */
  action?: "for_prompt" | "for_anchors";
  prompt?: string;
  anchors?: string[];
  candidate_anchors?: string[];
  tier?: "hot" | "all";
  session_id?: string;
}

export interface RememberInput {
  /** Discriminator. Defaults to "note" when omitted (for legacy alias compat). */
  type?: "note" | "cochange" | "move_anchor" | "promote_to_claude_md";
  // type:"note" payload
  note?: string;
  supersedes_note_id?: string;
  // type:"cochange" payload
  anchors?: string[];
  content?: string;
  // type:"move_anchor" payload
  old_anchor?: string;
  new_anchor?: string;
  // type:"promote_to_claude_md" payload
  note_ids?: string[];
  // shared
  session_id?: string;
  prompt_hash?: string;
}

export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  hint?: string;
}

function err<T>(message: string): ToolResult<T> {
  return { ok: false, error: message };
}

/** Project a stored note to the agent-facing wire shape. The cite-in-plan
 *  contract (CLAUDE.md Moment 3) needs only id + kind + anchor + polarity +
 *  content. Store bookkeeping (dedupe_key, reinforcement/contradiction
 *  counts, conflict_group_id, supersedes_note_id, inactive, anchor_missing,
 *  timestamps) stays in CozoDB for the dashboard — it never rides the wire. */
function projectNoteForWire(n: StoredNote): {
  note_id: string;
  kind: string;
  anchor: string;
  polarity: string;
  content: string;
} {
  return {
    note_id: n.note_id,
    kind: n.kind,
    // Recompose the single self-describing DSL anchor (e.g. "f:src/x.ts",
    // "p:") instead of shipping split anchor_type / anchor_value the agent
    // would have to reassemble.
    anchor: `${n.anchor_type}:${n.anchor_value}`,
    polarity: n.polarity,
    content: n.content,
  };
}

/** Dispatch unerr_recall_notes by input shape. */
export async function recallNotes(
  store: NotesStore,
  input: RecallNotesInput
): Promise<ToolResult<unknown>> {
  const action =
    input.action ??
    (input.prompt
      ? "for_prompt"
      : input.anchors && input.anchors.length > 0
        ? "for_anchors"
        : null);
  if (action === null) {
    return err("recall_notes: must provide `prompt` or `anchors`");
  }
  try {
    if (action === "for_prompt") {
      if (!input.prompt) return err("recall_notes: prompt required");
      const result = await store.recallByPrompt({
        prompt: input.prompt,
        candidate_anchors: input.candidate_anchors,
        session_id: input.session_id,
      });
      if (input.session_id && result.topic_shift === true) {
        setPendingTopicShift(input.session_id, {
          flag: true,
          overlap: result.topic_shift_overlap ?? 0,
        });
      }
      return {
        ok: true,
        data: {
          notes: result.notes.map(projectNoteForWire),
          ...(result.topic_shift ? { topic_shift: true } : {}),
        },
        hint:
          result.notes.length === 0
            ? "0 notes recalled — proceed with the task; at task close emit unerr-save: note kind|anchor|polarity|content in your closing message if you learn something non-obvious + anchorable"
            : `${result.notes.length} note(s) recalled — cite by note_id in your plan`,
      };
    }
    // for_anchors
    if (!input.anchors || input.anchors.length === 0) {
      return err("recall_notes: anchors[] required for for_anchors action");
    }
    const result = await store.recallByAnchors({
      anchors: input.anchors,
      tier: input.tier,
      session_id: input.session_id,
    });
    const requestedAnchors = input.anchors.length;
    return {
      ok: true,
      data: { notes: result.notes.map(projectNoteForWire) },
      hint:
        result.notes.length === 0
          ? `0 notes for ${requestedAnchors} anchor(s) — proceed; write a note at task close if non-obvious + anchorable`
          : `${result.notes.length} note(s) — cite by note_id in your plan`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`recall_notes failed: ${msg}`);
  }
}

/** Dispatch unerr_remember by `type` field. */
export async function remember(
  store: NotesStore,
  input: RememberInput,
  /** When type=promote_to_claude_md, the caller injects the writer. Kept as a
   *  function pointer so this module stays decoupled from filesystem I/O. */
  promoteWriter?: (
    noteIds: string[]
  ) => Promise<{ written: number; path: string }>
): Promise<ToolResult<unknown>> {
  const type = input.type ?? "note";
  try {
    switch (type) {
      case "note": {
        if (!input.note)
          return err("remember: note (DSL wire string) required");
        if (!input.session_id) return err("remember: session_id required");
        const result = await store.upsertNote({
          note: input.note,
          session_id: input.session_id,
          prompt_hash: input.prompt_hash ?? "",
          supersedes_note_id: input.supersedes_note_id,
        });
        // Wire payload: keep only what the agent acts on — note_id +
        // outcome, plus the conditionally-actionable bits (conflict_group_id
        // to surface both sides; reinforcement candidates projected to
        // {note_id, content} so the agent reinforces instead of rewriting).
        // The duplicate `hint` (was both in `data` and top-level) collapses to
        // one; store bookkeeping stays in CozoDB for the dashboard.
        const data: Record<string, unknown> = {
          note_id: result.note_id,
          outcome: result.outcome,
        };
        if (result.conflict_group_id) {
          data.conflict_group_id = result.conflict_group_id;
        }
        if (
          result.reinforcement_candidates &&
          result.reinforcement_candidates.length > 0
        ) {
          data.reinforce = result.reinforcement_candidates.map((n) => ({
            note_id: n.note_id,
            content: n.content,
          }));
        }
        return {
          ok: result.stored || result.outcome === "rate_limited",
          data,
          hint: result.hint,
        };
      }
      case "cochange": {
        if (!input.anchors || input.anchors.length < 2) {
          return err("remember(cochange): anchors[] (≥2) required");
        }
        if (!input.content) return err("remember(cochange): content required");
        const result = await store.upsertCoChange({
          anchors: input.anchors,
          content: input.content,
        });
        return { ok: true, data: result };
      }
      case "move_anchor": {
        if (!input.old_anchor || !input.new_anchor) {
          return err("remember(move_anchor): old_anchor + new_anchor required");
        }
        const result = await store.moveAnchor({
          old_anchor: input.old_anchor,
          new_anchor: input.new_anchor,
        });
        return {
          ok: true,
          data: result,
          hint:
            result.migrated === 0
              ? "no notes migrated — no rows pointed at old_anchor"
              : `migrated ${result.migrated} note(s) ${input.old_anchor} → ${input.new_anchor}`,
        };
      }
      case "promote_to_claude_md": {
        if (!input.note_ids || input.note_ids.length === 0) {
          return err("remember(promote_to_claude_md): note_ids[] required");
        }
        if (!promoteWriter) {
          return err(
            "remember(promote_to_claude_md): promoteWriter not provided — proxy must inject the CLAUDE.md mirror writer"
          );
        }
        const result = await promoteWriter(input.note_ids);
        return {
          ok: true,
          data: result,
          hint: `wrote ${result.written} entry/entries to ${result.path}`,
        };
      }
      default:
        return err(`remember: unknown type '${type}'`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`remember failed: ${msg}`);
  }
}

/**
 * Build the CLAUDE.md `promoteWriter` callback the proxy injects into
 * `remember({type:"promote_to_claude_md"})`. Resolves note_ids via a
 * caller-supplied loader, then writes the sentinel block.
 */
export function buildClaudeMdPromoter(opts: {
  claude_md_path: string;
  loadNotes: (ids: readonly string[]) => Promise<StoredNote[]>;
}): (noteIds: string[]) => Promise<{ written: number; path: string }> {
  return async (noteIds) => {
    const notes = await opts.loadNotes(noteIds);
    const result = promoteNotesToClaudeMd({
      claude_md_path: opts.claude_md_path,
      notes,
    });
    return { written: result.written, path: result.path };
  };
}
