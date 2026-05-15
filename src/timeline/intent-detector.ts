/**
 * Intent Detector (ST-4) — cross-session task stitching.
 *
 * Walks closed turns + recorded session_files + markers in timeline.db and
 * groups sessions into `intents`. A session attaches to an intent if EITHER:
 *
 *   a) it emitted a `mark_intent` whose text matches an existing intent's
 *      title (anchored stitch, source="agent_marker"); OR
 *   b) its file set has Jaccard overlap > 0.4 with an intent's file_set AND
 *      the intent was last active within the freshness window (default 14 d).
 *
 * Otherwise a new intent is created with source="file_jaccard". After each
 * run, intents inactive for > 21 d move to "dormant".
 *
 * Pure functions are exported for testing; the orchestrator `runIntentStitch`
 * does the I/O against CozoTimelineStore.
 */

import { randomUUID } from "node:crypto";
import type {
  CozoTimelineStore,
  IntentRow,
  MarkerRow,
  TurnRow,
} from "./timeline-store.js";

export interface SessionSummary {
  session_id: string;
  started_at: number;
  last_active_at: number;
  files: Set<string>;
  intent_text?: string;
}

export interface StitchOptions {
  /** Min Jaccard score for file-set match. Default 0.4. */
  jaccardThreshold?: number;
  /** Max ms between session start and intent.last_active_at to attach. Default 14d. */
  freshnessMs?: number;
  /** Idle threshold to move intent from active → dormant. Default 21d. */
  dormantAfterMs?: number;
  /** Reference "now" timestamp (ms). Defaults to Date.now. */
  nowMs?: number;
}

