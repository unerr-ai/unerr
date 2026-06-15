/**
 * unerr cloud — local decision records for the anti-forgetting loop (C5).
 *
 * A "decision record" is one deliberate choice the developer made — sourced
 * from the local `unerr-save: decision …` markers the Stop hook scrapes into
 * `timeline.db` (`*markers{type:"decision"}`). The anti-forgetting loop later
 * surfaces a spaced-recall prompt for each ("3 weeks ago you chose X over Y —
 * still remember why?") and sends the developer's y/n answer to the cloud.
 *
 * HR-2 boundary — this module reads markers, never code:
 *  - The marker `text` is the developer's own prose, but it may quote a path
 *    or symbol. So the record's `body` (the full prose) stays LOCAL; only an
 *    opt-in, code-stripped summary is ever eligible to leave the machine. The
 *    auto-draft confirmation surfaces ONE short paragraph (the marker text),
 *    never a blank template — per the C5 plan.
 *  - `stripCodeBearingProse` is the single chokepoint that decides whether a
 *    note is safe to send: anything that looks like a path, a code fence, or a
 *    bracketed/parenthesized symbol reference is treated as code-bearing and
 *    withheld unless the caller passes `optedIn: true`.
 *
 * Reads are READ-ONLY: this module opens `timeline.db` and queries it; it never
 * writes the shared tracking store. The FSRS schedule per record is derived in
 * memory from the marker's timestamp (see `fsrs-schedule.ts`) — no schema
 * change to the tracking layer.
 *
 * @sem domain=cloud role=identity
 */

import { join } from "node:path";
import type { MarkerRow } from "../timeline/timeline-store.js";
import { deterministicId } from "./event-id.js";
import {
  type RecallScheduleState,
  initialSchedule,
  isDue,
  orderByForgetting,
} from "./fsrs-schedule.js";

/** The marker type the Stop hook writes for `unerr-save: decision` lines. */
export const DECISION_MARKER_TYPE = "decision";

/**
 * A local decision record. `id` is the stable client id (UUIDv5 of the marker
 * identity) — the same key the recall answer's `client_answer_id` is derived
 * from, so a record, its prompt, and its answer share one lineage. `body` is
 * the full local prose; `schedule` is its FSRS state.
 */
export interface DecisionRecord {
  /** Stable UUIDv5 over the marker identity. Never random. */
  id: string;
  /** The developer's decision prose (LOCAL — may quote code). */
  body: string;
  /** Epoch ms the decision was recorded. */
  recorded_at_ms: number;
  /** Originating session id (local correlation only). */
  session_id: string;
  /** The FSRS spaced-recall schedule derived for this record. */
  schedule: RecallScheduleState;
}

/**
 * The stable id for a decision record. Derived from the marker's identity
 * (`marker_id` is itself stable per the timeline store), so a redrained /
 * retried answer re-derives the same id and dedups against the server upsert.
 * Never random (HR: client-minted ids are UUIDv5, B4-client).
 *
 * @sem domain=cloud role=identity
 */
export function decisionRecordId(marker: Pick<MarkerRow, "marker_id">): string {
  return deterministicId("decision", marker.marker_id);
}

/**
 * Project a raw decision marker into a `DecisionRecord` with an initial FSRS
 * schedule anchored at the marker's recorded time. Pure; the schedule is
 * derived, not read from disk, so it stays stable for a given marker + clock.
 *
 * @sem domain=cloud role=identity
 */
export function decisionRecordFromMarker(marker: MarkerRow): DecisionRecord {
  const recordedAtMs = Number.isFinite(marker.ts) ? marker.ts : Date.now();
  return {
    id: decisionRecordId(marker),
    body: marker.text,
    recorded_at_ms: recordedAtMs,
    session_id: marker.session_id,
    schedule: initialSchedule(recordedAtMs),
  };
}

/**
 * Read the local decision markers and project them into decision records,
 * ordered most-forgotten-first. Opens `timeline.db` read-only via the timeline
 * store. Returns `[]` when the store is absent or has no decision markers (the
 * recall loop is then simply quiet — HR-B, local stays usable without cloud).
 *
 * @sem domain=cloud role=identity
 */
export async function readDecisionRecords(
  projectRoot: string,
  opts: { now?: number; limit?: number } = {}
): Promise<DecisionRecord[]> {
  const now = opts.now ?? Date.now();
  const markers = await readDecisionMarkers(projectRoot, opts.limit);
  const records = markers.map(decisionRecordFromMarker);
  return orderByForgetting(records, now);
}

/**
 * The decision records whose spaced-recall prompt is due at `now`, most-
 * forgotten-first. This is what the daemon surfaces and what feeds the
 * client_answer_id round-trip.
 *
 * @sem domain=cloud role=identity
 */
export async function dueDecisionRecords(
  projectRoot: string,
  opts: { now?: number; limit?: number } = {}
): Promise<DecisionRecord[]> {
  const now = opts.now ?? Date.now();
  const records = await readDecisionRecords(projectRoot, opts);
  return records.filter((r) => isDue(r.schedule, now));
}

