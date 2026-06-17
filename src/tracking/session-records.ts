/**
 * Shared session records — the on-disk half of the dual session-id model
 * (SESSION_ID_CORRELATION Part 1). A small, atomically-written list of recent
 * conversations at `.unerr/state/sessions.json` that the prompt hook upserts
 * (it knows the agent's `native_session_id`) and the proxy + event writers read
 * (they know the unerr `session_id` + agent). It is the meeting point between
 * the long-lived proxy and the short-lived hook/exec processes, which never
 * share memory.
 *
 * This module is pure node:fs/crypto with no proxy/tracking dependencies so
 * both `src/proxy/session-registry.ts` (the in-memory `ProxySessionRegistry`)
 * and the event writers (`token-flow.ts`, `behavior-events.ts`) can use it
 * without an import cycle.
 *
 * Group a conversation by `coalesce(native_session_id, unerr_session_id)`.
 *
 * @sem domain=session-identity role=store
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Session correlation an exec/out-of-band process stamps on its rows. */
export interface ExecSessionContext {
  session_id: string | null;
  native_session_id: string | null;
  agent: string;
  turn: number;
}

/**
 * Resolve the live conversation identity for an exec / out-of-band process (the
 * shell compressor, cache-retrieve, prefix-stability) that is spawned by the
 * agent's shell, not the proxy. These processes never see a `clientId`, so they
 * join the live conversation through the files the proxy mirrors:
 *   - `UNERR_SESSION_ID` env → `.unerr/state/session.id` for the unerr id,
 *   - `UNERR_AGENT` env for the coding-agent id,
 *   - `UNERR_TURN` env → `.unerr/state/current.turn` for the live turn,
 *   - the shared sessions file (by agent) for the agent's `native_session_id`.
 * Every read is best-effort; missing inputs degrade to null / "unknown" / 0.
 */
export function resolveExecSessionContext(unerrDir: string): ExecSessionContext {
  const readFileTrim = (rel: string): string | null => {
    try {
      const v = readFileSync(join(unerrDir, "state", rel), "utf-8").trim();
      return v.length > 0 ? v : null;
    } catch {
      return null;
    }
  };
  const sessionId =
    (process.env.UNERR_SESSION_ID && process.env.UNERR_SESSION_ID.length > 0
      ? process.env.UNERR_SESSION_ID
      : null) ?? readFileTrim("session.id");
  const agent =
    process.env.UNERR_AGENT && process.env.UNERR_AGENT.length > 0
      ? process.env.UNERR_AGENT
      : "unknown";
  const turnRaw = process.env.UNERR_TURN ?? readFileTrim("current.turn");
  const turn = turnRaw != null ? Number.parseInt(turnRaw, 10) : Number.NaN;
  const nativeSessionId =
    agent !== "unknown"
      ? (latestRecordForAgent(unerrDir, agent)?.native_session_id ?? null)
      : null;
  return {
    session_id: sessionId,
    native_session_id: nativeSessionId,
    agent,
    turn: Number.isFinite(turn) ? turn : 0,
  };
}

/** One conversation's identity, as persisted in the shared file. */
export interface SessionRecord {
  /** unerr's per-bridge UUID. */
  unerr_session_id: string;
  /** The agent's own conversation id, when the agent exposed it; null
   *  otherwise. */
  native_session_id: string | null;
  /** Canonical coding-agent id (claude-code, cursor, …). */
  agent: string;
  /** Repo working directory this conversation ran in. */
  cwd: string;
  /** Human-readable conversation label, when known; null otherwise. */
  session_name: string | null;
  /** Last-touch epoch ms — recency for the latest-wins resolution. */
  updated_at: number;
}

/** Mint a fresh unerr session id (UUID). The bridge mints its own; this is the
 *  fallback when an event arrives from a client that never sent `unerr/hello`
 *  (older bridge, or the standalone stdio path). */
export function mintUnerrSessionId(): string {
  return randomUUID();
}

/** Absolute path to the shared session registry file for a `.unerr` dir. */
export function sessionsFilePath(unerrDir: string): string {
  return join(unerrDir, "state", "sessions.json");
}

/** Cap on persisted records — recent conversations only. Prevents the file
 *  from growing without bound across a long-lived repo. */
const MAX_RECORDS = 50;

/** Read all session records from the shared file. Never throws — a missing or
 *  corrupt file resolves to an empty list. */
