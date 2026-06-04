/**
 * Architecture-boundary engine (P2.1).
 *
 * Process-agnostic counterpart to {@link ../intelligence/edit-impact.ts}: given
 * the post-edit content of a file, it reports relative imports that cross a
 * DECLARED architecture-layer boundary. Layers are derived from the file PATH
 * (directory namespace) and matched against a small set of forbidden
 * source→target rules — NOT from graph communities.
 *
 * Why path rules, not communities: graph communities are Louvain/Leiden
 * clustering artifacts. Two files in the same architectural layer routinely land
 * in different communities (and files in different layers land in the same one),
 * so a community delta is a meaningless boundary signal — it neither maps to the
 * invariants the team enforces nor reads sensibly to a developer. Declared path
 * rules map 1:1 to those invariants (the DM-0 bridge-isolation rule today), the
 * same model dependency-cruiser, Nx `enforce-module-boundaries`, and ArchUnit
 * use. See .internal/behavior-automation.md §2.
 *
 * The pre-edit hook calls this over the per-repo UDS (folded into the
 * blast-radius query) and renders an ADVISORY nudge — never a block. It is
 * additive to the repo's CI boundary guards (e.g. bridge-isolation.test.ts): it
 * surfaces a crossing at edit time, before the commit, without ever stopping the
 * edit. An `@unerr-allow cross-community` override on the import line (or the
 * line above) suppresses the warning outright.
 *
 * Purely path-based, so it needs no graph and works on a cold or
 * partially-indexed graph: a forbidden import in the edited text is a real
 * crossing whether or not the target file has been indexed yet.
 */

const OVERRIDE_PATTERN = /\/\/\s*@unerr-allow\s+cross-community:\s*(.*)/;

/** A relative import in the edited file that crosses a declared layer boundary. */
export interface BoundaryViolation {
  /** The raw import line, verbatim. */
  import: string;
  /** The module specifier (e.g. `../intelligence/local-graph.js`). */
  specifier: string;
  /** Repo-relative path of the file being edited. */
  source_file: string;
  /** Source layer the edited file belongs to (the matched rule's `from`). */
  source_layer: string;
  /** Forbidden target layer the import reaches into (a matched `forbidden` prefix). */
  target_layer: string;
  /** Imperative, paste-ready guidance for resolving the crossing. */
  suggestion: string;
}

/**
 * One declared architecture rule: files matching `from` must not import the
 * implementation of any prefix in `forbidden`. A prefix ending in `/` matches by
 * directory; a prefix with no trailing `/` matches a single exact file path.
 */
export interface LayerRule {
  /** Source matcher: a repo-relative directory prefix (`src/proxy/`) or exact file (`src/proxy/bridge.ts`). */
  from: string;
  /** Target layer prefixes whose implementation this source must not import. */
  forbidden: string[];
  /** Imperative reason, surfaced in the suggestion. */
  reason: string;
}

/**
 * Default rules mirror the invariants this repo enforces in CI. Today that is
 * the DM-0 bridge-isolation rule (`src/__tests__/bridge-isolation.test.ts`):
 * `src/proxy/bridge.ts` is a pure stdio↔UDS relay and must import nothing from
 * the intelligence / behaviors / tracking layers. Extend this list as new
 * cross-layer invariants are declared — keep it in lockstep with the CI guard.
 */
export const DEFAULT_LAYER_RULES: LayerRule[] = [
  {
    from: "src/proxy/bridge.ts",
    forbidden: ["src/intelligence/", "src/behaviors/", "src/tracking/"],
    reason:
      "the bridge is a pure stdio↔UDS relay (DM-0) — intelligence belongs in the per-repo proxy process",
  },
];

export interface BoundaryCheckConfig {
  /** When true, `import type { … }` crossings are allowed (no implementation coupling). */
  allowTypeImports: boolean;
  /** Declared layer rules to enforce. Defaults to {@link DEFAULT_LAYER_RULES}. */
  rules: LayerRule[];
}

export const DEFAULT_BOUNDARY_CHECK_CONFIG: BoundaryCheckConfig = {
  allowTypeImports: true,
  rules: DEFAULT_LAYER_RULES,
};

