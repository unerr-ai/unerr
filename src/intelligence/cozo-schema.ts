/**
 * CozoDB Datalog schema for local graph store (v9 — multi-level graph).
 *
 * Twenty-two relations:
 *   - entities: All graph entities with risk + community fields (functions, classes, files, etc.)
 *   - edges: Relationships between entities (calls, imports, extends, etc.)
 *   - file_index: File path → entity key mapping for fast file queries
 *   - search_tokens: Inverted index for local text search
 *   - token_doc_frequency: IDF weights for search scoring (Sprint 6.6)
 *   - rules: Code rules for local evaluation (Phase 10b, Sprint 9 extensions)
 *   - patterns: Detected code patterns (Phase 10b)
 *   - drift_overlay: Locally-modified entities tracked for drift detection (Phase 10)
 *   - justifications: Entity purpose, taxonomy, feature_area, confidence (Phase 10 MV-03)
 *   - spatial_positions: 3D positions for local-first visualization (Phase 14)
 *   - rule_exceptions: Time-bound exception ledger for rule violations (Sprint 9.6)
 *   - deep_dive_projects: Phase 22 Blueprint project metadata (Sprint 11)
 *   - deep_dive_slices: Vertical slices with boundary rules + conventions (Sprint 11)
 *   - deep_dive_tasks: Implementation tasks with sprint/dependency tracking (Sprint 11)
 *   - deep_dive_design_system: Design tokens for UI implementation (Sprint 11)
 *   - communities: Community-level metadata from Louvain detection (Leapfrog Sprint A)
 *   - corrections: Learned error→fix patterns from shadow ledger (Leapfrog Sprint B)
 *   - entity_embeddings: Per-entity embedding vectors for local semantic search (Sprint L3)
 *   - file_edges: Weighted file-to-file edges aggregated from L0 (Multi-Level Graph)
 *   - class_edges: Weighted class-to-class edges aggregated from L0 (Multi-Level Graph)
 *   - file_communities: Materialized file-level communities from cascaded Louvain (Multi-Level Graph)
 */

export interface CozoDb {
  run(
    query: string,
    params?: Record<string, unknown>
  ): Promise<{ rows: unknown[][] }>;
  close?(): void;
  exportRelations?(relations: string[]): Promise<unknown>;
  importRelations?(data: object): Promise<unknown>;
}

/**
 * Get the set of existing relation names in the database.
 */
async function getExistingRelations(db: CozoDb): Promise<Set<string>> {
  const result = await db.run("::relations");
  return new Set(result.rows.map((row) => row[0] as string));
}

/**
 * Safely create a relation only if it doesn't already exist.
 * CozoDB's :create fails with stored_relation_conflict on existing relations.
 */
async function createIfMissing(
  db: CozoDb,
  existing: Set<string>,
  name: string,
  schema: string
): Promise<void> {
  if (existing.has(name)) return;
  await db.run(schema);
}

/**
 * Drop a relation if it exists but is missing required columns.
 * No released versions exist yet, so stale dev schemas are safe to drop.
 */
async function dropIfStale(
  db: CozoDb,
  existing: Set<string>,
  name: string,
  requiredColumns: string[]
): Promise<void> {
  if (!existing.has(name)) return;
  try {
    const colList = ["key", ...requiredColumns].join(", ");
    await db.run(`?[] := *${name}{${colList}}, key = '__schema_probe__'`);
  } catch {
    await db.run(`::remove ${name}`);
    existing.delete(name);
  }
}

/**
 * Initialize CozoDB schema. Creates only missing relations.
 * Safe to call on both fresh and persistent databases.
 */
