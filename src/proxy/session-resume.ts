/**
 * Session Resume Greeting — generates context from the previous session's
 * shadow ledger data. Injected as the first _context in a new session.
 *
 * Template-based (no LLM). Reads last session entries and produces:
 *   - Files modified and their risk levels
 *   - Incomplete refactors (entities modified but not committed)
 *   - Tool usage patterns (what the agent was doing)
 */

interface LedgerEntryLike {
  id: string;
  ts: string;
  tool: string;
  args_summary: Record<string, unknown>;
  result_summary: Record<string, unknown>;
  branch?: string;
  head_sha?: string;
  session_id?: string;
}

export interface SessionResumeContext {
  summary: string;
  filesModified: string[];
  toolsUsed: Record<string, number>;
  lastBranch: string | null;
  sessionDurationMs: number;
  incompleteEntities: string[];
}

/**
 * Generate a session resume greeting from shadow ledger entries.
 * Uses the last N entries from the previous session.
 */
export function generateSessionResume(
  entries: LedgerEntryLike[],
  maxEntries = 50
): SessionResumeContext | null {
  if (entries.length === 0) return null;

  const recent = entries.slice(-maxEntries);

  const sessionId = recent[recent.length - 1]?.session_id;
  const sessionEntries = sessionId
    ? recent.filter((e) => e.session_id === sessionId)
    : recent;

  if (sessionEntries.length === 0) return null;

  const filesModified = new Set<string>();
  const toolsUsed: Record<string, number> = {};
  const modifiedEntities = new Set<string>();
  const committedEntities = new Set<string>();

  for (const entry of sessionEntries) {
    const tool = entry.tool;
    toolsUsed[tool] = (toolsUsed[tool] ?? 0) + 1;

    const args = entry.args_summary;
    if (args.files && Array.isArray(args.files)) {
      for (const f of args.files as Array<string | { path: string }>) {
        const path = typeof f === "string" ? f : f.path;
        if (path) filesModified.add(path);
      }
    }
    if (typeof args.key === "string" && args.key.includes("/")) {
      const filePath = args.key.includes("::")
        ? args.key.split("::")[0]!
        : args.key;
      filesModified.add(filePath);
    }

    if (tool === "sync_local_diff") {
      if (args.files && Array.isArray(args.files)) {
        for (const f of args.files as Array<string | { path: string }>) {
          modifiedEntities.add(typeof f === "string" ? f : (f.path ?? ""));
        }
      }
    }

    if (entry.result_summary?.commit_sha) {
      for (const e of modifiedEntities) committedEntities.add(e);
    }
  }

  const incompleteEntities = [...modifiedEntities].filter(
    (e) => !committedEntities.has(e) && e !== ""
  );

  const firstTs = sessionEntries[0]?.ts;
  const lastTs = sessionEntries[sessionEntries.length - 1]?.ts;
  const sessionDurationMs =
    firstTs && lastTs
      ? new Date(lastTs).getTime() - new Date(firstTs).getTime()
      : 0;

  const lastBranch = sessionEntries[sessionEntries.length - 1]?.branch ?? null;

  const parts: string[] = [];
  parts.push(
    `Last session: ${sessionEntries.length} tool calls over ${formatDuration(sessionDurationMs)}`
  );

  if (filesModified.size > 0) {
    const fileList = [...filesModified].slice(0, 5);
    parts.push(
      `Modified ${filesModified.size} file(s): ${fileList.join(", ")}${filesModified.size > 5 ? ` (+${filesModified.size - 5} more)` : ""}`
    );
  }

  if (incompleteEntities.length > 0) {
    parts.push(
      `Uncommitted changes in: ${incompleteEntities.slice(0, 3).join(", ")}`
    );
  }

  if (lastBranch) {
    parts.push(`Branch: ${lastBranch}`);
  }

  return {
    summary: `${parts.join(". ")}.`,
    filesModified: [...filesModified],
    toolsUsed,
    lastBranch,
    sessionDurationMs,
    incompleteEntities,
  };
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
