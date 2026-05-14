/**
 * Layer 6 Sprint FE-F — persist approximate shell compression savings for `unerr status`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OutputCategory } from "./shell-classifier.js";

export interface ShellCompressionAggregate {
  totalEvents: number;
  tokensSavedApprox: number;
  byCategory: Record<string, { events: number; savedApprox: number }>;
  updatedAt: string;
}

/** Shared token estimate (~chars/4) for shell I/O and quality ratios. */
export function estimateRoughTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

export function recordShellCompressionEvent(
  cwd: string,
  category: OutputCategory,
  original: string,
  compressed: string,
): void {
  try {
    const dir = join(cwd, ".unerr", "state");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "shell_compression_stats.json");
    const origT = estimateRoughTokens(original);
    const outT = estimateRoughTokens(compressed);
    const saved = Math.max(0, origT - outT);

    let agg: ShellCompressionAggregate = {
      totalEvents: 0,
      tokensSavedApprox: 0,
      byCategory: {},
      updatedAt: new Date().toISOString(),
    };
    if (existsSync(path)) {
      agg = {
        ...agg,
        ...(JSON.parse(
          readFileSync(path, "utf-8"),
        ) as ShellCompressionAggregate),
      };
    }
    agg.totalEvents++;
    agg.tokensSavedApprox += saved;
    const prev = agg.byCategory[category] ?? { events: 0, savedApprox: 0 };
    agg.byCategory[category] = {
      events: prev.events + 1,
      savedApprox: prev.savedApprox + saved,
    };
    agg.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(agg));
  } catch {
    /* ignore */
  }
}

export function readShellCompressionAggregate(
  cwd: string,
): ShellCompressionAggregate | null {
  try {
    const path = join(cwd, ".unerr", "state", "shell_compression_stats.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as ShellCompressionAggregate;
  } catch {
    return null;
  }
}