const DEFAULT_JACCARD = 0.4;
const DEFAULT_FRESHNESS_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_DORMANT_MS = 21 * 24 * 60 * 60_000;

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (big.has(v)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function hashFileSet(files: Iterable<string>): string {
  const sorted = [...new Set(files)].sort();
  // Tiny deterministic hash — enough to dedupe identical file sets without
  // hauling in a crypto dep. Stable across processes since it's data-only.
  let h = 0;
  for (const f of sorted) {
    for (let i = 0; i < f.length; i++) {
      h = (h * 31 + f.charCodeAt(i)) | 0;
    }
    h = (h * 31 + 0x5f) | 0;
  }
  return `${sorted.length}-${(h >>> 0).toString(36)}`;
}

export interface StitchAttachment {
  intent_id: string;
  session_id: string;
}

export interface StitchResult {
  intents: IntentRow[];
  attachments: StitchAttachment[];
  dormantTransitions: string[];
}

/**
 * Pure stitch — given session summaries + existing intents (with their session
 * lists), return updated intents + new attachments. Does NOT call the DB.
 */
export function stitchIntents(
  sessions: SessionSummary[],
  existingIntents: IntentRow[],
  existingAttachments: StitchAttachment[],
  opts: StitchOptions = {}
): StitchResult {
  const jaccardThreshold = opts.jaccardThreshold ?? DEFAULT_JACCARD;
  const freshnessMs = opts.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const dormantAfterMs = opts.dormantAfterMs ?? DEFAULT_DORMANT_MS;
  const now = opts.nowMs ?? Date.now();

  const attachedSessions = new Set(
    existingAttachments.map((a) => a.session_id)
  );
  const titleIndex = new Map<string, IntentRow>();
  for (const i of existingIntents) {
    if (i.title.length > 0) titleIndex.set(i.title.toLowerCase(), i);
  }

  // Working copy of intents; we mutate file_set + last_active_at.
  const intents = new Map<string, IntentRow & { _filesSet: Set<string> }>();
  for (const i of existingIntents) {
    let files: string[] = [];
    try {
      const parsed = JSON.parse(i.file_set || "[]");
      if (Array.isArray(parsed)) files = parsed.map((x) => String(x));
    } catch {
      files = [];
    }
    intents.set(i.intent_id, { ...i, _filesSet: new Set(files) });
  }

  const newAttachments: StitchAttachment[] = [];

  // Stitch each session, oldest-first so deterministic merge order.
  const ordered = [...sessions].sort((a, b) => a.started_at - b.started_at);
  for (const s of ordered) {
    if (attachedSessions.has(s.session_id)) continue;

    // 1) marker anchor
    if (s.intent_text && s.intent_text.length > 0) {
      const existing = titleIndex.get(s.intent_text.toLowerCase());
      if (existing) {
        attachSession(intents.get(existing.intent_id)!, s);
        newAttachments.push({
          intent_id: existing.intent_id,
          session_id: s.session_id,
        });
        attachedSessions.add(s.session_id);
        continue;
      }
      const created = createIntent(s, s.intent_text, "agent_marker");
      intents.set(created.intent_id, created);
      titleIndex.set(s.intent_text.toLowerCase(), created);
      newAttachments.push({
        intent_id: created.intent_id,
        session_id: s.session_id,
      });
      attachedSessions.add(s.session_id);
      continue;
    }

    // 2) Jaccard
    let best: {
      intent: IntentRow & { _filesSet: Set<string> };
      score: number;
    } | null = null;
    for (const i of intents.values()) {
      if (s.started_at - i.last_active_at > freshnessMs) continue;
      const score = jaccard(s.files, i._filesSet);
      if (score >= jaccardThreshold && (best === null || score > best.score)) {
        best = { intent: i, score };
      }
    }
    if (best) {
      attachSession(best.intent, s);
      newAttachments.push({
        intent_id: best.intent.intent_id,
        session_id: s.session_id,
      });
      attachedSessions.add(s.session_id);
      continue;
    }

    // 3) Create fresh
    const created = createIntent(s, deriveTitle(s.files), "file_jaccard");
    intents.set(created.intent_id, created);
    if (created.title.length > 0)
      titleIndex.set(created.title.toLowerCase(), created);
    newAttachments.push({
      intent_id: created.intent_id,
      session_id: s.session_id,
    });
    attachedSessions.add(s.session_id);
  }

  // Pass — dormant transitions
  const dormantTransitions: string[] = [];
  for (const i of intents.values()) {
    if (i.status === "active" && now - i.last_active_at > dormantAfterMs) {
      i.status = "dormant";
      dormantTransitions.push(i.intent_id);
    }
  }

  return {
    intents: [...intents.values()].map((i) => stripWorkingFields(i)),
    attachments: newAttachments,
    dormantTransitions,
  };
}

function attachSession(
  intent: IntentRow & { _filesSet: Set<string> },
  session: SessionSummary
): void {
  for (const f of session.files) intent._filesSet.add(f);
  intent.last_active_at = Math.max(
    intent.last_active_at,
    session.last_active_at
  );
  intent.confidence = Math.min(1, intent.confidence + 0.05);
  intent.file_set = JSON.stringify([...intent._filesSet].sort());
  intent.file_set_hash = hashFileSet(intent._filesSet);
}

function createIntent(
  session: SessionSummary,
  title: string,
  source: "agent_marker" | "file_jaccard"
): IntentRow & { _filesSet: Set<string> } {
  const filesSorted = [...session.files].sort();
  return {
    intent_id: randomUUID(),
    title,
    started_at: session.started_at,
    last_active_at: session.last_active_at,
    file_set: JSON.stringify(filesSorted),
    file_set_hash: hashFileSet(filesSorted),
    status: "active",
    confidence: source === "agent_marker" ? 0.8 : 0.5,
    source,
    _filesSet: new Set(session.files),
  };
}

function stripWorkingFields(
  i: IntentRow & { _filesSet: Set<string> }
): IntentRow {
  const { _filesSet, ...row } = i;
  void _filesSet;
  return row;
}

function deriveTitle(files: Set<string>): string {
  if (files.size === 0) return "Misc";
  // Pick the most common directory prefix as a title hint.
  const dirCounts = new Map<string, number>();
  for (const f of files) {
    const dir = f.split("/").slice(0, -1).join("/") || "/";
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  let bestDir = "";
  let bestCount = -1;
  for (const [d, c] of dirCounts) {
    if (c > bestCount) {
      bestDir = d;
      bestCount = c;
    }
  }
  return bestDir ? `Work in ${bestDir}` : "Misc";
}

/**
 * Build session summaries from turns + markers fetched from the store.
 */
export function buildSessionSummaries(
  turns: TurnRow[],
  markers: MarkerRow[],
  filesBySession: Map<string, Set<string>>
): SessionSummary[] {
  const intentBySession = new Map<string, string>();
  for (const m of markers) {
    if (m.type === "mark_intent" && !intentBySession.has(m.session_id)) {
      intentBySession.set(m.session_id, m.text);
    }
  }

  const byId = new Map<string, SessionSummary>();
  for (const t of turns) {
    let s = byId.get(t.session_id);
    if (!s) {
      s = {
        session_id: t.session_id,
        started_at: t.started_at,
        last_active_at: t.ended_at,
        files: filesBySession.get(t.session_id) ?? new Set(),
        intent_text: intentBySession.get(t.session_id),
      };
      byId.set(t.session_id, s);
    } else {
      s.started_at = Math.min(s.started_at, t.started_at);
      s.last_active_at = Math.max(s.last_active_at, t.ended_at);
    }
  }
  return [...byId.values()];
}

/**
 * IO orchestrator — fetches state from the store, runs stitchIntents, writes
 * back. Safe to call repeatedly (idempotent: previously-attached sessions are
 * skipped).
 */
export async function runIntentStitch(
  store: CozoTimelineStore,
  opts: StitchOptions = {}
): Promise<{ created: number; attached: number; dormant: number }> {
  const turns = await store.listTurns({ limit: 500 });
  const markers = await store.listMarkers({ limit: 1000 });
  const sessionIds = new Set(turns.map((t) => t.session_id));

  const filesBySession = new Map<string, Set<string>>();
  for (const sid of sessionIds) {
    const files = await store.getSessionFiles(sid);
    filesBySession.set(sid, new Set(files));
  }

  const summaries = buildSessionSummaries(turns, markers, filesBySession);

  const existingIntents = await store.listIntents({ limit: 500 });
  const existingAttachments: StitchAttachment[] = [];
  for (const i of existingIntents) {
    const sessions = await store.listIntentSessions(i.intent_id);
    for (const sid of sessions) {
      existingAttachments.push({ intent_id: i.intent_id, session_id: sid });
    }
  }

  const result = stitchIntents(
    summaries,
    existingIntents,
    existingAttachments,
    opts
  );

  let created = 0;
  const existingIds = new Set(existingIntents.map((i) => i.intent_id));
  for (const i of result.intents) {
    await store.upsertIntent(i);
    if (!existingIds.has(i.intent_id)) created += 1;
  }
  for (const a of result.attachments) {
    await store.attachSession(a.intent_id, a.session_id);
  }

  return {
    created,
    attached: result.attachments.length,
    dormant: result.dormantTransitions.length,
  };
}
