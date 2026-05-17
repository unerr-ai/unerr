/**
 * Temporal Fact Store — CozoDB-backed project knowledge with decay model.
 *
 * Layer 9 core: stores facts (conventions, decisions, anti-patterns) that
 * persist across sessions. Each fact decays over time unless reinforced.
 *
 * Decay formula (computed inline in Datalog at read time):
 *   effective_confidence = base_confidence * recency_factor * evidence_factor
 *   recency_factor = e^(-lambda * days_since_last_reinforcement)
 *   evidence_factor = min(1.0, reinforcement_count / 3.0)
 *
 * Decay rates (lambda) per fact type:
 *   procedural: 0.10 (fast — "how to" instructions go stale)
 *   semantic:   0.05 (medium — architectural knowledge)
 *   negative:   0.02 (slow — anti-patterns remain relevant)
 *   convention: 0.02 (slow — project standards persist like anti-patterns)
 *   episodic:   0.00 (never — immutable history)
 */

import { randomUUID } from "node:crypto";
import type { CozoDb } from "./cozo-schema.js";
import { initFactsSchema, openFactsDb } from "./facts-schema.js";

// ── Types ────────────────────────────────────────────────────────────

export type FactType =
  | "procedural"
  | "semantic"
  | "negative"
  | "episodic"
  | "convention";
export type FactSource =
  | "convention_detector"
  | "negative_knowledge"
  | "causal_bridge"
  | "session_analysis"
  | "agent_explicit";

export interface EvidenceEntry {
  session_id: string;
  action: "created" | "reinforced" | "contradicted";
  timestamp: number;
}

export interface CreateFactInput {
  fact_type: FactType;
  scope: string;
  subject: string;
  content: string;
  source: FactSource;
  base_confidence?: number;
}

export interface TemporalFact {
  fact_id: string;
  fact_type: FactType;
  scope: string;
  subject: string;
  content: string;
  base_confidence: number;
  effective_confidence: number;
  reinforcement_count: number;
  created_at: number;
  last_reinforced_at: number;
  last_contradicted_at: number;
  source: FactSource;
}

export interface FactHealthSummary {
  total: number;
  active: number;
  decayed: number;
  by_type: Record<FactType, number>;
  avg_confidence: number;
}

export interface DecayConfig {
  procedural: number;
  semantic: number;
  negative: number;
  episodic: number;
  convention: number;
}

export interface TemporalConfig {
  decay_rates: DecayConfig;
  recall_threshold: number;
  max_facts_per_response: number;
  prune_threshold: number;
}

const DEFAULT_CONFIG: TemporalConfig = {
  decay_rates: {
    procedural: 0.1,
    semantic: 0.05,
    negative: 0.02,
    episodic: 0.0,
    convention: 0.02,
  },
  recall_threshold: 0.2,
  max_facts_per_response: 5,
  prune_threshold: 0.05,
};

const DEFAULT_CONFIDENCE: Record<FactSource, number> = {
  agent_explicit: 0.95,
  negative_knowledge: 0.9,
  causal_bridge: 1.0,
  convention_detector: 0.75,
  session_analysis: 0.6,
};

const MAX_CONTENT_LENGTH = 500;

/** Type-specific content limits — episodic needs space for what/why/how narratives. */
const TYPE_CONTENT_LIMITS: Record<string, number> = {
  convention: 600,
  semantic: 500,
  episodic: 800,
  procedural: 400,
  negative: 400,
};

// ── TemporalFactStore ────────────────────────────────────────────────

export class TemporalFactStore {
  private constructor(
    private db: CozoDb,
    private config: TemporalConfig
  ) {}

  /**
   * Expose the underlying facts.db handle so cohabiting stores (e.g.
   * SignalShowStore for rotation persistence) can share the connection
   * instead of opening a second SQLite handle to the same file.
   */
  getDb(): CozoDb {
    return this.db;
  }

  /**
   * Create and initialize a TemporalFactStore from a project root path.
   * Opens facts.db (creating if needed) and ensures schema is current.
   */
  static async create(
    projectRoot: string,
    config?: Partial<TemporalConfig>
  ): Promise<TemporalFactStore> {
    const { db } = await openFactsDb(projectRoot);
    await initFactsSchema(db);
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    if (config?.decay_rates) {
      mergedConfig.decay_rates = {
        ...DEFAULT_CONFIG.decay_rates,
        ...config.decay_rates,
      };
    }
    return new TemporalFactStore(db, mergedConfig);
  }

