/**
 * Layer B notes store — Active-cognition sub-handlers.
 *
 * Pure CozoDB driver code. The MCP tool wrappers in
 * `src/tools/intelligence/notes-mcp.ts` dispatch action/type fields here.
 *
 * Owns:
 *   - upsertNote — write a DSL note, reinforce on dedupe, flag conflicts,
 *     enforce session save cap (Sprint B items 3, 5, 9)
 *   - upsertCoChangeGroup — write/reinforce a co-change row (item 3)
 *   - moveAnchor — agent-driven rename migration (Sprint C item 7 entry)
 *   - recallByAnchors — return notes for explicit anchors (item 3)
 *   - recallByPrompt — anchor-candidate composition + recall (item 3)
 *   - listConflicts — list active conflict groups for surfacing (item 5)
 *
 * Conventions:
 *   - All public methods async (per CozoDB rule #3 in CLAUDE.md).
 *   - Schema knowledge stays in facts-schema.ts; column names referenced
 *     here only via Datalog text — never as imported constants.
 *   - Save rate-limit uses a per-session counter held in the store
 *     instance, NOT in the DB. The proxy passes a session-scoped store
 *     per session.
 *
 * See ACTIVE_COGNITION_REASON_LAYER.md §§5, 6, 11.5, 11.8, 14.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { recordCoChangeGroup } from "./cochange-index.js";

const UNERR_DIR_FOR_COCHANGE = join(process.cwd(), ".unerr");
import type { CozoDb } from "./cozo-schema.js";
import {
  type NoteAnchorType,
  type NoteKind,
  type NotePolarity,
  type ParsedNote,
  dedupeKey,
  parseNote,
  serializeNote,
} from "./note-dsl.js";
import { detectTopicShift } from "./topic-shift.js";

const SESSION_SAVE_CAP = 15;

export interface StoredNote {
  note_id: string;
  kind: NoteKind;
  anchor_type: NoteAnchorType;
  anchor_value: string;
  polarity: NotePolarity;
  content: string;
  dedupe_key: string;
  reinforcement_count: number;
  contradiction_count: number;
  conflict_group_id: string;
  supersedes_note_id: string;
  inactive: boolean;
  anchor_missing: boolean;
  created_at: number;
  last_seen_at: number;
}

export interface UpsertNoteInput {
  /** Raw DSL wire string OR a pre-parsed note. Either is accepted. */
  note: string | ParsedNote;
  session_id: string;
  prompt_hash: string;
  /** Explicit supersession marker — passed when the agent intentionally
   *  replaces an older note. Triggers inactive-flip of the named row. */
  supersedes_note_id?: string;
  /** Allow callers to override the clock for tests. Epoch ms. */
  now_ms?: number;
}

export interface UpsertNoteResult {
  stored: boolean;
  note_id: string;
  /** "created" | "reinforced" | "rate_limited" | "conflict" */
  outcome: "created" | "reinforced" | "rate_limited" | "conflict";
  /** When set, an existing conflict_group_id binds opposing-polarity rows. */
  conflict_group_id?: string;
  /** When rate_limited, this lists existing notes the agent should reinforce
   *  instead of writing a new row. */
  reinforcement_candidates?: StoredNote[];
  /** Human-readable hint for the agent's next move. */
  hint?: string;
}

export interface RecallByAnchorsInput {
  anchors: readonly string[]; // wire-format anchors like "f:src/a.ts" or "p:"
  tier?: "hot" | "all";
  /** Caller's session id for telemetry; the rate-limit counter is per-store-instance. */
  session_id?: string;
}

export interface RecallByPromptInput {
  prompt: string;
  /** Optional candidate anchors the caller pre-computed (e.g. from search_code). */
  candidate_anchors?: readonly string[];
  /** Anchors seen over recent turns (most recent last). Drives topic-shift detection. */
  recent_anchors_by_turn?: readonly (readonly string[])[];
  session_id?: string;
}

