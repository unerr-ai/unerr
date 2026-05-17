/**
 * Fact Generation Pipeline — automatically generates temporal facts from 4 algorithmic sources.
 *
 * Layer 9 PI-5: Runs in daemon mode when:
 *   1. A session summary arrives in .unerr/sessions/
 *   2. A full reindex completes (convention detection)
 *   3. A revert/rewind is detected (negative knowledge)
 *   4. A 24h survival window closes (causal bridge)
 *
 * All sources are purely algorithmic — zero LLM dependency.
 * Source #1 (Agent Explicit) is handled by the `record_fact` tool in PI-2.
 *
 * Pipeline flow:
 *   Source Event → Candidate Fact → Dedup Check → Existing?
 *     YES → Reinforce (bump count, update timestamp)
 *     NO  → Check contradictions → Create with base_confidence
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummaryRecord } from "../tracking/session-summary-writer.js";
import type { DetectedConvention } from "./local-convention-detector.js";
import type { CorrectionEntry } from "./negative-knowledge.js";
import type { CreateFactInput, TemporalFactStore } from "./temporal-facts.js";

// ── Types ────────────────────────────────────────────────────────────

export interface FactGeneratorResult {
  created: number;
  reinforced: number;
  source: string;
  details: string[];
}

export interface CausalBridgeEvent {
  session_id: string;
  entity_key: string;
  action: "survived" | "reverted";
  branch: string;
  timestamp: number;
}

// ── Pipeline Orchestrator ────────────────────────────────────────────

/**
 * Run the full fact generation pipeline.
 * Called by the daemon periodically or on specific triggers.
 */
export async function runFactGenerationPipeline(
  factStore: TemporalFactStore,
  unerrDir: string
): Promise<FactGeneratorResult[]> {
  const results: FactGeneratorResult[] = [];

  try {
    const sessionResult = await generateFromSessionAnalysis(
      factStore,
      unerrDir
    );
    if (sessionResult) results.push(sessionResult);
  } catch {
    // Non-critical — session analysis failure doesn't block other sources
  }

  return results;
}

// ── Source 2: Convention Detector → Semantic Facts ────────────────────

/**
 * Generate semantic facts from detected conventions.
 * Trigger: after full reindex completes.
 *
 * Conventions with >70% adherence rate become facts.
 * Already-existing facts get reinforced; new ones created.
 */
export async function generateFromConventions(
  factStore: TemporalFactStore,
  conventions: DetectedConvention[]
): Promise<FactGeneratorResult> {
  let created = 0;
  let reinforced = 0;
  const details: string[] = [];

  const MIN_CONFIDENCE = 0.7;
  const MIN_FREQUENCY = 5;

  for (const conv of conventions) {
    if (conv.confidence < MIN_CONFIDENCE) continue;
    if (conv.frequency < MIN_FREQUENCY) continue;

    const content = formatConventionFact(conv);
    if (content.length > 280) continue;

    const input: CreateFactInput = {
      fact_type: "semantic",
      scope: inferScopeFromConvention(conv),
      subject: conv.name,
      content,
      source: "convention_detector",
      base_confidence: Math.min(0.9, conv.confidence),
    };

    const { deduplicated } = await factStore.createFact(input);
    if (deduplicated) {
      reinforced++;
    } else {
      created++;
      details.push(`[convention] ${conv.name}: ${content.slice(0, 80)}`);
    }
  }

  return { created, reinforced, source: "convention_detector", details };
}

// ── Source 3: Negative Knowledge → Negative Facts ────────────────────

/**
 * Generate negative facts from revert/rewind events.
 * Trigger: revert detected by causal bridge or ledger analysis.
 *
 * Each correction entry becomes a "don't do X" fact with high confidence.
 */
