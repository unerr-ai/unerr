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
  | "code_search" // grep / rg / find -name on code (conceptual / multi-word)
  | "code_refs" // grep/sed/perl hunting ONE identifier repo-wide (rename / find-all-uses)
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

/**
 * A bare identifier — a single symbol name with no regex metacharacters,
 * spaces, or path separators. Hunting one of these repo-wide is the
 * find-all-references / rename use case, where get_references with
 * include_text_occurrences returns the full textual blast radius in one call.
 * A multi-word or regex pattern is a genuine text search and stays on grep /
 * search_code (hybrid: lexical, structural, and semantic are distinct tools —
 * route by intent, per the "grep replacement is three tools" guidance).
 */
function isBareIdentifier(pattern: string | undefined): pattern is string {
  return !!pattern && /^[A-Za-z_$][\w$]*$/.test(pattern);
}

/** Does the command search the whole tree (-r/-R/--include) rather than one file? */
function isRepoWideSearch(tail: string): boolean {
  return /(?:^|\s)-\w*[rR]\w*\b/.test(tail) || /--include\b/.test(tail);
}

/** Extract the OLD side of an in-place `s/OLD/NEW/` substitution (sed -i / perl -pi). */
function extractSubstTarget(tail: string): string | undefined {
  const inPlace = /(?:^|\s)-\w*i\w*\b/.test(tail) || /--in-place\b/.test(tail);
  if (!inPlace) return undefined;
  // s/OLD/NEW/  — OLD may contain escaped chars; stop at the first unescaped `/`.
  const m = tail.match(/\bs\/((?:\\.|[^/\\])+)\//);
  return m?.[1];
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

// Matches an output-redirect operator prefix: `>`, `>>`, `>|`, and the
// fd/stream-prefixed variants `1>`, `2>`, `&>` (and their `>>` forms). A
// token is a BARE operator when the whole token is this match (e.g. `>`,
// `2>>`); it's a GLUED operator+target when the token has more chars after
// the match (e.g. `>build.py`, `2>err.log`).
const REDIRECT_OP_RE = /^(?:[0-9]|&)?>{1,2}\|?/;

/**
 * Extract the file path from a code-read command. Prefers a token that looks
 * like a code file so `sed -n '1,5p' a.ts` / `awk 'NR<5' a.ts` resolve to the
 * path, not the inline script; falls back to the first non-flag token.
 *
 * A token that is the TARGET of an output redirect (`>`, `>>`, `1>`, `2>`,
 * `&>`, `>|` — separate or glued to the path, e.g. `> out.py` / `>out.py`)
 * is never returned: `cat > build.py << 'EOF'` WRITES build.py, it doesn't
 * read it, so it must not trigger the "use file_read" nudge.
 */
function extractReadPath(tail: string): string | undefined {
  const parts = tail.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];

  let skipNext = false;
  for (const p of parts) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const m = p.match(REDIRECT_OP_RE);
    if (m) {
      // Bare operator (whole token is just `>` / `>>` / etc.) — the NEXT
      // token is its target, skip that too. Glued (`>build.py`) already
      // carries the target inside this one token — skip only this token.
      if (m[0] === p) skipNext = true;
      continue;
    }
    const unq = p.replace(/^['"]|['"]$/g, "");
    if (!unq.startsWith("-") && CODE_EXTENSIONS_RE.test(unq)) return unq;
  }

  skipNext = false;
  for (const p of parts) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const m = p.match(REDIRECT_OP_RE);
    if (m) {
      if (m[0] === p) skipNext = true;
      continue;
    }
    if (p.startsWith("-")) continue;
    return p.replace(/^['"]|['"]$/g, "");
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

  // --- code_refs: in-place bulk substitution (sed -i / perl -pi) on code ---
  // A blind shell rewrite of an identifier misses callers/imports the graph
  // sees, mangles string-literal + comment occurrences inconsistently, and
  // can't be reviewed per-site. Route to the textual blast-radius tool + the
  // graph-aware edit path. Must run BEFORE the code_read branch (which also
  // matches `sed`) so an in-place edit isn't mislabeled a read.
  if (/^(sed|perl)$/.test(head)) {
    const target = extractSubstTarget(tail);
    if (target && looksLikeCodeTarget(tail)) {
      const id = isBareIdentifier(target) ? target : undefined;
      return {
        kind: "code_refs",
        suggest: id
          ? `get_references({key:${JSON.stringify(id)}, include_text_occurrences:true}) lists every site (callers + strings + comments) in one call; then file_edit each — do not blind-${head} code files`
          : `get_references({key:"<identifier>", include_text_occurrences:true}) + file_edit per site — do not blind-${head} code files`,
        arg: id,
      };
    }
    // Not an in-place substitution → fall through (a read-style sed is handled below).
  }

  // --- grep/rg/egrep against code paths: route by INTENT ---
  // A BARE IDENTIFIER hunted repo-wide is the find-all-references / rename use
  // case → get_references(include_text_occurrences) returns callers AND literal
  // string/comment/route-path occurrences search_code (symbol-only) cannot see.
  // A multi-word / regex pattern is a real text search → search_code.
  if (/^(grep|rg|egrep|fgrep)$/.test(head)) {
    if (!looksLikeCodeTarget(tail)) return null;
    const pattern = extractGrepPattern(tail);
    if (isBareIdentifier(pattern) && isRepoWideSearch(tail)) {
      return {
        kind: "code_refs",
        suggest: `get_references({key:${JSON.stringify(pattern)}, include_text_occurrences:true}) — all callers + string/comment/route uses in 1 call (rename/find-all-uses)`,
        arg: pattern,
      };
    }
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
  if (/^(cat|head|tail|less|more|bat|sed|awk|nl)$/.test(head)) {
    const path = extractReadPath(tail);
    if (!path) return null;
    if (!CODE_EXTENSIONS_RE.test(path)) return null;
    return {
      kind: "code_read",
      suggest: `file_read({file_path:${JSON.stringify(path)}}) — graph-aware code read; do not ${head} code files`,
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
