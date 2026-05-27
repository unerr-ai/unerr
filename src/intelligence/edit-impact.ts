/**
 * Edit-Impact Engine — process-agnostic cascade computation (P0.3).
 *
 * Given an in-flight edit (file + before/after content), detects whether any
 * entity's signature changed and resolves the depth-1 callers at risk. Holds
 * NO dispatcher / behavior-framework wiring, so the pre-edit hook (P0.5), the
 * proxy UDS handler (P0.4), and the cascade-guard behavior all call the SAME
 * logic instead of three drifting copies.
 *
 * Depth-1 only, by design: per CLAUDE.md, blast-radius signals need single-hop
 * callers (`getCallersOf` / `entity.fan_in`), not recursive traversal. The
 * separate N-hop `blast-radius.ts` engine answers a different question (full
 * transitive reach over an in-memory adjacency index).
 *
 * Async throughout: `getEntitiesByFile` / `getCallersOf` are CozoDB-backed.
 */

import type { LocalEntity } from "./local-graph.js";

export interface CallerAtRisk {
  file: string;
  entity: string;
  line: number;
  isTest: boolean;
}

export interface CascadeWarning {
  /** Bare entity name, for display (e.g. "computeEditImpact"). Never the
   *  multi-line signature blob — that breaks pasteable get_references actions. */
  changed_entity: string;
  /** 16-hex graph key of the changed entity, for `get_references({key:…})`. */
  changed_entity_key: string;
  change_type: SignatureChangeType;
  blast_radius: {
    direct_callers: CallerAtRisk[];
    test_files: CallerAtRisk[];
    indirect_callers: number;
    total_at_risk: number;
  };
  suggestion: string;
}

export type SignatureChangeType =
  | "parameter_added"
  | "parameter_removed"
  | "parameter_renamed"
  | "return_type_changed"
  | "type_changed"
  | "signature_modified";

/**
 * Narrow async graph surface this engine needs. `CozoGraphStore` satisfies it
 * structurally, so callers pass the real store; tests pass a fake. Keeping the
 * dependency this small is what makes the engine process-agnostic and unit
 * testable without a live CozoDB.
 */
export interface EditImpactGraph {
  getEntitiesByFile(filePath: string): Promise<LocalEntity[]>;
  getCallersOf(entityKey: string): Promise<LocalEntity[]>;
}

export interface EditImpactConfig {
  minCallersToWarn: number;
  includeTests: boolean;
}

export const DEFAULT_EDIT_IMPACT_CONFIG: EditImpactConfig = {
  minCallersToWarn: 2,
  includeTests: true,
};

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /test\//,
  /tests\//,
];

