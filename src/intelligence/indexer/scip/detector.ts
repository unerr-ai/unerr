/**
 * SCIP Binary Detector — resolves SCIP indexer binaries.
 *
 * Strategy:
 *   - TypeScript/JavaScript: BUNDLED as npm dependency (@sourcegraph/scip-typescript)
 *   - Python: BUNDLED as npm dependency (@sourcegraph/scip-python)
 *   - Go/Rust: AUTO-DOWNLOADED to ~/.unerr/bin/ on first use,
 *     or detected on PATH if already installed.
 *   - Java: Launcher script downloaded, requires JRE on PATH.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../../../utils/exec.js";
import { getCachedBinaryPath } from "./downloader.js";

export interface ScipBinaryInfo {
  language: string;
  binaryName: string;
  available: boolean;
  bundled: boolean;
  version: string | null;
  path: string | null;
}

/**
 * Bundled SCIP tools — shipped as npm dependencies.
 * These are ALWAYS available after `pnpm install`.
 */
const BUNDLED_SCIP: Record<string, { bin: string; resolveFrom: string }> = {
  typescript: {
    bin: "scip-typescript",
    resolveFrom: "@sourcegraph/scip-typescript",
  },
  python: {
    bin: "scip-python",
    resolveFrom: "@sourcegraph/scip-python",
  },
};

/**
 * External SCIP tools — checked on PATH after download cache.
 * Only languages with SCIP ✓ in README (Tier 1).
 */
const EXTERNAL_SCIP: Record<string, string[]> = {
  go: ["scip-go"],
  java: ["scip-java"],
  rust: ["rust-analyzer"],
  ruby: ["scip-ruby"],
  cpp: ["scip-clang"],
  csharp: ["scip-dotnet"],
};

/**
 * Resolve the path to a bundled SCIP binary.
 * Walks up from this file to find node_modules/.bin/<binary>.
 */
function resolveBundledBinary(binName: string): string | null {
  let dir = import.meta.dirname ?? __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "node_modules", ".bin", binName);
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve a binary of the given name on the current PATH via `which`.
 * Returns its absolute path, or null when it is not on PATH.
 */
async function resolveBinaryOnPath(binName: string): Promise<string | null> {
  try {
    const r = await exec("which", [binName]);
    if (r.exitCode === 0) return r.stdout.trim() || null;
  } catch {
    /* `which` missing or errored — treat as not found */
  }
  return null;
}

/**
 * Detect SCIP binary for a language.
 *
 * Resolution order:
 *   1. Bundled (npm) — TypeScript, Python
 *   2. Download cache (~/.unerr/bin/) — auto-downloaded binaries
 *   3. PATH — user-installed binaries
 *   4. Not available — orchestrator will attempt auto-download
 */
