/**
 * Session Narrative Capture — records what was built, why, and how as episodic facts.
 *
 * Works in BOTH `unerr` (daemon) and `unerr --mcp` (headless) modes.
 * Does NOT depend on the behavior framework (which is daemon-only).
 *
 * Two capture points:
 * 1. After each edit-type tool call → captures the investigation chain leading to the edit
 * 2. At session shutdown → synthesizes a session summary
 *
 * All narratives are stored as episodic facts (decay_rate=0.00, never expires).
 */

import type { LedgerEntry } from "../tracking/shadow-ledger.js";

/** Structured narrative for a single edit operation. */
export interface NarrativeEntry {
  file_path: string;
  what: string;
  why: string;
  how: string;
  sequence: string[];
  change_type: string;
}

/** Minimal fact store interface — avoids importing the full TemporalFactStore. */
interface FactStoreWriter {
  createFact(input: {
    fact_type: string;
    scope: string;
    subject: string;
    content: string;
    source: string;
    confidence?: number;
  }): Promise<{ fact_id: string; deduplicated: boolean }>;
}

/** Minimal shadow ledger interface. */
interface LedgerReader {
  getRecentEntries(limit?: number): LedgerEntry[];
  getSessionId(): string;
}

/** Tool intent classification. */
const TOOL_INTENT: Record<string, string> = {
  file_read: "exploration",
  file_outline: "exploration",
  get_entity: "investigation",
  get_references: "investigation",
  get_imports: "investigation",
  search_code: "navigation",
  get_file: "navigation",
  get_conventions: "investigation",
  get_critical_nodes: "analysis",
  get_cross_boundary_links: "analysis",
  get_project_stats: "analysis",
  file_connections: "analysis",
  get_test_coverage: "analysis",
};

/** Edit-type tool names (from agents' built-in tools). */
const EDIT_TOOLS = new Set([
  "file_edit",
  "write_file",
  "edit_file",
  "str_replace_editor",
  "Write",
  "Edit",
]);