export function readSessionRecords(unerrDir: string): SessionRecord[] {
  try {
    const raw = readFileSync(sessionsFilePath(unerrDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is SessionRecord =>
        r !== null &&
        typeof r === "object" &&
        typeof (r as SessionRecord).unerr_session_id === "string"
    );
  } catch {
    return [];
  }
}

/**
 * Upsert one session record into the shared file, keyed by the strongest id
 * available (`native_session_id` when present, else `unerr_session_id`).
 * Merges into an existing record so a later write that only knows the native id
 * doesn't drop a previously-stored unerr id (and vice-versa). Atomic
 * (temp-file + rename) so a concurrent reader never sees a half-written file.
 * Best-effort: any IO failure is swallowed (telemetry must never block a hook).
 */
export function upsertSessionRecord(
  unerrDir: string,
  input: {
    unerrSessionId?: string | null;
    nativeSessionId?: string | null;
    agent: string;
    cwd: string;
    sessionName?: string | null;
    now: number;
  }
): void {
  try {
    const records = readSessionRecords(unerrDir);
    const matches = (r: SessionRecord): boolean =>
      (input.nativeSessionId != null &&
        r.native_session_id === input.nativeSessionId) ||
      (input.unerrSessionId != null &&
        r.unerr_session_id === input.unerrSessionId);
    const existing = records.find(matches);
    const merged: SessionRecord = {
      unerr_session_id:
        input.unerrSessionId ??
        existing?.unerr_session_id ??
        mintUnerrSessionId(),
      native_session_id:
        input.nativeSessionId ?? existing?.native_session_id ?? null,
      agent: input.agent || existing?.agent || "unknown",
      cwd: input.cwd || existing?.cwd || "",
      session_name: input.sessionName ?? existing?.session_name ?? null,
      updated_at: input.now,
    };
    const next = records.filter((r) => !matches(r));
    next.push(merged);
    // Keep only the most-recent MAX_RECORDS by updated_at.
    next.sort((a, b) => b.updated_at - a.updated_at);
    writeRecordsAtomic(unerrDir, next.slice(0, MAX_RECORDS));
  } catch {
    /* best effort — never block the caller */
  }
}

/**
 * The native session id for an unerr per-bridge session id, via the shared
 * file. Lets a drain-time consumer that only has the unerr `session_id` (the
 * ledger / router streams, whose source rows never learned the native id)
 * attach the PRIMARY grouping key so every stream groups by
 * `coalesce(native_session_id, unerr_session_id)`. Returns null when no record
 * maps that unerr id or the record never captured a native id.
 */
export function nativeSessionIdForUnerrId(
  unerrDir: string,
  unerrSessionId: string
): string | null {
  return (
    readSessionRecords(unerrDir).find(
      (r) => r.unerr_session_id === unerrSessionId
    )?.native_session_id ?? null
  );
}

/** Find a record by the agent's own native id. */
export function resolveByNative(
  unerrDir: string,
  nativeSessionId: string
): SessionRecord | null {
  return (
    readSessionRecords(unerrDir).find(
      (r) => r.native_session_id === nativeSessionId
    ) ?? null
  );
}

/**
 * The most-recently-touched record for an agent (optionally constrained to a
 * cwd) within a supplied record list. Splitting the scan from the read lets a
 * caller memoize the (relatively expensive) file read and re-run the (cheap)
 * scan per event. Deterministic for the common one-conversation-per-repo case;
 * for two concurrent conversations of the same agent in one repo it returns the
 * latest — the design's accepted ambiguity, since the per-bridge unerr session
 * id still keeps those events correctly separated.
 */
export function latestRecordForAgentIn(
  records: SessionRecord[],
  agent: string,
  cwd?: string
): SessionRecord | null {
  const exact = records.filter(
    (r) => r.agent === agent && (cwd === undefined || r.cwd === cwd)
  );
  const pool = exact.length > 0 ? exact : records.filter((r) => r.agent === agent);
  if (pool.length === 0) return null;
  return pool.reduce((a, b) => (b.updated_at > a.updated_at ? b : a));
}

/** Read the file then scan for the latest record of an agent (convenience). */
export function latestRecordForAgent(
  unerrDir: string,
  agent: string,
  cwd?: string
): SessionRecord | null {
  return latestRecordForAgentIn(readSessionRecords(unerrDir), agent, cwd);
}

/** Atomic write: serialize to a temp file in the same dir, then rename. */
function writeRecordsAtomic(unerrDir: string, records: SessionRecord[]): void {
  const file = sessionsFilePath(unerrDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(records), "utf-8");
  renameSync(tmp, file);
}

/** mtime of the shared file (0 when absent) — lets readers memoize and only
 *  re-read when the hook has written something new, staying inside the <5ms
 *  tool budget and the writers' <0.1ms record budget. */
export function sessionsFileMtimeMs(unerrDir: string): number {
  try {
    return statSync(sessionsFilePath(unerrDir)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * mtime-memoized native-id resolver. Reads the shared file only when its mtime
 * has advanced since the last call, then scans the cached records for the
 * agent's latest conversation. Built for the event writers' hot path: a
 * statSync per record (microseconds) instead of a full read.
 */
export class NativeSessionResolver {
  private readonly unerrDir: string;
  private cached: SessionRecord[] = [];
  private cachedMtime = -1;

  constructor(unerrDir: string) {
    this.unerrDir = unerrDir;
  }

  /** Latest native id + conversation name for an agent, or null when no record
   *  exists yet (e.g. before the conversation's first prompt). */
  resolve(
    agent: string,
    cwd?: string
  ): { nativeSessionId: string | null; sessionName: string | null } | null {
    const mtime = sessionsFileMtimeMs(this.unerrDir);
    if (mtime !== this.cachedMtime) {
      this.cached = readSessionRecords(this.unerrDir);
      this.cachedMtime = mtime;
    }
    const record = latestRecordForAgentIn(this.cached, agent, cwd);
    if (!record) return null;
    return {
      nativeSessionId: record.native_session_id,
      sessionName: record.session_name,
    };
  }
}
