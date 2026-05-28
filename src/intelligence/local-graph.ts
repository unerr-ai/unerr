/**
 * CozoGraphStore — Local graph store backed by CozoDB.
 *
 * Provides read-only IGraphStore-like interface for local graph queries.
 * Loaded from msgpack snapshots loaded from local snapshots.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectCommunities } from "./community-detection.js";
import { initSchema } from "./cozo-schema.js";
import type { CozoDb } from "./cozo-schema.js";
import { buildSearchIndex, searchLocal, tokenize } from "./search-index.js";

export interface CompactEntity {
  key: string;
  kind: string;
  name: string;
  file_path: string;
  start_line?: number;
  end_line?: number;
  signature?: string;
  body?: string;
  /** Pre-computed blast radius: inbound call edges */
  fan_in?: number;
  /** Pre-computed blast radius: outbound call edges */
  fan_out?: number;
  /** Risk classification: "high" | "medium" | "normal" */
  risk_level?: string;
  /** Entity purpose from justification pipeline */
  purpose?: string;
  /** Entity taxonomy classification */
  taxonomy?: string;
  /** Feature area this entity belongs to */
  feature_area?: string;
  /** Justification confidence (0-1) */
  justification_confidence?: number;
  /** Community ID from Louvain detection (-1 = unassigned) */
  community?: number;
  /** Whether this entity is from a test file */
  is_test?: boolean;
  /** Owning class name (for methods). Used to create class→method containment edges. */
  parent_class?: string;
}

export interface CompactEdge {
  from_key: string;
  to_key: string;
  type: string;
  // CFG control flow fields (present on "calls" and "mutates_state" edges)
  seq?: number;
  cond?: string;
  br?: string;
  lp?: boolean;
  lk?: string;
  nd?: number;
  tg?: boolean;
  eh?: boolean;
  mt?: string;
  mm?: string;
  mo?: string;
}

// ── Multi-Level Graph: L1 Types ───────────────────────────────────

/** Weighted file-to-file edge (L1). Aggregated from L0 entity edges. */
export interface FileEdge {
  from_file: string;
  to_file: string;
  edge_type: string;
  weight: number;
}

/** Weighted class-to-class edge (L1). Aggregated from L0 method edges. */
export interface ClassEdge {
  from_class: string;
  to_class: string;
  edge_type: string;
  weight: number;
}

/** Materialized file-level community assignment from cascaded Louvain. */
export interface FileCommunity {
  file_path: string;
  community: number;
  label: string;
  cohesion: number;
}

export interface CompactRule {
  key: string;
  name: string;
  scope: string;
  severity: string;
  engine: string;
  query: string;
  message: string;
  file_glob: string;
  enabled: boolean;
  repo_id: string;
  /** Sprint 9: "active" | "staged" | "deprecated" */
  status?: string;
  /** Sprint 9: Comma-separated entity kinds this rule targets (e.g. "function,class") */
  target_kinds?: string;
  /** Sprint 9: ast-grep fix pattern for auto-remediation */
  ast_grep_fix?: string;
  /** Sprint 9: Example code snippet for rule documentation */
  example?: string;
  /** Sprint 9: Decay score from Rule Health Ledger (0.0 = healthy, 1.0 = decayed) */
  decay_score?: number;
  /** Sprint 9: Total evaluation count */
  evaluations?: number;
  /** Sprint 9: Total override count */
  overrides?: number;
}

/** Sprint 9.6: Time-bound exception for a rule violation */
export interface CompactRuleException {
  key: string;
  entity_key: string;
  rule_key: string;
  reason: string;
  granted_by: string;
  granted_at: string;
  expires_at: string;
  status: string;
  jira_ticket: string;
}

export interface CompactPattern {
  key: string;
  name: string;
  kind: string;
  frequency: number;
  confidence: number;
  exemplar_keys: string[];
  promoted_rule_key: string;
}

export interface CompactJustification {
  entity_key: string;
  purpose: string;
  taxonomy: string;
  feature_area: string;
  confidence: number;
}

export interface SnapshotEnvelope {
  version: number;
  repoId: string;
  orgId: string;
  entities: CompactEntity[];
  edges: CompactEdge[];
  rules?: CompactRule[];
  patterns?: CompactPattern[];
  justifications?: CompactJustification[];
  rule_exceptions?: CompactRuleException[];
  generatedAt: string;
}

export interface LocalEntity {
  key: string;
  kind: string;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string;
  body: string;
  fan_in: number;
  fan_out: number;
  risk_level: string;
  community: number;
}

export interface BlastRadiusResult {
  direct_callers: number;
  direct_callees: number;
  transitive_count: number;
  transitive_depth: number;
  is_chokepoint: boolean;
  /** Production callers only (excludes test entities) */
  production_callers: number;
  /** Test callers only */
  test_callers: number;
  /** Human-readable summary surfaced via the `ur|rsk` prefix line on blast-radius responses. */
  summary: string;
}

/** Sprint 3.1: Entity with graph distance from blast radius traversal. */
export interface BlastRadiusEntity {
  key: string;
  name: string;
  file: string;
  depth: number;
}

export interface DriftEntity {
  key: string;
  name: string;
  kind: string;
  signature: string;
  body: string;
  file_path: string;
  line_start: number;
  line_end: number;
  content_hash: string;
  drift_status: "added" | "modified" | "deleted" | "dependency_changed";
  intent_id: string;
  modified_at: string;
  /** Attribution origin: "ai" | "human" | "mixed" */
  origin: "ai" | "human" | "mixed";
  /** Previous body content before drift (for entity-level rewind) */
  previous_body: string;
  /** Previous signature before drift (for entity-level rewind) */
  previous_signature: string;
}

export interface DriftSummary {
  added: number;
  modified: number;
  deleted: number;
  dependency_changed: number;
  total: number;
}

/** Sprint 6.4: Locally-detected edge (import or function call). */
export interface DriftEdge {
  from_key: string;
  to_key: string;
  type: string;
  drift_status: "added" | "removed";
  modified_at: string;
}

// ── Sprint 11: Phase 22 Blueprint Deep Dive Types ──────────────────

/** Input type for loading a blueprint project into CozoDB. */
export interface DeepDiveProject {
  key: string;
  name: string;
  description: string;
  status: string;
  domain?: Record<string, unknown>;
  stage?: Record<string, unknown>;
  stackRecommendation?: Record<string, unknown>;
  designSystem?: unknown;
  healthBaseline?: Record<string, unknown>;
  orgId?: string;
  updatedAt?: string;
}

/** Input type for loading a blueprint slice. */
export interface DeepDiveSlice {
  key: string;
  projectKey: string;
  name: string;
  description?: string;
  repoTargetId?: string;
  parentSliceKey?: string;
  dependencies?: string[];
  status?: string;
  order?: number;
  sliceType?: string;
  dataModel?: unknown;
  apiSurface?: unknown;
  conventions?: Array<{ name: string; pattern: string; enforcement: string }>;
  boundaryRules?: Array<{ description: string; enforcement: string }>;
  userFlows?: unknown;
  uiDesign?: unknown;
}

/** Input type for loading a blueprint task. */
export interface DeepDiveTask {
  key: string;
  projectKey: string;
  sprintNumber: number;
  sliceName?: string;
  description?: string;
  status?: string;
  estimatedEffort?: string;
  dependencies?: string[];
  boundaryRules?: Array<{ description: string; enforcement?: string }>;
  conventions?: Array<{ name: string; pattern: string; enforcement?: string }>;
  acceptanceCriteria?: unknown[];
  completedAt?: string;
  completedFiles?: string[];
  checkpoint?: Record<string, unknown>;
}

/** Row type returned by deep dive project queries. */
export interface DeepDiveProjectRow {
  key: string;
  name: string;
  description: string;
  status: string;
  domain: Record<string, unknown>;
  stage: Record<string, unknown>;
  stackRecommendation: Record<string, unknown>;
  designSystem: unknown;
  healthBaseline: Record<string, unknown>;
  orgId: string;
  updatedAt: string;
}

/** Row type returned by deep dive slice queries. */
export interface DeepDiveSliceRow {
  key: string;
  name: string;
  description: string;
  repoTargetId: string;
  parentSliceKey: string;
  dependencies: string[];
  status: string;
  order: number;
  sliceType: string;
  dataModel: unknown;
  apiSurface: unknown;
  conventions: Array<{ name: string; pattern: string; enforcement: string }>;
  boundaryRules: Array<{ description: string; enforcement: string }>;
  userFlows: unknown;
  uiDesign: unknown;
}

/** Row type returned by deep dive task queries. */
export interface DeepDiveTaskRow {
  key: string;
  sprintNumber: number;
  sliceName: string;
  description: string;
  status: string;
  estimatedEffort: string;
  dependencies: string[];
  boundaryRules: Array<{ description: string; enforcement?: string }>;
  conventions: Array<{ name: string; pattern: string; enforcement?: string }>;
  acceptanceCriteria: unknown[];
  completedAt: string;
  completedFiles: string[];
  checkpoint: Record<string, unknown>;
}

/**
 * Default timeout for read queries (ms). A read should only fail on a TRUE
 * stall, not on transient contention. The old 2s value was too tight: heavy
 * reads (file_read/file_outline/search_code) that query-router.ts intends to
 * allow up to 5s "under indexer contention" were killed at 2s, and internal
 * (non-tool) reads had no headroom for a RocksDB compaction window. Raised 6×
 * to leave slack for unrelated stalls; tool-facing reads remain additionally
 * bounded by the smaller tool-level budget in query-router.ts.
 */
const QUERY_TIMEOUT_MS = 12_000;
/**
 * Timeout for write operations (ms). Its only legitimate job is to catch a TRUE
 * deadlock — `Promise.race` cannot cancel the native `db.run`, so a write that
 * "times out" keeps running and holds the single-writer lock (a zombie that
 * then starves reads). It must therefore exceed the worst-case legitimate
 * stall. Periodic orphan cleanup ("Removing N orphaned entities") triggers a
 * RocksDB compaction stall lasting tens of seconds; the old 10s value falsely
 * failed drift writes queued behind it. Raised 6× to ride out that stall while
 * still bounding a genuinely wedged operation.
 */
const WRITE_TIMEOUT_MS = 60_000;

export class CozoGraphStore {
  readonly db: CozoDb;
  private loaded = false;
  /** Serialized write queue — prevents concurrent CozoDB write contention. */
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(db: CozoDb) {
    this.db = db;
  }

