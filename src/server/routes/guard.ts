/**
 * Cascade-guard route — the "what was I protected from" feed.
 *
 * Behavior events record *that* a guard fired and a count; this route turns
 * those rows into inspectable evidence: the changed entity, the change type,
 * and the named callers at risk — grouped by coding-agent session and the
 * prompt that triggered each firing. The grouping mirrors the user's mental
 * model ("what happened in this piece of work"); the named callers are the
 * verifiable artifact that makes the protection believable rather than a bare
 * tally.
 *
 * GET /api/guard/firings — sessions → prompts → firings (+ totals)
 *
 * Companion to /api/behavior-events (which keeps the aggregate counters) and
 * /api/prompt-trace (the per-turn full trace). This route is read-only and
 * derives everything from the `behavior_events` table.
 *
 * @sem domain=dashboard role=read-model
 */

import { Hono } from "hono";
import { redactPrompt } from "../../hooks/prompt-capture.js";
import {
  type BehaviorEvent,
  readBehaviorEvents,
} from "../../tracking/behavior-events.js";

export interface GuardRouteDeps {
  unerrDir: string;
}

/** Default recent window for the non-vanity headline figure. */
const RECENT_WINDOW_DAYS = 7;

/** One named caller at risk, as persisted in the firing detail. */
interface CallerRef {
  file: string;
  entity: string;
  line: number;
  is_test: boolean;
}

/** A single changed entity inside one cascade-guard firing. */
interface CascadeEntity {
  entity: string;
  entity_key: string | null;
  change_type: string;
  total_at_risk: number;
  callers: CallerRef[];
  callers_truncated: number;
}

/** A single architecture-boundary breach inside one firing. */
interface BoundaryBreach {
  source_file: string;
  source_layer: string;
  target_layer: string;
  specifier: string;
}

/** A normalized firing the UI renders as one row. */
interface Firing {
  id: number;
  ts: string;
  turn: number;
  type: "cascade_guard" | "boundary_violation_flagged";
  file_path: string | null;
  /** Cascade firings only. */
  entities: CascadeEntity[];
  /** Boundary firings only. */
  breaches: BoundaryBreach[];
  /** Largest blast radius across this firing — drives the severity tier. */
  max_at_risk: number;
}

/** Firings that the same prompt initiated. */
interface PromptGroup {
  prompt: string | null;
  prompt_ts: string | null;
  firings: Firing[];
}

/** All firings within one coding-agent session. */
interface SessionGroup {
  session_id: string;
  agent: string;
  started_at: string;
  last_at: string;
  firing_count: number;
  prompts: PromptGroup[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseCallers(v: unknown): CallerRef[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const c = asRecord(raw);
    return {
      file: asString(c.file),
      entity: asString(c.entity),
      line: asNumber(c.line),
      is_test: c.is_test === true,
    };
  });
}

/** Normalize one raw behavior_events row into a Firing the UI can render. */
function toFiring(e: BehaviorEvent): Firing {
  const detail = asRecord(e.detail);
  const type = e.type as Firing["type"];
  const entities: CascadeEntity[] = [];
  const breaches: BoundaryBreach[] = [];
  let maxAtRisk = 0;

  if (type === "cascade_guard") {
    const rawFirings = Array.isArray(detail.firings) ? detail.firings : [];
    for (const raw of rawFirings) {
      const f = asRecord(raw);
      const totalAtRisk = asNumber(f.total_at_risk);
      maxAtRisk = Math.max(maxAtRisk, totalAtRisk);
      entities.push({
        entity: asString(f.entity),
        entity_key: typeof f.entity_key === "string" ? f.entity_key : null,
        change_type: asString(f.change_type),
        total_at_risk: totalAtRisk,
        callers: parseCallers(f.callers),
        callers_truncated: asNumber(f.callers_truncated),
      });
    }
    // Legacy rows (recorded before per-firing detail) only carry counts.
    if (entities.length === 0) maxAtRisk = asNumber(detail.total_at_risk);
  } else {
    const rawBreaches = Array.isArray(detail.breaches) ? detail.breaches : [];
    for (const raw of rawBreaches) {
      const b = asRecord(raw);
      breaches.push({
        source_file: asString(b.source_file),
        source_layer: asString(b.source_layer),
        target_layer: asString(b.target_layer),
        specifier: asString(b.specifier),
      });
    }
    maxAtRisk = breaches.length || asNumber(detail.violations);
  }

  return {
    id: e.id,
    ts: e.ts,
    turn: e.turn,
    type,
    file_path: e.entity_key,
    entities,
    breaches,
    max_at_risk: maxAtRisk,
  };
}

/** A captured prompt, reduced to what the join needs. */
interface PromptPoint {
  ts: number;
  text: string | null;
}

