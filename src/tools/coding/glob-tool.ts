/**
 * Glob Tool — find files by name patterns.
 * Uses Node.js built-in fs for portability.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveWithHome } from "../../utils/expand-home.js";
import type { Tool, ToolContext, ToolOutput } from "../types.js";

const MAX_RESULTS = 500;
const MAX_DEPTH = 15;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
]);

function matchPattern(filepath: string, pattern: string): boolean {
  // Convert glob to regex: ** → any path, * → any name segment, ? → any char
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex specials
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, "[^/]");

  return (
    new RegExp(`^${regex}$`).test(filepath) ||
    new RegExp(`(^|/)${regex}$`).test(filepath)
  );
}

function walkDir(dir: string, base: string, depth: number): string[] {
  if (depth > MAX_DEPTH) return [];
  const files: string[] = [];

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);
      const rel = relative(base, full);

      if (entry.isDirectory()) {
        files.push(...walkDir(full, base, depth + 1));
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  } catch {
    // Permission denied, etc.
  }

  return files;
}

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Returns matching file paths sorted by modification time. " +
    'Examples: "**/*.ts", "src/**/*.test.ts", "package.json"',
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.tsx")',
      },
      path: {
        type: "string",
        description: "Directory to search in. Default: project root",
      },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  requiresPermission: false,

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolOutput> {
    const pattern = args.pattern as string;
    const searchPath = resolveWithHome(ctx.cwd, (args.path as string) ?? ".");

    if (!existsSync(searchPath)) {
      return {
        content: `Path not found: ${searchPath}. For code lookups, call search_code (entity-aware, no path required) instead.`,
        isError: true,
      };
    }

    const allFiles = walkDir(searchPath, searchPath, 0);
    const matches = allFiles
      .filter((f) => matchPattern(f, pattern))
      .slice(0, MAX_RESULTS);

    // Sort by modification time (newest first)
    const withMtime = matches.map((f) => {
      try {
        const stat = statSync(join(searchPath, f));
        return { path: f, mtime: stat.mtimeMs };
      } catch {
        return { path: f, mtime: 0 };
      }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);

    if (withMtime.length === 0) {
      return {
        content: `No files matching: ${pattern}. For finding code entities by name, call search_code (graph-indexed, no glob pattern required).`,
      };
    }

    const result = withMtime.map((f) => f.path).join("\n");
    const truncated =
      matches.length >= MAX_RESULTS
        ? `\n\n(Truncated at ${MAX_RESULTS} results)`
        : "";
    return { content: result + truncated };
  },
};
