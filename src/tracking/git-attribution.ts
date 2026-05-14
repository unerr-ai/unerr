/**
 * Git-Native Attribution — Phase 5.5 §1.5
 *
 * Attaches ledger metadata to Git commits using:
 *   1. Git Trailers (in commit messages) — lightweight, `git log --format="%(trailers)"` parseable
 *   2. Git Notes (under refs/notes/unerr) — rich JSON metadata, aligned with git-ai v3 standard
 *
 * Both mechanisms survive rebases, merges, squashes, and cherry-picks.
 * This makes ledger data git-mergeable by construction — no sidecar JSONL files.
 *
 * Integration point: Called from `unerr push` before git push (P13 bridge).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeNote } from "../utils/git.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface GitNotePayload {
  version: "1.0";
  session_id: string;
  ledger_entry_ids: string[];
  prompt: string;
  plan_summary?: string;
  change_type?: string;
  feature_area?: string;
  entities_affected: string[];
  files_changed: string[];
  agent_model?: string;
  agent_tool?: string;
  created_at: string;
}

export interface AttributionContext {
  sessionId: string;
  ledgerEntryIds: string[];
  prompt: string;
  planSummary?: string;
  changeType?: string;
  featureArea?: string;
  agentModel?: string;
  agentTool?: string;
  filesChanged: string[];
}

// ── Git Trailers ───────────────────────────────────────────────────────────

/**
 * Build a commit message with Git Trailers appended.
 * Trailers are standardized key-value pairs at the end of a commit message,
 * separated from the body by a blank line. Parseable via `git log --format="%(trailers)"`.
 *
 * Aligned with git-ai v3 standard: session-based attribution with model + tool metadata.
 */
export function buildCommitMessageWithTrailers(
  baseMessage: string,
  attribution: AttributionContext,
): string {
  const trailers: string[] = [];

  trailers.push(`Unerr-Session: ${attribution.sessionId}`);

  if (attribution.ledgerEntryIds.length > 0) {
    // Only include first entry ID to keep message short; full list in Git Notes
    trailers.push(`Unerr-Ledger-Id: ${attribution.ledgerEntryIds[0]}`);
  }

  if (attribution.changeType) {
    trailers.push(`Unerr-Change-Type: ${attribution.changeType}`);
  }

  if (attribution.featureArea) {
    trailers.push(`Unerr-Feature: ${attribution.featureArea}`);
  }

  if (attribution.planSummary) {
    // Truncate plan to 72 chars for trailer (single-line convention)
    const truncated =
      attribution.planSummary.length > 72
        ? `${attribution.planSummary.slice(0, 69)}...`
        : attribution.planSummary;
    trailers.push(`Unerr-Plan: ${truncated}`);
  }

  if (attribution.agentModel) {
    trailers.push(`Unerr-Agent-Model: ${attribution.agentModel}`);
  }

  if (attribution.agentTool) {
    trailers.push(`Unerr-Agent-Tool: ${attribution.agentTool}`);
  }

  // Git trailer format: blank line + trailers (one per line)
  return `${baseMessage}\n\n${trailers.join("\n")}\n`;
}

// ── Git Notes ──────────────────────────────────────────────────────────────

/**
 * Build the Git Note payload (JSON) for a commit.
 * Written to refs/notes/unerr — a custom namespace that won't conflict
 * with the default refs/notes/commits.
 *
 * Contains rich metadata: full prompt, plan, entities affected, etc.
 * The git-ai v3 standard uses a similar approach under refs/notes/ai.
 */
export function buildGitNotePayload(
  attribution: AttributionContext,
): GitNotePayload {
  return {
    version: "1.0",
    session_id: attribution.sessionId,
    ledger_entry_ids: attribution.ledgerEntryIds,
    prompt: attribution.prompt,
    plan_summary: attribution.planSummary,
    change_type: attribution.changeType,
    feature_area: attribution.featureArea,
    entities_affected: [], // Resolved from SCIP index
    files_changed: attribution.filesChanged,
    agent_model: attribution.agentModel,
    agent_tool: attribution.agentTool,
    created_at: new Date().toISOString(),
  };
}

/**
 * Write a Git Note under refs/notes/unerr for a specific commit.
 * Uses simple-git via the centralized git utility.
 *
 * Target latency: <50ms (see §1.8.1).
 */
export async function writeGitNote(
  dir: string,
  _gitdir: string,
  commitSha: string,
  payload: GitNotePayload,
): Promise<void> {
  const noteContent = JSON.stringify(payload, null, 2);
  await writeNote(dir, "unerr", commitSha, noteContent);
}

/**
 * Read the attribution context from the local workspace manifest.
 * The manifest (.unerr/manifest.json) is maintained by P10's Local Proxy
 * and contains session-scoped attribution data.
 *
 * Returns null if no manifest exists (non-AI push).
 */
export function readAttributionFromManifest(
  cwd: string,
): AttributionContext | null {
  const manifestPath = join(cwd, ".unerr", "manifest.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw) as {
      sessionId?: string;
      attributions?: Array<{
        intentId?: string;
        prompt?: string;
        planSummary?: string;
        changeType?: string;
        featureArea?: string;
        agentModel?: string;
        agentTool?: string;
        filesChanged?: string[];
        ledgerEntryIds?: string[];
      }>;
    };

    if (!manifest.sessionId || !manifest.attributions?.length) return null;

    // Merge all unflushed attributions into a single context
    const allEntryIds: string[] = [];
    const allFiles: string[] = [];
    const prompts: string[] = [];

    for (const attr of manifest.attributions) {
      if (attr.ledgerEntryIds) allEntryIds.push(...attr.ledgerEntryIds);
      if (attr.filesChanged) allFiles.push(...attr.filesChanged);
      if (attr.prompt) prompts.push(attr.prompt);
    }

    // biome-ignore lint/style/noNonNullAssertion: length > 0 guaranteed by caller
    const latest = manifest.attributions[manifest.attributions.length - 1]!;

    return {
      sessionId: manifest.sessionId,
      ledgerEntryIds: [...new Set(allEntryIds)],
      prompt: prompts.join(" → "),
      planSummary: latest.planSummary,
      changeType: latest.changeType,
      featureArea: latest.featureArea,
      agentModel: latest.agentModel,
      agentTool: latest.agentTool,
      filesChanged: [...new Set(allFiles)],
    };
  } catch {
    return null;
  }
}
