/**
 * Unlock conditions for tier 2/3 MCP tools.
 *
 * Tier 1 tools are always exposed; they have no unlock condition. Every
 * tier 2/3 tool listed in `TIER_ENTRIES` (tool-descriptions.ts) MUST have
 * a corresponding entry here — module-load validation enforces this so a
 * new tool cannot ship without a defined unlock policy.
 *
 * Conditions are expressed as a small tagged-union AST. Leaf conditions
 * read directly from `SessionState`; composites compose via And/Or. The
 * evaluator (`unlock-evaluator.ts`) walks the AST in O(depth) — there is
 * no recursion-heavy logic, no I/O, no allocation beyond the result.
 *
 * Adding a new condition kind: extend `Condition`, add an exhaustive case
 * in `unlock-evaluator.ts`'s `evaluateCondition`, add a getter on
 * `SessionState`. TypeScript's `never` exhaustiveness check will surface
 * any branch that was missed.
 */

import { TIER_ENTRIES, toolsByTier } from "./tool-descriptions.js";

/**
 * The canonical `ur|<tag>` taxonomy. Mirrors `SIGNAL_PREFIX_LEGEND` in
 * `response-envelope.ts` — keep these two in sync. Adding a tag here
 * without a legend entry is a contract violation.
 */
export type UrTag =
  | "hlt"
  | "dft"
  | "rsk"
  | "wrn"
  | "hnt"
  | "fct"
  | "hth"
  | "hst"
  | "pg";

export type IntentMarkerType = "intent" | "decision" | "blocker" | "resolution";

/**
 * Tagged-union AST. Each variant carries only the data its evaluator needs.
 *
 * Leaf conditions are checked against `SessionState`:
 *   - `UrTagEmitted`            session.hasUrTag(tag)
 *   - `EntityFanInAtLeast`      session.maxEntityFanInSeen() ≥ min
 *   - `FileImportCountAtLeast`  session.maxFileImportsSeen() ≥ min
 *   - `FilesInSameDirAtLeast`   session.maxFilesPerDirSeen() ≥ min
 *   - `TestFileAccessed`        session.testFileSeen()
 *   - `FirstFileReadCompleted`  session.filesAccessedCount() ≥ 1
 *   - `EditOrWriteAttempted`    session.editOrWriteAttempted()
 *   - `FileReadTruncated`       session.fileReadTruncatedSeen()
 *   - `IntentMarkerAtLeast`     session.intentMarkerCount(type) ≥ min
 *   - `ToolCallCountAtLeast`    session.toolCallCount(name) ≥ min
 *   - `PriorSessionFactSurfaced` session.priorSessionFactSurfaced()
 *   - `SessionTurnsAtLeast`     session.turnCount() ≥ min
 *   - `NonTrivialActionObserved` session.nonTrivialActionObserved()
 *
 * Composites:
 *   - `And`  every child true
 *   - `Or`   any child true
 */
export type Condition =
  | { readonly kind: "UrTagEmitted"; readonly tag: UrTag }
  | { readonly kind: "EntityFanInAtLeast"; readonly min: number }
  | { readonly kind: "FileImportCountAtLeast"; readonly min: number }
  | { readonly kind: "FilesInSameDirAtLeast"; readonly min: number }
  | { readonly kind: "TestFileAccessed" }
  | { readonly kind: "FirstFileReadCompleted" }
  | { readonly kind: "EditOrWriteAttempted" }
  | { readonly kind: "FileReadTruncated" }
  | {
      readonly kind: "IntentMarkerAtLeast";
      readonly type: IntentMarkerType;
      readonly min: number;
    }
  | {
      readonly kind: "ToolCallCountAtLeast";
      readonly name: string;
      readonly min: number;
    }
  | { readonly kind: "PriorSessionFactSurfaced" }
  | { readonly kind: "SessionTurnsAtLeast"; readonly min: number }
  | { readonly kind: "NonTrivialActionObserved" }
  | { readonly kind: "And"; readonly all: readonly Condition[] }
  | { readonly kind: "Or"; readonly any: readonly Condition[] };

/** Sugar constructors — keep callers terse. */
export const C = {
  urTag: (tag: UrTag): Condition => ({ kind: "UrTagEmitted", tag }),
  fanIn: (min: number): Condition => ({ kind: "EntityFanInAtLeast", min }),
  imports: (min: number): Condition => ({
    kind: "FileImportCountAtLeast",
    min,
  }),
  sameDir: (min: number): Condition => ({
    kind: "FilesInSameDirAtLeast",
    min,
  }),
  testFile: (): Condition => ({ kind: "TestFileAccessed" }),
  firstRead: (): Condition => ({ kind: "FirstFileReadCompleted" }),
  editOrWrite: (): Condition => ({ kind: "EditOrWriteAttempted" }),
  readTruncated: (): Condition => ({ kind: "FileReadTruncated" }),
  intent: (type: IntentMarkerType, min = 1): Condition => ({
    kind: "IntentMarkerAtLeast",
    type,
    min,
  }),
  called: (name: string, min = 1): Condition => ({
    kind: "ToolCallCountAtLeast",
    name,
    min,
  }),
  priorFact: (): Condition => ({ kind: "PriorSessionFactSurfaced" }),
  turns: (min: number): Condition => ({ kind: "SessionTurnsAtLeast", min }),
  nonTrivial: (): Condition => ({ kind: "NonTrivialActionObserved" }),
  and: (...all: Condition[]): Condition => ({ kind: "And", all }),
  or: (...any: Condition[]): Condition => ({ kind: "Or", any }),
};