export async function initSchema(db: CozoDb): Promise<void> {
  const existing = await getExistingRelations(db);
  // Drop stale schemas from prior dev builds (no released versions to migrate).
  // Data is repopulated during indexing, so dropping is safe.
  await dropIfStale(db, existing, "entities", ["end_line", "is_test"]);

  await createIfMissing(
    db,
    existing,
    "entities",
    `
    :create entities {
      key: String
      =>
      kind: String,
      name: String,
      file_path: String,
      start_line: Int default 0,
      end_line: Int default 0,
      signature: String default "",
      body: String default "",
      fan_in: Int default 0,
      fan_out: Int default 0,
      risk_level: String default "normal",
      community: Int default -1,
      is_test: Bool default false
    }
  `
  );

  // Edge relation (v2: includes CFG control flow fields)
  await createIfMissing(
    db,
    existing,
    "edges",
    `
    :create edges {
      from_key: String,
      to_key: String,
      type: String
      =>
      sequence_order: Int default -1,
      condition: String default "",
      branch_kind: String default "",
      is_loop: Bool default false,
      loop_kind: String default "",
      nesting_depth: Int default 0,
      is_try_guarded: Bool default false,
      is_error_handler: Bool default false,
      mutation_target: String default "",
      mutation_mode: String default ""
    }
  `
  );

  // File index for fast file-based lookups
  await createIfMissing(
    db,
    existing,
    "file_index",
    `
    :create file_index {
      file_path: String,
      entity_key: String
    }
  `
  );

  // Search tokens (inverted index)
  await createIfMissing(
    db,
    existing,
    "search_tokens",
    `
    :create search_tokens {
      token: String,
      entity_key: String
    }
  `
  );

  // Token document frequency + pre-computed IDF weights (Sprint 6.6)
  // Populated during buildSearchIndex(). Used for IDF-weighted search scoring.
  await createIfMissing(
    db,
    existing,
    "token_doc_frequency",
    `
    :create token_doc_frequency {
      token: String
      =>
      doc_count: Int default 0,
      idf: Float default 0.0
    }
  `
  );

  // Rules (Phase 10b, Sprint 9 extensions: status, target_kinds, ast_grep_fix, health)
  await createIfMissing(
    db,
    existing,
    "rules",
    `
    :create rules {
      key: String
      =>
      name: String default "",
      scope: String default "repo",
      severity: String default "warn",
      engine: String default "structural",
      query: String default "",
      message: String default "",
      file_glob: String default "",
      enabled: Bool default true,
      repo_id: String default "",
      status: String default "active",
      target_kinds: String default "",
      ast_grep_fix: String default "",
      example: String default "",
      decay_score: Float default 0.0,
      evaluations: Int default 0,
      overrides: Int default 0
    }
  `
  );

  // Patterns (Phase 10b)
  await createIfMissing(
    db,
    existing,
    "patterns",
    `
    :create patterns {
      key: String
      =>
      name: String default "",
      kind: String default "",
      frequency: Int default 0,
      confidence: Float default 0.0,
      exemplar_keys: String default "",
      promoted_rule_key: String default ""
    }
  `
  );

  // Drift overlay (Phase 10) — entities modified locally, tracked for drift detection.
  // Ephemeral: cleared on branch switch or graph reload.
  await createIfMissing(
    db,
    existing,
    "drift_overlay",
    `
    :create drift_overlay {
      key: String
      =>
      name: String default "",
      kind: String default "",
      signature: String default "",
      body: String default "",
      file_path: String default "",
      line_start: Int default 0,
      line_end: Int default 0,
      content_hash: String default "",
      drift_status: String default "modified",
      intent_id: String default "",
      modified_at: String default "",
      origin: String default "human",
      previous_body: String default "",
      previous_signature: String default ""
    }
  `
  );

  // Drift edges (Sprint 6.4) — locally-detected edges (imports, function calls).
  // Populated during drift detection, merged with base edges at query time.
  // Cleared on branch switch (same lifecycle as drift_overlay).
  await createIfMissing(
    db,
    existing,
    "drift_edges",
    `
    :create drift_edges {
      from_key: String, to_key: String, type: String
      =>
      drift_status: String default "added",
      modified_at: String default ""
    }
  `
  );

  // Justifications (Phase 10 MV-03) — entity purpose/taxonomy from snapshot.
  // Loaded from snapshot, enables get_business_context + get_conventions locally.
  await createIfMissing(
    db,
    existing,
    "justifications",
    `
    :create justifications {
      entity_key: String
      =>
      purpose: String default "",
      taxonomy: String default "",
      feature_area: String default "",
      confidence: Float default 0.0
    }
  `
  );

  // Spatial positions (Phase 14) — 3D coordinates for local-first visualization.
  // Loaded from v3 snapshot. Enables `unerr serve --visual` locally.
  await createIfMissing(
    db,
    existing,
    "spatial_positions",
    `
    :create spatial_positions {
      entity_key: String
      =>
      x: Float default 0.0,
      y: Float default 0.0,
      z: Float default 0.0
    }
  `
  );

  // Rule exceptions (Sprint 9.6) — time-bound exception ledger for rule violations.
  // Loaded from snapshot. Active exceptions downgrade enforcement to "suggest".
  await createIfMissing(
    db,
    existing,
    "rule_exceptions",
    `
    :create rule_exceptions {
      key: String
      =>
      entity_key: String default "",
      rule_key: String default "",
      reason: String default "",
      granted_by: String default "",
      granted_at: String default "",
      expires_at: String default "",
      status: String default "active",
      jira_ticket: String default ""
    }
  `
  );

  // ── Sprint 11: Phase 22 Blueprint Deep Dive Relations ──────────────

  // Blueprint projects — approved architecture plans cached locally.
  await createIfMissing(
    db,
    existing,
    "deep_dive_projects",
    `
    :create deep_dive_projects {
      key: String
      =>
      name: String default "",
      description: String default "",
      status: String default "draft",
      domain: String default "{}",
      stage: String default "{}",
      stack_recommendation: String default "{}",
      design_system: String default "",
      health_baseline: String default "{}",
      org_id: String default "",
      updated_at: String default ""
    }
  `
  );

  // Blueprint slices — vertical implementation slices with boundary rules.
  await createIfMissing(
    db,
    existing,
    "deep_dive_slices",
    `
    :create deep_dive_slices {
      key: String
      =>
      project_key: String default "",
      name: String default "",
      description: String default "",
      repo_target_id: String default "",
      parent_slice_key: String default "",
      dependencies: String default "[]",
      status: String default "planned",
      order: Int default 0,
      slice_type: String default "",
      data_model: String default "",
      api_surface: String default "",
      conventions: String default "[]",
      boundary_rules: String default "[]",
      user_flows: String default "",
      ui_design: String default ""
    }
  `
  );

  // Blueprint tasks — implementation tasks within sprints.
  await createIfMissing(
    db,
    existing,
    "deep_dive_tasks",
    `
    :create deep_dive_tasks {
      key: String
      =>
      project_key: String default "",
      sprint_number: Int default 0,
      slice_name: String default "",
      description: String default "",
      status: String default "pending",
      estimated_effort: String default "",
      dependencies: String default "[]",
      boundary_rules: String default "[]",
      conventions: String default "[]",
      acceptance_criteria: String default "[]",
      completed_at: String default "",
      completed_files: String default "[]",
      checkpoint: String default "{}"
    }
  `
  );

  // Blueprint design system — denormalized design tokens for fast retrieval.
  await createIfMissing(
    db,
    existing,
    "deep_dive_design_system",
    `
    :create deep_dive_design_system {
      project_key: String
      =>
      tokens: String default "{}",
      updated_at: String default ""
    }
  `
  );

  // ── Leapfrog Sprint A: Community Detection Relations ──────────────

  // Communities — cluster-level metadata from Louvain community detection.
  await createIfMissing(
    db,
    existing,
    "communities",
    `
    :create communities {
      id: Int
      =>
      label: String default "",
      size: Int default 0,
      cohesion: Float default 0.0
    }
  `
  );

  // ── Leapfrog Sprint B: Correction Intelligence Relation ───────────

  // Corrections — learned error→fix patterns from shadow ledger analysis.
  await createIfMissing(
    db,
    existing,
    "corrections",
    `
    :create corrections {
      entity_key: String,
      error_type: String
      =>
      correction_summary: String default "",
      confidence: Float default 0.0,
      occurrences: Int default 0,
      last_seen: String default ""
    }
  `
  );

  // ── Sprint L3: Entity Embeddings for Local Semantic Search ───────

  // Entity embeddings — per-entity embedding vectors for local semantic search.
  await createIfMissing(
    db,
    existing,
    "entity_embeddings",
    `
    :create entity_embeddings {
      entity_key: String
      =>
      vector_json: String default "[]",
      model: String default "",
      dimensions: Int default 0,
      computed_at: String default ""
    }
  `
  );

  // ── Multi-Level Graph: L1 Materialized Relations ────────────────

  // Weighted file-to-file edges (L1). Aggregated from L0 entity edges during indexing.
  await createIfMissing(
    db,
    existing,
    "file_edges",
    `
    :create file_edges {
      from_file: String,
      to_file: String,
      edge_type: String
      =>
      weight: Int default 0,
      updated_at: Float default 0.0
    }
  `
  );

  // Weighted class-to-class edges (L1). Aggregated from L0 method/function edges.
  await createIfMissing(
    db,
    existing,
    "class_edges",
    `
    :create class_edges {
      from_class: String,
      to_class: String,
      edge_type: String
      =>
      weight: Int default 0,
      updated_at: Float default 0.0
    }
  `
  );

  // Materialized file-level communities from cascaded Louvain detection.
  await createIfMissing(
    db,
    existing,
    "file_communities",
    `
    :create file_communities {
      file_path: String
      =>
      community: Int default 0,
      label: String default "",
      cohesion: Float default 0.0,
      updated_at: Float default 0.0
    }
  `
  );
}
