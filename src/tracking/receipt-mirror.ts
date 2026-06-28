/**
 * Receipt Mirror — durable append-only JSONL mirror for metric events.
 *
 * Writes every metric event to `.unerr/state/receipt-events.jsonl`, a path
 * the cloud-drain pipeline never touches. This lets the Stop-hook receipt
 * builder read events even after the cloud pipeline truncates proxy.jsonl.
 *
 * @sem domain=tracking role=mirror
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Returns the absolute path of the receipt mirror file for a given repo root.
 */
export function receiptMirrorPath(repoRoot: string): string {
  return join(repoRoot, ".unerr", "state", "receipt-events.jsonl");
}

/**
 * Appends a single event object as a JSON line to the receipt mirror.
 * Creates the parent directory if needed. Swallows all I/O errors.
 */
export function appendReceiptMirror(repoRoot: string, ev: unknown): void {
  try {
    const path = receiptMirrorPath(repoRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(ev) + "\n");
  } catch {
    // telemetry must never throw into the write path
  }
}

/**
 * Trims the receipt mirror to remove events older than retentionMs and
 * optionally cap the line count. Writes atomically via a .tmp file.
 * Swallows all I/O errors. A line with an unparseable ts is always kept.
 */
export function trimReceiptMirror(
  repoRoot: string,
  opts: { retentionMs: number; now?: number; maxLines?: number }
): void {
  try {
    const path = receiptMirrorPath(repoRoot);
    if (!existsSync(path)) return;

    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return;

    const cutoff = (opts.now ?? Date.now()) - opts.retentionMs;

    // Keep a line when its ts is unparseable OR its age is within retentionMs.
    let kept = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line) as { ts?: unknown };
        if (typeof parsed.ts !== "string") return true; // unparseable ts → keep
        const age = Date.parse(parsed.ts);
        if (Number.isNaN(age)) return true; // unparseable ts → keep
        return age >= cutoff;
      } catch {
        return true; // torn/corrupt line → keep
      }
    });

    if (opts.maxLines !== undefined && kept.length > opts.maxLines) {
      kept = kept.slice(kept.length - opts.maxLines);
    }

    // Nothing was dropped — still rewrite for simplicity, but skip empty files.
    const tmp = path + ".tmp";
    writeFileSync(tmp, kept.map((l) => l + "\n").join(""));
    renameSync(tmp, path);
  } catch {
    // swallow all errors
  }
}