export function isTestFilePath(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Lightweight signature change detection without full AST parsing.
 * Looks for function/method definition patterns that differ between
 * old and new content.
 */
export function detectSignatureChange(
  entity: LocalEntity,
  oldContent: string | null,
  newContent: string | null
): SignatureChangeType | null {
  if (!oldContent || !newContent) {
    if (newContent && entity.signature) {
      const fnPattern = new RegExp(
        `(?:function|async\\s+function|export\\s+(?:async\\s+)?function)\\s+${escapeRegex(entity.name)}\\s*\\(`
      );
      if (fnPattern.test(newContent)) {
        return "signature_modified";
      }
    }
    return null;
  }

  // Path A — precise full-signature diff. Fires only when BOTH fragments carry
  // a complete `name(...)` (balanced parens). Most reliable; classifies exactly.
  const oldSigs = extractSignatures(oldContent, entity.name);
  const newSigs = extractSignatures(newContent, entity.name);
  if (oldSigs.length > 0 && newSigs.length > 0) {
    return classifyChange(oldSigs[0]!, newSigs[0]!);
  }

  // Path B — signature-region diff (Bug C). Real Claude `old_string`/`new_string`
  // are partial hunks: a multi-line signature edit usually includes the
  // `function name(` opener but NOT the closing `)` (it sits below the hunk), so
  // Path A's balanced-paren extraction returns empty and the change is missed.
  // Anchor on the opener present in BOTH fragments and compare the param region
  // up to the closing `)` OR end-of-fragment. Identical regions (the opener line
  // rode along but the signature didn't change) → null, so body-only edits that
  // happen to include the opener line stay silent.
  const oldRegion = extractSignatureRegion(oldContent, entity.name);
  const newRegion = extractSignatureRegion(newContent, entity.name);
  if (oldRegion !== null && newRegion !== null) {
    return classifyChange(oldRegion, newRegion);
  }

  return null;
}

/**
 * Classify a signature change between two signature strings (full or a partial
 * region from the opener onward). Shared by Path A (balanced) and Path B
 * (truncated): {@link extractParams} / {@link extractReturnType} tolerate a
 * missing closing paren, so a region like `(\n  a,\n  b,` still yields a param
 * count. Returns null when the two are identical.
 */
function classifyChange(
  oldSig: string,
  newSig: string
): SignatureChangeType | null {
  if (oldSig === newSig) return null;

  const oldParams = extractParams(oldSig);
  const newParams = extractParams(newSig);

  if (newParams.length > oldParams.length) return "parameter_added";
  if (newParams.length < oldParams.length) return "parameter_removed";

  const oldParamNames = oldParams.map((p) => p.split(/[:\s=]/)[0]?.trim());
  const newParamNames = newParams.map((p) => p.split(/[:\s=]/)[0]?.trim());
  for (let i = 0; i < oldParamNames.length; i++) {
    if (oldParamNames[i] !== newParamNames[i]) return "parameter_renamed";
  }

  const oldReturn = extractReturnType(oldSig);
  const newReturn = extractReturnType(newSig);
  if (oldReturn !== newReturn && oldReturn && newReturn)
    return "return_type_changed";

  return "type_changed";
}

/**
 * Extract the parameter region of `entityName`'s signature from a (possibly
 * partial) edit fragment: the slice from the opening `(` up to the matching `)`
 * if present, else to end-of-fragment. Returns null when the opener isn't in the
 * fragment. Unlike {@link extractSignatures} it does NOT require a balanced
 * `(...)`, so it survives a multi-line signature whose closing paren is below
 * the edited hunk.
 */
function extractSignatureRegion(
  content: string,
  entityName: string
): string | null {
  const escaped = escapeRegex(entityName);
  const opener = new RegExp(
    `(?:(?:export\\s+)?(?:async\\s+)?function\\s+)?${escaped}\\s*\\(`
  );
  const m = opener.exec(content);
  if (!m) return null;
  const parenStart = content.indexOf("(", m.index);
  if (parenStart === -1) return null;
  const rest = content.slice(parenStart); // from "(" onward
  const close = rest.indexOf(")");
  return close === -1 ? rest : rest.slice(0, close + 1);
}

function extractSignatures(content: string, entityName: string): string[] {
  const escapedName = escapeRegex(entityName);
  const patterns = [
    new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${escapedName}\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+)?`,
      "g"
    ),
    new RegExp(
      `(?:export\\s+)?(?:async\\s+)?${escapedName}\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+)?`,
      "g"
    ),
  ];

  const results: string[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    match = pattern.exec(content);
    while (match !== null) {
      results.push(match[0]);
      match = pattern.exec(content);
    }
    if (results.length > 0) break;
  }
  return results;
}

function extractParams(signature: string): string[] {
  const open = signature.indexOf("(");
  if (open === -1) return [];
  const rest = signature.slice(open + 1);
  // Tolerate a missing closing paren: a truncated region like `(a,\n  b,`
  // (multi-line signature whose `)` is below the edited hunk) still parses.
  const close = rest.indexOf(")");
  const inner = close === -1 ? rest : rest.slice(0, close);
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function extractReturnType(signature: string): string | null {
  const afterParen = signature.split(")").slice(1).join(")").trim();
  if (!afterParen.startsWith(":")) return null;
  return afterParen.slice(1).trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function toCallerAtRisk(entity: LocalEntity): CallerAtRisk {
  return {
    file: entity.file_path,
    entity: entity.name,
    line: entity.start_line,
    isTest: isTestFilePath(entity.file_path),
  };
}

export function buildSuggestion(
  entityName: string,
  direct: CallerAtRisk[],
  tests: CallerAtRisk[]
): string {
  const total = direct.length + tests.length;
  const parts = [`Update all ${total} caller(s) of ${entityName}.`];
  if (direct.length > 0) {
    parts.push(
      `Start with ${direct.length} direct caller(s): ${direct
        .map((c) => `${c.file.split("/").pop()}:${c.entity}`)
        .slice(0, 3)
        .join(
          ", "
        )}${direct.length > 3 ? ` (+${direct.length - 3} more)` : ""}.`
    );
  }
  if (tests.length > 0) {
    parts.push(`Then update ${tests.length} test file(s).`);
  }
  return parts.join(" ");
}

/**
 * Compute the cascade warnings for an in-flight edit. Pure of any session
 * state — returns one `CascadeWarning` per entity in `filePath` whose signature
 * changed and whose depth-1 caller count clears `minCallersToWarn`.
 *
 * This is the single callable entry point for every surface (hook, UDS,
 * behavior). Callers that need session tracking (e.g. cascade-guard's
 * incomplete-work handoff) layer it on top of the returned warnings.
 */
export async function computeEditImpact(
  graph: EditImpactGraph,
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
  config: EditImpactConfig = DEFAULT_EDIT_IMPACT_CONFIG
): Promise<CascadeWarning[]> {
  if (!oldContent && !newContent) return [];

  const entities = await graph.getEntitiesByFile(filePath);
  if (entities.length === 0) return [];

  const warnings: CascadeWarning[] = [];

  for (const entity of entities) {
    const changeType = detectSignatureChange(entity, oldContent, newContent);
    if (!changeType) continue;

    const callers = await graph.getCallersOf(entity.key);
    if (callers.length < config.minCallersToWarn) continue;

    const callersAtRisk = callers.map((c) => toCallerAtRisk(c));
    const directCallers = callersAtRisk.filter((c) => !c.isTest);
    const testCallers = callersAtRisk.filter((c) => c.isTest);

    const totalAtRisk = config.includeTests
      ? callersAtRisk.length
      : directCallers.length;

    if (totalAtRisk < config.minCallersToWarn) continue;

    warnings.push({
      changed_entity: entity.name,
      changed_entity_key: entity.key,
      change_type: changeType,
      blast_radius: {
        direct_callers: directCallers,
        test_files: testCallers,
        indirect_callers: 0,
        total_at_risk: totalAtRisk,
      },
      suggestion: buildSuggestion(entity.name, directCallers, testCallers),
    });
  }

  return warnings;
}

/** One recorded edit, as the session edit-log stores it (structural so this
 *  engine never imports `tracking/`). */
export interface RecordedEdit {
  file_path: string;
  old_content: string | null;
  new_content: string | null;
}

/** A caller left potentially out-of-date after a signature change this session. */
export interface IncompleteCaller {
  /** Bare entity name, for display. Never the signature blob. */
  changed_entity: string;
  /** 16-hex graph key of the changed entity, for `get_references({key:…})`. */
  changed_entity_key: string;
  change_type: SignatureChangeType;
  caller_file: string;
  caller_entity: string;
  is_test: boolean;
}

// Reconciliation flags even a single un-updated caller — minCallers:1, unlike
// the pre-edit warning which only fires at 2+ to stay quiet on trivial fan-out.
const RECONCILE_CONFIG: EditImpactConfig = {
  minCallersToWarn: 1,
  includeTests: true,
};

/**
 * Reconcile a session's recorded edits against the graph (P2.2): for every
 * signature change made this session, flag any depth-1 caller whose file was
 * never itself edited this session — i.e. "you changed X's signature but didn't
 * update caller Y". Runs at session end against the warm graph; results are
 * surfaced in the next session's resume block.
 *
 * The "caller file was edited → assume updated" heuristic is deliberately
 * file-granular: it can't see whether the specific call site was fixed, only
 * that the file was touched. That trades a small false-negative rate for zero
 * noise on files the developer clearly revisited.
 */
export async function reconcileIncompleteCallers(
  events: RecordedEdit[],
  graph: EditImpactGraph
): Promise<IncompleteCaller[]> {
  if (events.length === 0) return [];

  const editedFiles = new Set(events.map((e) => e.file_path));
  const seen = new Set<string>();
  const incomplete: IncompleteCaller[] = [];

  for (const event of events) {
    const warnings = await computeEditImpact(
      graph,
      event.file_path,
      event.old_content,
      event.new_content,
      RECONCILE_CONFIG
    );
    for (const w of warnings) {
      const callers = [
        ...w.blast_radius.direct_callers,
        ...w.blast_radius.test_files,
      ];
      for (const c of callers) {
        if (editedFiles.has(c.file)) continue; // touched this session → assume updated
        const dedupKey = `${w.changed_entity}|${c.file}|${c.entity}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        incomplete.push({
          changed_entity: w.changed_entity,
          changed_entity_key: w.changed_entity_key,
          change_type: w.change_type,
          caller_file: c.file,
          caller_entity: c.entity,
          is_test: c.isTest,
        });
      }
    }
  }

  return incomplete;
}
