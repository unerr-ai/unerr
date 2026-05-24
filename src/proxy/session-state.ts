/**
 * Per-session router state — the only mutable surface the gateway exposes.
 *
 * Every MCP session (one bridge↔proxy connection) owns one `SessionState`.
 * It accumulates structural signals from outgoing responses, monotonically
 * grows the set of exposed tools, and answers questions the unlock
 * evaluator asks of it. Nothing here performs I/O; the persistence side
 * is delegated to `ToolExposureStore`.
 *
 * Monotonicity guarantee — once a tool is in `_exposedTools`, it never
 * leaves. The MCP `tools/list_changed` contract treats list shrinkage as
 * undefined behaviour for several clients (and outright crashes Codex),
 * so we never remove. `nextDelta()` returns only newly-added entries.
 *
 * All accumulators are bounded:
 *   - `_urTags`             ≤ 9   (the canonical tag set)
 *   - `_filesByDir`         ≤ MAX_DIRS_TRACKED (configurable; default 64)
 *   - `_toolCallCounts`     ≤ 19  (one per tool name)
 *   - `_intentMarkerCounts` ≤ 4   (intent/decision/blocker/resolution)
 * Per-session memory is therefore O(#dirs touched) — capped — and never
 * grows unbounded under adversarial input.
 */

import { toolsByTier } from "./tool-descriptions.js";
import type { IntentMarkerType, UrTag } from "./tool-tiers.js";

/**
 * Maximum distinct directories tracked for the `FilesInSameDirAtLeast`
 * heuristic. Beyond this, additional directories are dropped silently —
 * the condition only fires on the *max* count, so dropping the tail is
 * safe. 64 covers every realistic repo (`src/`, `test/`, plus 60 module
 * subtrees) while keeping the Map small.
 */
const MAX_DIRS_TRACKED = 64;

/**
 * Threshold for "non-trivial action" without an edit/write. Used by the
 * `NonTrivialActionObserved` condition. Five distinct file reads is the
 * empirical knee where a session is doing real exploration vs. a one-shot
 * lookup; tier-3 tools (intent markers) gate behind this so trivial
 * sessions don't see them.
 */
const NON_TRIVIAL_READ_THRESHOLD = 5;

/**
 * Signals extracted from a single outgoing tool response. The router
 * collects these via `proxy.ts` after each `callTool` completes and
 * hands them to `SessionState.recordCall()` synchronously.
 *
 * Every field is optional — extractors only populate what they observe.
 * Absent fields are treated as "no signal" (not "signal absent"); the
 * evaluator never reads an undefined field as false.
 */
export interface CallSignals {
  /** The tool that just responded. Required — drives `toolCallCount`. */
  readonly toolName: string;
  /**
   * `ur|<tag>` prefix tags observed on this response's body, in order.
   * Duplicates allowed; the state stores them as a Set.
   */
  readonly urTags?: readonly UrTag[];
  /**
   * Highest entity fan_in surfaced by this response (from get_entity,
   * get_critical_nodes, get_references payloads). The state tracks the
   * max-ever-seen; smaller subsequent values are ignored.
   */
  readonly entityFanIn?: number;
  /**
   * Number of imports in the file this response describes (from
   * file_outline, file_read with import enumeration). Same max-tracking.
   */
  readonly fileImports?: number;
  /**
   * Absolute file path accessed by this call (file_read, file_outline,
   * file_connections). Used for the FilesInSameDir heuristic and the
   * NonTrivialActionObserved threshold. May be repeated; the state
   * deduplicates internally.
   */
  readonly filePath?: string;
  /**
   * True when the response describes a file under a test directory or
   * with a recognised test suffix. The extractor (in proxy.ts) decides;
   * we don't re-classify here.
   */
  readonly testFile?: boolean;
  /**
   * True when this call was an Edit or Write attempt (not necessarily
   * successful). Drives the `EditOrWriteAttempted` condition and bumps
   * `nonTrivialActionObserved` immediately.
   */
  readonly editOrWrite?: boolean;
  /**
   * True when file_read returned a truncated body (response_envelope
   * sets `_truncated: true` or includes a `ur|pg` page hint).
   */
  readonly fileReadTruncated?: boolean;
  /**
   * Intent-marker writes only. When a mark_* tool succeeds, the proxy
   * sets this to the marker's category. `null` / undefined for every
   * other tool.
   */
  readonly intentMarker?: IntentMarkerType;
  /**
   * True when a prior-session fact was surfaced (ur|fct on
   * file_read / recall_facts). Distinct from `urTags` because the
   * condition is independent of whether the tag actually got emitted
   * in the prefix (a recall_facts row count > 0 also counts).
   */
  readonly priorSessionFactSurfaced?: boolean;
}

/**
 * `SessionState` — single-session mutable bag.
 *
 * Construction order:
 *   1. `new SessionState()` — auto-exposes every tier 1 tool.
 *   2. `recordCall(signals)` after each MCP response.
 *   3. `advanceTurn()` once per JSON-RPC `tools/call` round-trip end.
 *   4. The unlock evaluator reads the getter methods listed in
 *      tool-tiers.ts's Condition doc-comment.
 *
 * Thread-safety: not safe across workers. Each bridge↔proxy connection
 * owns its own instance, and the proxy serializes tool calls per
 * connection, so a single owning thread is the only writer.
 */
export class SessionState {
  private readonly _exposedTools: Set<string>;
  private readonly _urTags = new Set<UrTag>();
  private readonly _toolCallCounts = new Map<string, number>();
  private readonly _intentMarkerCounts = new Map<IntentMarkerType, number>();
  private readonly _filesAccessed = new Set<string>();
  private readonly _filesByDir = new Map<string, number>();

