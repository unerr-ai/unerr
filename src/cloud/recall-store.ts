/**
 * unerr cloud — local recall store (C5 surface side).
 *
 * The C5 MECHANISM (`recall-sync.ts`, `decision-record.ts`) fetches due recall
 * PROMPTS over HTTPS and drafts decision records at merge. This module is the
 * small on-disk seam between those producers and the read-only surface that
 * shows them: the daemon writes the due prompts here on its refresh cadence and
 * the merge hook writes confirmed decision drafts here, while `unerr status`
 * reads it offline to render the recall lines. Nothing here talks to the
 * network — that all stays in `recall-sync.ts` behind `canSyncRecall()`.
 *
 * Scope — GLOBAL, not per-repo. Recall prompts are self-scoped to the token's
 * USER (CLI_API.md `/sync/recall`), and the daemon refresh that fills the store
 * is per-machine (it mirrors `~/.unerr/team-conventions.json`). So the store
 * lives at `~/.unerr/state/recall.json`, one file per user, shared with the
 * status surface — never under a repo's `.unerr/`.
 *
 * Writes are atomic (temp file + rename) exactly like `push-cursor.ts`, so a
 * crash mid-write leaves either the old snapshot or the new one. Reads swallow a
 * missing / corrupt file to an empty store (HR-B — the local product stays
 * usable when the cloud half is absent).
 *
 * @sem domain=cloud role=storage
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RecallPrompt } from "./client.js";
import type { DecisionDraft } from "./decision-record.js";

/** `~/.unerr/state/recall.json` — the per-user recall store path. */
export function recallStorePath(): string {
  return join(homedir(), ".unerr", "state", "recall.json");
}

/**
 * A merge-time decision draft persisted for confirmation. The full `summary` is
 * LOCAL prose (it may quote code) — it is never sent anywhere by this module.
 */
export interface PersistedDraft {
  /** Stable id of the source decision record (UUIDv5, never random). */
  id: string;
  /** The one-paragraph confirmation prose (LOCAL). */
  summary: string;
  /** Epoch ms the draft was captured at merge. */
  drafted_at_ms: number;
}

/** On-disk shape. `version` guards a future format change (pre-release: just 1). */
interface RecallFile {
  version: 1;
  /** Due recall prompts from the last daemon fetch. */
  due_prompts: RecallPrompt[];
  /** ISO ts of the last successful daemon fetch (null before the first). */
  fetched_at: string | null;
  /** Merge-time decision drafts awaiting confirmation, newest last. */
  drafts: PersistedDraft[];
}

const EMPTY: RecallFile = {
  version: 1,
  due_prompts: [],
  fetched_at: null,
  drafts: [],
};

/** Cap the persisted draft list so the file can't grow unbounded. */
const MAX_DRAFTS = 50;

/**
 * Read the recall store. A missing / unreadable / corrupt file reads as empty —
 * the surface then shows nothing, which is the correct quiet behavior when the
 * user is logged out or the daemon has not run yet (HR-B).
 *
 * @sem domain=cloud role=storage
 */
export async function readRecallStore(): Promise<RecallFile> {
  try {
    const raw = await readFile(recallStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RecallFile>;
    return {
      version: 1,
      due_prompts: Array.isArray(parsed.due_prompts) ? parsed.due_prompts : [],
      fetched_at:
        typeof parsed.fetched_at === "string" ? parsed.fetched_at : null,
      drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Persist the whole store atomically (temp file + rename, like push-cursor). */
async function writeRecallStore(file: RecallFile): Promise<void> {
  const path = recallStorePath();
  const json = `${JSON.stringify(file, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, json, "utf8");
  await rename(tmp, path);
}

/**
 * Replace the stored due prompts with a fresh fetch. Called by the daemon
 * recall sweep after `runRecallFetchOnce` returns `ok`. The drafts and other
 * fields are preserved — only the prompt snapshot + fetch timestamp move.
 *
 * @sem domain=cloud role=storage
 */
export async function saveDuePrompts(
  prompts: RecallPrompt[],
  opts: { now?: number } = {}
): Promise<void> {
  const file = await readRecallStore();
  file.due_prompts = prompts;
  file.fetched_at = new Date(opts.now ?? Date.now()).toISOString();
  await writeRecallStore(file);
}

/**
 * Append a merge-time decision draft, deduped by its stable `id` (a re-merge of
 * the same decision upserts rather than piling up) and capped at `MAX_DRAFTS`.
 * The full summary stays LOCAL.
 *
 * @sem domain=cloud role=storage
 */
export async function saveDecisionDraft(
  draft: DecisionDraft,
  opts: { now?: number } = {}
): Promise<void> {
  const file = await readRecallStore();
  const drafted_at_ms = opts.now ?? Date.now();
  const next = file.drafts.filter((d) => d.id !== draft.id);
  next.push({ id: draft.id, summary: draft.summary, drafted_at_ms });
  file.drafts = next.slice(-MAX_DRAFTS);
  await writeRecallStore(file);
}

/**
 * Drop a due prompt from the store by its `id`. Called after an answer is
 * accepted by the server so the surface stops re-showing an already-answered
 * prompt. A no-op when the id is absent.
 *
 * @sem domain=cloud role=storage
 */
export async function removeDuePrompt(promptId: string): Promise<void> {
  const file = await readRecallStore();
  const next = file.due_prompts.filter((p) => p.id !== promptId);
  if (next.length === file.due_prompts.length) return;
  file.due_prompts = next;
  await writeRecallStore(file);
}
