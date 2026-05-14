/**
 * Causal Bridge — assembles causal chains linking AI interactions to code survival.
 *
 * Given an entity key, traces all AI interactions (from shadow ledger) through
 * commit associations to survival outcomes. Produces a CausalChain with per-interaction
 * survival classification and aggregate durability.
 *
 * Survival window: 24 hours. If an entity survives 24h without being reverted
 * or modified, the interaction is classified as "survived".
 *
 * Outcome classification:
 *   - survived: entity unchanged after 24h
 *   - reverted: entity reverted via git revert/checkout within 24h
 *   - human_modified: entity changed by human commit within 24h
 *   - ai_modified: entity changed by another AI interaction within 24h
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitQuery } from "../utils/exec.js";
import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("causal-bridge");

export interface CausalInteraction {
  prompt: string;
  commitSha: string;
  sessionId: string;
  timestamp: string;
  survived: boolean;
  outcome: "survived" | "reverted" | "human_modified" | "ai_modified";
  survivalMs: number;
}

export interface CausalChain {
  entityKey: string;
  entityName: string;
  interactions: CausalInteraction[];
  durability: number;
  failureModes: string[];
}

interface LedgerEntryCompat {
  id: string;
  ts: string;
  tool: string;
  args_summary: Record<string, unknown>;
  result_summary: Record<string, unknown>;
  session_id: string;
  commit_sha?: string;
  plan_summary?: string;
  change_type?: string;
}

interface CommitInfo {
  sha: string;
  timestamp: number;
  message: string;
  author: string;
  files: string[];
}

const SURVIVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

const AI_COMMIT_PATTERNS = [
  /\bgenerated\b/i,
  /\bauto[-\s]?generated\b/i,
  /\bai[-\s]?assisted\b/i,
  /\bcopilot\b/i,
  /\bcursor\b/i,
  /\bclaude\b/i,
  /\bgpt\b/i,
  /\bunerr\b/i,
];

export class CausalBridge {
  private unerrDir: string;
  private cwd: string;
  private commitCache = new Map<string, CommitInfo>();

  constructor(unerrDir: string, cwd: string) {
    this.unerrDir = unerrDir;
    this.cwd = cwd;
  }

  async buildCausalChain(entityKey: string): Promise<CausalChain> {
    const entityName = extractEntityName(entityKey);
    const ledgerEntries = this.loadEntityLedgerEntries(entityKey);

    if (ledgerEntries.length === 0) {
      return {
        entityKey,
        entityName,
        interactions: [],
        durability: 1.0,
        failureModes: [],
      };
    }

    const commits = await this.loadEntityCommitHistory(entityKey);
    const interactions: CausalInteraction[] = [];
    const failureModeSet = new Set<string>();

    for (const entry of ledgerEntries) {
      const interaction = await this.classifyInteraction(
        entry,
        commits,
        entityKey,
      );
      interactions.push(interaction);

      if (!interaction.survived) {
        failureModeSet.add(interaction.outcome);
      }
    }

    const durability = computeAggregateDurability(interactions);

    return {
      entityKey,
      entityName,
      interactions,
      durability,
      failureModes: Array.from(failureModeSet),
    };
  }

  async buildCausalChains(entityKeys: string[]): Promise<CausalChain[]> {
    const chains: CausalChain[] = [];
    for (const key of entityKeys) {
      const chain = await this.buildCausalChain(key);
      chains.push(chain);
    }
    return chains;
  }

  private loadEntityLedgerEntries(entityKey: string): LedgerEntryCompat[] {
    const ledgerPath = join(this.unerrDir, "ledger", "shadow.jsonl");
    if (!existsSync(ledgerPath)) return [];

    const content = readFileSync(ledgerPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const entries: LedgerEntryCompat[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LedgerEntryCompat;
        if (entryReferencesEntity(entry, entityKey)) {
          entries.push(entry);
        }
      } catch {}
    }

    return entries.sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
    );
  }

  private async loadEntityCommitHistory(
    entityKey: string,
  ): Promise<CommitInfo[]> {
    const filePath = entityKeyToFilePath(entityKey);
    if (!filePath) return [];

    const raw = await gitQuery(
      [
        "log",
        "--format=%H|%at|%s|%an",
        "--follow",
        "--diff-filter=ACDMR",
        "--",
        filePath,
      ],
      this.cwd,
    );

    if (!raw) return [];

    const commits: CommitInfo[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split("|");
      if (parts.length < 4) continue;

      const sha = parts[0]!;
      const timestamp = Number.parseInt(parts[1]!, 10) * 1000;
      const message = parts[2]!;
      const author = parts.slice(3).join("|");

      if (this.commitCache.has(sha)) {
        commits.push(this.commitCache.get(sha)!);
        continue;
      }

      const filesRaw = await gitQuery(
        ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
        this.cwd,
      );
      const files = filesRaw
        ? filesRaw
            .split("\n")
            .map((f) => f.trim())
            .filter(Boolean)
        : [];

      const info: CommitInfo = { sha, timestamp, message, author, files };
      this.commitCache.set(sha, info);
      commits.push(info);
    }

    return commits.sort((a, b) => a.timestamp - b.timestamp);
  }

  private async classifyInteraction(
    entry: LedgerEntryCompat,
    commits: CommitInfo[],
    entityKey: string,
  ): Promise<CausalInteraction> {
    const entryTs = new Date(entry.ts).getTime();
    const prompt = extractPrompt(entry);
    const commitSha = entry.commit_sha ?? "";
    const sessionId = entry.session_id;

    const subsequentCommits = commits.filter(
      (c) =>
        c.timestamp > entryTs && c.timestamp <= entryTs + SURVIVAL_WINDOW_MS,
    );

    if (subsequentCommits.length === 0) {
      const timeSinceEntry = Date.now() - entryTs;
      const survived = timeSinceEntry >= SURVIVAL_WINDOW_MS;
      return {
        prompt,
        commitSha,
        sessionId,
        timestamp: entry.ts,
        survived,
        outcome: survived ? "survived" : "survived",
        survivalMs: timeSinceEntry,
      };
    }

    const filePath = entityKeyToFilePath(entityKey);
    for (const commit of subsequentCommits) {
      if (!filePath || !commit.files.includes(filePath)) continue;

      const survivalMs = commit.timestamp - entryTs;

      if (isRevertCommit(commit.message)) {
        return {
          prompt,
          commitSha,
          sessionId,
          timestamp: entry.ts,
          survived: false,
          outcome: "reverted",
          survivalMs,
        };
      }

      if (isAiCommit(commit.message)) {
        return {
          prompt,
          commitSha,
          sessionId,
          timestamp: entry.ts,
          survived: false,
          outcome: "ai_modified",
          survivalMs,
        };
      }

      return {
        prompt,
        commitSha,
        sessionId,
        timestamp: entry.ts,
        survived: false,
        outcome: "human_modified",
        survivalMs,
      };
    }

    return {
      prompt,
      commitSha,
      sessionId,
      timestamp: entry.ts,
      survived: true,
      outcome: "survived",
      survivalMs: Date.now() - entryTs,
    };
  }
}

function computeAggregateDurability(interactions: CausalInteraction[]): number {
  if (interactions.length === 0) return 1.0;
  const survivedCount = interactions.filter((i) => i.survived).length;
  return survivedCount / interactions.length;
}

function extractEntityName(entityKey: string): string {
  const parts = entityKey.split("::");
  return parts[parts.length - 1] ?? entityKey;
}

function entityKeyToFilePath(entityKey: string): string | null {
  const fileMatch = entityKey.match(/^([^:]+)/);
  if (!fileMatch) return null;
  return fileMatch[1]!;
}

function entryReferencesEntity(
  entry: LedgerEntryCompat,
  entityKey: string,
): boolean {
  const argsStr = JSON.stringify(entry.args_summary);
  if (argsStr.includes(entityKey)) return true;

  const resultStr = JSON.stringify(entry.result_summary);
  if (resultStr.includes(entityKey)) return true;

  const filePath = entityKeyToFilePath(entityKey);
  if (filePath && argsStr.includes(filePath)) return true;

  return false;
}

function extractPrompt(entry: LedgerEntryCompat): string {
  if (entry.plan_summary) return entry.plan_summary;
  const args = entry.args_summary;
  if (typeof args.prompt === "string") return args.prompt;
  if (typeof args.message === "string") return args.message;
  if (typeof args.query === "string") return args.query;
  return `${entry.tool} call`;
}

function isRevertCommit(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.startsWith("revert ") ||
    lower.includes("revert:") ||
    lower.includes("undo ") ||
    lower.includes("rollback ")
  );
}

function isAiCommit(message: string): boolean {
  return AI_COMMIT_PATTERNS.some((p) => p.test(message));
}

/**
 * Standalone causal chain assembly from pre-loaded ledger entries.
 * Does not require git — classifies based on entry data alone.
 */