/** Extract feature area from file path (second directory segment). */
function extractFeatureArea(filePath: string | undefined): string {
  if (!filePath) return "unknown";
  const parts = filePath.replace(/^\.?\//, "").split("/");
  // "src/proxy/foo.ts" → "proxy", "src/intelligence/bar.ts" → "intelligence"
  return parts.length >= 2 ? (parts[1] ?? "unknown") : (parts[0] ?? "unknown");
}

/** Classify tool intent. */
function classifyToolIntent(toolName: string): string {
  return (
    TOOL_INTENT[toolName] ??
    (EDIT_TOOLS.has(toolName) ? "modification" : "other")
  );
}

/** Summarize a tool call for sequence display. */
function summarizeToolCall(entry: LedgerEntry): string {
  const args = entry.args_summary;
  const key =
    (args.key as string) ??
    (args.entity as string) ??
    (args.file_path as string) ??
    "";
  const shortKey = key.length > 40 ? `...${key.slice(-37)}` : key;
  return shortKey ? `${entry.tool}(${shortKey})` : entry.tool;
}

export class SessionNarrativeCapture {
  private narratives: NarrativeEntry[] = [];
  private filesModified = new Set<string>();

  constructor(
    private factStore: FactStoreWriter,
    private ledger: LedgerReader
  ) {}

  /**
   * Called after each edit-type tool call. Captures the investigation chain
   * leading to the edit as an episodic fact. Non-blocking (caller should use setImmediate).
   */
  async captureEditNarrative(editEntry: LedgerEntry): Promise<void> {
    const filePath =
      (editEntry.args_summary.file_path as string) ??
      (editEntry.args_summary.path as string) ??
      "unknown";
    this.filesModified.add(filePath);

    // Get recent entries in the correlation window (30s before this edit)
    const recent = this.ledger.getRecentEntries(50);
    const editTs = new Date(editEntry.ts).getTime();
    const windowMs = 30_000;

    // Find preceding tool calls in the same correlation window
    const chain = recent.filter((e) => {
      if (e.id === editEntry.id) return false;
      const entryTs = new Date(e.ts).getTime();
      return entryTs >= editTs - windowMs && entryTs <= editTs;
    });

    // Build the narrative from the investigation chain
    const sequence = chain.map(summarizeToolCall);
    sequence.push(summarizeToolCall(editEntry));

    // Derive "what" from the edit target
    const entity =
      (editEntry.args_summary.entity as string) ??
      (editEntry.args_summary.key as string) ??
      "";
    const what = entity
      ? `Modified ${entity} in ${filePath}`
      : `Modified ${filePath}`;

    // Derive "why" from the investigation chain
    const investigationTools = chain.filter(
      (e) => classifyToolIntent(e.tool) === "investigation"
    );
    const why =
      investigationTools.length > 0
        ? `Investigated via ${investigationTools.map((e) => e.tool).join(" → ")} before modifying`
        : "Direct modification";

    // Derive "how" from the sequence
    const how =
      sequence.length > 1
        ? sequence.join(" → ")
        : `Direct edit: ${summarizeToolCall(editEntry)}`;

    const changeType = editEntry.change_type ?? "modification";

    const narrative: NarrativeEntry = {
      file_path: filePath,
      what,
      why,
      how,
      sequence,
      change_type: changeType,
    };
    this.narratives.push(narrative);

    // Store as episodic fact (decay=0.00, never expires)
    const sessionId = this.ledger.getSessionId();
    const content = `What: ${what}. Why: ${why}. How: ${how}. Sequence: ${sequence.join(", ")}`;
    await this.factStore.createFact({
      fact_type: "episodic",
      scope: filePath,
      subject: `edit:${sessionId}:${Date.now()}`,
      content: content.slice(0, 800),
      source: "session_analysis",
      confidence: 0.6,
    });
  }

  /**
   * Called at session shutdown. Synthesizes a session summary from accumulated narratives.
   * Works in both `unerr` and `unerr --mcp` modes.
   */
  async captureSessionSummary(sessionId: string): Promise<{
    narratives: NarrativeEntry[];
    filesModified: string[];
    summary: string;
  }> {
    const files = [...this.filesModified];

    if (this.narratives.length === 0) {
      return {
        narratives: [],
        filesModified: files,
        summary: "No modifications captured.",
      };
    }

    // Group narratives by feature area
    const byArea = new Map<string, NarrativeEntry[]>();
    for (const n of this.narratives) {
      const area = extractFeatureArea(n.file_path);
      let list = byArea.get(area);
      if (!list) {
        list = [];
        byArea.set(area, list);
      }
      list.push(n);
    }

    // Build summary
    const areaSummaries = [...byArea.entries()]
      .map(([area, entries]) => {
        const whats = entries.map((e) => e.what).slice(0, 3);
        return `${area}: ${whats.join("; ")}`;
      })
      .slice(0, 5);

    const summary = `Session modified ${files.length} file(s) across ${byArea.size} area(s). ${areaSummaries.join(". ")}`;

    // Store session summary as episodic fact
    await this.factStore.createFact({
      fact_type: "episodic",
      scope: "project",
      subject: `session:${sessionId}`,
      content: summary.slice(0, 800),
      source: "session_analysis",
      confidence: 0.7,
    });

    return { narratives: this.narratives, filesModified: files, summary };
  }

  /** Get narratives captured so far (for display/API). */
  getNarratives(): NarrativeEntry[] {
    return this.narratives;
  }

  /** Get files modified this session. */
  getFilesModified(): string[] {
    return [...this.filesModified];
  }
}

/**
 * Populate shadow ledger intent fields before append.
 * Call this to derive change_type, feature_area, plan_summary from tool call context.
 */
export function deriveIntentFields(
  toolName: string,
  args: Record<string, unknown>,
  recentEntries: LedgerEntry[]
): { change_type: string; feature_area: string; plan_summary: string } {
  const filePath =
    (args.file_path as string) ??
    (args.path as string) ??
    (args.key as string)?.split("::")[0];

  const change_type = classifyToolIntent(toolName);
  const feature_area = extractFeatureArea(filePath);

  // Build plan summary from last 3-5 tool calls in correlation window
  const lastFew = recentEntries.slice(-5);
  const plan_summary = lastFew.map(summarizeToolCall).join(" → ");

  return { change_type, feature_area, plan_summary };
}