  /**
   * Create a TemporalFactStore from an already-opened CozoDB instance.
   * Used when the caller manages the database lifecycle.
   */
  static fromDb(
    db: CozoDb,
    config?: Partial<TemporalConfig>
  ): TemporalFactStore {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    if (config?.decay_rates) {
      mergedConfig.decay_rates = {
        ...DEFAULT_CONFIG.decay_rates,
        ...config.decay_rates,
      };
    }
    return new TemporalFactStore(db, mergedConfig);
  }

  // ── Write Operations ─────────────────────────────────────────────

  /**
   * Create a new fact or reinforce an existing one with matching (fact_type, scope, subject).
   * Returns the fact_id (new or existing) and whether a duplicate was found.
   */
  async createFact(
    input: CreateFactInput
  ): Promise<{ fact_id: string; deduplicated: boolean }> {
    const limit = TYPE_CONTENT_LIMITS[input.fact_type] ?? MAX_CONTENT_LENGTH;
    const content = input.content.slice(0, limit);
    const now = Date.now();

    const existing = await this.findDuplicate(
      input.fact_type,
      input.scope,
      input.subject
    );

    if (existing) {
      await this.reinforceFact(existing, {
        session_id: "auto-dedup",
        action: "reinforced",
        timestamp: now,
      });
      return { fact_id: existing, deduplicated: true };
    }

    const factId = randomUUID();
    const baseConfidence =
      input.base_confidence ?? DEFAULT_CONFIDENCE[input.source] ?? 0.8;
    const evidence: EvidenceEntry[] = [
      { session_id: "initial", action: "created", timestamp: now },
    ];

    await this.db.run(
      `
      ?[fact_id, fact_type, scope, subject, content, base_confidence,
        reinforcement_count, created_at, last_reinforced_at,
        last_contradicted_at, source, evidence] <- [[
        $fact_id, $fact_type, $scope, $subject, $content, $base_confidence,
        1, $now, $now, 0.0, $source, $evidence
      ]]
      :put facts {
        fact_id => fact_type, scope, subject, content, base_confidence,
        reinforcement_count, created_at, last_reinforced_at,
        last_contradicted_at, source, evidence
      }
      `,
      {
        fact_id: factId,
        fact_type: input.fact_type,
        scope: input.scope,
        subject: input.subject,
        content,
        base_confidence: baseConfidence,
        now,
        source: input.source,
        evidence: JSON.stringify(evidence),
      }
    );

    return { fact_id: factId, deduplicated: false };
  }

  /**
   * Reinforce an existing fact — increases reinforcement_count, updates timestamp.
   */
  async reinforceFact(factId: string, evidence: EvidenceEntry): Promise<void> {
    const rows = await this.getRawFact(factId);
    if (!rows) return;

    const existingEvidence: EvidenceEntry[] = JSON.parse(
      rows.evidence as string
    );
    existingEvidence.push(evidence);
    const trimmedEvidence = existingEvidence.slice(-20);

    await this.db.run(
      `
      ?[fact_id, fact_type, scope, subject, content, base_confidence,
        reinforcement_count, created_at, last_reinforced_at,
        last_contradicted_at, source, evidence] <- [[
        $fact_id, $fact_type, $scope, $subject, $content, $base_confidence,
        $reinforcement_count, $created_at, $now, $last_contradicted_at,
        $source, $evidence
      ]]
      :put facts {
        fact_id => fact_type, scope, subject, content, base_confidence,
        reinforcement_count, created_at, last_reinforced_at,
        last_contradicted_at, source, evidence
      }
      `,
      {
        fact_id: factId,
        fact_type: rows.fact_type,
        scope: rows.scope,
        subject: rows.subject,
        content: rows.content,
        base_confidence: rows.base_confidence,
        reinforcement_count: (rows.reinforcement_count as number) + 1,
        created_at: rows.created_at,
        now: Date.now(),
        last_contradicted_at: rows.last_contradicted_at,
        source: rows.source,
        evidence: JSON.stringify(trimmedEvidence),
      }
    );
  }