export interface RecallResult {
  notes: StoredNote[];
  /** Anchors actually queried (after candidate composition). */
  anchors_queried: string[];
  /** Set only when recallByPrompt computes it. True ⇒ Surface 2 should render a shift line. */
  topic_shift?: boolean;
  /** Jaccard overlap that drove the topic_shift decision. Telemetry-only. */
  topic_shift_overlap?: number;
}

export interface CoChangeUpsertInput {
  anchors: readonly string[]; // ["f:src/a.ts", "f:src/b.ts"]
  content: string;
  now_ms?: number;
}

export interface CoChangeUpsertResult {
  group_id: string;
  reinforcement_count: number;
  outcome: "created" | "reinforced";
}

export interface MoveAnchorInput {
  old_anchor: string; // wire-format e.g. "f:src/old.ts"
  new_anchor: string; // wire-format e.g. "f:src/new.ts"
  now_ms?: number;
}

export interface MoveAnchorResult {
  migrated: number;
  old_anchor: string;
  new_anchor: string;
}

/** Per-session state held in-memory by the store. */
interface SessionState {
  saves_this_session: number;
}

/**
 * Construct a session-scoped notes store. One instance per session — the
 * save-rate-limit counter lives on the instance.
 */
export class NotesStore {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly db: CozoDb) {}

  /** Reset the save counter for a session. Tests use this; runtime relies on instance lifecycle. */
  resetSessionCounter(sessionId: string): void {
    this.sessions.set(sessionId, { saves_this_session: 0 });
  }

  /**
   * Write or reinforce a note. Drives §6.1 `unerr_remember({type:"note"})`.
   *
   * Order of checks:
   *   1. Parse + validate DSL (delegated to note-dsl).
   *   2. Compute dedupe key; if a row with this key exists, reinforce.
   *   3. Otherwise, scan for opposing-polarity rows under same kind+anchor.
   *      If found, assign or join the conflict_group_id and write the new
   *      row as `conflict` outcome (still stored — the agent's job is to
   *      surface both sides; we don't pick winners).
   *   4. If supersedes_note_id is set, flip that row's inactive=true.
   *   5. Apply session save cap. Over cap returns rate_limited + a list of
   *      reinforcement candidates the agent can target instead.
   */
  async upsertNote(input: UpsertNoteInput): Promise<UpsertNoteResult> {
    const parsed =
      typeof input.note === "string" ? parseNote(input.note) : input.note;
    const wire = serializeNote(parsed);
    const dk = dedupeKey(parsed);
    const now = input.now_ms ?? Date.now();

    // 1) Dedupe / reinforce on existing row.
    const existing = await this.findByDedupeKey(dk);
    if (existing) {
      await this.db.run(
        `?[note_id, reinforcement_count, last_seen_at] <- [[$id, $rc, $now]]
         :update notes {note_id => reinforcement_count, last_seen_at}`,
        { id: existing.note_id, rc: existing.reinforcement_count + 1, now }
      );
      return {
        stored: true,
        note_id: existing.note_id,
        outcome: "reinforced",
        hint: `reinforced existing note ${existing.note_id} (count=${existing.reinforcement_count + 1})`,
      };
    }

    // 2) Conflict detection — opposing polarity for same kind + anchor.
    const conflicts = await this.findOpposingPolarity(parsed);

    // 3) Session save cap.
    const state =
      this.sessions.get(input.session_id) ??
      this.sessions
        .set(input.session_id, { saves_this_session: 0 })
        .get(input.session_id);
    if (!state) throw new Error("session-state init failed");
    if (state.saves_this_session >= SESSION_SAVE_CAP) {
      const candidates = await this.findReinforcementCandidates(parsed);
      return {
        stored: false,
        note_id: "",
        outcome: "rate_limited",
        reinforcement_candidates: candidates,
        hint: `session cap ${SESSION_SAVE_CAP} reached — reinforce existing notes instead of writing new ones`,
      };
    }

    // 4) Decide conflict group: reuse if one already exists for this kind+anchor,
    //    else mint a new one when conflicts.length > 0.
    let conflictGroupId = "";
    if (conflicts.length > 0) {
      conflictGroupId =
        conflicts.find((c) => c.conflict_group_id !== "")?.conflict_group_id ??
        `cg-${randomId()}`;
      // Bind any existing-but-ungrouped conflicting rows into this group.
      for (const c of conflicts) {
        if (c.conflict_group_id === "") {
          await this.db.run(
            `?[note_id, conflict_group_id] <- [[$id, $cgid]]
             :update notes {note_id => conflict_group_id}`,
            { id: c.note_id, cgid: conflictGroupId }
          );
        }
      }
    }

    // 5) Supersession flip — flip the named row to inactive.
    if (input.supersedes_note_id && input.supersedes_note_id.length > 0) {
      await this.db.run(
        `?[note_id, inactive] <- [[$id, true]]
         :update notes {note_id => inactive}`,
        { id: input.supersedes_note_id }
      );
    }

    // 6) Insert the new row.
    const noteId = `n-${randomId()}`;
    await this.db.run(
      `?[note_id, kind, anchor_type, anchor_value, polarity, content,
         dedupe_key, reinforcement_count, contradiction_count,
         created_session_id, created_prompt_hash, created_at, last_seen_at,
         decay_score, conflict_group_id, supersedes_note_id,
         inactive, anchor_missing, anchor_missing_since]
       <- [[
         $id, $kind, $atype, $aval, $pol, $content,
         $dk, 0, 0, $sess, $phash, $now, $now,
         0.0, $cgid, $sup, false, false, 0.0
       ]]
       :put notes`,
      {
        id: noteId,
        kind: parsed.kind,
        atype: parsed.anchor_type,
        aval: parsed.anchor_value,
        pol: parsed.polarity,
        content: parsed.content,
        dk,
        sess: input.session_id,
        phash: input.prompt_hash,
        now,
        cgid: conflictGroupId,
        sup: input.supersedes_note_id ?? "",
      }
    );

    state.saves_this_session++;

    return {
      stored: true,
      note_id: noteId,
      outcome: conflicts.length > 0 ? "conflict" : "created",
      conflict_group_id:
        conflictGroupId.length > 0 ? conflictGroupId : undefined,
      hint:
        conflicts.length > 0
          ? `stored as ${noteId}; conflict group ${conflictGroupId} now has ${conflicts.length + 1} active notes — surface all when citing ${wire}`
          : `stored as ${noteId}`,
    };
  }

  /** §6.1 `unerr_remember({type:"cochange"})`. Dedupes on sorted-anchor join. */
  async upsertCoChange(
    input: CoChangeUpsertInput
  ): Promise<CoChangeUpsertResult> {
    if (input.anchors.length < 2) {
      throw new Error("co-change groups require at least two anchors");
    }
    const sorted = [...input.anchors].sort();
    const anchorsJson = JSON.stringify(sorted);
    const now = input.now_ms ?? Date.now();
    const groupId = `cg-${createHash("sha1").update(anchorsJson).digest("hex").slice(0, 12)}`;

    const existing = await this.db.run(
      "?[reinforcement_count] := *co_change_groups{group_id, reinforcement_count}, group_id = $gid",
      { gid: groupId }
    );
    if (existing.rows.length > 0) {
      const rc = (existing.rows[0]?.[0] as number) + 1;
      await this.db.run(
        `?[group_id, reinforcement_count, last_seen_at] <- [[$gid, $rc, $now]]
         :update co_change_groups {group_id => reinforcement_count, last_seen_at}`,
        { gid: groupId, rc, now }
      );
      return {
        group_id: groupId,
        reinforcement_count: rc,
        outcome: "reinforced",
      };
    }

    await this.db.run(
      `?[group_id, anchors, content, reinforcement_count, created_at, last_seen_at]
       <- [[$gid, $a, $c, 0, $now, $now]]
       :put co_change_groups`,
      { gid: groupId, a: anchorsJson, c: input.content, now }
    );
    recordCoChangeGroup(UNERR_DIR_FOR_COCHANGE, sorted);
    return { group_id: groupId, reinforcement_count: 0, outcome: "created" };
  }

  /**
   * §11.1 silent-decay tier — flip every note for an anchor to
   * `anchor_missing=true` so the tier formula in note-tiering accelerates decay
   * by 0.5 per week. Caller should pass nowMs as the "missing since" mark.
   */
  async markAnchorMissing(
    anchor: string,
    nowMs?: number
  ): Promise<{ flagged: number; anchor: string }> {
    const parsed = parseAnchor(anchor);
    const now = nowMs ?? Date.now();
    const rows = await this.db.run(
      `?[note_id] := *notes{note_id, anchor_type, anchor_value, anchor_missing},
         anchor_type = $atype, anchor_value = $aval, anchor_missing = false`,
      { atype: parsed.anchor_type, aval: parsed.anchor_value }
    );
    let flagged = 0;
    for (const row of rows.rows) {
      const id = row[0] as string;
      await this.db.run(
        `?[note_id, anchor_missing, anchor_missing_since]
         <- [[$id, true, $now]]
         :update notes {note_id => anchor_missing, anchor_missing_since}`,
        { id, now }
      );
      flagged++;
    }
    return { flagged, anchor };
  }

  /** §6.1 `unerr_remember({type:"move_anchor"})`. Updates every note row carrying old_anchor. */
  async moveAnchor(input: MoveAnchorInput): Promise<MoveAnchorResult> {
    const oldParsed = parseAnchor(input.old_anchor);
    const newParsed = parseAnchor(input.new_anchor);
    const rows = await this.db.run(
      `?[note_id] := *notes{note_id, anchor_type, anchor_value},
         anchor_type = $atype, anchor_value = $aval`,
      { atype: oldParsed.anchor_type, aval: oldParsed.anchor_value }
    );
    const now = input.now_ms ?? Date.now();
    let migrated = 0;
    for (const row of rows.rows) {
      const id = row[0] as string;
      await this.db.run(
        `?[note_id, anchor_type, anchor_value, anchor_missing, anchor_missing_since, last_seen_at]
         <- [[$id, $atype, $aval, false, 0.0, $now]]
         :update notes {note_id => anchor_type, anchor_value, anchor_missing, anchor_missing_since, last_seen_at}`,
        {
          id,
          atype: newParsed.anchor_type,
          aval: newParsed.anchor_value,
          now,
        }
      );
      migrated++;
    }
    return {
      migrated,
      old_anchor: input.old_anchor,
      new_anchor: input.new_anchor,
    };
  }

  /** §6.1 `unerr_recall_notes({anchors})`. Default returns active notes only. */
  async recallByAnchors(input: RecallByAnchorsInput): Promise<RecallResult> {
    if (input.anchors.length === 0) return { notes: [], anchors_queried: [] };
    const out: StoredNote[] = [];
    for (const a of input.anchors) {
      const { anchor_type, anchor_value } = parseAnchor(a);
      const rows = await this.db.run(
        `?[note_id, kind, anchor_type, anchor_value, polarity, content,
           dedupe_key, reinforcement_count, contradiction_count,
           conflict_group_id, supersedes_note_id, inactive, anchor_missing,
           created_at, last_seen_at]
         := *notes{
              note_id, kind, anchor_type, anchor_value,
              polarity, content, dedupe_key, reinforcement_count,
              contradiction_count, conflict_group_id, supersedes_note_id,
              inactive, anchor_missing, created_at, last_seen_at
            },
            anchor_type = $atype,
            anchor_value = $aval,
            inactive = false`,
        { atype: anchor_type, aval: anchor_value }
      );
      for (const r of rows.rows) out.push(rowToStoredNote(r));
    }
    return { notes: out, anchors_queried: [...input.anchors] };
  }

  /**
   * §6.1 `unerr_recall_notes({prompt})`. Anchor candidates are composed from
   * three sources, in priority order:
   *   1. `candidate_anchors` the caller pre-computed (e.g. from search_code),
   *   2. lexical inference from the prompt text — file-path tokens become
   *      `f:` anchors, identifier tokens (camelCase / PascalCase / snake)
   *      become `e:` anchors (`anchorCandidatesFromPrompt`),
   *   3. `p:` (project-wide) always rides along, last so budget trimming
   *      keeps the specific anchors first.
   * `g:` (glob) notes match by pattern against the prompt's file paths, not
   * by exact anchor equality, so they get their own pass.
   *
   * History: this used to default to `["p:"]` when no `candidate_anchors`
   * were passed — and no caller ever passed any, so a note anchored to a
   * file NAMED IN THE PROMPT never rode along in the prompt-receipt hook or
   * the unerr_context bundle. The Moment-1/Moment-2 contract silently
   * degraded to project-wide notes only.
   */
  async recallByPrompt(input: RecallByPromptInput): Promise<RecallResult> {
    const inferred = anchorCandidatesFromPrompt(input.prompt);
    const anchorSet = new Set<string>();
    for (const a of input.candidate_anchors ?? []) anchorSet.add(a);
    for (const a of inferred.anchors) anchorSet.add(a);
    anchorSet.add("p:");
    // CROSS_REPO_INTELLIGENCE Sprint 7.2: workspace-wide notes (`w:`) always ride
    // along, like `p:` — a rule authored for the whole workspace applies to every
    // repo in it, including this one. Federated recall (7.1) surfaces peers' `w:`
    // notes; this surfaces the home's own.
    anchorSet.add("w:");
    const anchors = [...anchorSet];
    const base = await this.recallByAnchors({
      anchors,
      session_id: input.session_id,
    });
    const globMatches =
      inferred.file_paths.length > 0
        ? await this.recallGlobMatches(inferred.file_paths)
        : [];
    const seen = new Set<string>();
    const notes = [...base.notes, ...globMatches].filter((n) => {
      if (seen.has(n.note_id)) return false;
      seen.add(n.note_id);
      return true;
    });
    const result: RecallResult = { notes, anchors_queried: anchors };
    if (!input.recent_anchors_by_turn) return result;
    const shift = detectTopicShift({
      current_anchors: anchors,
      recent_anchors_by_turn: input.recent_anchors_by_turn,
    });
    return {
      ...result,
      topic_shift: shift.topic_shift,
      topic_shift_overlap: shift.overlap,
    };
  }

  /**
   * Recall active `g:`-anchored notes whose glob matches any of the given
   * file paths. Glob anchors can't go through recallByAnchors' exact
   * anchor_value equality — `g:*.test.ts` must fire for a prompt naming
   * `src/foo.test.ts`. Glob rows are few (they're hand-written rules), so
   * one full scan of anchor_type="g" + in-memory matching is cheap.
   */
  private async recallGlobMatches(filePaths: string[]): Promise<StoredNote[]> {
    const rows = await this.db.run(
      `?[note_id, kind, anchor_type, anchor_value, polarity, content,
         dedupe_key, reinforcement_count, contradiction_count,
         conflict_group_id, supersedes_note_id, inactive, anchor_missing,
         created_at, last_seen_at]
       := *notes{
            note_id, kind, anchor_type, anchor_value,
            polarity, content, dedupe_key, reinforcement_count,
            contradiction_count, conflict_group_id, supersedes_note_id,
            inactive, anchor_missing, created_at, last_seen_at
          },
          anchor_type = "g",
          inactive = false`
    );
    const out: StoredNote[] = [];
    for (const r of rows.rows) {
      const note = rowToStoredNote(r);
      let regex: RegExp;
      try {
        regex = globToRegex(note.anchor_value);
      } catch {
        continue; // malformed glob — skip, never break recall
      }
      const bareGlob = !note.anchor_value.includes("/");
      const hit = filePaths.some((p) => {
        if (regex.test(p)) return true;
        // A slash-free glob like `*.test.ts` means "any file with this
        // shape" — match the basename too.
        if (bareGlob) {
          const base = p.slice(p.lastIndexOf("/") + 1);
          return regex.test(base);
        }
        return false;
      });
      if (hit) out.push(note);
    }
    return out;
  }

  /** Surface conflict groups for §6.1 conflict-detection responses. */
  async listConflicts(): Promise<{ group_id: string; notes: StoredNote[] }[]> {
    const rows = await this.db.run(
      `?[note_id, kind, anchor_type, anchor_value, polarity, content,
         dedupe_key, reinforcement_count, contradiction_count,
         conflict_group_id, supersedes_note_id, inactive, anchor_missing,
         created_at, last_seen_at]
       := *notes{
            note_id, kind, anchor_type, anchor_value, polarity, content,
            dedupe_key, reinforcement_count, contradiction_count,
            conflict_group_id, supersedes_note_id, inactive, anchor_missing,
            created_at, last_seen_at
          },
          inactive = false,
          conflict_group_id != ''`
    );
    const groups = new Map<string, StoredNote[]>();
    for (const r of rows.rows) {
      const n = rowToStoredNote(r);
      const arr = groups.get(n.conflict_group_id) ?? [];
      arr.push(n);
      groups.set(n.conflict_group_id, arr);
    }
    return Array.from(groups, ([group_id, notes]) => ({ group_id, notes }));
  }

  private async findByDedupeKey(dk: string): Promise<StoredNote | null> {
    const rows = await this.db.run(
      `?[note_id, kind, anchor_type, anchor_value, polarity, content,
         dedupe_key, reinforcement_count, contradiction_count,
         conflict_group_id, supersedes_note_id, inactive, anchor_missing,
         created_at, last_seen_at]
       := *notes{
            note_id, kind, anchor_type, anchor_value, polarity, content,
            dedupe_key, reinforcement_count, contradiction_count,
            conflict_group_id, supersedes_note_id, inactive, anchor_missing,
            created_at, last_seen_at
          },
          dedupe_key = $dk`,
      { dk }
    );
    if (rows.rows.length === 0) return null;
    const first = rows.rows[0];
    if (!first) return null;
    return rowToStoredNote(first);
  }

  private async findOpposingPolarity(note: ParsedNote): Promise<StoredNote[]> {
    const rows = await this.db.run(
      `?[note_id, kind, anchor_type, anchor_value, polarity, content,
         dedupe_key, reinforcement_count, contradiction_count,
         conflict_group_id, supersedes_note_id, inactive, anchor_missing,
         created_at, last_seen_at]
       := *notes{
            note_id, kind, anchor_type, anchor_value,
            polarity, content, dedupe_key, reinforcement_count,
            contradiction_count, conflict_group_id, supersedes_note_id,
            inactive, anchor_missing, created_at, last_seen_at
          },
          kind = $k,
          anchor_type = $atype,
          anchor_value = $aval,
          inactive = false,
          polarity != $pol,
          polarity != '~'`,
      {
        k: note.kind,
        atype: note.anchor_type,
        aval: note.anchor_value,
        pol: note.polarity,
      }
    );
    return rows.rows.map(rowToStoredNote);
  }

  private async findReinforcementCandidates(
    note: ParsedNote
  ): Promise<StoredNote[]> {
    const rows = await this.db.run(
      `?[note_id, kind, anchor_type, anchor_value, polarity, content,
         dedupe_key, reinforcement_count, contradiction_count,
         conflict_group_id, supersedes_note_id, inactive, anchor_missing,
         created_at, last_seen_at]
       := *notes{
            note_id, kind, anchor_type, anchor_value,
            polarity, content, dedupe_key, reinforcement_count,
            contradiction_count, conflict_group_id, supersedes_note_id,
            inactive, anchor_missing, created_at, last_seen_at
          },
          kind = $k,
          anchor_type = $atype,
          anchor_value = $aval,
          inactive = false`,
      {
        k: note.kind,
        atype: note.anchor_type,
        aval: note.anchor_value,
      }
    );
    return rows.rows.map(rowToStoredNote);
  }
}

