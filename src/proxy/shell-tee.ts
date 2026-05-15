/**
 * Shell output tee — persists full raw output to disk when compression is significant.
 * Enables recovery of full context when compressed output is insufficient.
 */

import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface TeeResult {
  filePath: string;
  sizeBytes: number;
}

const MAX_TEE_FILES = 50;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

function commandSlug(cmd: string): string {
  return cmd
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("-")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 40);
}

/**
 * Writes full shell output to `.unerr/tee/<ts>-<slug>.txt` when:
 * - compression ratio > 30%
 * - raw size > 1KB
 *
 * Returns null if thresholds are not met or write fails.
 */
export function teeShellOutput(
  cwd: string,
  command: string,
  raw: string,
  compressed: string
): TeeResult | null {
  const ratio = 1 - compressed.length / raw.length;
  if (ratio < 0.3 || raw.length < 1024) return null;

  const teeDir = join(cwd, ".unerr", "tee");
  try {
    mkdirSync(teeDir, { recursive: true });
  } catch {
    // already exists
  }

  const slug = commandSlug(command);
  const ts = Date.now();
  const filename = `${ts}-${slug}.txt`;
  const filePath = join(teeDir, filename);

  const header = [
    "# unerr tee — full shell output",
    `# command: ${command}`,
    `# captured: ${new Date(ts).toISOString()}`,
    `# raw_bytes: ${raw.length}  compressed_bytes: ${compressed.length}  ratio: ${(ratio * 100).toFixed(1)}%`,
    "# ---",
    "",
  ].join("\n");

  const content = header + raw;

  try {
    writeFileSync(filePath, content, "utf8");
  } catch {
    return null;
  }

  cleanupOldTees(teeDir);

  return { filePath, sizeBytes: content.length };
}

/**
 * Removes tee files older than `maxAgeMs` and keeps at most `MAX_TEE_FILES`.
 * Returns the number of files deleted.
 */
export function cleanupOldTees(teeDir: string, maxAgeMs = MAX_AGE_MS): number {
  let deleted = 0;
  let entries: { name: string; mtime: number; path: string }[] = [];

  try {
    entries = readdirSync(teeDir)
      .filter((f) => f.endsWith(".txt"))
      .map((name) => {
        const p = join(teeDir, name);
        try {
          const { mtimeMs } = statSync(p);
          return { name, mtime: mtimeMs, path: p };
        } catch {
          return { name, mtime: 0, path: p };
        }
      });
  } catch {
    return 0;
  }

  const now = Date.now();

  // Delete files older than maxAgeMs
  for (const e of entries) {
    if (now - e.mtime > maxAgeMs) {
      try {
        unlinkSync(e.path);
        deleted++;
      } catch {
        // ignore
      }
    }
  }

  // Keep at most MAX_TEE_FILES (newest first)
  const remaining = entries
    .filter((e) => now - e.mtime <= maxAgeMs)
    .sort((a, b) => b.mtime - a.mtime);

  if (remaining.length > MAX_TEE_FILES) {
    for (const e of remaining.slice(MAX_TEE_FILES)) {
      try {
        unlinkSync(e.path);
        deleted++;
      } catch {
        // ignore
      }
    }
  }

  return deleted;
}