export async function generateFromNegativeKnowledge(
  factStore: TemporalFactStore,
  corrections: CorrectionEntry[]
): Promise<FactGeneratorResult> {
  let created = 0;
  let reinforced = 0;
  const details: string[] = [];

  for (const correction of corrections) {
    const content = correction.reason.slice(0, 280);

    const input: CreateFactInput = {
      fact_type: "negative",
      scope: correction.entityKey,
      subject: correction.entityKey,
      content,
      source: "negative_knowledge",
      base_confidence: 0.9,
    };

    const { deduplicated } = await factStore.createFact(input);
    if (deduplicated) {
      reinforced++;
    } else {
      created++;
      details.push(
        `[negative] ${correction.entityKey}: ${content.slice(0, 60)}`
      );
    }
  }

  return { created, reinforced, source: "negative_knowledge", details };
}

// ── Source 4: Causal Bridge → Episodic Facts ─────────────────────────

/**
 * Generate episodic facts from 24h survival analysis.
 * Trigger: 24h after a session ends, check if changes survived.
 *
 * Survived changes → episodic "survived" fact (confidence 1.0, never decays).
 * Reverted changes → triggers negative knowledge pipeline.
 */
export async function generateFromCausalBridge(
  factStore: TemporalFactStore,
  events: CausalBridgeEvent[]
): Promise<FactGeneratorResult> {
  let created = 0;
  let reinforced = 0;
  const details: string[] = [];

  for (const event of events) {
    if (event.action === "survived") {
      const content = `Change to ${event.entity_key} on ${new Date(event.timestamp).toISOString().split("T")[0]} survived — shipped to ${event.branch}`;

      const input: CreateFactInput = {
        fact_type: "episodic",
        scope: event.entity_key,
        subject: event.entity_key,
        content: content.slice(0, 280),
        source: "causal_bridge",
        base_confidence: 1.0,
      };

      const { deduplicated } = await factStore.createFact(input);
      if (deduplicated) {
        reinforced++;
      } else {
        created++;
        details.push(`[episodic:survived] ${event.entity_key}`);
      }
    } else if (event.action === "reverted") {
      const content = `Change to ${event.entity_key} was reverted within 24h — approach was incorrect`;

      const input: CreateFactInput = {
        fact_type: "negative",
        scope: event.entity_key,
        subject: event.entity_key,
        content: content.slice(0, 280),
        source: "causal_bridge",
        base_confidence: 0.85,
      };

      const { deduplicated } = await factStore.createFact(input);
      if (deduplicated) {
        reinforced++;
      } else {
        created++;
        details.push(`[negative:reverted] ${event.entity_key}`);
      }
    }
  }

  return { created, reinforced, source: "causal_bridge", details };
}

// ── Source 5: Session Analysis → Procedural Facts ────────────────────

/**
 * Generate procedural facts from session summary aggregation.
 * Trigger: new session summary received.
 *
 * Detects patterns across sessions:
 *   - Hot files (read in >50% of sessions)
 *   - Common tool sequences
 *   - High-revert files (files that frequently get reverted)
 */
export async function generateFromSessionAnalysis(
  factStore: TemporalFactStore,
  unerrDir: string
): Promise<FactGeneratorResult> {
  let created = 0;
  const reinforced = 0;
  const details: string[] = [];

  const summaries = loadRecentSessions(unerrDir, 20);
  if (summaries.length < 3) {
    return {
      created: 0,
      reinforced: 0,
      source: "session_analysis",
      details: [],
    };
  }

  const hotFiles = detectHotFiles(summaries);
  for (const [file, frequency] of hotFiles) {
    const pct = Math.round(frequency * 100);
    const content = `${file} is accessed in ${pct}% of sessions (hot file)`;
    const confidence = Math.min(0.85, 0.4 + frequency * 0.5);

    const input: CreateFactInput = {
      fact_type: "procedural",
      scope: file,
      subject: "hot-file",
      content,
      source: "session_analysis",
      base_confidence: confidence,
    };

    const factId = await factStore.createFact(input);
    if (factId) {
      created++;
      details.push(`[procedural:hot] ${file} (${pct}%)`);
    }
  }

  const highRevertFiles = detectHighRevertFiles(summaries);
  for (const [file, revertRate] of highRevertFiles) {
    const pct = Math.round(revertRate * 100);
    const content = `${file} has a ${pct}% revert rate across sessions — changes here are fragile`;

    const input: CreateFactInput = {
      fact_type: "negative",
      scope: file,
      subject: file,
      content: content.slice(0, 280),
      source: "session_analysis",
      base_confidence: Math.min(0.85, 0.5 + revertRate * 0.4),
    };

    const factId = await factStore.createFact(input);
    if (factId) {
      created++;
      details.push(`[negative:fragile] ${file} (${pct}% revert rate)`);
    }
  }

  return { created, reinforced, source: "session_analysis", details };
}