export function assembleCausalChain(
  entityKey: string,
  entries: Array<{
    id: string;
    ts: string;
    tool: string;
    args_summary: Record<string, unknown>;
    result_summary: Record<string, unknown>;
    session_id: string;
    head_sha: string;
    commit_sha?: string;
    plan_summary?: string;
  }>,
): CausalChain {
  const entityName = extractEntityName(entityKey);
  const relevant = entries.filter((e) => entryReferencesEntity(e, entityKey));
  const interactions: CausalInteraction[] = [];
  const failureModeSet = new Set<string>();

  for (let i = 0; i < relevant.length; i++) {
    const entry = relevant[i]!;
    const entryTs = new Date(entry.ts).getTime();
    const prompt = extractPrompt(entry);
    const commitSha =
      entry.commit_sha ??
      (typeof entry.result_summary.commit_sha === "string"
        ? entry.result_summary.commit_sha
        : "");

    let survived = true;
    let outcome: CausalInteraction["outcome"] = "survived";
    let survivalMs = Date.now() - entryTs;

    if (i + 1 < relevant.length) {
      const nextEntry = relevant[i + 1]!;
      const nextTs = new Date(nextEntry.ts).getTime();
      survivalMs = nextTs - entryTs;

      if (survivalMs < SURVIVAL_WINDOW_MS) {
        survived = false;
        outcome = "ai_modified";
      }
    }

    interactions.push({
      prompt,
      commitSha,
      sessionId: entry.session_id,
      timestamp: entry.ts,
      survived,
      outcome,
      survivalMs,
    });

    if (!survived) {
      failureModeSet.add(outcome);
    }
  }

  return {
    entityKey,
    entityName,
    interactions,
    durability: computeDurability(interactions),
    failureModes: Array.from(failureModeSet),
  };
}

/**
 * Computes aggregate durability from a set of interactions.
 * Durability = fraction of interactions that survived.
 */
export function computeDurability(
  interactions: Array<{ survived: boolean; survivalMs: number }>,
): number {
  if (interactions.length === 0) return 1.0;
  const survivedCount = interactions.filter((i) => i.survived).length;
  return survivedCount / interactions.length;
}