  private _maxEntityFanIn = 0;
  private _maxFileImports = 0;
  private _testFileSeen = false;
  private _editOrWriteAttempted = false;
  private _fileReadTruncatedSeen = false;
  private _priorSessionFactSurfaced = false;
  private _turnCount = 0;

  constructor() {
    this._exposedTools = new Set<string>(toolsByTier(1));
  }

  // ── Mutation ────────────────────────────────────────────────────────────

  /**
   * Fold one response's signals into the session. Idempotent on repeats
   * (urTags/file paths dedupe; max-trackers only grow). Always O(1) per
   * field; the dir bookkeeping is O(1) amortised given `MAX_DIRS_TRACKED`.
   */
  recordCall(signals: CallSignals): void {
    this._toolCallCounts.set(
      signals.toolName,
      (this._toolCallCounts.get(signals.toolName) ?? 0) + 1
    );

    if (signals.urTags) {
      for (const tag of signals.urTags) {
        this._urTags.add(tag);
      }
    }

    if (
      signals.entityFanIn !== undefined &&
      signals.entityFanIn > this._maxEntityFanIn
    ) {
      this._maxEntityFanIn = signals.entityFanIn;
    }

    if (
      signals.fileImports !== undefined &&
      signals.fileImports > this._maxFileImports
    ) {
      this._maxFileImports = signals.fileImports;
    }

    if (signals.filePath && !this._filesAccessed.has(signals.filePath)) {
      this._filesAccessed.add(signals.filePath);
      const dir = directoryOf(signals.filePath);
      if (this._filesByDir.has(dir)) {
        this._filesByDir.set(dir, (this._filesByDir.get(dir) ?? 0) + 1);
      } else if (this._filesByDir.size < MAX_DIRS_TRACKED) {
        this._filesByDir.set(dir, 1);
      }
      // If size === MAX_DIRS_TRACKED and dir is new: drop silently.
      // The condition uses the max, so unseen dirs don't matter.
    }

    if (signals.testFile) this._testFileSeen = true;
    if (signals.editOrWrite) this._editOrWriteAttempted = true;
    if (signals.fileReadTruncated) this._fileReadTruncatedSeen = true;
    if (signals.priorSessionFactSurfaced) {
      this._priorSessionFactSurfaced = true;
    }

    if (signals.intentMarker) {
      this._intentMarkerCounts.set(
        signals.intentMarker,
        (this._intentMarkerCounts.get(signals.intentMarker) ?? 0) + 1
      );
    }
  }

  /** Bump the turn counter. Called once per `tools/call` round-trip. */
  advanceTurn(): void {
    this._turnCount += 1;
  }

  /**
   * Atomically add a set of tool names to the exposed surface. Returns
   * the subset that was actually newly added (already-exposed names are
   * filtered out). The caller — `unlock-evaluator.ts` — uses this delta
   * to (a) emit `tools/list_changed` and (b) persist the unlock event.
   */
  expose(toolNames: readonly string[]): readonly string[] {
    const added: string[] = [];
    for (const name of toolNames) {
      if (!this._exposedTools.has(name)) {
        this._exposedTools.add(name);
        added.push(name);
      }
    }
    return added;
  }

  // ── Read-only views consumed by the unlock evaluator ───────────────────

  exposedTools(): ReadonlySet<string> {
    return this._exposedTools;
  }

  isExposed(toolName: string): boolean {
    return this._exposedTools.has(toolName);
  }

  hasUrTag(tag: UrTag): boolean {
    return this._urTags.has(tag);
  }

  maxEntityFanInSeen(): number {
    return this._maxEntityFanIn;
  }

  maxFileImportsSeen(): number {
    return this._maxFileImports;
  }

  maxFilesPerDirSeen(): number {
    let max = 0;
    for (const n of this._filesByDir.values()) {
      if (n > max) max = n;
    }
    return max;
  }

  testFileSeen(): boolean {
    return this._testFileSeen;
  }

  filesAccessedCount(): number {
    return this._filesAccessed.size;
  }

  editOrWriteAttempted(): boolean {
    return this._editOrWriteAttempted;
  }

  fileReadTruncatedSeen(): boolean {
    return this._fileReadTruncatedSeen;
  }

  intentMarkerCount(type: IntentMarkerType): number {
    return this._intentMarkerCounts.get(type) ?? 0;
  }

  toolCallCount(name: string): number {
    return this._toolCallCounts.get(name) ?? 0;
  }

  priorSessionFactSurfaced(): boolean {
    return this._priorSessionFactSurfaced;
  }

  turnCount(): number {
    return this._turnCount;
  }

  /**
   * "Non-trivial action" — either an edit/write was attempted, or the
   * agent has read ≥ NON_TRIVIAL_READ_THRESHOLD distinct files. Used to
   * gate tier-3 intent markers behind real session activity.
   */
  nonTrivialActionObserved(): boolean {
    return (
      this._editOrWriteAttempted ||
      this._filesAccessed.size >= NON_TRIVIAL_READ_THRESHOLD
    );
  }
}

/**
 * Extract the immediate parent directory of a file path. POSIX and Win32
 * both use `/` for path normalisation here because the proxy stores file
 * paths as POSIX strings (see local-graph normalisation). A path with no
 * separator is treated as living in the synthetic root `""`.
 */
function directoryOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "" : filePath.slice(0, idx);
}