// ── Internal Helpers ─────────────────────────────────────────────────

function loadRecentSessions(
  unerrDir: string,
  limit: number
): SessionSummaryRecord[] {
  const sessionsDir = join(unerrDir, "sessions");
  if (!existsSync(sessionsDir)) return [];

  try {
    const files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .slice(-limit);

    const summaries: SessionSummaryRecord[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(sessionsDir, file), "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          summaries.push(JSON.parse(lastLine) as SessionSummaryRecord);
        }
      } catch {
        // Skip unreadable session files
      }
    }
    return summaries;
  } catch {
    return [];
  }
}

/**
 * Detect hot files — files that appear in >50% of sessions.
 * Returns [file, frequency] pairs sorted by frequency descending.
 */
function detectHotFiles(
  summaries: SessionSummaryRecord[]
): Array<[string, number]> {
  const fileCounts = new Map<string, number>();
  const total = summaries.length;

  for (const session of summaries) {
    const seen = new Set<string>();
    for (const file of session.files_modified) {
      if (!seen.has(file)) {
        seen.add(file);
        fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
      }
    }
  }

  const HOT_THRESHOLD = 0.5;
  return [...fileCounts.entries()]
    .map(([file, count]) => [file, count / total] as [string, number])
    .filter(([_, freq]) => freq >= HOT_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
}

/**
 * Detect files with high revert rates across sessions.
 * A file modified in session with revert_count > 0 = potential fragile file.
 */
function detectHighRevertFiles(
  summaries: SessionSummaryRecord[]
): Array<[string, number]> {
  const fileModifiedCount = new Map<string, number>();
  const fileRevertCount = new Map<string, number>();

  for (const session of summaries) {
    for (const file of session.files_modified) {
      fileModifiedCount.set(file, (fileModifiedCount.get(file) ?? 0) + 1);
      if (session.revert_count > 0) {
        fileRevertCount.set(file, (fileRevertCount.get(file) ?? 0) + 1);
      }
    }
  }

  const HIGH_REVERT_THRESHOLD = 0.4;
  const MIN_MODIFICATIONS = 3;

  return [...fileModifiedCount.entries()]
    .filter(([_, count]) => count >= MIN_MODIFICATIONS)
    .map(([file, count]) => {
      const reverts = fileRevertCount.get(file) ?? 0;
      return [file, reverts / count] as [string, number];
    })
    .filter(([_, rate]) => rate >= HIGH_REVERT_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}

function formatConventionFact(conv: DetectedConvention): string {
  const pct = Math.round(conv.confidence * 100);
  switch (conv.kind) {
    case "naming":
      return `Naming convention: ${conv.name} (${pct}% confidence, ${conv.frequency} entities)`;
    case "structure":
      return `Structure pattern: ${conv.name} (${pct}% confidence)`;
    case "import_direction":
      return `Import convention: ${conv.name} (${pct}% confidence)`;
    default:
      return `Convention: ${conv.name} (${pct}% confidence)`;
  }
}

function inferScopeFromConvention(conv: DetectedConvention): string {
  if (conv.exemplarKeys.length > 0) {
    const first = conv.exemplarKeys[0]!;
    const parts = first.split("/");
    if (parts.length >= 2) {
      return parts.slice(0, 2).join("/");
    }
  }
  return "project";
}