  /**
   * Contradict a fact — halves its confidence.
   */
  async contradictFact(factId: string, reason: string): Promise<void> {
    const rows = await this.getRawFact(factId);
    if (!rows) return;

    const now = Date.now();
    const existingEvidence: EvidenceEntry[] = JSON.parse(
      rows.evidence as string
    );
    existingEvidence.push({
      session_id: "contradiction",
      action: "contradicted",
      timestamp: now,
    });

    await this.db.run(
      `
      ?[fact_id, fact_type, scope, subject, content, base_confidence,
        reinforcement_count, created_at, last_reinforced_at,
        last_contradicted_at, source, evidence] <- [[
        $fact_id, $fact_type, $scope, $subject, $content, $base_confidence,
        $reinforcement_count, $created_at, $last_reinforced_at, $now,
        $source, $evidence
      ]]
      :put facts {
        fact_id => fact_type, scope, subject, content, base_confidence,
        reinforcement_count, created_at, last_reinforced_at,
        last_contradicted_at, source, evidence
      }
      `,
      {
        fact_id: factId,
        fact_type: rows.fact_type,
        scope: rows.scope,
        subject: rows.subject,
        content: rows.content,
        base_confidence: (rows.base_confidence as number) * 0.5,
        reinforcement_count: rows.reinforcement_count,
        created_at: rows.created_at,
        last_reinforced_at: rows.last_reinforced_at,
        now,
        source: rows.source,
        evidence: JSON.stringify(existingEvidence.slice(-20)),
      }
    );
  }

  // ── Read Operations (with inline decay computation) ──────────────

  /**
   * Recall facts by scope with decay-adjusted confidence filtering.
   */
  async recallByScope(
    scope: string,
    minConfidence?: number
  ): Promise<TemporalFact[]> {
    return this.runDecayQuery(
      `*facts{fact_id, fact_type, scope, subject, content,
              base_confidence, reinforcement_count, created_at,
              last_reinforced_at, last_contradicted_at, source, evidence},
        scope == $filter_scope`,
      { filter_scope: scope },
      minConfidence
    );
  }

  /**
   * Recall facts by subject (entity key or topic).
   */
  async recallBySubject(
    subject: string,
    minConfidence?: number
  ): Promise<TemporalFact[]> {
    return this.runDecayQuery(
      `*facts{fact_id, fact_type, scope, subject, content,
              base_confidence, reinforcement_count, created_at,
              last_reinforced_at, last_contradicted_at, source, evidence},
        subject == $filter_subject`,
      { filter_subject: subject },
      minConfidence
    );
  }

  /**
   * Recall all negative facts (anti-patterns) — always relevant regardless of scope.
   */
  async recallNegative(minConfidence?: number): Promise<TemporalFact[]> {
    return this.runDecayQuery(
      `*facts{fact_id, fact_type, scope, subject, content,
              base_confidence, reinforcement_count, created_at,
              last_reinforced_at, last_contradicted_at, source, evidence},
        fact_type == "negative"`,
      {},
      minConfidence
    );
  }

  /**
   * Generate scope hierarchy from a file path for hierarchical matching.
   * "src/proxy/proxy.ts" → ["src/proxy/proxy.ts", "src/proxy/", "src/", "project"]
   */
  private buildScopeHierarchy(filePath: string): string[] {
    const scopes = [filePath];
    const parts = filePath.split("/");
    // Build directory prefixes from deepest to shallowest
    for (let i = parts.length - 1; i > 0; i--) {
      scopes.push(`${parts.slice(0, i).join("/")}/`);
    }
    scopes.push("project");
    return scopes;
  }

  /**
   * Recall facts by prefix hierarchy — facts scoped to a directory apply to all files in it.
   * "src/proxy/proxy.ts" matches facts scoped to "src/proxy/proxy.ts", "src/proxy/", "src/", and "project".
   */
  async recallByPrefix(
    filePath: string,
    minConfidence?: number
  ): Promise<TemporalFact[]> {
    const scopes = this.buildScopeHierarchy(filePath);
    // Build CozoDB or-clause for all scope levels
    const conditions = scopes.map((_, i) => `scope == $s${i}`).join(" or ");
    const params: Record<string, string> = {};
    for (let i = 0; i < scopes.length; i++) {
      params[`s${i}`] = scopes[i]!;
    }
    return this.runDecayQuery(
      `*facts{fact_id, fact_type, scope, subject, content,
              base_confidence, reinforcement_count, created_at,
              last_reinforced_at, last_contradicted_at, source, evidence},
        (${conditions})`,
      params,
      minConfidence
    );
  }

