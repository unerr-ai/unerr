/**
 * CozoDB Schema for facts.db — Temporal Intelligence (Layer 9).
 *
 * SEPARATE from graph.db (cozo-schema.ts). This schema manages:
 *   - facts: Temporal knowledge with decay model (procedural, semantic, negative, episodic)
 *   - entity_interactions: Cross-session entity access history
 *
 * Storage: `.unerr/facts.db` (SQLite-backed CozoDB, parallel to graph.db)
 *
 * Dual-mode access:
 *   - Daemon (unerr): read-write — generates facts, reinforces, prunes
 *   - Headless (--mcp): read-only + single atomic write via record_fact tool
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CozoDb } from "./cozo-schema.js";

const FACTS_DB_FILENAME = "facts.db";

export interface FactsDbResult {
  db: CozoDb;
  isNew: boolean;
  dbPath: string;
}

/**
 * Open or create the facts.db CozoDB instance at `{projectRoot}/.unerr/facts.db`.
 */
export async function openFactsDb(projectRoot: string): Promise<FactsDbResult> {
  const unerrDir = join(projectRoot, ".unerr");
  mkdirSync(unerrDir, { recursive: true });

  const dbPath = join(unerrDir, FACTS_DB_FILENAME);
  const isNew = !existsSync(dbPath);

  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;

  const db = new (CozoDbConstructor as any)("sqlite", dbPath) as CozoDb;

  return { db, isNew, dbPath };
}

/**
 * Initialize facts.db schema. Creates only missing relations.
 * Safe to call on both fresh and existing databases.
 */
export async function initFactsSchema(db: CozoDb): Promise<void> {
  const existing = await getExistingRelations(db);

  if (!existing.has("facts")) {
    await db.run(`
      :create facts {
        fact_id: String
        =>
        fact_type: String,
        scope: String,
        subject: String,
        content: String,
        base_confidence: Float,
        reinforcement_count: Int,
        created_at: Float,
        last_reinforced_at: Float,
        last_contradicted_at: Float,
        source: String,
        evidence: String
      }
    `);
  }

  if (!existing.has("entity_interactions")) {
    await db.run(`
      :create entity_interactions {
        entity_key: String,
        session_id: String,
        interaction_type: String,
        timestamp: Float
        =>
        tool_name: String,
        outcome: String
      }
    `);
  }

  if (!existing.has("signal_shows")) {
    // Rotation persistence: how many times each signal/fact has been surfaced.
    // KEY (signal_id, session_id) — each session writes only its own row, so
    // parallel `unerr --mcp` instances in the same repo never contend on writes.
    // Aggregate count = SUM(count) over all sessions; recency = MAX(last_shown_ms).
    await db.run(`
      :create signal_shows {
        signal_id: String,
        session_id: String
        =>
        scope: String,
        count: Int,
        last_shown_ms: Float
      }
    `);
  }
}

async function getExistingRelations(db: CozoDb): Promise<Set<string>> {
  const result = await db.run("::relations");
  return new Set(result.rows.map((row) => row[0] as string));
}
