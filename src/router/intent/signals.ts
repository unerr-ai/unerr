/**
 * Sprint P2-1: Signal collector.
 *
 * Aggregates all available session signals into a unified structure
 * consumed by the intent scorer. Signals are:
 *
 *   1. Recent files (last 10 accessed/edited file paths)
 *   2. Graph entities (entities with family tags from import-walking)
 *   3. ur|<tag> events (recent signal prefix emissions)
 *   4. Intent markers (mark_intent text content)
 *   5. Recent tool calls (tool family history for stickiness)
 *   6. Shell drift events (cd to different directories)
 *
 * The collector is stateful per session — it accumulates signals as
 * the agent works. The scorer reads the current snapshot each time
 * it needs to compute family scores.
 */

import { type StickinessState, createStickinessState, recordFamilyCall, advanceTurn } from "./stickiness.js";
import { type DecayState, createEmptyDecayState } from "./threshold-decay.js";
import { resolveFamiliesFromImports } from "./library-families.js";

export interface SignalEvent {
  readonly type: "file" | "entity" | "ur_tag" | "intent_marker" | "tool_call" | "shell_drift";
  readonly value: string;
  readonly family?: string;
  readonly turnNumber: number;
  readonly ts: number;
}

export interface CollectedSignals {
  readonly recentFiles: readonly string[];
  readonly entityFamilyTags: ReadonlyMap<string, ReadonlySet<string>>;
  readonly recentToolFamilies: readonly string[];
  readonly intentMarkers: readonly string[];
  readonly urTagEvents: readonly string[];
  readonly shellDriftPaths: readonly string[];
  readonly stickinessState: StickinessState;
  readonly decayState: DecayState;
  readonly currentTurn: number;
}

const MAX_RECENT_FILES = 10;
const MAX_TOOL_HISTORY = 20;
const MAX_EVENTS = 100;

export class SignalCollector {
  private files: string[] = [];
  private entityTags = new Map<string, Set<string>>();
  private toolFamilies: string[] = [];
  private intentMarkers: string[] = [];
  private urTags: string[] = [];
  private shellDrifts: string[] = [];
  private stickinessState: StickinessState;
  private decayState: DecayState;
  private turn = 0;
  private events: SignalEvent[] = [];

  constructor(decayState?: DecayState) {
    this.stickinessState = createStickinessState();
    this.decayState = decayState ?? createEmptyDecayState();
  }

  /**
   * Record a file access/edit event.
   */
  recordFile(filePath: string): void {
    const idx = this.files.indexOf(filePath);
    if (idx !== -1) this.files.splice(idx, 1);
    this.files.unshift(filePath);
    if (this.files.length > MAX_RECENT_FILES) this.files.pop();

    this.pushEvent({ type: "file", value: filePath, turnNumber: this.turn, ts: Date.now() });
  }

  /**
   * Record entity family tags discovered via import-graph walking.
   */
  recordEntityFamilies(entityName: string, imports: readonly string[]): void {
    const families = resolveFamiliesFromImports(imports);
    if (families.size > 0) {
      this.entityTags.set(entityName, families as Set<string>);
      this.pushEvent({ type: "entity", value: entityName, turnNumber: this.turn, ts: Date.now() });
    }
  }

  /**
   * Record entity with pre-resolved family tags.
   */
  recordEntityTags(entityName: string, families: ReadonlySet<string>): void {
    if (families.size > 0) {
      this.entityTags.set(entityName, new Set(families));
    }
  }

  /**
   * Record a tool call and its associated family.
   */
  recordToolCall(family: string): void {
    this.toolFamilies.unshift(family);
    if (this.toolFamilies.length > MAX_TOOL_HISTORY) this.toolFamilies.pop();
    this.stickinessState = recordFamilyCall(this.stickinessState, family, this.turn);
    this.pushEvent({ type: "tool_call", value: family, family, turnNumber: this.turn, ts: Date.now() });
  }

  /**
   * Record an intent marker (from mark_intent).
   */
  recordIntentMarker(text: string): void {
    this.intentMarkers.unshift(text);
    if (this.intentMarkers.length > 10) this.intentMarkers.pop();
    this.pushEvent({ type: "intent_marker", value: text, turnNumber: this.turn, ts: Date.now() });
  }

  /**
   * Record a ur|<tag> event emission.
   */
  recordUrTag(tagLine: string): void {
    this.urTags.unshift(tagLine);
    if (this.urTags.length > 20) this.urTags.pop();
    this.pushEvent({ type: "ur_tag", value: tagLine, turnNumber: this.turn, ts: Date.now() });
  }

  /**
   * Record shell drift (directory change).
   */
  recordShellDrift(path: string): void {
    this.shellDrifts.unshift(path);
    if (this.shellDrifts.length > 5) this.shellDrifts.pop();
    this.pushEvent({ type: "shell_drift", value: path, turnNumber: this.turn, ts: Date.now() });
  }

  /**
   * Advance the turn counter. Call once per agent turn.
   */
  advanceTurn(): void {
    this.turn++;
    this.stickinessState = advanceTurn(this.stickinessState);
  }

  /**
   * Get the current snapshot of all collected signals.
   * This is the input consumed by the scorer.
   */
  getSnapshot(): CollectedSignals {
    return {
      recentFiles: [...this.files],
      entityFamilyTags: new Map(this.entityTags),
      recentToolFamilies: [...this.toolFamilies],
      intentMarkers: [...this.intentMarkers],
      urTagEvents: [...this.urTags],
      shellDriftPaths: [...this.shellDrifts],
      stickinessState: this.stickinessState,
      decayState: this.decayState,
      currentTurn: this.turn,
    };
  }

  /**
   * Get all recorded events (for trace persistence).
   */
  getEvents(): readonly SignalEvent[] {
    return this.events;
  }

  get currentTurn(): number {
    return this.turn;
  }

  private pushEvent(event: SignalEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }
}
