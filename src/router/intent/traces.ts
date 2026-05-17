/**
 * Sprint P2-1: Intent trace persistence.
 *
 * Records every scorer invocation (scores, exposure decisions, latency)
 * into `.unerr/router/intent-traces/` as JSONL files. One file per
 * session (named by session ID). Used for:
 *   - Dashboard intent viewer (P2-6)
 *   - Replay command (P2 CLI)
 *   - Accuracy analysis (P2-4)
 *
 * Non-blocking writes — trace failures are logged, never fatal.
 */

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import type { ScorerOutput } from "./scorer.js";

export interface IntentTrace {
  readonly ts: string;
  readonly turnNumber: number;
  readonly sessionId: string;
  readonly scores: readonly {
    family: string;
    score: number;
    exposed: boolean;
    sticky: boolean;
    reasons: readonly string[];
  }[];
  readonly exposedFamilies: readonly string[];
  readonly multiDomain: boolean;
  readonly latencyMs: number;
  readonly budgetExceeded: boolean;
  readonly triggerTool?: string;
}

export class IntentTraceWriter {
  private readonly dir: string;
  private initialized = false;

  constructor(unerrDir: string) {
    this.dir = join(unerrDir, "router", "intent-traces");
  }

  /**
   * Record a scorer output as a trace entry.
   * Non-blocking: appends to session JSONL file.
   */
  record(
    sessionId: string,
    turnNumber: number,
    output: ScorerOutput,
    triggerTool?: string,
  ): void {
    this.ensureDir();

    const trace: IntentTrace = {
      ts: new Date().toISOString(),
      turnNumber,
      sessionId,
      scores: output.scores.map((s) => ({
        family: s.family,
        score: s.score,
        exposed: s.exposed,
        sticky: s.sticky,
        reasons: s.reasons,
      })),
      exposedFamilies: [...output.exposedFamilies],
      multiDomain: output.multiDomain,
      latencyMs: output.latencyMs,
      budgetExceeded: output.budgetExceeded,
      triggerTool,
    };

    const filePath = join(this.dir, `${sessionId}.jsonl`);

    try {
      appendFileSync(filePath, JSON.stringify(trace) + "\n", "utf-8");
    } catch {
      // Trace persistence is non-critical — never fatal
    }
  }

  /**
   * Read all traces for a session.
   */
  async readSession(sessionId: string): Promise<readonly IntentTrace[]> {
    const filePath = join(this.dir, `${sessionId}.jsonl`);
    try {
      const body = await fs.readFile(filePath, "utf-8");
      const traces: IntentTrace[] = [];
      for (const line of body.split("\n")) {
        if (line.length === 0) continue;
        try {
          traces.push(JSON.parse(line) as IntentTrace);
        } catch {
          // skip malformed
        }
      }
      return traces;
    } catch {
      return [];
    }
  }

  /**
   * List all session trace files.
   */
  async listSessions(): Promise<readonly string[]> {
    this.ensureDir();
    try {
      const files = await fs.readdir(this.dir);
      return files
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(".jsonl", ""));
    } catch {
      return [];
    }
  }

  private ensureDir(): void {
    if (this.initialized) return;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    this.initialized = true;
  }
}