  /**
   * Recall facts relevant to a file — by hierarchical scope prefix OR entity keys within that file.
   * This is the primary recall method used during tool responses.
   */
  async recallForFile(
    filePath: string,
    entityKeys: string[]
  ): Promise<TemporalFact[]> {
    const threshold = this.config.recall_threshold;
    const maxFacts = this.config.max_facts_per_response;

    // Use hierarchical prefix matching instead of exact scope
    const scopeFacts = await this.recallByPrefix(filePath, threshold);

    const entityFacts: TemporalFact[] = [];
    for (const key of entityKeys.slice(0, 10)) {
      const facts = await this.recallBySubject(key, threshold);
      for (const f of facts) {
        if (!entityFacts.some((ef) => ef.fact_id === f.fact_id)) {
          entityFacts.push(f);
        }
      }
    }

    const projectNegative = await this.recallByScope("project", threshold);
    const negFacts = projectNegative.filter((f) => f.fact_type === "negative");

    const all = [...scopeFacts, ...entityFacts, ...negFacts];
    const deduped = new Map<string, TemporalFact>();
    for (const fact of all) {
      const existing = deduped.get(fact.fact_id);
      if (
        !existing ||
        fact.effective_confidence > existing.effective_confidence
      ) {
        deduped.set(fact.fact_id, fact);
      }
    }

    return [...deduped.values()]
      .sort((a, b) => b.effective_confidence - a.effective_confidence)
      .slice(0, maxFacts);
  }

  /**
   * Recall all facts regardless of scope (for dashboard listing).
   */
  async recallAll(minConfidence?: number): Promise<TemporalFact[]> {
    return this.runDecayQuery(
      `*facts{fact_id, fact_type, scope, subject, content,
              base_confidence, reinforcement_count, created_at,
              last_reinforced_at, last_contradicted_at, source, evidence}`,
      {},
      minConfidence ?? 0
    );
  }

  /**
   * Recall facts with effective confidence in a given range (for decay visibility).
   */
  async recallDecaying(
    minConf: number,
    maxConf: number
  ): Promise<TemporalFact[]> {
    const all = await this.runDecayQuery(
      `*facts{fact_id, fact_type, scope, subject, content,
              base_confidence, reinforcement_count, created_at,
              last_reinforced_at, last_contradicted_at, source, evidence}`,
      {},
      minConf
    );
    return all.filter((f) => f.effective_confidence < maxConf);
  }

  /**
   * Get overall health metrics of the fact store.
   */
  async getFactHealth(): Promise<FactHealthSummary> {
    const allFacts = await this.runDecayQuery(
      `*facts{fact_id, fact_type, scope, subject, content,
              base_confidence, reinforcement_count, created_at,
              last_reinforced_at, last_contradicted_at, source, evidence}`,
      {},
      0
    );

    const byType: Record<FactType, number> = {
      procedural: 0,
      semantic: 0,
      negative: 0,
      episodic: 0,
      convention: 0,
    };

    let totalConfidence = 0;
    let active = 0;
    const threshold = this.config.recall_threshold;

    for (const fact of allFacts) {
      byType[fact.fact_type]++;
      totalConfidence += fact.effective_confidence;
      if (fact.effective_confidence >= threshold) active++;
    }

    return {
      total: allFacts.length,
      active,
      decayed: allFacts.length - active,
      by_type: byType,
      avg_confidence:
        allFacts.length > 0 ? totalConfidence / allFacts.length : 0,
    };
  }

  /**
   * Remove facts whose effective confidence has dropped below the prune threshold.
   * Returns the number of facts pruned.
   */
  async pruneDecayed(threshold?: number): Promise<number> {
    const pruneThreshold = threshold ?? this.config.prune_threshold;
    const allFacts = await this.runDecayQuery(
      `*facts{fact_id, fact_type, scope, subject, content,
              base_confidence, reinforcement_count, created_at,
              last_reinforced_at, last_contradicted_at, source, evidence}`,
      {},
      0
    );

    const toPrune = allFacts.filter(
      (f) =>
        f.fact_type !== "episodic" && f.effective_confidence < pruneThreshold
    );

    for (const fact of toPrune) {
      await this.db.run(
        `
        ?[fact_id] <- [[$fact_id]]
        :rm facts { fact_id }
        `,
        { fact_id: fact.fact_id }
      );
    }

    return toPrune.length;
  }

