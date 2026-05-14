/**
 * Session-Aware Context Deduplication — tracks which _context keys have been
 * delivered in this session and filters out repeats.
 *
 * Design: in-memory only (no persistence across sessions — that's Sprint H).
 * Bounded to MAX_TRACKED_KEYS to prevent memory leaks in long sessions.
 *
 * Temporal intelligence note: the dedup window corresponds to the episodic
 * memory tier (Section 13.2). Within a session, repeated context has near-zero
 * value. Cross-session dedup requires the warm/cold tier architecture (Sprint H).
 */

const MAX_TRACKED_KEYS = 10_000;

export interface SessionDedup {
  filter: (
    entityKey: string,
    context: Record<string, unknown>,
  ) => Record<string, unknown>;
  hasDelivered: (entityKey: string, contextKey: string) => boolean;
  markDelivered: (entityKey: string, contextKeys: string[]) => void;
  getDeliveredCount: () => number;
  reset: () => void;
}

/**
 * Create a session dedup tracker.
 * Filters context keys that have already been delivered for a given entity.
 */
export function createSessionDedup(): SessionDedup {
  const delivered = new Map<string, Set<string>>();
  let totalKeys = 0;

  function compoundKey(entityKey: string, contextKey: string): string {
    return `${entityKey}::${contextKey}`;
  }

  function hasDelivered(entityKey: string, contextKey: string): boolean {
    const entitySet = delivered.get(entityKey);
    return entitySet?.has(contextKey) ?? false;
  }

  function markDelivered(entityKey: string, contextKeys: string[]): void {
    let entitySet = delivered.get(entityKey);
    if (!entitySet) {
      entitySet = new Set();
      delivered.set(entityKey, entitySet);
    }
    for (const key of contextKeys) {
      if (!entitySet.has(key)) {
        entitySet.add(key);
        totalKeys++;
      }
    }

    if (totalKeys > MAX_TRACKED_KEYS) {
      evictOldest();
    }
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
      }
    }
  }

  function filter(
    entityKey: string,
    context: Record<string, unknown>,
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
    totalKeys = 0;
  }

  return { filter, hasDelivered, markDelivered, getDeliveredCount, reset };
}
