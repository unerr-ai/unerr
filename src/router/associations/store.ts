/**
 * Sprint P2-5: Association persistence.
 *
 * Writes association records to `.unerr/router/associations.jsonl`.
 * One line per association, append-only. Used by:
 *   - Dashboard (P2-6) to show intelligence associations
 *   - Aggregator to compute weekly summaries
 *   - Replay to verify association detection accuracy
 *
 * Non-blocking writes — persistence failures never crash the proxy.
 */

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import type { AssociationRecord } from "./types.js";

const ASSOCIATIONS_FILE = "associations.jsonl";

export class AssociationStore {
  private readonly filePath: string;
  private initialized = false;

  constructor(unerrDir: string) {
    const dir = join(unerrDir, "router");
    this.filePath = join(dir, ASSOCIATIONS_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.initialized = true;
  }

  /**
   * Append one or more association records.
   * Non-blocking — errors are swallowed (logged elsewhere).
   */
  append(records: readonly AssociationRecord[]): void {
    if (records.length === 0) return;
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    try {
      appendFileSync(this.filePath, lines, "utf-8");
    } catch {
      // Persistence is non-critical — never fatal
    }
  }

  /**
   * Read all association records from disk.
   */
  async readAll(): Promise<readonly AssociationRecord[]> {
    try {
      const body = await fs.readFile(this.filePath, "utf-8");
      const records: AssociationRecord[] = [];
      for (const line of body.split("\n")) {
        if (line.length === 0) continue;
        try {
          records.push(JSON.parse(line) as AssociationRecord);
        } catch {
          // skip malformed
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  /**
   * Read records within a date range.
   */
  async readRange(startTs: string, endTs: string): Promise<readonly AssociationRecord[]> {
    const all = await this.readAll();
    return all.filter((r) => r.ts >= startTs && r.ts <= endTs);
  }

  /**
   * Read records for a specific session.
   */
  async readSession(sessionId: string): Promise<readonly AssociationRecord[]> {
    const all = await this.readAll();
    return all.filter((r) => r.sessionId === sessionId);
  }
}
