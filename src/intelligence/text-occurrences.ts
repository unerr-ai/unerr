/**
 * Word-boundary literal sweep for a symbol name — the textual occurrences a
 * callers-only graph structurally cannot see (a name baked into a test-fixture
 * string, a config key, a dynamic-dispatch string). A safe rename must update
 * these too, so `get_references` pairs its semantic callers with this sweep when
 * the agent signals rename intent. Matching is whole-word and case-sensitive
 * (the `-w -F` ripgrep convention) so `userId` never flags `getUserId`.
 *
 */

import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const MAX_DEPTH = 12;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".unerr",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "vendor",
]);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cs",
  ".swift",
  ".kt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".md",
]);

export interface TextOccurrence {
  file: string;
  line: number;
  preview: string;
}

export interface TextOccurrenceResult {
  matches: TextOccurrence[];
  total: number;
  truncated: boolean;
}

/** Escape a symbol name for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission denied, race with a delete, etc.
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, depth + 1, out);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      if (TEXT_EXTENSIONS.has(entry.name.slice(dot))) out.push(full);
    }
  }
}

/**
 * Find whole-word, case-sensitive occurrences of `name` across the project's
 * source/config/doc files, excluding any path already covered by the call graph
 * (`excludeRelPaths`, repo-relative). Returns up to `cap` matches plus the true
 * total, so the caller can report "N textual occurrences not in the call graph".
 * Best-effort and bounded — never throws.
 */
export function findTextOccurrences(
  projectRoot: string,
  name: string,
  excludeRelPaths: Set<string>,
  cap = 25
): TextOccurrenceResult {
  if (!name) return { matches: [], total: 0, truncated: false };
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  const files: string[] = [];
  walk(projectRoot, 0, files);

  const matches: TextOccurrence[] = [];
  let total = 0;
  for (const full of files) {
    const rel = relative(projectRoot, full);
    if (excludeRelPaths.has(rel)) continue;
    let content: string;
    try {
      content = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    // Cheap reject before the per-line scan.
    if (!content.includes(name)) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (text === undefined || !re.test(text)) continue;
      total++;
      if (matches.length < cap) {
        matches.push({
          file: rel,
          line: i + 1,
          preview: text.trim().slice(0, 160),
        });
      }
    }
  }
  return { matches, total, truncated: total > matches.length };
}
