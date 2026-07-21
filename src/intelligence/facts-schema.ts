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

  if (!existing.has("notes")) {
    // Active-cognition Layer B store. Anchored prose the agent writes/reads
    // via the four-moment contract. Each row is one DSL note:
    //   kind|anchor_type:anchor_value|polarity|content
    //
    // kind         — cnv|rul|wrn|dec|blk|fct
    // anchor_type  — f (file) | e (entity) | g (glob) | p (project-wide)
    // polarity     — + (do) | - (don't) | ~ (mixed)
    //
    // conflict_group_id binds opposing-polarity notes for the same kind+anchor
    // so they surface together. supersedes_note_id + inactive flag preserve an
    // audit trail without destructive deletes. anchor_missing tracks notes
    // whose anchor disappeared (file deleted with no detected rename); decay
    // accelerates from anchor_missing_since.
    //
    // content_embedding deliberately omitted from v1 — reserved for future
    // pro-tier semantic search. Column can be added without migration per the
    // pre-release schema rule.
    await db.run(`
      :create notes {
        note_id: String
        =>
        kind: String,
        anchor_type: String,
        anchor_value: String,
        polarity: String,
        content: String,
        dedupe_key: String,
        reinforcement_count: Int default 0,
        contradiction_count: Int default 0,
        created_session_id: String,
        created_prompt_hash: String,
        created_at: Float,
        last_seen_at: Float,
        decay_score: Float default 0.0,
        conflict_group_id: String default '',
        supersedes_note_id: String default '',
        inactive: Bool default false,
        anchor_missing: Bool default false,
        anchor_missing_since: Float default 0.0
      }
    `);

    // Five secondary indexes per Execute spec §14 Sprint A. Best-effort: if
    // the running CozoDB build rejects the syntax, the relation still works
    // (scans are <5ms on the populations we care about) and we add indexes
    // back when real workload data motivates a perf pass.
    const indexes = [
      "by_anchor {anchor_type, anchor_value}",
      "by_dedupe {dedupe_key}",
      "by_kind {kind}",
      "by_conflict {conflict_group_id}",
      "by_decay {decay_score}",
    ];
    for (const idx of indexes) {
      try {
        await db.run(`::index create notes:${idx}`);
      } catch {
        // Index creation is non-fatal — see note above.
      }
    }
  }

  if (!existing.has("co_change_groups")) {
    // Cross-anchor co-change relationships. Kept outside the single-anchor
    // DSL so the four-tuple note shape stays clean. `anchors` is a JSON-
    // encoded array of "kind:value" strings (e.g. '["f:src/a.ts","f:src/b.ts"]')
    // — query-time decode is one JSON.parse, no string-magic on our side.
    await db.run(`
      :create co_change_groups {
        group_id: String
        =>
        anchors: String,
        content: String,
        reinforcement_count: Int default 0,
        created_at: Float,
        last_seen_at: Float
      }
    `);
  }
}

async function getExistingRelations(db: CozoDb): Promise<Set<string>> {
  const result = await db.run("::relations");
  return new Set(result.rows.map((row) => row[0] as string));
}