export async function detectScipBinary(
  language: string
): Promise<ScipBinaryInfo> {
  // 1. Check bundled first (TypeScript, Python)
  const bundled = BUNDLED_SCIP[language];
  if (bundled) {
    const binPath = resolveBundledBinary(bundled.bin);
    if (binPath) {
      return {
        language,
        binaryName: bundled.bin,
        available: true,
        bundled: true,
        version: null,
        path: binPath,
      };
    }
    // node_modules resolution failed — the compiled native binary and global
    // installs have no local node_modules/.bin. Fall back to a PATH-installed
    // binary of the same name (a container can `pip install`/`npm i -g` it)
    // before giving up. NEVER claim availability with a bare `npx <bin>`: the
    // runner execs args[0] verbatim, so a "npx scip-python" path spawns a
    // single-token command → ENOENT, and the language is silently dropped.
    // Honest availability lets the orchestrator skip with a clear, fast reason.
    const onPath = await resolveBinaryOnPath(bundled.bin);
    if (onPath) {
      return {
        language,
        binaryName: bundled.bin,
        available: true,
        bundled: false,
        version: null,
        path: onPath,
      };
    }
    return {
      language,
      binaryName: bundled.bin,
      available: false,
      bundled: false,
      version: null,
      path: null,
    };
  }

  // 2. Check download cache (~/.unerr/bin/)
  const cachedPath = getCachedBinaryPath(language);
  if (cachedPath) {
    return {
      language,
      binaryName: cachedPath.split("/").pop() ?? `scip-${language}`,
      available: true,
      bundled: false,
      version: null,
      path: cachedPath,
    };
  }

  // 3. Check external binaries on PATH
  const candidates = EXTERNAL_SCIP[language] ?? [];
  for (const candidate of candidates) {
    try {
      const whichResult = await exec("which", [candidate]);
      if (whichResult.exitCode === 0) {
        const versionResult = await exec(candidate, ["--version"]);
        return {
          language,
          binaryName: candidate,
          available: true,
          bundled: false,
          version:
            versionResult.exitCode === 0
              ? (versionResult.stdout.split("\n")[0]?.trim() ?? null)
              : null,
          path: whichResult.stdout.trim() || null,
        };
      }
    } catch {}
  }

  // 4. Not available — caller should attempt auto-download
  return {
    language,
    binaryName: candidates[0] ?? `scip-${language}`,
    available: false,
    bundled: false,
    version: null,
    path: null,
  };
}

/**
 * Extension → SCIP language mapping.
 * Only languages with SCIP support (Tier 1 with SCIP ✓ in README).
 */
const EXT_TO_SCIP_LANG: Record<string, string> = {
  // TypeScript / JavaScript (scip-typescript handles all)
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",

  // Python
  ".py": "python",
  ".pyi": "python",
  ".pyx": "python",

  // Go
  ".go": "go",

  // Java / Kotlin / Scala (JVM — scip-java handles all)
  ".java": "java",
  ".kt": "java",
  ".kts": "java",
  ".scala": "java",
  ".sc": "java",

  // Rust
  ".rs": "rust",

  // Ruby
  ".rb": "ruby",

  // C / C++ (scip-clang handles both)
  ".c": "cpp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",

  // C#
  ".cs": "csharp",
};

/**
 * Detect the primary language of a project from file extensions.
 * Returns the language with the most source files.
 */
export function detectPrimaryLanguage(files: string[]): string | null {
  const counts: Record<string, number> = {};

  for (const file of files) {
    const dotIdx = file.lastIndexOf(".");
    if (dotIdx === -1) continue;
    const ext = file.slice(dotIdx);
    const lang = EXT_TO_SCIP_LANG[ext];
    if (lang) {
      counts[lang] = (counts[lang] ?? 0) + 1;
    }
  }

  let maxLang: string | null = null;
  let maxCount = 0;
  for (const [lang, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      maxLang = lang;
    }
  }

  return maxLang;
}

/**
 * Detect ALL languages present in the project (for multi-language SCIP).
 * Returns languages sorted by file count (primary first).
 */
export function detectProjectLanguages(
  files: string[]
): { language: string; fileCount: number }[] {
  const counts: Record<string, number> = {};

  for (const file of files) {
    const dotIdx = file.lastIndexOf(".");
    if (dotIdx === -1) continue;
    const ext = file.slice(dotIdx);
    const lang = EXT_TO_SCIP_LANG[ext];
    if (lang) {
      counts[lang] = (counts[lang] ?? 0) + 1;
    }
  }

  return Object.entries(counts)
    .map(([language, fileCount]) => ({ language, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

/**
 * Get all languages that have SCIP support (bundled or detected).
 */
export async function getAvailableScipLanguages(): Promise<ScipBinaryInfo[]> {
  const allLangs = [
    ...Object.keys(BUNDLED_SCIP),
    ...Object.keys(EXTERNAL_SCIP),
  ];
  const results = await Promise.all(allLangs.map(detectScipBinary));
  return results.filter((r) => r.available);
}