interface ParsedImport {
  raw: string;
  specifier: string;
  isTypeOnly: boolean;
  hasOverride: boolean;
}

/**
 * Parse relative `import … from "…"` statements out of source text. Only
 * relative specifiers (starting with `.`) are returned — bare-package imports
 * never cross an internal layer boundary. Captures whether each is a type-only
 * import and whether the line (or the line above it) carries an `@unerr-allow
 * cross-community` override.
 */
export function parseImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    const importMatch = line.match(
      /^import\s+(type\s+)?(?:\{[^}]*\}|[^'"]+)\s+from\s+['"]([^'"]+)['"]/
    );
    if (!importMatch) continue;

    const isTypeOnly = !!importMatch[1];
    const specifier = importMatch[2]!;
    if (!specifier.startsWith(".")) continue;

    const prevLine = i > 0 ? (lines[i - 1]?.trim() ?? "") : "";
    const hasOverride =
      OVERRIDE_PATTERN.test(prevLine) || OVERRIDE_PATTERN.test(line);

    results.push({ raw: line, specifier, isTypeOnly, hasOverride });
  }

  return results;
}

/**
 * Resolve a relative import specifier against the importing file's path,
 * collapsing `.`/`..` segments. Normalises a `.js`/extensionless specifier to a
 * `.ts` path so it matches the repo's source layout (NodeNext imports name
 * `.js`; sources are `.ts`). Returns null for non-relative specifiers.
 */
export function resolveImportPath(
  specifier: string,
  sourceFile: string
): string | null {
  if (!specifier.startsWith(".")) return null;

  const sourceParts = sourceFile.split("/");
  sourceParts.pop();

  const resolved = [...sourceParts];
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }

  let result = resolved.join("/");
  // NodeNext specifiers carry `.js`; the repo's sources are `.ts`.
  result = result.replace(/\.jsx?$/, "");
  if (!/\.[jt]sx?$/.test(result)) result += ".ts";
  return result;
}

/** Match a repo-relative path against a rule prefix: trailing-`/` = directory
 *  prefix; otherwise an exact-file match. */
function matchesPrefix(path: string, pattern: string): boolean {
  return pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern;
}

function buildSuggestion(
  _specifier: string,
  targetLayer: string,
  reason: string
): string {
  return `import type only, or route through a shared schemas/ module — importing the implementation of "${targetLayer}" couples the layers (${reason}). Add "// @unerr-allow cross-community: <reason>" above the import to keep it intentionally.`;
}

/**
 * Report relative imports in `newContent` that cross a declared layer boundary
 * for the edited file. Returns `[]` when the file matches no rule, the content
 * is empty, or no import reaches a forbidden layer — so the caller never
 * special-cases a file outside the declared architecture.
 *
 * Type-only imports (when `allowTypeImports`) and `@unerr-allow`-annotated
 * imports are skipped. Order of returned violations follows import order; the
 * first matching rule per import wins (one violation per import line).
 */
export function computeBoundaryViolations(
  filePath: string,
  newContent: string | null,
  config: BoundaryCheckConfig = DEFAULT_BOUNDARY_CHECK_CONFIG
): BoundaryViolation[] {
  if (!newContent) return [];

  const imports = parseImports(newContent);
  if (imports.length === 0) return [];

  const rules = config.rules ?? DEFAULT_LAYER_RULES;
  const applicable = rules.filter((r) => matchesPrefix(filePath, r.from));
  if (applicable.length === 0) return [];

  const violations: BoundaryViolation[] = [];

  for (const imp of imports) {
    if (imp.isTypeOnly && config.allowTypeImports) continue;
    if (imp.hasOverride) continue;

    const targetPath = resolveImportPath(imp.specifier, filePath);
    if (!targetPath) continue;

    for (const rule of applicable) {
      const forbidden = rule.forbidden.find((f) =>
        matchesPrefix(targetPath, f)
      );
      if (!forbidden) continue;
      violations.push({
        import: imp.raw,
        specifier: imp.specifier,
        source_file: filePath,
        source_layer: rule.from,
        target_layer: forbidden,
        suggestion: buildSuggestion(imp.specifier, forbidden, rule.reason),
      });
      break; // first matching rule wins — one violation per import line
    }
  }

  return violations;
}
