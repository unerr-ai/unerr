/**
 * Rename/move anchor migration — Sprint C item 7, §11.1.
 *
 * Three-tier preferred path:
 *   1. Agent-driven (preferred) — `NotesStore.moveAnchor` invoked by
 *      `unerr_remember({type:"move_anchor"})` (in B3a).
 *   2. Watcher-driven fallback — when the proxy's native file watcher
 *      detects a file deletion, this module checks git history for a
 *      rename within the last N=20 commits. If found, migrates.
 *   3. Silent decay — if neither finds a new home, the anchor is flagged
 *      `anchor_missing=true`; the tier formula (A4) accelerates decay
 *      by 0.5 per week from the missing-since mark.
 *
 * This module owns layers 2+3. Layer 1 is the agent's call into the
 * MCP tool wrapper, already covered by `NotesStore.moveAnchor`.
 *
 * The git command runner is injected so callers can fake it in tests.
 */

import { execFileSync } from "node:child_process";
import type { NotesStore } from "./notes-store.js";

export const RENAME_LOOKBACK_DEFAULT = 20;
/** Git considers ≥50% content similarity a rename by default; we tighten to
 *  80% for note migration since false positives are worse than misses. */
export const RENAME_SIMILARITY_MIN_DEFAULT = 80;

export interface GitRunner {
  /**
   * Run a git command in `cwd` and return stdout. Throws on non-zero exit.
   * Signature matches `execFileSync` so the real runner is a thin shim.
   */
  (args: readonly string[], cwd: string): string;
}

/** Default runner wraps execFileSync. Tests pass a fake. */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

export interface DetectRenameInput {
  /** Repo root. */
  repo_dir: string;
  /** Path that disappeared, relative to repo root. */
  old_path: string;
  /** How many commits back to look. Default 20. */
  lookback?: number;
  /** Minimum git similarity percentage (1-100). Default 80. */
  similarity_min?: number;
  /** Inject a fake runner for tests. */
  git?: GitRunner;
}

export interface DetectRenameResult {
  /** When set, the file was renamed to this path within the lookback window. */
  new_path?: string;
  /** Git's similarity index (50-100) when a rename is found. */
  similarity?: number;
  /** Why detection failed (when new_path is unset). For telemetry. */
  reason?: "no_match" | "below_threshold" | "git_error";
}

/**
 * Look for a git rename in the last N commits. Uses
 *   git log --diff-filter=R --follow --name-status --pretty=format: -N -- <old>
 *
 * Returns the new path + similarity when found. We use --follow so a chain
 * of renames in the lookback window resolves to the most recent destination.
 */
export function detectGitRename(input: DetectRenameInput): DetectRenameResult {
  const lookback = input.lookback ?? RENAME_LOOKBACK_DEFAULT;
  const minSim = input.similarity_min ?? RENAME_SIMILARITY_MIN_DEFAULT;
  const git = input.git ?? defaultGitRunner;
  let raw: string;
  try {
    raw = git(
      [
        "log",
        "--diff-filter=R",
        "--follow",
        "--name-status",
        "--pretty=format:",
        `-${lookback}`,
        "--",
        input.old_path,
      ],
      input.repo_dir
    );
  } catch {
    return { reason: "git_error" };
  }
  // Lines like: "R087\told/path.ts\tnew/path.ts" — first column is similarity.
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("R")) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const tag = parts[0] ?? "";
    const fromPath = parts[1] ?? "";
    const toPath = parts[2] ?? "";
    const simMatch = tag.match(/^R(\d{1,3})$/);
    if (!simMatch?.[1]) continue;
    const sim = Number.parseInt(simMatch[1], 10);
    if (fromPath !== input.old_path) continue;
    if (sim < minSim) return { reason: "below_threshold", similarity: sim };
    return { new_path: toPath, similarity: sim };
  }
  return { reason: "no_match" };
}

export interface HandleFileDeletionInput {
  /** Repo root for git lookups. */
  repo_dir: string;
  /** The deleted file's path relative to repo root. */
  deleted_path: string;
  /** Inject a fake runner for tests. */
  git?: GitRunner;
  /** Override lookback/similarity if needed. */
  lookback?: number;
  similarity_min?: number;
  now_ms?: number;
}

export interface HandleFileDeletionResult {
  outcome: "migrated" | "flagged_missing" | "no_anchored_notes";
  /** When migrated: how many notes moved + the new path. */
  migrated?: number;
  new_path?: string;
  similarity?: number;
  /** When flagged_missing: how many notes were marked. */
  flagged?: number;
}

/**
 * Layer-2 + Layer-3 orchestrator. Called by the native watcher when a file
 * disappears. Tries git rename detection first; falls back to silent-decay
 * flag. Returns a structured outcome the proxy can render in Surface 3.
 */
export async function handleFileDeletion(
  store: NotesStore,
  input: HandleFileDeletionInput
): Promise<HandleFileDeletionResult> {
  const oldAnchor = `f:${input.deleted_path}`;

  const rename = detectGitRename({
    repo_dir: input.repo_dir,
    old_path: input.deleted_path,
    lookback: input.lookback,
    similarity_min: input.similarity_min,
    git: input.git,
  });

  if (rename.new_path) {
    const newAnchor = `f:${rename.new_path}`;
    const result = await store.moveAnchor({
      old_anchor: oldAnchor,
      new_anchor: newAnchor,
      now_ms: input.now_ms,
    });
    if (result.migrated === 0) {
      return { outcome: "no_anchored_notes" };
    }
    return {
      outcome: "migrated",
      migrated: result.migrated,
      new_path: rename.new_path,
      similarity: rename.similarity,
    };
  }

  const flag = await store.markAnchorMissing(oldAnchor, input.now_ms);
  if (flag.flagged === 0) return { outcome: "no_anchored_notes" };
  return { outcome: "flagged_missing", flagged: flag.flagged };
}
