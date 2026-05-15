/**
 * Session Continuity Protocol — BA-1.2
 *
 * On session start (first tool call), queries the shadow ledger for
 * the previous session's entries, identifies incomplete work chains,
 * and injects structured resume context into the response.
 *
 * Incomplete work detection:
 *   - Entities modified but callers not updated (from blast radius)
 *   - Files with uncommitted changes at session end
 *   - Entities that were being actively worked on (high tool call count)
 *
 * For complex resumes (>50 ledger entries), generates an agent-as-LLM
 * sub-prompt requesting the host agent summarize the raw data.
 */

import type { LedgerEntry, ShadowLedger } from "../tracking/shadow-ledger.js";
import {
  type AssertLevel,
  Behavior,
  type BehaviorOutput,
  type ToolCallContext,
} from "./framework.js";

const AGENT_LLM_THRESHOLD = 50;
const MAX_RESUME_ITEMS = 5;

export interface IncompleteWorkItem {
  entity: string;
  status: string;
  remaining: string[];
  risk: "high" | "medium" | "low";
}

export interface SessionResumePayload {
  last_session: {
    when: string;
    duration: string;
    summary: string;
    tool_calls: number;
  };
  incomplete_work: IncompleteWorkItem[];
  working_state: {
    last_branch: string | null;
    files_modified: number;
    uncommitted_files: string[];
  };
  suggested_next: string;
  use_agent_llm?: boolean;
  agent_llm_prompt?: string;
}

export interface SessionContinuityConfig {
  enabled: boolean;
  level: AssertLevel;
  includeIncompleteWork: boolean;
  maxResumeItems: number;
}

export class SessionContinuityBehavior extends Behavior {
  readonly id = "session_continuity";
  readonly hooks = ["session_start"] as const;
  readonly defaultLevel: AssertLevel = "suggestion";

  private ledger: ShadowLedger | null = null;
  private continuityConfig: SessionContinuityConfig;

  constructor(config?: Partial<SessionContinuityConfig>) {
    super(config, "suggestion");
    this.continuityConfig = {
      enabled: true,
      level: "suggestion",
      includeIncompleteWork: true,
      maxResumeItems: MAX_RESUME_ITEMS,
      ...config,
    };
  }

  attachLedger(ledger: ShadowLedger): void {
    this.ledger = ledger;
  }

  async onSessionStart(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    if (!this.ledger) return null;

    const allEntries = this.ledger.readAllEntries();
    if (allEntries.length === 0) return null;

    const previousSessionEntries = extractPreviousSession(
      allEntries,
      ctx.sessionId
    );
    if (previousSessionEntries.length === 0) return null;

    const resume = buildResumePayload(
      previousSessionEntries,
      this.continuityConfig.maxResumeItems
    );

    if (previousSessionEntries.length > AGENT_LLM_THRESHOLD) {
      resume.use_agent_llm = true;
      resume.agent_llm_prompt = buildAgentLlmPrompt(resume);
    }

    return {
      behaviorId: this.id,
      level: this.level,
      relatedSkillId: "session-context-preservation",
      _meta: {
        behavior: this.id,
        previous_session_entries: previousSessionEntries.length,
        incomplete_items: resume.incomplete_work.length,
      },
      _context: {
        session_resume: resume,
      },
    };
  }
}

function extractPreviousSession(
  allEntries: LedgerEntry[],
  currentSessionId: string
): LedgerEntry[] {
  const sessionIds = new Set<string>();
  for (const entry of allEntries) {
    if (entry.session_id !== currentSessionId) {
      sessionIds.add(entry.session_id);
    }
  }

  if (sessionIds.size === 0) return [];

  let lastSessionId: string | null = null;
  let lastTimestamp = 0;
  for (const entry of allEntries) {
    if (entry.session_id === currentSessionId) continue;
    const ts = new Date(entry.ts).getTime();
    if (ts > lastTimestamp) {
      lastTimestamp = ts;
      lastSessionId = entry.session_id;
    }
  }

  if (!lastSessionId) return [];
  return allEntries.filter((e) => e.session_id === lastSessionId);
}