  /**
   * Record an entity interaction (for cross-session history tracking).
   */
  async recordInteraction(
    entityKey: string,
    sessionId: string,
    interactionType: string,
    toolName: string,
    outcome: string
  ): Promise<void> {
    await this.db.run(
      `
      ?[entity_key, session_id, interaction_type, timestamp, tool_name, outcome] <- [[
        $entity_key, $session_id, $interaction_type, $timestamp, $tool_name, $outcome
      ]]
      :put entity_interactions {
        entity_key, session_id, interaction_type, timestamp
        => tool_name, outcome
      }
      `,
      {
        entity_key: entityKey,
        session_id: sessionId,
        interaction_type: interactionType,
        timestamp: Date.now(),
        tool_name: toolName,
        outcome,
      }
    );
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async findDuplicate(
    factType: string,
    scope: string,
    subject: string
  ): Promise<string | null> {
    const result = await this.db.run(
      `
      ?[fact_id] :=
        *facts{fact_id, fact_type, scope, subject},
        fact_type == $filter_type,
        scope == $filter_scope,
        subject == $filter_subject
      :limit 1
      `,
      {
        filter_type: factType,
        filter_scope: scope,
        filter_subject: subject,
      }
    );
    return result.rows.length > 0 ? (result.rows[0]?.[0] as string) : null;
  }

  private async getRawFact(
    factId: string
  ): Promise<Record<string, unknown> | null> {
    const result = await this.db.run(
      `
      ?[fact_id, fact_type, scope, subject, content, base_confidence,
        reinforcement_count, created_at, last_reinforced_at,
        last_contradicted_at, source, evidence] :=
        *facts{fact_id, fact_type, scope, subject, content,
               base_confidence, reinforcement_count, created_at,
               last_reinforced_at, last_contradicted_at, source, evidence},
        fact_id == $filter_fact_id
      `,
      { filter_fact_id: factId }
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    return {
      fact_id: row[0],
      fact_type: row[1],
      scope: row[2],
      subject: row[3],
      content: row[4],
      base_confidence: row[5],
      reinforcement_count: row[6],
      created_at: row[7],
      last_reinforced_at: row[8],
      last_contradicted_at: row[9],
      source: row[10],
      evidence: row[11],
    };
  }

  /**
   * Execute a recall query with inline decay computation.
   * The decay math runs entirely within CozoDB Datalog — no post-processing.
   */
  private async runDecayQuery(
    sourceClause: string,
    params: Record<string, unknown>,
    minConfidence?: number
  ): Promise<TemporalFact[]> {
    const threshold = minConfidence ?? this.config.recall_threshold;
    const nowMs = Date.now();

    const query = `
      ?[fact_id, fact_type, scope, subject, content, base_confidence,
        reinforcement_count, created_at, last_reinforced_at,
        last_contradicted_at, source, evidence, effective_conf] :=
        ${sourceClause},
        days = ($now_ms - last_reinforced_at) / 86400000.0,
        lambda = if(fact_type == "procedural", $lambda_procedural,
                 if(fact_type == "semantic", $lambda_semantic,
                 if(fact_type == "negative", $lambda_negative,
                 if(fact_type == "convention", $lambda_convention, 0.0)))),
        recency = exp(-1.0 * lambda * max(0.0, days)),
        ev_factor = if(source == "agent_explicit", 1.0, min(1.0, reinforcement_count / 3.0)),
        effective_conf = base_confidence * recency * ev_factor,
        effective_conf >= $min_confidence
      :order -effective_conf
      :limit 50
    `;

    const result = await this.db.run(query, {
      ...params,
      now_ms: nowMs,
      lambda_procedural: this.config.decay_rates.procedural,
      lambda_semantic: this.config.decay_rates.semantic,
      lambda_negative: this.config.decay_rates.negative,
      lambda_convention: this.config.decay_rates.convention,
      min_confidence: threshold,
    });

    return result.rows.map((row) => ({
      fact_id: row[0] as string,
      fact_type: row[1] as FactType,
      scope: row[2] as string,
      subject: row[3] as string,
      content: row[4] as string,
      base_confidence: row[5] as number,
      effective_confidence: row[12] as number,
      reinforcement_count: row[6] as number,
      created_at: row[7] as number,
      last_reinforced_at: row[8] as number,
      last_contradicted_at: row[9] as number,
      source: row[10] as FactSource,
    }));
  }
}