/**
 * The unlock policy for every tier 2/3 tool. Keys MUST match exactly the
 * tier 2/3 entries in `TIER_ENTRIES` — module-load assertion below enforces.
 */
export const UNLOCK_CONDITIONS: Readonly<Record<string, Condition>> = {
  // ── Tier 2 ─────────────────────────────────────────────────────────────
  get_critical_nodes: C.or(C.urTag("rsk"), C.fanIn(10)),

  get_cross_boundary_links: C.or(
    C.urTag("hnt"),
    // "Cross-module file accessed" is approximated by ≥ 2 files in the
    // same session whose first directory differs. We model that with
    // the simpler heuristic: ≥ 5 distinct directories touched.
    C.sameDir(2)
  ),

  file_connections: C.sameDir(2),

  get_test_coverage: C.testFile(),

  get_imports: C.imports(5),

  // Conventions help the agent write to project style. The intended flow
  // is "ask conventions → write code", so the gate fires on the first
  // file read. `editOrWrite` would invert the value — and is unreachable
  // in a pure MCP session anyway because built-in Edit/Write don't route
  // through QueryRouter.
  get_conventions: C.firstRead(),

  get_file: C.readTruncated(),

  // On-demand review is worth surfacing once there is something to review:
  // a risk signal already fired (the agent is on a risky path), or it has done
  // non-trivial work (edit / write / ≥5 reads). Built-in Edit/Write don't route
  // through the router, so `nonTrivial`'s read component is the reliable path
  // in a pure MCP session; `ur|rsk` covers the in-flight-review case.
  review_changes: C.or(C.urTag("rsk"), C.nonTrivial()),

  // ── Tier 3 ─────────────────────────────────────────────────────────────
  mark_intent: C.and(C.turns(3), C.nonTrivial()),

  mark_decision: C.intent("intent"),

  mark_blocker: C.intent("intent"),

  mark_resolution: C.intent("blocker"),

  recall_facts: C.priorFact(),

  record_fact: C.intent("decision"),
};

/**
 * Human-readable explanation of why a condition fired. Used in the
 * `reasonText` field of an `UnlockEvent` and in soft-refuse responses.
 */
export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case "UrTagEmitted":
      return `ur|${c.tag} emitted`;
    case "EntityFanInAtLeast":
      return `entity fan_in ≥ ${c.min} observed`;
    case "FileImportCountAtLeast":
      return `file with ≥ ${c.min} imports read`;
    case "FilesInSameDirAtLeast":
      return `≥ ${c.min} files accessed in same directory`;
    case "TestFileAccessed":
      return "test file accessed";
    case "FirstFileReadCompleted":
      return "first file read completed";
    case "EditOrWriteAttempted":
      return "edit or write attempted";
    case "FileReadTruncated":
      return "file_read truncated on a large file";
    case "IntentMarkerAtLeast":
      return `${c.type} marker count ≥ ${c.min}`;
    case "ToolCallCountAtLeast":
      return `${c.name} called ≥ ${c.min} times`;
    case "PriorSessionFactSurfaced":
      return "prior-session fact surfaced (ur|fct)";
    case "SessionTurnsAtLeast":
      return `session turns ≥ ${c.min}`;
    case "NonTrivialActionObserved":
      return "non-trivial action observed (edit / write / ≥5 reads)";
    case "And":
      return c.all.map(describeCondition).join(" AND ");
    case "Or":
      return c.any.map(describeCondition).join(" OR ");
    default: {
      const _exhaustive: never = c;
      throw new Error(
        `Unhandled condition kind: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}

// ── Module-load-time consistency check ─────────────────────────────────────
//
// Every tier 2/3 tool must have an entry in UNLOCK_CONDITIONS. No tier 1
// tool may have one (Tier 1 is always-on; an unlock condition would be
// meaningless). Fail loud at import if either invariant breaks.

{
  const tier1 = new Set(toolsByTier(1));
  const tier23 = new Set([...toolsByTier(2), ...toolsByTier(3)]);
  const policyKeys = new Set(Object.keys(UNLOCK_CONDITIONS));

  const tier1WithPolicy = [...tier1].filter((n) => policyKeys.has(n));
  const tier23WithoutPolicy = [...tier23].filter((n) => !policyKeys.has(n));
  const unknownPolicyKeys = [...policyKeys].filter(
    (n) => !(tier1.has(n) || tier23.has(n))
  );

  if (
    tier1WithPolicy.length > 0 ||
    tier23WithoutPolicy.length > 0 ||
    unknownPolicyKeys.length > 0
  ) {
    throw new Error(
      "UNLOCK_CONDITIONS is out of sync with TIER_ENTRIES.\n" +
        `  Tier 1 tools with a policy (should be none): ${tier1WithPolicy.join(", ") || "(none)"}\n` +
        `  Tier 2/3 tools missing a policy: ${tier23WithoutPolicy.join(", ") || "(none)"}\n` +
        `  Unknown policy keys (not in TIER_ENTRIES): ${unknownPolicyKeys.join(", ") || "(none)"}`
    );
  }

  // Sanity: every tool TIER_ENTRIES references is the same tool name format
  // (lowercase / underscore). Catches accidental typos.
  for (const name of Object.keys(UNLOCK_CONDITIONS)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid tool name in UNLOCK_CONDITIONS: "${name}"`);
    }
    if (!TIER_ENTRIES[name]) {
      throw new Error(
        `UNLOCK_CONDITIONS["${name}"] does not match any TIER_ENTRIES entry`
      );
    }
  }
}
