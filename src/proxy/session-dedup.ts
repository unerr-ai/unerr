/**
 * Session-Aware Context Deduplication — tracks which _context keys have been
 * delivered and filters out repeats.
 *
 * Two tiers:
 *   - In-session: an in-memory Map, bounded to MAX_TRACKED_KEYS. Within a
 *     session, repeated context has near-zero value.
 *   - Cross-session: when a repo root (`cwd`) is supplied, the delivered set is
 *     seeded from / persisted to `.unerr/state/xsession-dedup.json`, so context
 *     delivered in a prior session within the warm window is suppressed instead
 *     of re-injected. This is SUPPRESSION ONLY — it never adds a delivery
 *     channel (the §11.6 invariant). Entries older than the warm TTL (the cold
 *     tier) are dropped on load, so filtered context re-surfaces after the
 *     window even if it was seen before.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Body / file content dedup ─────────────────────────────────────────────

/**
 * Recency window for body dedup with NO compaction signal: turns within this
 * count are considered "recent enough" to skip a re-send. Deliberately tiny —
 * without a signal the store is guessing at when the harness compacted and
 * evicted the delivered copy, so it only trusts the last few turns.
 */
export const BODY_DEDUP_MAX_TURNS = 5;

/**
 * Recency window once the harness has reported a compaction at least once
 * (`unerr/compaction`, see compaction-protocol.ts). Eviction is then SIGNALLED
 * rather than guessed: every compaction flushes the entries it invalidated, so a
 * surviving entry is one the agent still holds and the window no longer has to
 * stand in for "the harness probably compacted by now".
 *
 * Two-mode logic, on purpose: the narrow window is the fallback for an
 * installation whose compaction hooks are missing (older Claude Code, another
 * agent, hooks not installed) — there we keep guessing conservatively. The wide
 * window only activates after proof that the signal is live in THIS process.
 */
export const BODY_DEDUP_MAX_TURNS_SIGNALLED = 50;

/**
 * Whether body/file content dedup is active. Defaults on; set
 * UNERR_BODY_DEDUP=0 to disable for a session without a rebuild.
 */
export const BODY_DEDUP_ENABLED = process.env.UNERR_BODY_DEDUP !== "0";

/**
 * Cap on tracked body-dedup entries, enforced by LRU eviction in `record()`.
 * Safe at this size because eviction here is fail-open: dropping an entry only
 * costs one extra re-send of a body the agent already had (tokens), it can
 * never cause a wrong suppression (which would cost correctness). 2000 just
 * needs to comfortably outlast the recency window (5-50 turns) worth of
 * distinct (path, span) reads in one long session.
 */
const MAX_BODY_DEDUP_ENTRIES = 2000;

const MAX_TRACKED_KEYS = 10_000;

/** Warm window: context delivered within this span is suppressed; older = cold. */
const WARM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Minimum gap between throttled disk persists during a live session. */
const PERSIST_THROTTLE_MS = 3_000;

const XSESSION_SCHEMA = 1;

interface PersistedDedupFile {
  schema: number;
  /** entityKey → { delivered context keys, last-delivery epoch ms }. */
  entities: Record<string, { keys: string[]; ts: number }>;
}

