/**
 * Grep Tool — search file contents using regex patterns.
 * Uses Node.js built-in fs for portability (no ripgrep dependency).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../types.js";

const MAX_RESULTS = 200;
const MAX_DEPTH = 10;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".zip",
  ".tar",
  ".gz",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".node",
  ".wasm",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
]);

function walkFiles(dir: string, depth: number, glob?: string): string[] {
  if (depth > MAX_DEPTH) return [];
  const files: string[] = [];

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && SKIP_DIRS.has(entry.name)) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkFiles(full, depth + 1, glob));
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (BINARY_EXTENSIONS.has(ext)) continue;
        if (glob && !matchGlob(entry.name, glob)) continue;
        files.push(full);
      }
    }
  } catch {
    // Permission denied, etc.
  }

  return files;
}

function matchGlob(filename: string, pattern: string): boolean {
  // Simple glob: *.ts, *.{ts,tsx}, etc.
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*")
    .replace(
      /\{([^}]+)\}/g,
      (_, alts: string) => `(${alts.split(",").join("|")})`,
    );
  return new RegExp(`^${regex}$`).test(filename);
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers. " +
    "Use the glob parameter to filter by file type (e.g., '*.ts', '*.{ts,tsx}').",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression pattern to search for",
      },
      path: {
        type: "string",
        description: "Directory or file to search in. Default: project root",
      },
      glob: {
        type: "string",
        description: "Glob pattern to filter files (e.g., '*.ts')",
      },
      case_insensitive: {
        type: "boolean",
        description: "Case insensitive search. Default: false",
      },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  requiresPermission: false,

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const pattern = args.pattern as string;
    const searchPath = resolve(ctx.cwd, (args.path as string) ?? ".");
    const glob = args.glob as string | undefined;
    const caseInsensitive = (args.case_insensitive as boolean) ?? false;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? "gi" : "g");
    } catch (err) {
      return {
        content: `Invalid regex: ${pattern}. Check pattern escaping. For matching code entity names, call search_code instead — it handles identifiers natively without regex.`,
        isError: true,
      };
    }

    if (!existsSync(searchPath)) {
      return {
        content: `Path not found: ${searchPath}. For code searches, call search_code (entity-aware, no path required) instead.`,
        isError: true,
      };
    }

    const stat = statSync(searchPath);
    const files = stat.isFile() ? [searchPath] : walkFiles(searchPath, 0, glob);

    const matches: string[] = [];

    for (const file of files) {
      if (matches.length >= MAX_RESULTS) break;

      try {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_RESULTS) break;
          // biome-ignore lint/style/noNonNullAssertion: index within bounds
          const line = lines[i]!;
          if (regex.test(line)) {
            const relPath = relative(ctx.cwd, file);
            matches.push(`${relPath}:${i + 1}: ${line}`);
          }
          regex.lastIndex = 0; // Reset global regex
        }
      } catch {
        // Binary file or read error — skip
      }
    }

    if (matches.length === 0) {
      return {
        content: `No matches found for pattern: ${pattern}. If you were searching for a code entity by name, call search_code (graph-indexed, finds renames + indirect refs that regex misses).`,
      };
    }

    const truncated =
      matches.length >= MAX_RESULTS
        ? `\n\n(Truncated at ${MAX_RESULTS} results)`
        : "";
    return { content: matches.join("\n") + truncated };
  },
};