/** Build the per-session prompt timeline (sorted ascending by ts). */
function promptTimeline(prompts: BehaviorEvent[]): Map<string, PromptPoint[]> {
  const bySession = new Map<string, PromptPoint[]>();
  for (const p of prompts) {
    const ms = Date.parse(p.ts);
    if (!Number.isFinite(ms)) continue;
    const detail = asRecord(p.detail);
    const verbatim = typeof detail.prompt === "string" ? detail.prompt : null;
    const list = bySession.get(p.session_id) ?? [];
    list.push({ ts: ms, text: verbatim ? redactPrompt(verbatim) : null });
    bySession.set(p.session_id, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.ts - b.ts);
  return bySession;
}

/** The prompt that initiated the turn a firing belongs to: the latest prompt
 *  whose capture timestamp is at or before the firing. The UserPromptSubmit
 *  hook fires just before the proxy opens the turn, so this is the prompt that
 *  kicked off the work. Returns null when no capture precedes the firing. */
function initiatingPrompt(
  timeline: PromptPoint[] | undefined,
  firingMs: number
): PromptPoint | null {
  if (!timeline || timeline.length === 0) return null;
  let best: PromptPoint | null = null;
  for (const p of timeline) {
    if (p.ts <= firingMs) best = p;
    else break;
  }
  return best;
}

export function createGuardRoutes(deps: GuardRouteDeps): Hono {
  const app = new Hono();

  app.get("/firings", (c) => {
    const start = performance.now();
    const fromTs = c.req.query("from");
    const toTs = c.req.query("to");

    const cascade = readBehaviorEvents(deps.unerrDir, {
      type: "cascade_guard",
      from_ts: fromTs,
      to_ts: toTs,
    });
    const boundary = readBehaviorEvents(deps.unerrDir, {
      type: "boundary_violation_flagged",
      from_ts: fromTs,
      to_ts: toTs,
    });
    // Prompts are joined unfiltered by date — a firing inside the window may
    // have been initiated by a prompt captured a moment before it.
    const prompts = readBehaviorEvents(deps.unerrDir, {
      type: "user_prompt_received",
    });
    const timeline = promptTimeline(prompts);

    // id → source row, so grouping can read session_id/agent in O(1).
    const rowById = new Map<number, BehaviorEvent>();
    for (const e of [...cascade, ...boundary]) rowById.set(e.id, e);

    const firings = [...cascade, ...boundary]
      .map(toFiring)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

    // Group by session, then by initiating prompt. Sessions and prompts are
    // ordered most-recent-first so the feed reads newest work at the top.
    const sessionMap = new Map<
      string,
      {
        agent: string;
        promptMap: Map<string, PromptGroup>;
        firstTs: string;
        lastTs: string;
        count: number;
      }
    >();

    for (const f of firings) {
      const raw = rowById.get(f.id);
      const sessionId = raw?.session_id ?? "unknown";
      const agent = raw?.agent ?? "unknown";
      const firingMs = Date.parse(f.ts);
      const prompt = initiatingPrompt(timeline.get(sessionId), firingMs);
      const promptTs = prompt ? new Date(prompt.ts).toISOString() : null;
      const promptKey = promptTs ?? "__none__";

      let sess = sessionMap.get(sessionId);
      if (!sess) {
        sess = {
          agent,
          promptMap: new Map(),
          firstTs: f.ts,
          lastTs: f.ts,
          count: 0,
        };
        sessionMap.set(sessionId, sess);
      }
      sess.count += 1;
      if (f.ts > sess.lastTs) sess.lastTs = f.ts;
      if (f.ts < sess.firstTs) sess.firstTs = f.ts;

      let pg = sess.promptMap.get(promptKey);
      if (!pg) {
        pg = { prompt: prompt?.text ?? null, prompt_ts: promptTs, firings: [] };
        sess.promptMap.set(promptKey, pg);
      }
      pg.firings.push(f);
    }

    const sessions: SessionGroup[] = [...sessionMap.entries()]
      .map(([session_id, s]) => ({
        session_id,
        agent: s.agent,
        started_at: s.firstTs,
        last_at: s.lastTs,
        firing_count: s.count,
        // Prompts already inherit firing order (most-recent first) because
        // firings were sorted before grouping; order prompt groups by their
        // newest firing.
        prompts: [...s.promptMap.values()].sort((a, b) => {
          const at = a.firings[0]?.ts ?? "";
          const bt = b.firings[0]?.ts ?? "";
          return bt.localeCompare(at);
        }),
      }))
      .sort((a, b) => b.last_at.localeCompare(a.last_at));

    const cutoff = Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const recent = firings.filter((f) => Date.parse(f.ts) >= cutoff).length;

    return c.json({
      data: {
        sessions,
        totals: {
          total_firings: firings.length,
          cascade_firings: cascade.length,
          boundary_firings: boundary.length,
          recent_window: recent,
          window_days: RECENT_WINDOW_DAYS,
        },
      },
      _meta: {
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  return app;
}