/**
 * Read raw decision markers from `timeline.db`. Read-only: opens the store,
 * runs the marker query, returns rows. Swallows every failure to `[]` so a
 * missing / locked store never breaks a turn (HR-B).
 */
async function readDecisionMarkers(
  projectRoot: string,
  limit = 200
): Promise<MarkerRow[]> {
  try {
    const dbPath = join(projectRoot, ".unerr", "timeline.db");
    const { existsSync } = await import("node:fs");
    if (!existsSync(dbPath)) return [];
    const { CozoTimelineStore } = await import("../timeline/timeline-store.js");
    const store = await CozoTimelineStore.create(projectRoot);
    return await store.listMarkers({ type: DECISION_MARKER_TYPE, limit });
  } catch {
    return [];
  }
}

/**
 * Decide whether a developer-written recall note is safe to send to the cloud.
 * The HR-2 rule is edge-first: code never leaves the machine. A note that
 * looks code-bearing (a path, a code fence, a bracketed/parenthesized symbol,
 * or a backticked token) is withheld unless the caller explicitly opted in.
 *
 * Returns the note to send, or `undefined` to send no note. Sending no note is
 * always valid — the answer's y/n `remembered` is the metric; the note is
 * optional colour.
 *
 * @sem domain=cloud role=security
 */
export function stripCodeBearingProse(
  note: string | undefined,
  opts: { optedIn?: boolean } = {}
): string | undefined {
  if (!note) return undefined;
  const trimmed = note.trim();
  if (trimmed.length === 0) return undefined;
  if (opts.optedIn) return clampNote(trimmed);
  return looksCodeBearing(trimmed) ? undefined : clampNote(trimmed);
}

/**
 * Heuristic: does this prose carry code (path / fence / symbol reference)?
 * Conservative — a false positive only withholds an optional note; a false
 * negative would leak code, so the patterns lean toward withholding.
 */
function looksCodeBearing(text: string): boolean {
  // Code fence or inline backtick.
  if (text.includes("`")) return true;
  // A filesystem-ish path: a slash between non-space tokens, or a known ext.
  if (/[\w.-]+\/[\w./-]+/.test(text)) return true;
  if (
    /\.(ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|h|sql|json|yaml|yml)\b/.test(text)
  )
    return true;
  // A call / index / generic expression: foo(), bar[0], Map<K,V>, a.b.c().
  if (/\w+\s*\([^)]*\)/.test(text)) return true;
  if (/\w+\[[^\]]*\]/.test(text)) return true;
  if (/\w+<[^>]+>/.test(text)) return true;
  if (/\w+\.\w+\.\w+/.test(text)) return true;
  return false;
}

/** Server caps the note at 2048 chars (CLI_API.md); clamp before send. */
const NOTE_MAX = 2048;
function clampNote(note: string): string {
  return note.length <= NOTE_MAX ? note : note.slice(0, NOTE_MAX);
}

/**
 * A draft decision record to confirm at merge. The C5 plan requires ONE short
 * paragraph the developer confirms, NEVER a blank template — so the draft is
 * seeded from the recent decision markers' prose, not an empty form. The full
 * `body` stays LOCAL (it may quote code); `needs_confirmation` is always true
 * (the developer confirms before anything is recorded).
 *
 * MERGE-HOOK BOUNDARY (documented stub): the trigger that fires this at a git
 * merge belongs in the commit/merge hook (`src/commands/check-commit.ts`),
 * which is owned by another agent and outside this change's edit scope. This
 * module supplies the pure draft builder; the hook owner wires the call —
 * `autoDraftAtMerge(records)` → present `draft.summary` for confirmation → on
 * "yes" persist via the existing `unerr-save: decision` marker path. No blank
 * template is ever shown.
 */
export interface DecisionDraft {
  /** Stable id of the source decision record. */
  id: string;
  /** The one-paragraph summary shown for confirmation (LOCAL prose). */
  summary: string;
  /** Always true — the developer confirms before the record is kept. */
  needs_confirmation: true;
}

/**
 * Build the at-merge confirmation draft from the most recent decision records.
 * Picks the newest record and renders its prose as a single paragraph (never a
 * blank template, per C5). Returns `null` when there is no decision to draft.
 * Pure — does not touch git or the network. The merge-hook owner calls this
 * (see DecisionDraft boundary note).
 *
 * @sem domain=cloud role=identity
 */
export function autoDraftAtMerge(
  records: readonly DecisionRecord[]
): DecisionDraft | null {
  if (records.length === 0) return null;
  const newest = records.reduce((a, b) =>
    b.recorded_at_ms > a.recorded_at_ms ? b : a
  );
  const summary = newest.body.trim();
  if (summary.length === 0) return null;
  return { id: newest.id, summary, needs_confirmation: true };
}