function rowToStoredNote(row: unknown[]): StoredNote {
  return {
    note_id: row[0] as string,
    kind: row[1] as NoteKind,
    anchor_type: row[2] as NoteAnchorType,
    anchor_value: row[3] as string,
    polarity: row[4] as NotePolarity,
    content: row[5] as string,
    dedupe_key: row[6] as string,
    reinforcement_count: row[7] as number,
    contradiction_count: row[8] as number,
    conflict_group_id: row[9] as string,
    supersedes_note_id: row[10] as string,
    inactive: row[11] as boolean,
    anchor_missing: row[12] as boolean,
    created_at: row[13] as number,
    last_seen_at: row[14] as number,
  };
}

function parseAnchor(wire: string): {
  anchor_type: NoteAnchorType;
  anchor_value: string;
} {
  if (wire.length < 2 || wire[1] !== ":") {
    throw new Error(`malformed anchor '${wire}' — expected '<type>:<value>'`);
  }
  const t = wire[0] as NoteAnchorType;
  return { anchor_type: t, anchor_value: wire.slice(2) };
}

const MAX_PATH_CANDIDATES = 8;
const MAX_IDENT_CANDIDATES = 12;

/** Tokens that look like file paths: either contain a slash + extension, or
 *  are a bare filename with a known source extension. */
