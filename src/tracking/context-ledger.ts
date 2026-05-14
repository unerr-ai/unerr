/**
 * Cross-Session Context Dedup Ledger — persists delivered _context keys
 * across sessions so repeated information isn't re-delivered.
 *
 * Stored in .unerr/state/context-ledger.json.
 * On session start, loads previous deliveries into the in-session dedup (C.4).
 *
 * Temporal intelligence note: this implements the warm tier of the
 * three-tier memory architecture (Section 13.8). Keys older than
 * TTL_DAYS are evicted to prevent unbounded growth.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TTL_DAYS = 7;
const MAX_ENTRIES = 50_000;

interface LedgerRecord {
  entityKey: string;
  contextKey: string;
  deliveredAt: string;
}

export interface ContextLedger {
  load: () => Map<string, Set<string>>;
  save: (delivered: Map<string, Set<string>>) => void;
  hasDelivered: (entityKey: string, contextKey: string) => boolean;
  markDelivered: (entityKey: string, contextKeys: string[]) => void;
  getDeliveredCount: () => number;
  prune: () => number;
}

export function createContextLedger(unerrDir: string): ContextLedger {
  const stateDir = join(unerrDir, "state");
  const filePath = join(stateDir, "context-ledger.json");

  let records: LedgerRecord[] = [];
  let index = new Map<string, Set<string>>();

  function ensureDir(): void {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
  }

  function compoundKey(entityKey: string, contextKey: string): string {
    return `${entityKey}::${contextKey}`;
  }

  function load(): Map<string, Set<string>> {
    ensureDir();
    if (!existsSync(filePath)) {
      records = [];
      index = new Map();
      return new Map();
    }

    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as LedgerRecord[];
      records = Array.isArray(parsed) ? parsed : [];
    } catch {
      records = [];
    }

    index = new Map();
    for (const r of records) {
      let set = index.get(r.entityKey);
      if (!set) {
        set = new Set();
        index.set(r.entityKey, set);
      }
      set.add(r.contextKey);
    }

    return new Map([...index.entries()].map(([k, v]) => [k, new Set(v)]));
  }

  function save(delivered: Map<string, Set<string>>): void {
    ensureDir();
    const newRecords: LedgerRecord[] = [];
    const now = new Date().toISOString();

    for (const [entityKey, contextKeys] of delivered) {
      for (const contextKey of contextKeys) {
        const existing = records.find(
          (r) => r.entityKey === entityKey && r.contextKey === contextKey,
        );
        newRecords.push({
          entityKey,
          contextKey,
          deliveredAt: existing?.deliveredAt ?? now,
        });
      }
    }

    records = newRecords;
    index = delivered;

    try {
      writeFileSync(filePath, JSON.stringify(records, null, 2), "utf-8");
    } catch {
      /* best effort */
    }
  }

  function hasDelivered(entityKey: string, contextKey: string): boolean {
    const set = index.get(entityKey);
    return set?.has(contextKey) ?? false;
  }

  function markDelivered(entityKey: string, contextKeys: string[]): void {
    let set = index.get(entityKey);
    if (!set) {
      set = new Set();
      index.set(entityKey, set);
    }
    const now = new Date().toISOString();
    for (const ck of contextKeys) {
      if (!set.has(ck)) {
        set.add(ck);
        records.push({ entityKey, contextKey: ck, deliveredAt: now });
      }
    }
  }

  function getDeliveredCount(): number {
    return records.length;
  }

  function prune(): number {
    const cutoff = new Date(
      Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const before = records.length;

    records = records.filter((r) => r.deliveredAt >= cutoff);

    if (records.length > MAX_ENTRIES) {
      records = records.slice(-MAX_ENTRIES);
    }

    index = new Map();
    for (const r of records) {
      let set = index.get(r.entityKey);
      if (!set) {
        set = new Set();
        index.set(r.entityKey, set);
      }
      set.add(r.contextKey);
    }

    return before - records.length;
  }

  load();

  return { load, save, hasDelivered, markDelivered, getDeliveredCount, prune };
}