  /**
   * Timeout-protected read query. Returns empty rows on timeout instead of hanging.
   * Use this for all tool-facing read paths to prevent stuck MCP calls.
   */
  async query(
    script: string,
    params?: Record<string, unknown>,
    timeoutMs = QUERY_TIMEOUT_MS
  ): Promise<{ rows: unknown[][] }> {
    return Promise.race([
      this.db.run(script, params),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`CozoDB query timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  /**
   * Serialized, timeout-protected write operation.
   * Writes are queued so they don't contend with each other,
   * and reads (via query()) can detect contention via timeout.
   */
  async write(
    script: string,
    params?: Record<string, unknown>
  ): Promise<{ rows: unknown[][] }> {
    let result: { rows: unknown[][] };
    const op = this.writeChain.then(async () => {
      result = await Promise.race([
        this.db.run(script, params),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`CozoDB write timeout after ${WRITE_TIMEOUT_MS}ms`)
              ),
            WRITE_TIMEOUT_MS
          )
        ),
      ]);
    });
    this.writeChain = op.catch(() => {}); // keep chain alive on failure
    await op;
    return result!;
  }

  /**
   * Async factory — ensures CozoDB schema exists before returning the store.
   * Safe for both fresh and persistent databases.
   *
   * RC-6: Checks for concurrent DB access. If a daemon process already
   * owns the DB (detected via PID lock file), returns null so callers
   * can fall back to parse-only mode.
   */
  static async create(
    db: CozoDb,
    projectRoot?: string
  ): Promise<CozoGraphStore> {
    // RC-6: Check if another process owns the DB
    if (projectRoot) {
      const pidPath = join(projectRoot, ".unerr", "state", "proxy.pid");
      if (existsSync(pidPath)) {
        try {
          const raw = readFileSync(pidPath, "utf-8").trim();
          let ownerPid: number | undefined;
          if (raw.startsWith("{")) {
            const data = JSON.parse(raw);
            ownerPid = typeof data.pid === "number" ? data.pid : undefined;
          } else {
            ownerPid = Number.parseInt(raw, 10);
            if (Number.isNaN(ownerPid)) ownerPid = undefined;
          }
          if (ownerPid !== undefined && ownerPid !== process.pid) {
            try {
              process.kill(ownerPid, 0); // Check if alive (signal 0)
              throw new Error(
                `DB owned by daemon (PID ${ownerPid}). Use parse-only mode to avoid lock contention.`
              );
            } catch (killErr) {
              if (
                killErr instanceof Error &&
                killErr.message.startsWith("DB owned by daemon")
              ) {
                throw killErr;
              }
              // Process not alive — stale PID file, safe to proceed
              process.stderr.write(
                `[unerr] Stale PID file detected (PID ${ownerPid} not alive). Proceeding with DB access.\n`
              );
            }
          }
        } catch (outerErr) {
          if (
            outerErr instanceof Error &&
            outerErr.message.startsWith("DB owned by daemon")
          ) {
            throw outerErr;
          }
          // PID file parse error — proceed with DB access
        }
      }
    }

    const store = new CozoGraphStore(db);
    await initSchema(db);
    return store;
  }

  /**
   * Check if the graph has indexed data (entities relation is populated).
   * Used to determine if a persistent DB needs initial indexing.
   */
  async isPopulated(): Promise<boolean> {
    const result = await this.query("?[count(key)] := *entities{key}");
    const count = (result.rows[0]?.[0] as number) ?? 0;
    return count > 0;
  }

  /**
   * Get the entity count without loading full data.
   */
  async getEntityCount(): Promise<number> {
    const result = await this.query("?[count(key)] := *entities{key}");
    return (result.rows[0]?.[0] as number) ?? 0;
  }

  /**
   * Load a deserialized snapshot into CozoDB.
   */
  async loadSnapshot(envelope: SnapshotEnvelope): Promise<void> {
    // Bulk insert entities (v3: includes risk fields)
    for (const entity of envelope.entities) {
      await this.write(
        `?[key, kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level] <- [[$key, $kind, $name, $fp, $sl, $el, $sig, $body, $fi, $fo, $rl]]
         :put entities { key => kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level }`,
        {
          key: entity.key,
          kind: entity.kind,
          name: entity.name,
          fp: entity.file_path,
          sl: entity.start_line ?? 0,
          el: (entity as any).end_line ?? 0,
          sig: entity.signature ?? "",
          body: entity.body ?? "",
          fi: entity.fan_in ?? 0,
          fo: entity.fan_out ?? 0,
          rl: entity.risk_level ?? "normal",
        }
      );

      // Build file index
      await this.write(
        "?[file_path, entity_key] <- [[$fp, $key]] :put file_index { file_path, entity_key }",
        { fp: entity.file_path, key: entity.key }
      );
    }

    // Bulk insert edges (v2: includes CFG control flow fields)
    for (const edge of envelope.edges) {
      await this.write(
        "?[from_key, to_key, type, sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode] <- [[$from, $to, $type, $seq, $cond, $br, $lp, $lk, $nd, $tg, $eh, $mt, $mm]] :put edges { from_key, to_key, type => sequence_order, condition, branch_kind, is_loop, loop_kind, nesting_depth, is_try_guarded, is_error_handler, mutation_target, mutation_mode }",
        {
          from: edge.from_key,
          to: edge.to_key,
          type: edge.type,
          seq: edge.seq ?? -1,
          cond: edge.cond ?? "",
          br: edge.br ?? "",
          lp: edge.lp ?? false,
          lk: edge.lk ?? "",
          nd: edge.nd ?? 0,
          tg: edge.tg ?? false,
          eh: edge.eh ?? false,
          mt: edge.mt ?? "",
          mm: edge.mm ?? "",
        }
      );
    }

    // Load rules if present (v2 envelope)
    if (envelope.rules && envelope.rules.length > 0) {
      await this.loadRules(envelope.rules);
    }

    // Load patterns if present (v2 envelope)
    if (envelope.patterns && envelope.patterns.length > 0) {
      await this.loadPatterns(envelope.patterns);
    }

    // Load rule exceptions if present (Sprint 9.6)
    if (envelope.rule_exceptions && envelope.rule_exceptions.length > 0) {
      await this.loadRuleExceptions(envelope.rule_exceptions);
    }

    // Load justifications if present (v4 envelope / MV-03)
    if (envelope.justifications && envelope.justifications.length > 0) {
      await this.loadJustifications(envelope.justifications);
    }

    // Load inline justifications from entities (alternative path)
    for (const entity of envelope.entities) {
      if (entity.purpose || entity.taxonomy || entity.feature_area) {
        await this.write(
          `?[entity_key, purpose, taxonomy, feature_area, confidence] <-
            [[$ek, $purpose, $taxonomy, $fa, $conf]]
           :put justifications { entity_key => purpose, taxonomy, feature_area, confidence }`,
          {
            ek: entity.key,
            purpose: entity.purpose ?? "",
            taxonomy: entity.taxonomy ?? "",
            fa: entity.feature_area ?? "",
            conf: entity.justification_confidence ?? 0,
          }
        );
      }
    }

    // Build search index
    await buildSearchIndex(this.db);

    // Leapfrog Sprint A: Community detection via Louvain
    await this.detectAndStoreCommunities();

    this.loaded = true;
  }

  /**
   * Leapfrog Sprint A.2: Run community detection and store results in CozoDB.
   *
   * Extracts all entities and edges from CozoDB, runs Louvain community detection,
   * then writes community assignments back to entities.community and the communities relation.
   * Called once at the end of loadSnapshot(). <200ms for 5K entities.
   */
  private async detectAndStoreCommunities(): Promise<void> {
    // Extract minimal entity data for community detection
    const entityResult = await this.query(
      "?[key, file_path] := *entities{key, file_path}"
    );
    const entities = entityResult.rows.map((row) => ({
      key: row[0] as string,
      file_path: row[1] as string,
    }));

    if (entities.length === 0) return;

    // Extract edges (all types contribute to community structure)
    // R.5: Include edge type so community detection can weight contains edges at 0.3
    const edgeResult = await this.query(
      "?[from_key, to_key, type] := *edges{from_key, to_key, type}"
    );
    const edges = edgeResult.rows.map((row) => ({
      from_key: row[0] as string,
      to_key: row[1] as string,
      type: row[2] as string,
    }));

    // Run community detection
    const result = detectCommunities(entities, edges);

    // Write community assignments back to entities using :update (only changes community column)
    for (const [key, communityId] of result.assignments) {
      await this.write(
        "?[key, community] <- [[$key, $cid]] :update entities { key => community }",
        { key, cid: communityId }
      );
    }

    // Write community metadata
    for (const c of result.communities) {
      await this.write(
        "?[id, label, size, cohesion] <- [[$id, $label, $size, $cohesion]] :put communities { id => label, size, cohesion }",
        { id: c.id, label: c.label, size: c.size, cohesion: c.cohesion }
      );
    }
  }

  /**
   * Get a single entity by key.
   */
  async getEntity(key: string): Promise<LocalEntity | null> {
    const result = await this.query(
      "?[key, kind, name, fp, sl, el, sig, body, fi, fo, rl, community] := *entities{key, kind, name, file_path: fp, start_line: sl, end_line: el, signature: sig, body, fan_in: fi, fan_out: fo, risk_level: rl, community}, key = $key",
      { key }
    );
    if (result.rows.length === 0) return null;
    const [k, kind, name, fp, sl, el, sig, body, fi, fo, rl, community] = result
      .rows[0] as [
      string,
      string,
      string,
      string,
      number,
      number,
      string,
      string,
      number,
      number,
      string,
      number,
    ];
    return {
      key: k,
      kind,
      name,
      file_path: fp,
      start_line: sl,
      end_line: el,
      signature: sig,
      body,
      fan_in: fi,
      fan_out: fo,
      risk_level: rl,
      community,
    };
  }

  /**
   * Get all entities that call the given entity.
   * Merges base edges with drift_edges (Task 6.4).
   */
  async getCallersOf(key: string): Promise<LocalEntity[]> {
    // Defensive kind filter: only callable kinds (function, method, class) can be
    // callers. Pre-fix drift_edges may contain variable/interface/type rows from
    // the historical extractor bug that scanned full-file content per-entity.
    const result = await this.query(
      `base[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] := *edges{from_key, to_key: $key, type: "calls"},
        *entities{key: from_key, kind, name, file_path: fp, start_line: sl, end_line: el, signature: sig, body, fan_in: fi, fan_out: fo, risk_level: rl, community: comm},
        kind != "variable", kind != "interface", kind != "type", kind != "enum", kind != "namespace",
        k = from_key
       drift[k] := *drift_edges[k, $key, "calls", ds, _], ds != "removed"
       drift_entity[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] :=
        drift[k], *entities{key: k, kind, name, file_path: fp, start_line: sl, end_line: el, signature: sig, body, fan_in: fi, fan_out: fo, risk_level: rl, community: comm},
        kind != "variable", kind != "interface", kind != "type", kind != "enum", kind != "namespace"
       drift_overlay_entity[k, kind, name, fp, ls, el, sig, body, fi, fo, rl, comm] :=
        drift[k], *drift_overlay{key: k, name, kind, signature: sig, body, file_path: fp, line_start: ls},
        kind != "variable", kind != "interface", kind != "type", kind != "enum", kind != "namespace",
        not *entities{key: k}, el = 0, fi = 0, fo = 0, rl = "normal", comm = -1
       ?[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] :=
        base[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm]
       ?[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] :=
        drift_entity[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm],
        not base[k, _, _, _, _, _, _, _, _, _, _, _]
       ?[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] :=
        drift_overlay_entity[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm],
        not base[k, _, _, _, _, _, _, _, _, _, _, _],
        not drift_entity[k, _, _, _, _, _, _, _, _, _, _, _]`,
      { key }
    );
    return result.rows.map((row) => {
      const [k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] = row as [
        string,
        string,
        string,
        string,
        number,
        number,
        string,
        string,
        number,
        number,
        string,
        number,
      ];
      return {
        key: k,
        kind,
        name,
        file_path: fp,
        start_line: sl,
        end_line: el,
        signature: sig,
        body,
        fan_in: fi,
        fan_out: fo,
        risk_level: rl,
        community: comm,
      };
    });
  }

  /**
   * Get all entities called by the given entity.
   * Merges base edges with drift_edges (Task 6.4).
   */
  async getCalleesOf(key: string): Promise<LocalEntity[]> {
    const result = await this.query(
      `base[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] := *edges{from_key: $key, to_key, type: "calls"},
        *entities{key: to_key, kind, name, file_path: fp, start_line: sl, end_line: el, signature: sig, body, fan_in: fi, fan_out: fo, risk_level: rl, community: comm},
        kind != "variable", kind != "interface", kind != "type", kind != "enum", kind != "namespace",
        k = to_key
       drift[k] := *drift_edges[$key, k, "calls", ds, _], ds != "removed"
       drift_entity[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] :=
        drift[k], *entities{key: k, kind, name, file_path: fp, start_line: sl, end_line: el, signature: sig, body, fan_in: fi, fan_out: fo, risk_level: rl, community: comm},
        kind != "variable", kind != "interface", kind != "type", kind != "enum", kind != "namespace"
       drift_overlay_entity[k, kind, name, fp, ls, el, sig, body, fi, fo, rl, comm] :=
        drift[k], *drift_overlay{key: k, name, kind, signature: sig, body, file_path: fp, line_start: ls},
        kind != "variable", kind != "interface", kind != "type", kind != "enum", kind != "namespace",
        not *entities{key: k}, el = 0, fi = 0, fo = 0, rl = "normal", comm = -1
       ?[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] :=
        base[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm]
       ?[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] :=
        drift_entity[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm],
        not base[k, _, _, _, _, _, _, _, _, _, _, _]
       ?[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] :=
        drift_overlay_entity[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm],
        not base[k, _, _, _, _, _, _, _, _, _, _, _],
        not drift_entity[k, _, _, _, _, _, _, _, _, _, _, _]`,
      { key }
    );
    return result.rows.map((row) => {
      const [k, kind, name, fp, sl, el, sig, body, fi, fo, rl, comm] = row as [
        string,
        string,
        string,
        string,
        number,
        number,
        string,
        string,
        number,
        number,
        string,
        number,
      ];
      return {
        key: k,
        kind,
        name,
        file_path: fp,
        start_line: sl,
        end_line: el,
        signature: sig,
        body,
        fan_in: fi,
        fan_out: fo,
        risk_level: rl,
        community: comm,
      };
    });
  }

  /**
   * Compute blast radius for an entity using recursive Datalog traversal.
   *
   * Returns direct callers/callees counts, transitive dependent count at
   * the specified depth, and chokepoint detection (fan_in > 5 AND fan_out > 5).
   * Designed to complete in <5ms on graphs with 10K+ entities.
   */
  async getBlastRadius(
    entityKey: string,
    maxDepth = 2
  ): Promise<BlastRadiusResult> {
    // Direct callers and callees (depth 1)
    const callersResult = await this.query(
      `?[k] := *edges{from_key, to_key: $key, type: "calls"}, k = from_key`,
      { key: entityKey }
    );
    const calleesResult = await this.query(
      `?[k] := *edges{from_key: $key, to_key, type: "calls"}, k = to_key`,
      { key: entityKey }
    );

    const directCallers = callersResult.rows.length;
    const directCallees = calleesResult.rows.length;

    // Split callers into production vs test
    const callerTestSplit = await this.query(
      `?[k, it] := *edges{from_key, to_key: $key, type: "calls"},
        *entities{key: from_key, is_test: it}, k = from_key`,
      { key: entityKey }
    );
    let productionCallers = 0;
    let testCallers = 0;
    for (const row of callerTestSplit.rows) {
      if (row[1] as boolean) testCallers++;
      else productionCallers++;
    }

    // Direct caller count IS the blast radius for signal purposes. Earlier
    // versions ran a recursive transitive walk (callers-of-callers up to
    // maxDepth) but: (a) the only `_meta.blast_radius.transitive_depth2`
    // consumer was dropped when MCP `_meta` was removed, and (b) the recursive
    // form was broken (two `?[]` heads). Keep `transitive_count` in the result
    // shape for back-compat, set to `directCallers` — depth-1 truth.
    const transitiveCount = directCallers;
    void maxDepth; // retained as a stable parameter for callers; one-hop now.

    // Chokepoint: fan_in > 5 AND fan_out > 5
    const entity = await this.getEntity(entityKey);
    const isChokepoint =
      entity !== null && entity.fan_in > 5 && entity.fan_out > 5;

    // Build summary string for _context
    const parts: string[] = [];
    if (productionCallers > 0)
      parts.push(
        `${productionCallers} production caller${productionCallers !== 1 ? "s" : ""}`
      );
    if (testCallers > 0)
      parts.push(`${testCallers} test caller${testCallers !== 1 ? "s" : ""}`);
    if (directCallees > 0)
      parts.push(
        `${directCallees} direct callee${directCallees !== 1 ? "s" : ""}`
      );
    if (isChokepoint) parts.push("CHOKEPOINT");
    const summary = parts.length > 0 ? parts.join(", ") : "No dependencies";

    return {
      direct_callers: directCallers,
      direct_callees: directCallees,
      production_callers: productionCallers,
      test_callers: testCallers,
      transitive_count: transitiveCount,
      transitive_depth: 1,
      is_chokepoint: isChokepoint,
      summary,
    };
  }

  /**
   * Sprint 3.1: Full N-hop blast radius returning entity details with depth.
   *
   * Traverses callers recursively up to maxDepth using CozoDB Datalog recursion,
   * then joins entity details (name, file_path) for each affected node.
   * Configurable max depth (default 2). <10ms on 10K-entity graphs at depth 3.
   */
  async getBlastRadiusEntities(
    entityKey: string,
    maxDepth = 2
  ): Promise<BlastRadiusEntity[]> {
    // Single-hop direct callers — same data, no broken recursion. The
    // consumer (`_meta.blast_radius.affected_entities.slice(0, 20)`) was
    // removed when MCP `_meta` was filtered out; this method survives for
    // backwards-compat and the file-siblings fallback below.
    void maxDepth; // depth-N walk would re-introduce the parser bug; depth-1 truth is sufficient.
    const directResult = await this.query(
      `?[target] := *edges{from_key, to_key: $root, type: "calls"}, target = from_key`,
      { root: entityKey }
    );

    const depthMap = new Map<string, number>();
    for (const row of directResult.rows) {
      const key = row[0] as string;
      if (key === entityKey) continue;
      if (!depthMap.has(key)) depthMap.set(key, 1);
    }

    if (depthMap.size === 0) {
      // R.6: File-level fallback — return sibling entities from the same file
      return this.getFileSiblings(entityKey);
    }

    // Batch-fetch entity details for all affected keys
    const entities: BlastRadiusEntity[] = [];
    for (const [key, depth] of depthMap) {
      const entityResult = await this.query(
        "?[k, name, fp] := *entities{key: k, name, file_path: fp}, k = $key",
        { key }
      );
      if (entityResult.rows.length > 0) {
        const [, name, file] = entityResult.rows[0] as [string, string, string];
        entities.push({ key, name, file, depth });
      }
    }

    // Sort by depth ascending, then by key for deterministic output
    entities.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
    return entities;
  }

  /**
   * R.6: Get sibling entities from the same file as the given entity.
   * Used as blast radius fallback when no callers exist.
   */
  private async getFileSiblings(
    entityKey: string
  ): Promise<BlastRadiusEntity[]> {
    // Find the file path for this entity
    const fileResult = await this.query(
      "?[fp] := *entities{key: $key, file_path: fp}",
      { key: entityKey }
    );
    if (fileResult.rows.length === 0) return [];
    const filePath = fileResult.rows[0]?.[0] as string;

    // Get all entities in the same file (via contains edges from the file entity)
    const siblingsResult = await this.query(
      `?[key, name, fp] := *edges{from_key: $fileKey, to_key: key, type: "contains"}, *entities{key, name, file_path: fp}, key != $entityKey`,
      { fileKey: `file:${filePath}`, entityKey }
    );

    return siblingsResult.rows.map((row) => ({
      key: row[0] as string,
      name: row[1] as string,
      file: row[2] as string,
      depth: 0, // Same file = depth 0 (adjacent)
    }));
  }

  // ── Sprint R.7: File-Level Queries ──────────────────────────────────

  /**
   * R.7: Get all entities contained within a file.
   */
  async getFileEntities(
    filePath: string
  ): Promise<Array<{ key: string; kind: string; name: string }>> {
    const result = await this.query(
      `?[key, kind, name] := *edges{from_key: $fileKey, to_key: key, type: "contains"}, *entities{key, kind, name}`,
      { fileKey: `file:${filePath}` }
    );
    return result.rows.map((row) => ({
      key: row[0] as string,
      kind: row[1] as string,
      name: row[2] as string,
    }));
  }

  /**
   * R.7: Get files connected to the given file via imports or co-change edges.
   * Returns connected files with edge type and direction.
   */
  async getFileNeighbors(
    filePath: string
  ): Promise<
    Array<{ file: string; edgeType: string; direction: "in" | "out" }>
  > {
    const fileKey = `file:${filePath}`;
    // Outbound: this file imports others
    const outResult = await this.query(
      "?[to_key, type] := *edges{from_key: $fk, to_key, type}, to_key != $fk",
      { fk: fileKey }
    );
    // Inbound: others import this file
    const inResult = await this.query(
      "?[from_key, type] := *edges{from_key, to_key: $fk, type}, from_key != $fk",
      { fk: fileKey }
    );

    type Neighbor = {
      file: string;
      edgeType: string;
      direction: "in" | "out";
    };
    const outbound: Neighbor[] = [];
    const inbound: Neighbor[] = [];

    for (const row of outResult.rows) {
      const toKey = row[0] as string;
      const edgeType = row[1] as string;
      // Only include file→file edges (skip contains edges to entities)
      if (toKey.startsWith("file:")) {
        outbound.push({ file: toKey.slice(5), edgeType, direction: "out" });
      }
    }
    for (const row of inResult.rows) {
      const fromKey = row[0] as string;
      const edgeType = row[1] as string;
      if (fromKey.startsWith("file:")) {
        inbound.push({ file: fromKey.slice(5), edgeType, direction: "in" });
      }
    }

    // Interleave so both directions survive a small `limit` at the wire cap.
    // Without this, in/out are emitted as two contiguous runs and the default
    // 20-item cap can hide one side entirely.
    const neighbors: Neighbor[] = [];
    const maxLen = Math.max(outbound.length, inbound.length);
    for (let i = 0; i < maxLen; i++) {
      const o = outbound[i];
      if (o) neighbors.push(o);
      const inb = inbound[i];
      if (inb) neighbors.push(inb);
    }

    return neighbors;
  }

  // ── Sprint R.13: Test Coverage Query ──────────────────────────────

  /**
   * Find test entities that cover a given source entity.
   * Uses "tests" edges (direct) and optionally traverses callers for transitive coverage.
   */
  async getTestCoverage(
    entityKey: string,
    includeTransitive = true
  ): Promise<
    Array<{ key: string; name: string; file: string; depth: number }>
  > {
    // Direct: tests edges pointing to this entity
    const directResult = await this.query(
      `?[k, name, fp] := *edges{from_key: k, to_key: $target, type: "tests"},
        *entities{key: k, name, file_path: fp}`,
      { target: entityKey }
    );

    const results: Array<{
      key: string;
      name: string;
      file: string;
      depth: number;
    }> = [];
    const seenKeys = new Set<string>();
    // Coverage is fundamentally a FILE-level signal — a test file either
    // exercises this entity or it doesn't, and which particular helper
    // function inside the file routes the call isn't actionable info for
    // the agent. Dedup by file_path to keep one (closest-depth) row per
    // covering test file.
    const seenFiles = new Set<string>();

    for (const row of directResult.rows) {
      const key = row[0] as string;
      const file = row[2] as string;
      if (seenKeys.has(key) || seenFiles.has(file)) continue;
      seenKeys.add(key);
      seenFiles.add(file);
      results.push({
        key,
        name: row[1] as string,
        file,
        depth: 1,
      });
    }

    // Transitive: test entities that call something that calls the target
    if (includeTransitive) {
      const transitiveResult = await this.query(
        `?[k, name, fp] := *edges{from_key: mid, to_key: $target, type: "calls"},
          *edges{from_key: k, to_key: mid, type: "tests"},
          *entities{key: k, name, file_path: fp}`,
        { target: entityKey }
      );

      for (const row of transitiveResult.rows) {
        const key = row[0] as string;
        const file = row[2] as string;
        if (seenKeys.has(key) || seenFiles.has(file)) continue;
        seenKeys.add(key);
        seenFiles.add(file);
        results.push({
          key,
          name: row[1] as string,
          file,
          depth: 2,
        });
      }
    }

    return results;
  }

  // ── Leapfrog Sprint A: Community Query Methods ─────────────────────

  /**
   * Get community metadata for an entity's community.
   * Returns null if entity has no community assignment (community == -1).
   */
  async getCommunityForEntity(entityKey: string): Promise<{
    id: number;
    label: string;
    size: number;
    cohesion: number;
  } | null> {
    const result = await this.query(
      `?[id, label, size, cohesion] :=
        *entities{key, community},
        key = $key, community >= 0,
        *communities[community, label, size, cohesion],
        id = community`,
      { key: entityKey }
    );
    if (result.rows.length === 0) return null;
    const [id, label, size, cohesion] = result.rows[0] as [
      number,
      string,
      number,
      number,
    ];
    return { id, label, size, cohesion };
  }

  /**
   * Get cross-community edges for an entity.
   * Returns edges where the entity connects to entities in different communities.
   */
  async getCrossCommunityEdges(entityKey: string): Promise<
    Array<{
      entity_name: string;
      entity_key: string;
      entity_community_id: number;
      entity_community_label: string;
      relation: string;
    }>
  > {
    // Outbound cross-community edges
    const outbound = await this.query(
      `?[to_name, to_key, to_community, to_label, edge_type] :=
        *edges{from_key: $key, to_key: tk, type: edge_type},
        *entities{key: $key, community: c1},
        *entities{key: tk, name: to_name, community: to_community},
        c1 >= 0, to_community >= 0, c1 != to_community,
        *communities{id: to_community, label: to_label},
        to_key = tk`,
      { key: entityKey }
    );

    // Inbound cross-community edges
    const inbound = await this.query(
      `?[from_name, from_key, from_community, from_label, edge_type] :=
        *edges{from_key: fk, to_key: $key, type: edge_type},
        *entities{key: $key, community: c1},
        *entities{key: fk, name: from_name, community: from_community},
        c1 >= 0, from_community >= 0, c1 != from_community,
        *communities{id: from_community, label: from_label},
        from_key = fk`,
      { key: entityKey }
    );

    const edges: Array<{
      entity_name: string;
      entity_key: string;
      entity_community_id: number;
      entity_community_label: string;
      relation: string;
    }> = [];

    for (const row of outbound.rows) {
      const [name, key, cid, label, rel] = row as [
        string,
        string,
        number,
        string,
        string,
      ];
      edges.push({
        entity_name: name,
        entity_key: key,
        entity_community_id: cid,
        entity_community_label: label,
        relation: rel,
      });
    }

    for (const row of inbound.rows) {
      const [name, key, cid, label, rel] = row as [
        string,
        string,
        number,
        string,
        string,
      ];
      edges.push({
        entity_name: name,
        entity_key: key,
        entity_community_id: cid,
        entity_community_label: label,
        relation: `${rel} (inbound)`,
      });
    }

    return edges;
  }

  /**
   * Get all cross-community edges in the graph, sorted by surprise score.
   * Surprise = inverse of inter-community edge density between the two communities.
   */
  async getCrossBoundaryLinks(
    communityId?: number,
    topN = 10
  ): Promise<
    Array<{
      from_name: string;
      from_file: string;
      from_community: number;
      from_community_label: string;
      to_name: string;
      to_file: string;
      to_community: number;
      to_community_label: string;
      edge_type: string;
      surprise_score: number;
    }>
  > {
    // Get all cross-community edges
    const query =
      communityId !== undefined
        ? `?[fn, ff, fc, fl, tn, tf, tc, tl, et] :=
            *edges{from_key: fk, to_key: tk, type: et},
            *entities{key: fk, name: fn, file_path: ff, community: fc},
            *entities{key: tk, name: tn, file_path: tf, community: tc},
            fc >= 0, tc >= 0, fc != tc,
            (fc = $cid or tc = $cid),
            *communities{id: fc, label: fl},
            *communities{id: tc, label: tl}`
        : `?[fn, ff, fc, fl, tn, tf, tc, tl, et] :=
            *edges{from_key: fk, to_key: tk, type: et},
            *entities{key: fk, name: fn, file_path: ff, community: fc},
            *entities{key: tk, name: tn, file_path: tf, community: tc},
            fc >= 0, tc >= 0, fc != tc,
            *communities{id: fc, label: fl},
            *communities{id: tc, label: tl}`;

    const result = await this.query(
      query,
      communityId !== undefined ? { cid: communityId } : {}
    );

    // Count edges per community pair for density calculation
    const pairCounts = new Map<string, number>();
    for (const row of result.rows) {
      const fc = row[2] as number;
      const tc = row[6] as number;
      const pairKey = `${Math.min(fc, tc)}-${Math.max(fc, tc)}`;
      pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
    }

    // Get max pair count for normalization
    const maxPairCount = Math.max(1, ...pairCounts.values());

    // Score and sort
    const scored = result.rows.map((row) => {
      const [fn, ff, fc, fl, tn, tf, tc, tl, et] = row as [
        string,
        string,
        number,
        string,
        string,
        string,
        number,
        string,
        string,
      ];
      const pairKey = `${Math.min(fc, tc)}-${Math.max(fc, tc)}`;
      const density = (pairCounts.get(pairKey) ?? 0) / maxPairCount;
      return {
        from_name: fn,
        from_file: ff,
        from_community: fc,
        from_community_label: fl,
        to_name: tn,
        to_file: tf,
        to_community: tc,
        to_community_label: tl,
        edge_type: et,
        surprise_score: Math.round((1.0 - density) * 1000) / 1000,
      };
    });

    scored.sort((a, b) => b.surprise_score - a.surprise_score);
    return scored.slice(0, topN);
  }

  /**
   * Get cross-boundary links for a specific pair of directory prefixes.
   *
   * Unlike getCrossBoundaryLinks (which fetches ALL cross-community edges and
   * post-filters), this runs a targeted Datalog query with starts_with so it
   * always finds relevant edges regardless of how many total cross-community
   * edges exist in the project.  Used when both from_path and to_path are
   * provided to get_cross_boundary_links.
   *
   * NOTE: Entity community IDs are hierarchical (macroCid * 1000 + subId).
   * The `communities` table only stores macro IDs.  This method avoids the
   * table join and resolves labels by looking up macroId = floor(id / 1000).
   */
  async getCrossPathLinks(
    fromPrefix: string,
    toPrefix: string,
    topN: number
  ): Promise<
    Array<{
      from_name: string;
      from_file: string;
      from_community: number;
      from_community_label: string;
      to_name: string;
      to_file: string;
      to_community: number;
      to_community_label: string;
      edge_type: string;
      surprise_score: number;
    }>
  > {
    // Normalise: ensure trailing slash so "src/proxy" doesn't match
    // "src/proxy-extra/" accidentally.
    const fp = fromPrefix.endsWith("/") ? fromPrefix : `${fromPrefix}/`;
    const tp = toPrefix.endsWith("/") ? toPrefix : `${toPrefix}/`;

    // Skip the communities table join — entity community IDs are
    // macroCid * 1000 + subId, so *communities{id: fc} would miss any entity
    // with a sub-community ID.  We resolve labels in TypeScript below.
    const mkQuery = (a: string, b: string) =>
      `?[fn, ff, fc, tn, tf, tc, et] :=
        *edges{from_key: fk, to_key: tk, type: et},
        *entities{key: fk, name: fn, file_path: ff, community: fc},
        *entities{key: tk, name: tn, file_path: tf, community: tc},
        starts_with(ff, $a), starts_with(tf, $b),
        fc >= 0, tc >= 0
        :limit $n`;

    const [fwdRes, revRes] = await Promise.all([
      this.query(mkQuery(fp, tp), { a: fp, b: tp, n: topN }).catch(() => ({
        rows: [] as unknown[][],
      })),
      this.query(mkQuery(tp, fp), { a: tp, b: fp, n: topN }).catch(() => ({
        rows: [] as unknown[][],
      })),
    ]);

    // Resolve macro community labels: macroId = floor(subCommunityId / 1000)
    const macroIds = new Set<number>();
    for (const rows of [fwdRes.rows, revRes.rows]) {
      for (const row of rows) {
        macroIds.add(Math.floor((row[2] as number) / 1000));
        macroIds.add(Math.floor((row[5] as number) / 1000));
      }
    }
    const labelMap = new Map<number, string>();
    if (macroIds.size > 0) {
      const ids = [...macroIds];
      try {
        const labelRes = await this.query(
          `?[id, label] := *communities{id, label}, id in $ids`,
          { ids }
        );
        for (const row of labelRes.rows) {
          labelMap.set(row[0] as number, row[1] as string);
        }
      } catch {
        // label lookup is best-effort; carry on without labels
      }
    }

    const seen = new Set<string>();
    const results: Array<{
      from_name: string;
      from_file: string;
      from_community: number;
      from_community_label: string;
      to_name: string;
      to_file: string;
      to_community: number;
      to_community_label: string;
      edge_type: string;
      surprise_score: number;
    }> = [];

    for (const row of [...fwdRes.rows, ...revRes.rows]) {
      const fc = row[2] as number;
      const tc = row[5] as number;
      const key = `${row[0] as string}:${row[3] as string}:${row[6] as string}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        from_name: row[0] as string,
        from_file: row[1] as string,
        from_community: fc,
        from_community_label:
          labelMap.get(Math.floor(fc / 1000)) ?? String(Math.floor(fc / 1000)),
        to_name: row[3] as string,
        to_file: row[4] as string,
        to_community: tc,
        to_community_label:
          labelMap.get(Math.floor(tc / 1000)) ?? String(Math.floor(tc / 1000)),
        edge_type: row[6] as string,
        surprise_score: 1.0, // all edges here cross an explicit path boundary
      });
    }
    return results.slice(0, topN);
  }

  /**
   * Get critical nodes — highest degree entities excluding file-level hubs.
   * Degree ranking excluding kind=="file" and kind=="module".
   */
  async getCriticalNodes(
    topN = 10,
    communityId?: number
  ): Promise<
    Array<{
      key: string;
      name: string;
      file_path: string;
      kind: string;
      fan_in: number;
      fan_out: number;
      degree: number;
      community: number;
      community_label: string;
      risk_level: string;
    }>
  > {
    const query =
      communityId !== undefined
        ? `?[key, name, fp, fi, fo, degree, community, label, rl, kind] :=
            *entities{key, name, file_path: fp, fan_in: fi, fan_out: fo, community, risk_level: rl, kind},
            kind != "file", kind != "module",
            community = $cid, community >= 0,
            *communities{id: community, label},
            degree = fi + fo
           :order -degree
           :limit $top_n`
        : `?[key, name, fp, fi, fo, degree, community, label, rl, kind] :=
            *entities{key, name, file_path: fp, fan_in: fi, fan_out: fo, community, risk_level: rl, kind},
            kind != "file", kind != "module",
            community >= 0,
            *communities{id: community, label},
            degree = fi + fo
           :order -degree
           :limit $top_n`;

    const params: Record<string, unknown> = { top_n: topN };
    if (communityId !== undefined) params.cid = communityId;

    const result = await this.query(query, params);

    return result.rows.map((row) => {
      const [key, name, fp, fi, fo, degree, community, label, rl, kind] =
        row as [
          string,
          string,
          string,
          number,
          number,
          number,
          number,
          string,
          string,
          string,
        ];
      return {
        key,
        name,
        file_path: fp,
        kind,
        fan_in: fi,
        fan_out: fo,
        degree,
        community,
        community_label: label,
        risk_level: rl,
      };
    });
  }

  /**
   * Get all communities with metadata.
   */
  async getAllCommunities(): Promise<
    Array<{
      id: number;
      label: string;
      size: number;
      cohesion: number;
    }>
  > {
    const result = await this.query(
      "?[id, label, size, cohesion] := *communities[id, label, size, cohesion] :order -size"
    );
    return result.rows.map((row) => {
      const [id, label, size, cohesion] = row as [
        number,
        string,
        number,
        number,
      ];
      return { id, label, size, cohesion };
    });
  }

  /**
   * Get all entities in a given file.
   */
  async getEntitiesByFile(filePath: string): Promise<LocalEntity[]> {
    const result = await this.query(
      `?[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, community] := *file_index[$fp, ek],
        *entities{key: ek, kind, name, file_path: fp, start_line: sl, end_line: el, signature: sig, body, fan_in: fi, fan_out: fo, risk_level: rl, community},
        k = ek`,
      { fp: filePath }
    );
    return result.rows.map((row) => {
      const [k, kind, name, fp, sl, el, sig, body, fi, fo, rl, community] =
        row as [
          string,
          string,
          string,
          string,
          number,
          number,
          string,
          string,
          number,
          number,
          string,
          number,
        ];
      return {
        key: k,
        kind,
        name,
        file_path: fp,
        start_line: sl,
        end_line: el,
        signature: sig,
        body,
        fan_in: fi,
        fan_out: fo,
        risk_level: rl,
        community,
      };
    });
  }

  /**
   * Find a single entity by exact name match (first match across all files).
   * Used by drift edge resolution (Task 6.4).
   */
  async findEntityByName(name: string): Promise<LocalEntity | null> {
    const result = await this.query(
      "?[k, kind, name, fp, sl, el, sig, body, fi, fo, rl, community] := *entities{key: k, kind, name, file_path: fp, start_line: sl, end_line: el, signature: sig, body, fan_in: fi, fan_out: fo, risk_level: rl, community}, name = $name :limit 1",
      { name }
    );
    if (result.rows.length === 0) return null;
    const [k, kind, n, fp, sl, el, sig, body, fi, fo, rl, community] = result
      .rows[0] as [
      string,
      string,
      string,
      string,
      number,
      number,
      string,
      string,
      number,
      number,
      string,
      number,
    ];
    return {
      key: k,
      kind,
      name: n,
      file_path: fp,
      start_line: sl,
      end_line: el,
      signature: sig,
      body,
      fan_in: fi,
      fan_out: fo,
      risk_level: rl,
      community,
    };
  }

  /**
   * Search entities by name query.
   */
  async searchEntities(
    query: string,
    limit = 20
  ): Promise<
    Array<{
      key: string;
      name: string;
      kind: string;
      file_path: string;
      score: number;
    }>
  > {
    return await searchLocal(this.db, query, limit);
  }

  /**
   * Get import edges for a file.
   */
  async getImports(
    filePath: string
  ): Promise<Array<{ imported_file: string }>> {
    // File-level import edges use "file:<path>" keys (created by local-indexer R.3).
    const fileKey = `file:${filePath}`;
    const result = await this.query(
      `?[to_key] := *edges{from_key: $fk, to_key, type: "imports"}`,
      { fk: fileKey }
    );
    return result.rows.map((row) => {
      const raw = row[0] as string;
      // Strip "file:" prefix from file-level keys
      const imported_file = raw.startsWith("file:") ? raw.slice(5) : raw;
      return { imported_file };
    });
  }

  /**
   * Bulk insert rules into CozoDB.
   */
  async loadRules(rules: CompactRule[]): Promise<void> {
    for (const rule of rules) {
      await this.write(
        `?[key, name, scope, severity, engine, query, message, file_glob, enabled, repo_id, status, target_kinds, ast_grep_fix, example, decay_score, evaluations, overrides] <- [[$key, $name, $scope, $severity, $engine, $query, $message, $fg, $enabled, $rid, $status, $tk, $agf, $ex, $ds, $evals, $ov]]
         :put rules { key => name, scope, severity, engine, query, message, file_glob, enabled, repo_id, status, target_kinds, ast_grep_fix, example, decay_score, evaluations, overrides }`,
        {
          key: rule.key,
          name: rule.name,
          scope: rule.scope,
          severity: rule.severity,
          engine: rule.engine,
          query: rule.query,
          message: rule.message,
          fg: rule.file_glob,
          enabled: rule.enabled,
          rid: rule.repo_id,
          status: rule.status ?? "active",
          tk: rule.target_kinds ?? "",
          agf: rule.ast_grep_fix ?? "",
          ex: rule.example ?? "",
          ds: rule.decay_score ?? 0.0,
          evals: rule.evaluations ?? 0,
          ov: rule.overrides ?? 0,
        }
      );
    }
  }

  /**
   * Bulk insert patterns into CozoDB.
   */
  async loadPatterns(patterns: CompactPattern[]): Promise<void> {
    for (const pattern of patterns) {
      await this.write(
        `?[key, name, kind, frequency, confidence, exemplar_keys, promoted_rule_key] <- [[$key, $name, $kind, $freq, $conf, $ek, $prk]]
         :put patterns { key => name, kind, frequency, confidence, exemplar_keys, promoted_rule_key }`,
        {
          key: pattern.key,
          name: pattern.name,
          kind: pattern.kind,
          freq: pattern.frequency,
          conf: pattern.confidence,
          ek: pattern.exemplar_keys.join(","),
          prk: pattern.promoted_rule_key,
        }
      );
    }
  }

  /**
   * Check if rules exist in the local store.
   */
  async hasRules(): Promise<boolean> {
    try {
      const result = await this.query(
        "?[key] := *rules[key, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _] :limit 1"
      );
      return result?.rows?.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get rules, optionally filtered by file path glob matching.
   * Returns rules sorted by scope priority (workspace > branch > path > repo > org).
   */
  async getRules(filePath?: string): Promise<CompactRule[]> {
    let result: { rows: unknown[][] };
    try {
      result = await this.query(
        "?[key, name, scope, severity, engine, query, message, fg, enabled, rid, status, tk, agf, ex, ds, evals, ov] := *rules[key, name, scope, severity, engine, query, message, fg, enabled, rid, status, tk, agf, ex, ds, evals, ov], enabled = true"
      );
    } catch {
      return [];
    }
    if (!result?.rows) return [];

    const rules: CompactRule[] = result.rows.map((row) => {
      const [
        key,
        name,
        scope,
        severity,
        engine,
        query,
        message,
        file_glob,
        enabled,
        repo_id,
        status,
        target_kinds,
        ast_grep_fix,
        example,
        decay_score,
        evaluations,
        overrides,
      ] = row as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        boolean,
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        number,
      ];
      return {
        key,
        name,
        scope,
        severity,
        engine,
        query,
        message,
        file_glob,
        enabled,
        repo_id,
        status,
        target_kinds,
        ast_grep_fix,
        example,
        decay_score,
        evaluations,
        overrides,
      };
    });

    // Filter by file path glob if provided
    if (filePath) {
      return rules.filter((rule) => {
        if (!rule.file_glob) return true;
        return matchGlob(filePath, rule.file_glob);
      });
    }

    // Sort by scope priority
    const scopePriority: Record<string, number> = {
      workspace: 5,
      branch: 4,
      path: 3,
      repo: 2,
      org: 1,
    };
    rules.sort(
      (a, b) => (scopePriority[b.scope] ?? 0) - (scopePriority[a.scope] ?? 0)
    );

    return rules;
  }

  /**
   * Sprint 9.9: Get rule health summary for status display.
   *
   * Categories based on decay_score:
   * - healthy: decay_score < 0.3 (or no score)
   * - aging: 0.3 <= decay_score < 0.6
   * - decayed: decay_score >= 0.6
   * - dormant: evaluations == 0
   */
  async getRuleHealthSummary(): Promise<{
    total: number;
    healthy: number;
    aging: number;
    decayed: number;
    dormant: number;
    warnings: Array<{
      key: string;
      name: string;
      decayScore: number;
      overrideRate: number;
    }>;
  }> {
    const rules = await this.getRules();
    let healthy = 0;
    let aging = 0;
    let decayed = 0;
    let dormant = 0;
    const warnings: Array<{
      key: string;
      name: string;
      decayScore: number;
      overrideRate: number;
    }> = [];

    for (const rule of rules) {
      const evals = rule.evaluations ?? 0;
      const overrides = rule.overrides ?? 0;
      const ds = rule.decay_score ?? 0;

      if (evals === 0) {
        dormant++;
      } else if (ds >= 0.6) {
        decayed++;
        const overrideRate =
          evals > 0 ? Math.round((overrides / evals) * 100) : 0;
        warnings.push({
          key: rule.key,
          name: rule.name,
          decayScore: ds,
          overrideRate,
        });
      } else if (ds >= 0.3) {
        aging++;
      } else {
        healthy++;
      }
    }

    // Sort warnings by decay score descending
    warnings.sort((a, b) => b.decayScore - a.decayScore);

    return {
      total: rules.length,
      healthy,
      aging,
      decayed,
      dormant,
      warnings: warnings.slice(0, 3),
    };
  }

  /**
   * Get all patterns.
   */
  async getPatterns(): Promise<CompactPattern[]> {
    const result = await this.query(
      "?[key, name, kind, freq, conf, ek, prk] := *patterns[key, name, kind, freq, conf, ek, prk]"
    );

    return result.rows.map((row) => {
      const [
        key,
        name,
        kind,
        frequency,
        confidence,
        exemplarKeysStr,
        promoted_rule_key,
      ] = row as [string, string, string, number, number, string, string];
      return {
        key,
        name,
        kind,
        frequency,
        confidence,
        exemplar_keys: exemplarKeysStr
          ? exemplarKeysStr.split(",").filter(Boolean)
          : [],
        promoted_rule_key,
      };
    });
  }

  /**
   * Health check — always up for local store.
   */
  healthCheck(): { status: "up"; latencyMs: number } {
    return { status: "up", latencyMs: 0 };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  // ── Justification Queries (MV-03) ──────────────────────────────

  /**
   * Bulk insert justifications into CozoDB.
   */
  async loadJustifications(
    justifications: CompactJustification[]
  ): Promise<void> {
    for (const j of justifications) {
      await this.write(
        `?[entity_key, purpose, taxonomy, feature_area, confidence] <-
          [[$ek, $purpose, $taxonomy, $fa, $conf]]
         :put justifications { entity_key => purpose, taxonomy, feature_area, confidence }`,
        {
          ek: j.entity_key,
          purpose: j.purpose,
          taxonomy: j.taxonomy,
          fa: j.feature_area,
          conf: j.confidence,
        }
      );
    }
  }

  /**
   * Get business context (justification) for an entity.
   */
  async getBusinessContext(entityKey: string): Promise<{
    purpose: string;
    taxonomy: string;
    feature_area: string;
    confidence: number;
    entity: LocalEntity | null;
  } | null> {
    const result = await this.query(
      `?[ek, purpose, taxonomy, fa, conf] :=
        *justifications[ek, purpose, taxonomy, fa, conf], ek = $ek`,
      { ek: entityKey }
    );
    if (result.rows.length === 0) return null;

    const [, purpose, taxonomy, feature_area, confidence] = result.rows[0] as [
      string,
      string,
      string,
      string,
      number,
    ];

    const entity = await this.getEntity(entityKey);

    return { purpose, taxonomy, feature_area, confidence, entity };
  }

  /**
   * Get conventions: patterns with adherence rates computed from entity coverage.
   */
  async getConventions(): Promise<
    Array<{
      name: string;
      kind: string;
      frequency: number;
      confidence: number;
      adherence_rate: number;
    }>
  > {
    const patterns = await this.getPatterns();
    if (patterns.length === 0) return [];

    // Per-kind entity counts for accurate adherence computation
    const kindResult = await this.query(
      "?[kind, count(key)] := *entities{key, kind}"
    );
    const kindCounts = new Map<string, number>();
    for (const row of kindResult.rows) {
      kindCounts.set(row[0] as string, row[1] as number);
    }

    return patterns.map((p) => {
      // Use the count of entities of the same kind for adherence
      const kindCount = Math.max(kindCounts.get(p.kind) ?? 1, 1);
      return {
        name: p.name,
        kind: p.kind,
        frequency: p.frequency,
        confidence: p.confidence,
        // Adherence = (frequency / kindCount) capped at 1.0
        adherence_rate: Math.min(1, p.frequency / kindCount),
      };
    });
  }

  /**
   * Get top N conventions applicable to a specific entity's file path.
   * Conventions are patterns + rules filtered by file_glob match,
   * sorted by confidence descending, limited to top N.
   */
  async getConventionsForEntity(
    entityFilePath: string,
    limit = 3
  ): Promise<
    Array<{
      id: string;
      name: string;
      adherence_pct: number;
      rule: string;
    }>
  > {
    // Get rules that apply to this file
    const rules = await this.getRules(entityFilePath);
    const conventions: Array<{
      id: string;
      name: string;
      adherence_pct: number;
      rule: string;
    }> = [];

    // Patterns as conventions (naming, structure)
    const patterns = await this.getPatterns();
    // Per-kind entity counts for accurate adherence
    const kindResult = await this.query(
      "?[kind, count(key)] := *entities{key, kind}"
    );
    const kindCounts = new Map<string, number>();
    for (const row of kindResult.rows) {
      kindCounts.set(row[0] as string, row[1] as number);
    }

    for (const p of patterns) {
      const kindCount = Math.max(kindCounts.get(p.kind) ?? 1, 1);
      conventions.push({
        id: `pattern:${p.key}`,
        name: p.name,
        adherence_pct: Math.round(Math.min(1, p.frequency / kindCount) * 100),
        rule: `${p.kind} pattern (${p.frequency} occurrences, ${Math.round(p.confidence * 100)}% confidence)`,
      });
    }

    // Rules as conventions (severity-based ordering)
    for (const r of rules) {
      conventions.push({
        id: `rule:${r.key}`,
        name: r.name,
        adherence_pct: 100, // Rules are prescriptive, not measured
        rule: r.message || `${r.severity} rule: ${r.name}`,
      });
    }

    // Sort by adherence_pct ascending (lowest adherence = most relevant to surface)
    // then take top N
    conventions.sort((a, b) => a.adherence_pct - b.adherence_pct);
    return conventions.slice(0, limit);
  }

  /**
   * Check if justifications exist in the local store.
   */
  async hasJustifications(): Promise<boolean> {
    const result = await this.query(
      "?[ek] := *justifications[ek, _, _, _, _] :limit 1"
    );
    return result.rows.length > 0;
  }

  // ── Rule Exceptions (Sprint 9.6) ────────────────────────────────

  /**
   * Bulk insert rule exceptions into CozoDB.
   */
  async loadRuleExceptions(exceptions: CompactRuleException[]): Promise<void> {
    for (const ex of exceptions) {
      await this.write(
        `?[key, entity_key, rule_key, reason, granted_by, granted_at, expires_at, status, jira_ticket] <- [[$key, $ek, $rk, $reason, $gb, $ga, $ea, $status, $jt]]
         :put rule_exceptions { key => entity_key, rule_key, reason, granted_by, granted_at, expires_at, status, jira_ticket }`,
        {
          key: ex.key,
          ek: ex.entity_key,
          rk: ex.rule_key,
          reason: ex.reason,
          gb: ex.granted_by,
          ga: ex.granted_at,
          ea: ex.expires_at,
          status: ex.status ?? "active",
          jt: ex.jira_ticket ?? "",
        }
      );
    }
  }

  /**
   * Get active rule exceptions for an entity, optionally filtered by rule key.
   * Returns only non-expired, active exceptions.
   */
  async getRuleExceptions(
    entityKey: string,
    ruleKey?: string
  ): Promise<CompactRuleException[]> {
    const result = await this.query(
      "?[key, ek, rk, reason, gb, ga, ea, status, jt] := *rule_exceptions[key, ek, rk, reason, gb, ga, ea, status, jt], ek = $ek, status = 'active'",
      { ek: entityKey }
    );

    const now = new Date().toISOString();
    const exceptions: CompactRuleException[] = result.rows
      .map((row) => {
        const [
          key,
          entity_key,
          rule_key,
          reason,
          granted_by,
          granted_at,
          expires_at,
          status,
          jira_ticket,
        ] = row as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        return {
          key,
          entity_key,
          rule_key,
          reason,
          granted_by,
          granted_at,
          expires_at,
          status,
          jira_ticket,
        };
      })
      .filter((ex) => !ex.expires_at || ex.expires_at > now);

    if (ruleKey) {
      return exceptions.filter((ex) => ex.rule_key === ruleKey);
    }
    return exceptions;
  }

  /**
   * Get all rule exceptions that are expiring within the given window (milliseconds).
   * Used by _meta to surface "exception expiring soon" warnings.
   */
  async getExpiringExceptions(
    windowMs: number
  ): Promise<CompactRuleException[]> {
    const result = await this.query(
      "?[key, ek, rk, reason, gb, ga, ea, status, jt] := *rule_exceptions[key, ek, rk, reason, gb, ga, ea, status, jt], status = 'active'"
    );

    const now = Date.now();
    const threshold = new Date(now + windowMs).toISOString();
    const nowIso = new Date(now).toISOString();

    return result.rows
      .map((row) => {
        const [
          key,
          entity_key,
          rule_key,
          reason,
          granted_by,
          granted_at,
          expires_at,
          status,
          jira_ticket,
        ] = row as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        return {
          key,
          entity_key,
          rule_key,
          reason,
          granted_by,
          granted_at,
          expires_at,
          status,
          jira_ticket,
        };
      })
      .filter(
        (ex) =>
          ex.expires_at && ex.expires_at > nowIso && ex.expires_at <= threshold
      );
  }

  // ── Drift Overlay CRUD ──────────────────────────────────────────

  /**
   * Insert or update an entity in the drift overlay.
   */
  async upsertDriftEntity(entity: DriftEntity): Promise<void> {
    await this.write(
      `?[key, name, kind, signature, body, file_path, line_start, line_end, content_hash, drift_status, intent_id, modified_at, origin, previous_body, previous_signature] <-
        [[$key, $name, $kind, $sig, $body, $fp, $ls, $le, $ch, $ds, $iid, $ma, $origin, $pb, $ps]]
       :put drift_overlay { key => name, kind, signature, body, file_path, line_start, line_end, content_hash, drift_status, intent_id, modified_at, origin, previous_body, previous_signature }`,
      {
        key: entity.key,
        name: entity.name,
        kind: entity.kind,
        sig: entity.signature,
        body: entity.body,
        fp: entity.file_path,
        ls: entity.line_start,
        le: entity.line_end,
        ch: entity.content_hash,
        ds: entity.drift_status,
        iid: entity.intent_id,
        ma: entity.modified_at,
        origin: entity.origin,
        pb: entity.previous_body,
        ps: entity.previous_signature,
      }
    );
  }

  /**
   * Remove an entity from the drift overlay.
   */
  async removeDriftEntity(key: string): Promise<void> {
    await this.write("?[key] <- [[$key]] :rm drift_overlay { key }", { key });
  }

  /**
   * Get all drift overlay entities for a given file path.
   */
  async getDriftEntitiesForFile(filePath: string): Promise<DriftEntity[]> {
    const result = await this.query(
      `?[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps] :=
        *drift_overlay[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps],
        fp = $fp`,
      { fp: filePath }
    );
    return result.rows.map((row) => {
      const [
        key,
        name,
        kind,
        signature,
        body,
        file_path,
        line_start,
        line_end,
        content_hash,
        drift_status,
        intent_id,
        modified_at,
        origin,
        previous_body,
        previous_signature,
      ] = row as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      return {
        key,
        name,
        kind,
        signature,
        body,
        file_path,
        line_start,
        line_end,
        content_hash,
        drift_status: drift_status as DriftEntity["drift_status"],
        intent_id,
        modified_at,
        origin: origin as DriftEntity["origin"],
        previous_body,
        previous_signature,
      };
    });
  }

  /**
   * Get a single drift entity by key.
   */
  async getDriftEntity(key: string): Promise<DriftEntity | null> {
    const result = await this.query(
      `?[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps] :=
        *drift_overlay[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps],
        key = $key`,
      { key }
    );
    if (result.rows.length === 0) return null;
    const [
      k,
      name,
      kind,
      signature,
      body,
      file_path,
      line_start,
      line_end,
      content_hash,
      drift_status,
      intent_id,
      modified_at,
      origin,
      previous_body,
      previous_signature,
    ] = result.rows[0] as [
      string,
      string,
      string,
      string,
      string,
      string,
      number,
      number,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      key: k,
      name,
      kind,
      signature,
      body,
      file_path,
      line_start,
      line_end,
      content_hash,
      drift_status: drift_status as DriftEntity["drift_status"],
      intent_id,
      modified_at,
      origin: origin as DriftEntity["origin"],
      previous_body,
      previous_signature,
    };
  }

  /**
   * Get all drift overlay entities (for stash snapshot serialization).
   */
  async getAllDriftEntities(): Promise<DriftEntity[]> {
    const result = await this.query(
      `?[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps] :=
        *drift_overlay[key, name, kind, sig, body, fp, ls, le, ch, ds, iid, ma, origin, pb, ps]`
    );
    return result.rows.map((row) => {
      const [
        key,
        name,
        kind,
        signature,
        body,
        file_path,
        line_start,
        line_end,
        content_hash,
        drift_status,
        intent_id,
        modified_at,
        origin,
        previous_body,
        previous_signature,
      ] = row as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      return {
        key,
        name,
        kind,
        signature,
        body,
        file_path,
        line_start,
        line_end,
        content_hash,
        drift_status: drift_status as DriftEntity["drift_status"],
        intent_id,
        modified_at,
        origin: origin as DriftEntity["origin"],
        previous_body,
        previous_signature,
      };
    });
  }

  /**
   * Clear all drift overlay entries (branch switch, graph re-pull).
   */
  async clearDriftOverlay(): Promise<void> {
    // Get all keys, then remove them
    const result = await this.write(
      "?[key] := *drift_overlay[key, _, _, _, _, _, _, _, _, _, _, _, _, _, _]"
    );
    for (const row of result.rows) {
      const [key] = row as [string];
      await this.write("?[key] <- [[$key]] :rm drift_overlay { key }", {
        key,
      });
    }
    // Also clear drift edges (same lifecycle — Task 6.4)
    await this.clearDriftEdges();
  }

  // ── Sprint 6.4: Drift Edges CRUD ───────────────────────────────────

  /**
   * Insert or update an edge in the drift_edges overlay.
   */
  async upsertDriftEdge(edge: DriftEdge): Promise<void> {
    await this.write(
      `?[from_key, to_key, type, drift_status, modified_at] <-
        [[$fk, $tk, $type, $ds, $ma]]
       :put drift_edges { from_key, to_key, type => drift_status, modified_at }`,
      {
        fk: edge.from_key,
        tk: edge.to_key,
        type: edge.type,
        ds: edge.drift_status,
        ma: edge.modified_at,
      }
    );
  }

  /**
   * Remove an edge from the drift_edges overlay.
   */
  async removeDriftEdge(
    fromKey: string,
    toKey: string,
    type: string
  ): Promise<void> {
    await this.write(
      "?[from_key, to_key, type] <- [[$fk, $tk, $type]] :rm drift_edges { from_key, to_key, type }",
      { fk: fromKey, tk: toKey, type }
    );
  }

  /**
   * Get all drift edges (for snapshot serialization).
   */
  async getAllDriftEdges(): Promise<DriftEdge[]> {
    const result = await this.query(
      "?[fk, tk, type, ds, ma] := *drift_edges[fk, tk, type, ds, ma]"
    );
    return result.rows.map((row) => {
      const [from_key, to_key, type, drift_status, modified_at] = row as [
        string,
        string,
        string,
        string,
        string,
      ];
      return {
        from_key,
        to_key,
        type,
        drift_status: drift_status as DriftEdge["drift_status"],
        modified_at,
      };
    });
  }

  /**
   * Clear all drift edges (branch switch, graph re-pull).
   */
  async clearDriftEdges(): Promise<void> {
    const result = await this.write(
      "?[fk, tk, type] := *drift_edges[fk, tk, type, _, _]"
    );
    for (const row of result.rows) {
      const [fk, tk, type] = row as [string, string, string];
      await this.write(
        "?[from_key, to_key, type] <- [[$fk, $tk, $type]] :rm drift_edges { from_key, to_key, type }",
        { fk, tk, type }
      );
    }
  }

  // ── Sprint E-8: Delta Application (P5-EVO-19) ─────────────────────

  /**
   * Apply an incremental delta from the server to the local CozoDB graph.
   * Called when a delta message is received via Redis pub/sub.
   *
   * Operations:
   *   1. Upsert added/updated entities into :entities + :file_index
   *   2. Remove deleted entity keys from :entities + :file_index
   *   3. Upsert added edges into :edges, remove old edges for changed entities
   *   4. Upsert updated justifications into :justifications
   *   5. Rebuild search tokens for affected entities (incremental)
   */
  async applyDelta(delta: {
    entities: {
      added: Array<{
        key: string;
        kind: string;
        name: string;
        file_path: string;
        start_line?: number;
        signature?: string;
        body?: string;
        fan_in?: number;
        fan_out?: number;
        risk_level?: string;
      }>;
      updated: Array<{
        key: string;
        kind: string;
        name: string;
        file_path: string;
        start_line?: number;
        signature?: string;
        body?: string;
        fan_in?: number;
        fan_out?: number;
        risk_level?: string;
      }>;
      deletedKeys: string[];
    };
    edges: {
      added: Array<{ from_key: string; to_key: string; type: string }>;
      removed: Array<{ from_key: string; to_key: string; type: string }>;
    };
    justifications: {
      updated: Array<{
        entity_key: string;
        purpose: string;
        taxonomy: string;
        feature_area: string;
        confidence: number;
      }>;
    };
  }): Promise<{
    applied: number;
    deleted: number;
    edges: number;
    justifications: number;
    /** Task 6.9: Overlay entries pruned because base now matches local */
    overlayExpired: number;
  }> {
    let applied = 0;
    let deleted = 0;
    let edgeCount = 0;
    let justCount = 0;

    // 1. Upsert added + updated entities
    const allEntities = [...delta.entities.added, ...delta.entities.updated];
    for (const entity of allEntities) {
      await this.write(
        `?[key, kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level] <- [[$key, $kind, $name, $fp, $sl, $el, $sig, $body, $fi, $fo, $rl]]
         :put entities { key => kind, name, file_path, start_line, end_line, signature, body, fan_in, fan_out, risk_level }`,
        {
          key: entity.key,
          kind: entity.kind,
          name: entity.name,
          fp: entity.file_path,
          sl: entity.start_line ?? 0,
          el: (entity as any).end_line ?? 0,
          sig: entity.signature ?? "",
          body: entity.body ?? "",
          fi: entity.fan_in ?? 0,
          fo: entity.fan_out ?? 0,
          rl: entity.risk_level ?? "normal",
        }
      );

      // Update file index
      await this.write(
        "?[file_path, entity_key] <- [[$fp, $key]] :put file_index { file_path, entity_key }",
        { fp: entity.file_path, key: entity.key }
      );

      applied++;
    }

    // 2. Delete removed entities
    for (const key of delta.entities.deletedKeys) {
      try {
        await this.write("?[key] <- [[$key]] :rm entities { key }", { key });
        // Clean up file_index entries for this entity
        await this.write(
          "?[fp, ek] := *file_index[fp, ek], ek = $key :rm file_index { file_path: fp, entity_key: ek }",
          { key }
        );
        deleted++;
      } catch {
        // Entity may not exist locally — that's fine
      }
    }

    // 3. Remove old edges for changed entities, then insert new edges
    for (const edge of delta.edges.removed) {
      try {
        await this.write(
          "?[from_key, to_key, type] <- [[$from, $to, $type]] :rm edges { from_key, to_key, type }",
          { from: edge.from_key, to: edge.to_key, type: edge.type }
        );
      } catch {
        // Edge may not exist
      }
    }

    for (const edge of delta.edges.added) {
      await this.write(
        "?[from_key, to_key, type] <- [[$from, $to, $type]] :put edges { from_key, to_key, type }",
        { from: edge.from_key, to: edge.to_key, type: edge.type }
      );
      edgeCount++;
    }

    // 4. Upsert justifications
    for (const j of delta.justifications.updated) {
      await this.write(
        `?[entity_key, purpose, taxonomy, feature_area, confidence] <-
          [[$ek, $purpose, $taxonomy, $fa, $conf]]
         :put justifications { entity_key => purpose, taxonomy, feature_area, confidence }`,
        {
          ek: j.entity_key,
          purpose: j.purpose,
          taxonomy: j.taxonomy,
          fa: j.feature_area,
          conf: j.confidence,
        }
      );
      justCount++;
    }

    // 5. Rebuild search tokens for affected entities (incremental)
    const affectedKeys = new Set([
      ...allEntities.map((e) => e.key),
      ...delta.entities.deletedKeys,
    ]);

    // Remove old search tokens for affected entities
    for (const key of affectedKeys) {
      try {
        await this.write(
          "?[token, ek] := *search_tokens[token, ek], ek = $key :rm search_tokens { token, entity_key: ek }",
          { key }
        );
      } catch {
        // May not exist
      }
    }

    // Insert new search tokens for added/updated entities
    for (const entity of allEntities) {
      const tokens = tokenize(entity.name);
      for (const token of tokens) {
        await this.write(
          "?[token, entity_key] <- [[$token, $key]] :put search_tokens { token, entity_key }",
          { token, key: entity.key }
        );
      }
    }

    // 6. Task 6.9: Prune stale overlay entries — base now matches local after delta
    let expired = 0;
    const overlayEntities = await this.getAllDriftEntities();
    for (const overlay of overlayEntities) {
      // Only prune modified entries (added/deleted have different semantics)
      if (overlay.drift_status !== "modified") continue;
      const base = await this.getEntity(overlay.key);
      if (
        base &&
        base.body === overlay.body &&
        base.signature === overlay.signature
      ) {
        await this.removeDriftEntity(overlay.key);
        expired++;
      }
    }

    return {
      applied,
      deleted,
      edges: edgeCount,
      justifications: justCount,
      overlayExpired: expired,
    };
  }

  /**
   * Get aggregate counts of drift overlay entries by status.
   */
  async getDriftSummary(): Promise<DriftSummary> {
    const result = await this.query(
      "?[ds, count(key)] := *drift_overlay[key, _, _, _, _, _, _, _, _, ds, _, _, _, _, _]"
    );
    const summary: DriftSummary = {
      added: 0,
      modified: 0,
      deleted: 0,
      dependency_changed: 0,
      total: 0,
    };
    for (const row of result.rows) {
      const [status, count] = row as [string, number];
      if (status === "added") summary.added = count;
      else if (status === "modified") summary.modified = count;
      else if (status === "deleted") summary.deleted = count;
      else if (status === "dependency_changed")
        summary.dependency_changed = count;
    }
    summary.total =
      summary.added +
      summary.modified +
      summary.deleted +
      summary.dependency_changed;
    return summary;
  }

  // ── Sprint 11: Phase 22 Blueprint Deep Dive Methods ──────────────

  /**
   * Load blueprint project data into CozoDB (from Butter-Sync or snapshot).
   */
  async loadDeepDiveProject(project: DeepDiveProject): Promise<void> {
    await this.write(
      `?[key, name, description, status, domain, stage, stack_recommendation, design_system, health_baseline, org_id, updated_at] <-
        [[$key, $name, $description, $status, $domain, $stage, $stack_recommendation, $design_system, $health_baseline, $org_id, $updated_at]]
      :put deep_dive_projects { key => name, description, status, domain, stage, stack_recommendation, design_system, health_baseline, org_id, updated_at }`,
      {
        key: project.key,
        name: project.name,
        description: project.description,
        status: project.status,
        domain: JSON.stringify(project.domain ?? {}),
        stage: JSON.stringify(project.stage ?? {}),
        stack_recommendation: JSON.stringify(project.stackRecommendation ?? {}),
        design_system: JSON.stringify(project.designSystem ?? ""),
        health_baseline: JSON.stringify(project.healthBaseline ?? {}),
        org_id: project.orgId ?? "",
        updated_at: project.updatedAt ?? new Date().toISOString(),
      }
    );
  }

  /**
   * Load blueprint slices for a project.
   */
  async loadDeepDiveSlices(slices: DeepDiveSlice[]): Promise<void> {
    for (const s of slices) {
      await this.write(
        `?[key, project_key, name, description, repo_target_id, parent_slice_key, dependencies, status, order, slice_type, data_model, api_surface, conventions, boundary_rules, user_flows, ui_design] <-
          [[$key, $project_key, $name, $description, $repo_target_id, $parent_slice_key, $dependencies, $status, $order, $slice_type, $data_model, $api_surface, $conventions, $boundary_rules, $user_flows, $ui_design]]
        :put deep_dive_slices { key => project_key, name, description, repo_target_id, parent_slice_key, dependencies, status, order, slice_type, data_model, api_surface, conventions, boundary_rules, user_flows, ui_design }`,
        {
          key: s.key,
          project_key: s.projectKey,
          name: s.name,
          description: s.description ?? "",
          repo_target_id: s.repoTargetId ?? "",
          parent_slice_key: s.parentSliceKey ?? "",
          dependencies: JSON.stringify(s.dependencies ?? []),
          status: s.status ?? "planned",
          order: s.order ?? 0,
          slice_type: s.sliceType ?? "",
          data_model: JSON.stringify(s.dataModel ?? ""),
          api_surface: JSON.stringify(s.apiSurface ?? ""),
          conventions: JSON.stringify(s.conventions ?? []),
          boundary_rules: JSON.stringify(s.boundaryRules ?? []),
          user_flows: JSON.stringify(s.userFlows ?? ""),
          ui_design: JSON.stringify(s.uiDesign ?? ""),
        }
      );
    }
  }

  /**
   * Load blueprint tasks for a project.
   */
  async loadDeepDiveTasks(tasks: DeepDiveTask[]): Promise<void> {
    for (const t of tasks) {
      await this.write(
        `?[key, project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint] <-
          [[$key, $project_key, $sprint_number, $slice_name, $description, $status, $estimated_effort, $dependencies, $boundary_rules, $conventions, $acceptance_criteria, $completed_at, $completed_files, $checkpoint]]
        :put deep_dive_tasks { key => project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint }`,
        {
          key: t.key,
          project_key: t.projectKey,
          sprint_number: t.sprintNumber,
          slice_name: t.sliceName ?? "",
          description: t.description ?? "",
          status: t.status ?? "pending",
          estimated_effort: t.estimatedEffort ?? "",
          dependencies: JSON.stringify(t.dependencies ?? []),
          boundary_rules: JSON.stringify(t.boundaryRules ?? []),
          conventions: JSON.stringify(t.conventions ?? []),
          acceptance_criteria: JSON.stringify(t.acceptanceCriteria ?? []),
          completed_at: t.completedAt ?? "",
          completed_files: JSON.stringify(t.completedFiles ?? []),
          checkpoint: JSON.stringify(t.checkpoint ?? {}),
        }
      );
    }
  }

  /**
   * Load design system tokens for a project.
   */
  async loadDeepDiveDesignSystem(
    projectKey: string,
    tokens: unknown
  ): Promise<void> {
    await this.write(
      `?[project_key, tokens, updated_at] <-
        [[$project_key, $tokens, $updated_at]]
      :put deep_dive_design_system { project_key => tokens, updated_at }`,
      {
        project_key: projectKey,
        tokens: JSON.stringify(tokens ?? {}),
        updated_at: new Date().toISOString(),
      }
    );
  }

  /**
   * Get a blueprint project by key.
   */
  async getDeepDiveProject(key: string): Promise<DeepDiveProjectRow | null> {
    const result = await this.query(
      `?[key, name, description, status, domain, stage, stack_recommendation, design_system, health_baseline, org_id, updated_at] :=
        *deep_dive_projects[key, name, description, status, domain, stage, stack_recommendation, design_system, health_baseline, org_id, updated_at],
        key = $key`,
      { key }
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      key: row[0],
      name: row[1],
      description: row[2],
      status: row[3],
      domain: JSON.parse(row[4] || "{}"),
      stage: JSON.parse(row[5] || "{}"),
      stackRecommendation: JSON.parse(row[6] || "{}"),
      designSystem: row[7] ? JSON.parse(row[7]) : null,
      healthBaseline: JSON.parse(row[8] || "{}"),
      orgId: row[9],
      updatedAt: row[10],
    };
  }

  /**
   * Get the first active project (most recently updated).
   */
  async getActiveDeepDiveProject(): Promise<DeepDiveProjectRow | null> {
    const result = await this.query(
      `?[key, name, description, status, domain, stage, stack_recommendation, design_system, health_baseline, org_id, updated_at] :=
        *deep_dive_projects[key, name, description, status, domain, stage, stack_recommendation, design_system, health_baseline, org_id, updated_at],
        status != "draft"
      :sort -updated_at
      :limit 1`
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      key: row[0],
      name: row[1],
      description: row[2],
      status: row[3],
      domain: JSON.parse(row[4] || "{}"),
      stage: JSON.parse(row[5] || "{}"),
      stackRecommendation: JSON.parse(row[6] || "{}"),
      designSystem: row[7] ? JSON.parse(row[7]) : null,
      healthBaseline: JSON.parse(row[8] || "{}"),
      orgId: row[9],
      updatedAt: row[10],
    };
  }

  /**
   * Get all slices for a project, ordered by their order field.
   */
  async getDeepDiveSlices(projectKey: string): Promise<DeepDiveSliceRow[]> {
    const result = await this.query(
      `?[key, project_key, name, description, repo_target_id, parent_slice_key, dependencies, status, order, slice_type, data_model, api_surface, conventions, boundary_rules, user_flows, ui_design] :=
        *deep_dive_slices[key, project_key, name, description, repo_target_id, parent_slice_key, dependencies, status, order, slice_type, data_model, api_surface, conventions, boundary_rules, user_flows, ui_design],
        project_key = $project_key
      :sort order`,
      { project_key: projectKey }
    );
    return result.rows.map((row) => {
      const [
        key,
        ,
        name,
        description,
        repoTargetId,
        parentSliceKey,
        deps,
        status,
        order,
        sliceType,
        dataModel,
        apiSurface,
        conventions,
        boundaryRules,
        userFlows,
        uiDesign,
      ] = row as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      return {
        key,
        name,
        description,
        repoTargetId,
        parentSliceKey,
        dependencies: JSON.parse(deps || "[]"),
        status,
        order,
        sliceType,
        dataModel: dataModel ? JSON.parse(dataModel) : null,
        apiSurface: apiSurface ? JSON.parse(apiSurface) : null,
        conventions: JSON.parse(conventions || "[]"),
        boundaryRules: JSON.parse(boundaryRules || "[]"),
        userFlows: userFlows ? JSON.parse(userFlows) : null,
        uiDesign: uiDesign ? JSON.parse(uiDesign) : null,
      };
    });
  }

  /**
   * Get a single slice by key.
   */
  async getDeepDiveSlice(key: string): Promise<DeepDiveSliceRow | null> {
    const result = await this.query(
      `?[key, project_key, name, description, repo_target_id, parent_slice_key, dependencies, status, order, slice_type, data_model, api_surface, conventions, boundary_rules, user_flows, ui_design] :=
        *deep_dive_slices[key, project_key, name, description, repo_target_id, parent_slice_key, dependencies, status, order, slice_type, data_model, api_surface, conventions, boundary_rules, user_flows, ui_design],
        key = $key`,
      { key }
    );
    if (result.rows.length === 0) return null;
    const [
      k,
      ,
      name,
      description,
      repoTargetId,
      parentSliceKey,
      deps,
      status,
      order,
      sliceType,
      dataModel,
      apiSurface,
      conventions,
      boundaryRules,
      userFlows,
      uiDesign,
    ] = result.rows[0] as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      number,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      key: k,
      name,
      description,
      repoTargetId,
      parentSliceKey,
      dependencies: JSON.parse(deps || "[]"),
      status,
      order,
      sliceType,
      dataModel: dataModel ? JSON.parse(dataModel) : null,
      apiSurface: apiSurface ? JSON.parse(apiSurface) : null,
      conventions: JSON.parse(conventions || "[]"),
      boundaryRules: JSON.parse(boundaryRules || "[]"),
      userFlows: userFlows ? JSON.parse(userFlows) : null,
      uiDesign: uiDesign ? JSON.parse(uiDesign) : null,
    };
  }

  /**
   * Get all tasks for a project, optionally filtered by sprint number.
   */
  async getDeepDiveTasks(
    projectKey: string,
    sprintNumber?: number
  ): Promise<DeepDiveTaskRow[]> {
    const query =
      sprintNumber != null
        ? `?[key, project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint] :=
          *deep_dive_tasks[key, project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint],
          project_key = $project_key, sprint_number = $sprint_number
        :sort key`
        : `?[key, project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint] :=
          *deep_dive_tasks[key, project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint],
          project_key = $project_key
        :sort sprint_number, key`;
    const params: Record<string, unknown> = { project_key: projectKey };
    if (sprintNumber != null) params.sprint_number = sprintNumber;
    const result = await this.query(query, params);
    return result.rows.map((row) => {
      const [
        key,
        ,
        sprintNum,
        sliceName,
        description,
        status,
        estimatedEffort,
        deps,
        bRules,
        convs,
        criteria,
        completedAt,
        completedFiles,
        checkpoint,
      ] = row as [
        string,
        string,
        number,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      return {
        key,
        sprintNumber: sprintNum,
        sliceName,
        description,
        status,
        estimatedEffort,
        dependencies: JSON.parse(deps || "[]"),
        boundaryRules: JSON.parse(bRules || "[]"),
        conventions: JSON.parse(convs || "[]"),
        acceptanceCriteria: JSON.parse(criteria || "[]"),
        completedAt,
        completedFiles: JSON.parse(completedFiles || "[]"),
        checkpoint: JSON.parse(checkpoint || "{}"),
      };
    });
  }

  /**
   * Mark a task as complete in the local graph.
   */
  async completeDeepDiveTask(
    taskKey: string,
    completedFiles?: string[]
  ): Promise<boolean> {
    const result = await this.query(
      `?[key, project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint] :=
        *deep_dive_tasks[key, project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint],
        key = $key`,
      { key: taskKey }
    );
    if (result.rows.length === 0) return false;
    const row = result.rows[0] as string[];
    await this.write(
      `?[key, project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint] <-
        [[$key, $project_key, $sprint_number, $slice_name, $description, "complete", $estimated_effort, $dependencies, $boundary_rules, $conventions, $acceptance_criteria, $completed_at, $completed_files, $checkpoint]]
      :put deep_dive_tasks { key => project_key, sprint_number, slice_name, description, status, estimated_effort, dependencies, boundary_rules, conventions, acceptance_criteria, completed_at, completed_files, checkpoint }`,
      {
        key: taskKey,
        project_key: row[1],
        sprint_number: row[2],
        slice_name: row[3],
        description: row[4],
        estimated_effort: row[6],
        dependencies: row[7],
        boundary_rules: row[8],
        conventions: row[9],
        acceptance_criteria: row[10],
        completed_at: new Date().toISOString(),
        completed_files: JSON.stringify(completedFiles ?? []),
        checkpoint: row[13],
      }
    );
    return true;
  }

  /**
   * Get design system tokens for a project.
   */
  async getDeepDiveDesignSystem(projectKey: string): Promise<unknown | null> {
    const result = await this.query(
      `?[project_key, tokens, updated_at] :=
        *deep_dive_design_system[project_key, tokens, updated_at],
        project_key = $project_key`,
      { project_key: projectKey }
    );
    if (result.rows.length === 0) return null;
    const [, tokens] = result.rows[0] as [string, string, string];
    return JSON.parse(tokens || "{}");
  }

  /**
   * Check if any deep dive project exists (for dynamic tool loading).
   */
  async hasDeepDiveProject(): Promise<boolean> {
    const result = await this.query(
      "?[key] := *deep_dive_projects[key, _, _, _, _, _, _, _, _, _, _] :limit 1"
    );
    return result.rows.length > 0;
  }

  /**
   * Get deep dive project state for dynamic tool loading.
   * Returns: "none" | "pre_approval" | "approved" | "building"
   */
  async getDeepDiveProjectState(): Promise<
    "none" | "pre_approval" | "approved" | "building"
  > {
    const project = await this.getActiveDeepDiveProject();
    if (!project) return "none";
    if (project.status === "building") return "building";
    if (project.status === "approved") return "approved";
    return "pre_approval";
  }

  // ── Leapfrog Sprint B: Correction Intelligence ─────────────────

  /**
   * Persist correction patterns from the detector into the CozoDB corrections relation.
   * Uses :put for upsert behavior — re-running the detector updates existing patterns
   * with higher occurrences and latest timestamps.
   */
  async persistCorrections(
    patterns: Array<{
      entity_key: string;
      error_type: string;
      correction_summary: string;
      confidence: number;
      occurrences: number;
      last_seen: string;
    }>
  ): Promise<void> {
    for (const p of patterns) {
      // Check if existing pattern exists to merge occurrences
      const existing = await this.query(
        `?[entity_key, error_type, correction_summary, confidence, occurrences, last_seen] :=
          *corrections{entity_key: $ek, error_type: $et, correction_summary, confidence, occurrences, last_seen}`,
        { ek: p.entity_key, et: p.error_type }
      );
      const prevOcc =
        existing.rows.length > 0 ? (existing.rows[0]?.[4] as number) : 0;
      const prevConf =
        existing.rows.length > 0 ? (existing.rows[0]?.[3] as number) : 0;

      await this.write(
        `?[entity_key, error_type, correction_summary, confidence, occurrences, last_seen] <-
          [[$ek, $et, $cs, $conf, $occ, $ls]]
        :put corrections {
          entity_key, error_type
          =>
          correction_summary, confidence, occurrences, last_seen
        }`,
        {
          ek: p.entity_key,
          et: p.error_type,
          cs: p.correction_summary,
          conf: Math.max(p.confidence, prevConf),
          occ: prevOcc + p.occurrences,
          ls: p.last_seen,
        }
      );
    }
  }

  /**
   * Get corrections for a specific entity, filtered by minimum confidence.
   * Returns results sorted by confidence descending. <1ms (indexed query).
   */
  async getCorrections(
    entityKey: string,
    minConfidence = 0.7
  ): Promise<
    Array<{
      entity_key: string;
      error_type: string;
      correction_summary: string;
      confidence: number;
      occurrences: number;
      last_seen: string;
    }>
  > {
    const result = await this.query(
      `?[entity_key, error_type, correction_summary, confidence, occurrences, last_seen] :=
        *corrections{entity_key, error_type, correction_summary, confidence, occurrences, last_seen},
        entity_key = $ek,
        confidence >= $min_conf
      :order -confidence`,
      { ek: entityKey, min_conf: minConfidence }
    );

    return result.rows.map((row) => ({
      entity_key: row[0] as string,
      error_type: row[1] as string,
      correction_summary: row[2] as string,
      confidence: row[3] as number,
      occurrences: row[4] as number,
      last_seen: row[5] as string,
    }));
  }

  /**
   * Get all corrections above a confidence threshold.
   */
  async getAllCorrections(minConfidence = 0.7): Promise<
    Array<{
      entity_key: string;
      error_type: string;
      correction_summary: string;
      confidence: number;
      occurrences: number;
      last_seen: string;
    }>
  > {
    const result = await this.query(
      `?[entity_key, error_type, correction_summary, confidence, occurrences, last_seen] :=
        *corrections{entity_key, error_type, correction_summary, confidence, occurrences, last_seen},
        confidence >= $min_conf
      :order -confidence`,
      { min_conf: minConfidence }
    );

    return result.rows.map((row) => ({
      entity_key: row[0] as string,
      error_type: row[1] as string,
      correction_summary: row[2] as string,
      confidence: row[3] as number,
      occurrences: row[4] as number,
      last_seen: row[5] as string,
    }));
  }

  /**
   * Local get_project_stats — pure CozoDB Datalog aggregation.
   * Returns entity/edge/file/rule/drift counts and breakdown by kind.
   * Target: <10ms.
   */
  async getLocalProjectStats(): Promise<{
    entityCount: number;
    edgeCount: number;
    fileCount: number;
    ruleCount: number;
    driftCount: number;
    communityCount: number;
    correctionCount: number;
    entityByKind: Record<string, number>;
    edgeByType: Record<string, number>;
    languageBreakdown: Record<string, number>;
    topFiles: Array<{ filePath: string; entityCount: number }>;
  }> {
    const entityCount =
      ((await this.query("?[count(key)] := *entities{key}"))
        .rows[0]?.[0] as number) ?? 0;

    const edgeCount =
      ((await this.query("?[count(from_key)] := *edges{from_key}"))
        .rows[0]?.[0] as number) ?? 0;

    const fileCount =
      ((
        await this.query(
          "?[count_unique(file_path)] := *entities{key, file_path}"
        )
      ).rows[0]?.[0] as number) ?? 0;

    const ruleCount =
      ((
        await this.query(
          "?[count(key)] := *rules{key, enabled}, enabled = true"
        )
      ).rows[0]?.[0] as number) ?? 0;

    const driftCount =
      ((await this.query("?[count(key)] := *drift_overlay{key}"))
        .rows[0]?.[0] as number) ?? 0;

    const communityCount =
      ((await this.query("?[count(id)] := *communities{id}"))
        .rows[0]?.[0] as number) ?? 0;

    const correctionCount =
      ((await this.query("?[count(entity_key)] := *corrections{entity_key}"))
        .rows[0]?.[0] as number) ?? 0;

    // Entity breakdown by kind
    const entityByKind: Record<string, number> = {};
    const kindRows = (
      await this.query("?[kind, count(key)] := *entities{key, kind}")
    ).rows;
    for (const row of kindRows) {
      entityByKind[row[0] as string] = row[1] as number;
    }

    // Edge breakdown by type
    const edgeByType: Record<string, number> = {};
    const typeRows = (
      await this.query("?[type, count(from_key)] := *edges{from_key, type}")
    ).rows;
    for (const row of typeRows) {
      edgeByType[row[0] as string] = row[1] as number;
    }

    // Top 10 files by entity count
    const topFileRows = (
      await this.query(
        "?[file_path, count(entity_key)] := *file_index{file_path, entity_key} :order -count(entity_key) :limit 10"
      )
    ).rows;
    const topFiles = topFileRows.map((row) => ({
      filePath: row[0] as string,
      entityCount: row[1] as number,
    }));

    // Language breakdown — aggregate unique file paths by extension.
    // CozoDB Datalog has no string-split, so we post-process in JS.
    const languageBreakdown: Record<string, number> = {};
    const filePathRows = (
      await this.query("?[file_path] := *file_index{file_path, entity_key}")
    ).rows;
    const seenPaths = new Set<string>();
    for (const row of filePathRows) {
      const filePath = row[0] as string;
      if (seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);
      const lastDot = filePath.lastIndexOf(".");
      const lastSlash = Math.max(
        filePath.lastIndexOf("/"),
        filePath.lastIndexOf("\\")
      );
      const ext =
        lastDot > lastSlash && lastDot >= 0
          ? filePath.slice(lastDot + 1).toLowerCase()
          : "other";
      languageBreakdown[ext] = (languageBreakdown[ext] ?? 0) + 1;
    }

    return {
      entityCount,
      edgeCount,
      fileCount,
      ruleCount,
      driftCount,
      communityCount,
      correctionCount,
      entityByKind,
      edgeByType,
      languageBreakdown,
      topFiles,
    };
  }

  /**
   * Remove corrections not seen in the last N days.
   * Returns the number of pruned entries.
   */
  async pruneCorrections(staleDays = 30): Promise<number> {
    const cutoff = new Date(
      Date.now() - staleDays * 24 * 60 * 60 * 1000
    ).toISOString();

    const stale = await this.write(
      `?[entity_key, error_type] :=
        *corrections{entity_key, error_type, last_seen},
        last_seen < $cutoff`,
      { cutoff }
    );

    let pruned = 0;
    for (const row of stale.rows) {
      await this.write(
        `?[entity_key, error_type] <- [[$ek, $et]]
        :rm corrections {entity_key, error_type}`,
        { ek: row[0] as string, et: row[1] as string }
      );
      pruned++;
    }
    return pruned;
  }
}

/** Simple glob matching — supports * and ** patterns. */
function matchGlob(filePath: string, glob: string): boolean {
  const regex = glob
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`).test(filePath);
}