export interface SessionDedupOptions {
  /**
   * Repo root. When set, the dedup set is seeded from and persisted to
   * `.unerr/state/xsession-dedup.json` (cross-session suppression).
   */
  cwd?: string;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface SessionDedup {
  filter: (
    entityKey: string,
    context: Record<string, unknown>
  ) => Record<string, unknown>;
  hasDelivered: (entityKey: string, contextKey: string) => boolean;
  markDelivered: (entityKey: string, contextKeys: string[]) => void;
  getDeliveredCount: () => number;
  reset: () => void;
  /**
   * Force-persist the delivered set to the cross-session file. No-op unless
   * cross-session persistence is active. Call on shutdown so the final session
   * state survives even if the throttle window had not elapsed.
   */
  flush: () => void;
}

function xsessionPath(cwd: string): string {
  return join(cwd, ".unerr", "state", "xsession-dedup.json");
}

function readPersisted(cwd: string): PersistedDedupFile {
  try {
    const parsed = JSON.parse(
      readFileSync(xsessionPath(cwd), "utf8")
    ) as Partial<PersistedDedupFile>;
    if (parsed && typeof parsed.entities === "object" && parsed.entities) {
      return {
        schema: XSESSION_SCHEMA,
        entities: parsed.entities as PersistedDedupFile["entities"],
      };
    }
  } catch {
    /* absent or corrupt → empty (best-effort) */
  }
  return { schema: XSESSION_SCHEMA, entities: {} };
}

function writePersisted(cwd: string, file: PersistedDedupFile): void {
  try {
    const dir = join(cwd, ".unerr", "state");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(xsessionPath(cwd), JSON.stringify(file), "utf8");
  } catch {
    /* best effort — a failed persist just means re-injection next session */
  }
}

/** Drop cold (aged-out) entities so stale entries re-surface after the window. */
function pruneCold(file: PersistedDedupFile, now: number): PersistedDedupFile {
  const cutoff = now - WARM_TTL_MS;
  const entities: PersistedDedupFile["entities"] = {};
  for (const [key, val] of Object.entries(file.entities)) {
    if (val && typeof val.ts === "number" && val.ts >= cutoff) {
      const keys = Array.isArray(val.keys)
        ? val.keys.filter((s): s is string => typeof s === "string")
        : [];
      if (keys.length > 0) entities[key] = { keys, ts: val.ts };
    }
  }
  return { schema: XSESSION_SCHEMA, entities };
}

/**
 * Direct cross-session "was this delivered?" probe for short-lived hook
 * subprocesses that cannot hold the in-memory dedup (e.g. SessionStart).
 */
export function xsessionWasDelivered(
  cwd: string,
  entityKey: string,
  contextKey: string
): boolean {
  const file = pruneCold(readPersisted(cwd), Date.now());
  return file.entities[entityKey]?.keys.includes(contextKey) ?? false;
}

/**
 * Direct cross-session record for short-lived hook subprocesses.
 * Read-modify-write of the per-repo file.
 */
export function xsessionRecordDelivered(
  cwd: string,
  entityKey: string,
  contextKeys: string[]
): void {
  if (contextKeys.length === 0) return;
  const now = Date.now();
  const file = pruneCold(readPersisted(cwd), now);
  const current = file.entities[entityKey];
  const set = new Set(current?.keys ?? []);
  for (const key of contextKeys) set.add(key);
  file.entities[entityKey] = { keys: [...set], ts: now };
  writePersisted(cwd, file);
}

/**
 * Create a session dedup tracker.
 * Filters context keys that have already been delivered for a given entity.
 */
export function createSessionDedup(
  opts: SessionDedupOptions = {}
): SessionDedup {
  const now = opts.now ?? (() => Date.now());
  const cwd = opts.cwd;
  const persistent = cwd !== undefined;

  const delivered = new Map<string, Set<string>>();
  // Per-entity last-delivery timestamp — tracked only in the persistent tier so
  // an entity ages out by when it was actually delivered, not when we flush.
  const entityTs = new Map<string, number>();
  let totalKeys = 0;
  let lastPersistAt = 0;

  // Cross-session seed: warm entries delivered in prior sessions are treated as
  // already-delivered, so identical context is suppressed this session.
  if (persistent && cwd) {
    const file = pruneCold(readPersisted(cwd), now());
    for (const [entityKey, val] of Object.entries(file.entities)) {
      const set = new Set(val.keys);
      delivered.set(entityKey, set);
      entityTs.set(entityKey, val.ts);
      totalKeys += set.size;
    }
  }

  function hasDelivered(entityKey: string, contextKey: string): boolean {
    return delivered.get(entityKey)?.has(contextKey) ?? false;
  }

  function persist(force: boolean): void {
    if (!persistent || !cwd) return;
    const t = now();
    if (!force && t - lastPersistAt < PERSIST_THROTTLE_MS) return;
    lastPersistAt = t;
    const entities: PersistedDedupFile["entities"] = {};
    for (const [entityKey, set] of delivered.entries()) {
      if (set.size === 0) continue;
      entities[entityKey] = {
        keys: [...set],
        ts: entityTs.get(entityKey) ?? t,
      };
    }
    writePersisted(cwd, { schema: XSESSION_SCHEMA, entities });
  }

  function markDelivered(entityKey: string, contextKeys: string[]): void {
    let entitySet = delivered.get(entityKey);
    if (!entitySet) {
      entitySet = new Set();
      delivered.set(entityKey, entitySet);
    }
    let added = false;
    for (const key of contextKeys) {
      if (!entitySet.has(key)) {
        entitySet.add(key);
        totalKeys++;
        added = true;
      }
    }
    if (added) entityTs.set(entityKey, now());

    if (totalKeys > MAX_TRACKED_KEYS) {
      evictOldest();
    }
    if (added) persist(false);
  }

  function evictOldest(): void {
    const iterator = delivered.keys();
    let evicted = 0;
    const target = Math.floor(MAX_TRACKED_KEYS * 0.2);
    while (evicted < target) {
      const result = iterator.next();
      if (result.done) break;
      const entityKey = result.value;
      const entitySet = delivered.get(entityKey);
      if (entitySet) {
        evicted += entitySet.size;
        totalKeys -= entitySet.size;
        delivered.delete(entityKey);
        entityTs.delete(entityKey);
      }
    }
  }

  function filter(
    entityKey: string,
    context: Record<string, unknown>
  ): Record<string, unknown> {
    const filtered: Record<string, unknown> = {};
    const newKeys: string[] = [];

    for (const [key, value] of Object.entries(context)) {
      if (!hasDelivered(entityKey, key)) {
        filtered[key] = value;
        newKeys.push(key);
      }
    }

    if (newKeys.length > 0) {
      markDelivered(entityKey, newKeys);
    }

    return filtered;
  }

  function getDeliveredCount(): number {
    return totalKeys;
  }

  function reset(): void {
    delivered.clear();
    entityTs.clear();
    totalKeys = 0;
  }

  function flush(): void {
    persist(true);
  }

  return {
    filter,
    hasDelivered,
    markDelivered,
    getDeliveredCount,
    reset,
    flush,
  };
}

// ── Body / file content dedup — compaction-aware recency window ──────────
//
// Two modes. Without a compaction signal the window is a 5-turn GUESS at when
// the harness evicted the delivered copy. Once the harness reports a compaction
// (`unerr/compaction` → clearBodies), the invalidated entries are dropped
// outright and the window widens to 50 turns — the guess is replaced by the
// signal. The mtime gate is unchanged in both modes: an edited file always
// re-delivers.

interface BodyDedupEntry {
  /** File mtime at delivery (ms) — freshness gate. */
  mtime: number;
  /** Session tool-call count when delivered — recency gate. */
  turn: number;
  /** Estimated token count of the body delivered last time. Reported as the
   *  measured saving when a re-read is skipped (the agent avoids re-receiving
   *  exactly these tokens). */
  tokens: number;
  /** The agent's own conversation id at delivery, when the proxy could resolve
   *  one. Used ONLY to scope a compaction flush; `null` means "conversation
   *  unknown", which a scoped flush also drops (it cannot prove the entry
   *  belongs to a different, still-live conversation). */
  nativeSessionId: string | null;
}

/**
 * Which conversation a body delivery belongs to. Supplied per call by the proxy
 * dispatcher (`ProxySessionRegistry.resolve`), never held as mutable state on
 * the store — two MCP clients can have calls in flight at the same time, and a
 * shared "current session" field would let one client's read match the other's
 * delivery.
 */
export interface BodyDedupScope {
  /** Per-bridge unerr session id — distinct per connected MCP client, stable
   *  across compaction and `/clear`. Partitions the entry keys, so a body
   *  delivered to one client can never be skipped for another. */
  sessionId?: string | null;
  /** The agent's own conversation id, when a hook has recorded one. Carried on
   *  the entry so a compaction flush can scope itself. */
  nativeSessionId?: string | null;
}

/**
 * Tracks file body deliveries for short-recency dedup within a session.
 * Keyed on absolute file path. Uses BODY_DEDUP_MAX_TURNS recency window
 * so dedup never fires after likely harness compaction. Distinct from
 * enrichment dedup (which uses a 7-day TTL and different keys).
 */
export interface BodyDedupStore {
  /**
   * Returns { deliveredTurn } when dedup applies — file is unchanged and
   * the prior delivery is within the recency window.
   * Returns null when the full body must be re-sent.
   */
  check(
    absPath: string,
    currentMtime: number,
    currentTurn: number,
    offset?: number,
    limit?: number,
    tokenBudget?: number,
    scope?: BodyDedupScope
  ): { deliveredTurn: number; tokens: number } | null;
  /** Record a successfully delivered file body for future dedup. `tokens` is
   *  the estimated token count of the delivered body — reported as the saving
   *  on a later skip. The (offset, limit, tokenBudget) span keys the entry, so
   *  a later read of a different slice of the same file is a miss, not a hit. */
  record(
    absPath: string,
    mtime: number,
    turn: number,
    tokens: number,
    offset?: number,
    limit?: number,
    tokenBudget?: number,
    scope?: BodyDedupScope
  ): void;
  /**
   * Drop delivered-body entries the agent can no longer see, because the harness
   * compacted or cleared its context. Returns the number of entries dropped.
   *
   * Also flips the store into signalled mode for the rest of its life: the
   * recency window widens from {@link BODY_DEDUP_MAX_TURNS} to
   * {@link BODY_DEDUP_MAX_TURNS_SIGNALLED}, because eviction is now reported
   * rather than guessed. The flag is per-store (per repo proxy), not per
   * conversation — a hook that fires once proves the harness reports compaction
   * for this installation.
   *
   * `nativeSessionId` scopes the flush to one conversation. Pass `null`/omit to
   * drop every tracked body (a `/clear`, or a signal with no conversation id).
   * A scoped flush also drops entries recorded with an unknown conversation:
   * over-dropping costs one re-read, under-dropping would hand the agent a
   * pointer to content it no longer holds.
   */
  clearBodies(nativeSessionId?: string | null): number;
  /** True once a compaction/clear has been reported this process. */
  isCompactionSignalled(): boolean;
  /** The recency window in turns currently in force (5 or 50). */
  recencyWindowTurns(): number;
}

/**
 * Creates a per-session short-recency body dedup store. One instance
 * per QueryRouter session. Not persisted across sessions (body content
 * must be re-read on session restart).
 *
 * Keyed on the full read *request* — path plus the (offset, limit,
 * tokenBudget) span — NOT the path alone. Two reads collide only when they
 * would deliver byte-identical content, so a read of a different slice of an
 * already-delivered file is a cache miss and the agent never receives a
 * "reuse prior content" pointer for a span it was never sent. (A path-only
 * key collapsed every sliced re-read onto the first delivery; the agent then
 * escaped to shell reads to get the lines it had actually asked for.)
 */
export function createBodyDedup(): BodyDedupStore {
  const entries = new Map<string, BodyDedupEntry>();
  // Set by the first clearBodies() call — i.e. the first `unerr/compaction`
  // notification. Until then the store cannot tell a compaction from a quiet
  // stretch of turns, so it keeps the narrow guess window.
  let compactionSignalled = false;

  const windowTurns = (): number =>
    compactionSignalled ? BODY_DEDUP_MAX_TURNS_SIGNALLED : BODY_DEDUP_MAX_TURNS;

  // The dedup key is the whole read request, partitioned by the MCP client that
  // received it. The mtime gate already covers "file changed"; the span covers
  // "different part of the same file"; the client partition covers "a second
  // agent session against this repo never received this body at all".
  const keyFor = (
    absPath: string,
    offset?: number,
    limit?: number,
    tokenBudget?: number,
    scope?: BodyDedupScope
  ): string =>
    // NUL joins the client partition to the request key — a byte that appears in
    // neither a session id nor a path, so two distinct requests never collide.
    `${scope?.sessionId ?? ""}\u0000${absPath}#${offset ?? ""}:${limit ?? ""}:${tokenBudget ?? ""}`;

  return {
    check(
      absPath,
      currentMtime,
      currentTurn,
      offset,
      limit,
      tokenBudget,
      scope
    ) {
      const mapKey = keyFor(absPath, offset, limit, tokenBudget, scope);
      const entry = entries.get(mapKey);
      if (!entry) return null;
      // Freshness: mtime changed → file was edited → re-send in full
      if (entry.mtime !== currentMtime) {
        entries.delete(mapKey);
        return null;
      }
      // Recency: outside window → the delivered copy may be gone → re-send in
      // full. The window is 5 turns while eviction is guessed, 50 once the
      // harness reports compaction (see clearBodies).
      if (currentTurn - entry.turn > windowTurns()) {
        entries.delete(mapKey);
        return null;
      }
      return { deliveredTurn: entry.turn, tokens: entry.tokens };
    },
    record(absPath, mtime, turn, tokens, offset, limit, tokenBudget, scope) {
      const mapKey = keyFor(absPath, offset, limit, tokenBudget, scope);
      // Delete before set: a plain set() on an existing key leaves it at its
      // ORIGINAL position in Map iteration order, which would evict hot
      // entries below instead of stale ones.
      entries.delete(mapKey);
      entries.set(mapKey, {
        mtime,
        turn,
        tokens,
        nativeSessionId: scope?.nativeSessionId ?? null,
      });
      // Insertion order == recency order (oldest first) once every set() is
      // preceded by a delete(), so the front of the Map is always the LRU entry.
      while (entries.size > MAX_BODY_DEDUP_ENTRIES) {
        const oldestKey = entries.keys().next().value as string;
        entries.delete(oldestKey);
      }
    },
    clearBodies(nativeSessionId) {
      compactionSignalled = true;
      const scope = nativeSessionId ?? null;
      let dropped = 0;
      for (const [mapKey, entry] of entries) {
        // Keep ONLY entries that provably belong to another conversation.
        if (scope !== null && entry.nativeSessionId !== null) {
          if (entry.nativeSessionId !== scope) continue;
        }
        entries.delete(mapKey);
        dropped++;
      }
      return dropped;
    },
    isCompactionSignalled() {
      return compactionSignalled;
    },
    recencyWindowTurns() {
      return windowTurns();
    },
  };
}
