/**
 * Drift-pattern detector for the Tier 1 nudge system (Nudge v2 / N2).
 *
 * Pure function — no I/O, no state. Given a shell command string, returns
 * either null (no drift) or a structured suggestion describing what unerr
 * MCP tool would have been a better choice.
 *
 * Patterns are kept conservative: only fire when the command CLEARLY
 * targets code, so we don't false-positive on log greps or generic file
 * listings.
 */

export type DriftKind =
  | "code_search" // grep / rg / find -name on code
  | "code_read" // cat / head / tail / less on a code file
  | "dir_explore"; // ls -R on a source directory

export interface DriftHint {
  kind: DriftKind;
  /** Short, ready-to-use suggestion the agent can paste into its next call. */
  suggest: string;
  /** Optional argument extracted from the offending command (e.g. the search term). */
  arg?: string;
}

const CODE_EXTENSIONS_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|cs|cpp|c|h|hpp|php|scala|ex|exs|lua|dart|zig|sh|bash|zsh)$/i;

// `/` is included in the prefix class so absolute paths like
// `/Users/foo/repo/src/proxy/` also match — agents often grep into source
// trees by absolute path, and those should fire the drift nudge too.
const CODE_PATH_HINT_RE =
  /(?:^|[\s'"/])(?:src|lib|app|test|tests|pkg|cmd|internal|packages|apps|components|hooks|utils|services|controllers|models)\b/;

/**
 * Strip leading shell decorations (env vars, command chains) and return
 * the first executable token plus its tail.
 */
function splitFirstCommand(cmd: string): { head: string; tail: string } {
  // Drop leading `VAR=val VAR2=val2 ` env prefixes
  let s = cmd.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "");
  // Drop leading `time `, `sudo `, `xargs `, `env -- `
  s = s.replace(/^(?:time|sudo|xargs|env\s+--)\s+/, "");
  const sp = s.indexOf(" ");
  if (sp < 0) return { head: s, tail: "" };
  return { head: s.slice(0, sp), tail: s.slice(sp + 1) };
}

/** Does the command look like it's targeting code (paths or extensions)? */
function looksLikeCodeTarget(tail: string): boolean {
  if (CODE_EXTENSIONS_RE.test(tail)) return true;
  if (CODE_PATH_HINT_RE.test(tail)) return true;
  return false;
}

/** Extract the search term from `grep PATTERN paths` / `rg PATTERN paths`. */
function extractGrepPattern(tail: string): string | undefined {
  // Skip leading flags like -r -n -i -E etc.
  const parts = tail.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
  for (const p of parts) {
    if (p.startsWith("-")) continue;
    return p.replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

/** Extract the file path from `cat PATH` / `head PATH` etc. */
function extractReadPath(tail: string): string | undefined {
  const parts = tail.match(/\S+/g) ?? [];
  for (const p of parts) {
    if (p.startsWith("-")) continue;
    return p;
  }
  return undefined;
}

/**
 * Inspect a shell command. Return a DriftHint if the command represents a
 * code-navigation task that unerr MCP tools would do better; null otherwise.
 */
export function isDriftCommand(cmd: string): DriftHint | null {
  if (!cmd || !cmd.trim()) return null;
  const { head, tail } = splitFirstCommand(cmd);

  // --- code_search: grep/rg/egrep against code paths ---
  // TRIM (table row #2): why-leads, drop trailing "— graph-ranked, <5ms" tail.
  if (/^(grep|rg|egrep|fgrep)$/.test(head)) {
    if (!looksLikeCodeTarget(tail)) return null;
    const pattern = extractGrepPattern(tail);
    return {
      kind: "code_search",
      suggest: pattern
        ? `search_code({query:${JSON.stringify(pattern)}}) ranks by graph, <5ms vs full-tree grep`
        : `search_code({query:"..."}) ranks by graph, <5ms vs full-tree grep`,
      arg: pattern,
    };
  }

  // --- code_search via `find -name` ---
  if (head === "find") {
    if (!/-i?name\b/.test(tail)) return null;
    const m = tail.match(/-i?name\s+(['"]?)([^'"\s]+)\1/);
    const name = m?.[2];
    if (!name || !CODE_EXTENSIONS_RE.test(name)) return null;
    return {
      kind: "code_search",
      suggest: `search_code({query:${JSON.stringify(name.replace(/^\*\.?|\.$/g, ""))}}) returns entities, not just file paths`,
      arg: name,
    };
  }

  // --- code_read: cat/head/tail/less on a code file ---
  // TRIM (table row #1): "auto-loads conventions" before the call template.
  if (/^(cat|head|tail|less|more|bat)$/.test(head)) {
    const path = extractReadPath(tail);
    if (!path) return null;
    if (!CODE_EXTENSIONS_RE.test(path)) return null;
    return {
      kind: "code_read",
      suggest: `file_read({file_path:${JSON.stringify(path)}}) auto-loads conventions; faster than cat`,
      arg: path,
    };
  }

  // --- dir_explore: ls -R on a source dir ---
  if (head === "ls") {
    const flags = tail.match(/-\w+/g)?.join(" ") ?? "";
    if (!/R/.test(flags)) return null;
    const path = tail
      .replace(/-\w+\s*/g, "")
      .trim()
      .split(/\s+/)[0];
    if (!path) return null;
    if (!CODE_PATH_HINT_RE.test(path) && !CODE_PATH_HINT_RE.test(` ${path}`))
      return null;
    return {
      kind: "dir_explore",
      suggest: `file_outline({file_path:${JSON.stringify(path)}}) returns structure without reading bodies`,
      arg: path,
    };
  }

  return null;
}

/**
 * Build a one-line nudge string for a detected drift. Format is intentionally
 * short to keep the byte cost low — drops the internal "drift(<kind>): try"
 * preamble (unerr taxonomy, not useful to the agent) and leads with the
 * paste-ready call template.
 */
export function formatDriftNudge(hint: DriftHint): string {
  return `[unerr] ${hint.suggest}`;
}