const PROMPT_PATH_RE =
  /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|rb|css|md|json)\b/g;

/** Tokens that look like code identifiers: camelCase, multi-hump PascalCase,
 *  or snake_case/SCREAMING_SNAKE. Plain prose words never match (they need an
 *  internal capital or underscore), so false positives are rare and harmless —
 *  each candidate is one indexed exact-match query that returns nothing. */
const PROMPT_IDENT_RE =
  /\b(?:[a-z$][a-z0-9$]*(?:[A-Z][A-Za-z0-9$]*)+|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g;

/**
 * Lexical anchor inference from a verbatim prompt — no graph access needed.
 * File-path-shaped tokens become `f:` candidates (and feed the `g:` glob
 * pass); identifier-shaped tokens become `e:` candidates. Capped so a long
 * prompt can't fan out into hundreds of queries. Exported for tests and for
 * callers that want the candidates without a store instance.
 */
export function anchorCandidatesFromPrompt(prompt: string): {
  anchors: string[];
  file_paths: string[];
} {
  const filePaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const m of prompt.matchAll(PROMPT_PATH_RE)) {
    if (filePaths.length >= MAX_PATH_CANDIDATES) break;
    const p = m[0].replace(/^\.\//, "");
    if (!seenPaths.has(p)) {
      seenPaths.add(p);
      filePaths.push(p);
    }
  }
  const idents = new Set<string>();
  for (const m of prompt.matchAll(PROMPT_IDENT_RE)) {
    if (idents.size >= MAX_IDENT_CANDIDATES) break;
    idents.add(m[0]);
  }
  const anchors: string[] = [];
  for (const p of filePaths) anchors.push(`f:${p}`);
  for (const ident of idents) anchors.push(`e:${ident}`);
  return { anchors, file_paths: filePaths };
}

/**
 * Minimal glob→RegExp for note `g:` anchors: `**` spans directories, `*`
 * matches within a segment, `?` matches one char. Anything fancier (braces,
 * extglobs) is treated literally — note globs are hand-written one-liners
 * like `*.test.ts`, not build configs.
 */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 12);
}

export const NOTES_SESSION_SAVE_CAP = SESSION_SAVE_CAP;
