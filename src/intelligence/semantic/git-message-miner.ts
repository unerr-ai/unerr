/**
 * Git Commit Message Miner — maps commit messages to entities via blame.
 *
 * Extracts semantic context from git history:
 *   - Which commits touched which entities (via file + line intersection)
 *   - Commit message keywords → entity semantic labels
 */

import { gitQuery } from "../../utils/exec.js";

export interface CommitEntityMapping {
  commitHash: string;
  message: string;
  entityKey: string;
  filePath: string;
}

export interface GitMessageContext {
  entityKey: string;
  commitMessages: string[];
  keywords: string[];
}

/**
 * Get recent commits that touched a specific file.
 */
export async function getFileCommits(
  filePath: string,
  cwd: string,
  maxCount = 20
): Promise<Array<{ hash: string; message: string; date: string }>> {
  const output = await gitQuery(
    ["log", `--max-count=${maxCount}`, "--format=%H|%s|%ci", "--", filePath],
    cwd
  );
  if (!output) return [];

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, date] = line.split("|");
      return { hash: hash ?? "", message: message ?? "", date: date ?? "" };
    })
    .filter((c) => c.hash.length > 0);
}

/**
 * Extract keywords from commit messages (for semantic context).
 */
export function extractKeywords(messages: string[]): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "can",
    "need",
    "dare",
    "ought",
    "and",
    "or",
    "but",
    "not",
    "no",
    "nor",
    "for",
    "to",
    "in",
    "on",
    "at",
    "by",
    "from",
    "with",
    "of",
    "it",
    "its",
    "this",
    "that",
  ]);

  const keywords = new Map<string, number>();

  for (const msg of messages) {
    const words = msg
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    for (const word of words) {
      keywords.set(word, (keywords.get(word) ?? 0) + 1);
    }
  }

  return [...keywords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word]) => word);
}

/**
 * Mine git context for a set of entities.
 */
export async function mineEntityContext(
  entities: Array<{ key: string; file_path: string }>,
  cwd: string
): Promise<Map<string, GitMessageContext>> {
  const contexts = new Map<string, GitMessageContext>();
  const fileCache = new Map<string, Array<{ hash: string; message: string }>>();

  for (const entity of entities) {
    let commits = fileCache.get(entity.file_path);
    if (!commits) {
      commits = await getFileCommits(entity.file_path, cwd);
      fileCache.set(entity.file_path, commits);
    }

    const messages = commits.map((c) => c.message);
    const keywords = extractKeywords(messages);

    contexts.set(entity.key, {
      entityKey: entity.key,
      commitMessages: messages.slice(0, 5),
      keywords,
    });
  }

  return contexts;
}