function buildResumePayload(
  entries: LedgerEntry[],
  maxItems: number
): SessionResumePayload {
  const firstTs = new Date(entries[0]?.ts ?? 0).getTime();
  const lastTs = new Date(entries[entries.length - 1]?.ts ?? 0).getTime();
  const durationMs = lastTs - firstTs;
  const elapsedSinceMs = Date.now() - lastTs;

  const filesModified = new Set<string>();
  const entityModifications = new Map<string, number>();
  const committedEntities = new Set<string>();
  const toolsUsed = new Map<string, number>();
  let lastBranch: string | null = null;

  for (const entry of entries) {
    toolsUsed.set(entry.tool, (toolsUsed.get(entry.tool) ?? 0) + 1);

    if (entry.branch) lastBranch = entry.branch;

    const args = entry.args_summary;
    if (args.files && Array.isArray(args.files)) {
      for (const f of args.files as Array<string | { path: string }>) {
        const path = typeof f === "string" ? f : f.path;
        if (path) filesModified.add(path);
      }
    }

    if (typeof args.key === "string" && args.key.includes("/")) {
      const entityKey = args.key;
      filesModified.add(
        entityKey.includes("::") ? entityKey.split("::")[0]! : entityKey
      );
      entityModifications.set(
        entityKey,
        (entityModifications.get(entityKey) ?? 0) + 1
      );
    }

    if (entry.result_summary?.commit_sha) {
      for (const [key] of entityModifications) {
        committedEntities.add(key);
      }
    }
  }

  const incompleteEntities = [...entityModifications.entries()]
    .filter(([key]) => !committedEntities.has(key) && key !== "")
    .sort(([, a], [, b]) => b - a);

  const incompleteWork: IncompleteWorkItem[] = incompleteEntities
    .slice(0, maxItems)
    .map(([entity, modCount]) => ({
      entity,
      status: `Modified ${modCount} time(s), not committed`,
      remaining: [],
      risk:
        modCount >= 3
          ? ("high" as const)
          : modCount >= 2
            ? ("medium" as const)
            : ("low" as const),
    }));

  const uncommittedFiles = [...filesModified]
    .filter((f) => !committedEntities.has(f))
    .slice(0, 10);

  const topTool = [...toolsUsed.entries()].sort(([, a], [, b]) => b - a)[0];
  const summaryParts: string[] = [];
  if (topTool)
    summaryParts.push(`Primary activity: ${topTool[0]} (${topTool[1]}x)`);
  if (filesModified.size > 0)
    summaryParts.push(`${filesModified.size} file(s) touched`);
  if (incompleteWork.length > 0)
    summaryParts.push(`${incompleteWork.length} incomplete item(s)`);

  const suggestedNext =
    incompleteWork.length > 0
      ? `Complete outstanding work on ${incompleteWork[0]?.entity} (${incompleteWork[0]?.status})`
      : "No outstanding items from last session — ready for new work.";

  return {
    last_session: {
      when: formatElapsed(elapsedSinceMs),
      duration: formatDuration(durationMs),
      summary: summaryParts.join(". "),
      tool_calls: entries.length,
    },
    incomplete_work: incompleteWork,
    working_state: {
      last_branch: lastBranch,
      files_modified: filesModified.size,
      uncommitted_files: uncommittedFiles,
    },
    suggested_next: suggestedNext,
  };
}

function buildAgentLlmPrompt(resume: SessionResumePayload): string {
  const parts: string[] = [
    "Summarize the following session state for the developer in 2-3 natural sentences.",
    "Focus on: what was being worked on, what's incomplete, and what to do next.",
    "",
    `Last session: ${resume.last_session.when} (${resume.last_session.duration}, ${resume.last_session.tool_calls} tool calls)`,
    `Summary: ${resume.last_session.summary}`,
  ];

  if (resume.incomplete_work.length > 0) {
    parts.push("", "Incomplete items:");
    for (const item of resume.incomplete_work) {
      parts.push(`  - ${item.entity}: ${item.status} (risk: ${item.risk})`);
    }
  }

  parts.push("", `Suggested next: ${resume.suggested_next}`);
  return parts.join("\n");
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
