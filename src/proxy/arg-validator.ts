/**
 * Boundary-level arg normalization + required-field validation for MCP tool
 * dispatch. Two responsibilities:
 *
 *   1. Alias normalization — natural-language param names (entity_name,
 *      entity, file, path) get rewritten onto the canonical schema name
 *      (key, file_path) before the handler runs. The handler stays clean
 *      and the schema documents both names.
 *
 *   2. Required-field enforcement — if the tool's JSON Schema declares
 *      `required: [...]` and the caller didn't supply one of those fields,
 *      we return a structured error immediately. Without this gate, the
 *      handler reads `undefined`, runs a query with an undefined filter,
 *      and silently returns an empty result — which the agent reads as a
 *      valid "graph has no data" signal and drifts to grep.
 *
 * Both behaviours apply uniformly to every tool registered in
 * `tool-definitions.ts`. Adding a new tool that declares `required` gets
 * validated for free; adding `entity_name`/`file` to a new tool's schema
 * gets alias-routed for free.
 */
export interface MinimalToolDef {
  name: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ValidationFailure {
  error: string;
  required: string[];
  details: string;
}

/** Map from canonical schema key → accepted aliases. */
const ALIAS_MAP: Record<string, readonly string[]> = {
  key: ["entity_name", "entity"],
  file_path: ["file", "path"],
};

/**
 * Rewrite alias args onto their canonical name. Mutates `args` in place
 * (the dispatch loop owns this object). Aliases only apply when the
 * canonical key isn't already set AND the tool's schema actually declares
 * the canonical property — so we never invent fields on tools that don't
 * accept them.
 */
export function normalizeArgAliases(
  toolDef: MinimalToolDef,
  args: Record<string, unknown>
): void {
  const props = toolDef.inputSchema.properties;
  for (const [canonical, aliases] of Object.entries(ALIAS_MAP)) {
    if (!(canonical in props)) continue;
    if (
      args[canonical] !== undefined &&
      args[canonical] !== null &&
      args[canonical] !== ""
    ) {
      continue;
    }
    for (const alias of aliases) {
      const v = args[alias];
      if (typeof v === "string" && v.trim() !== "") {
        args[canonical] = v;
        break;
      }
      if (typeof v === "number" || typeof v === "boolean") {
        args[canonical] = v;
        break;
      }
    }
  }
}

/**
 * Check that every `required` field on the tool's schema is present and
 * non-empty in `args`. Returns null on success, or a structured failure
 * the dispatch loop can serialize back to the caller.
 *
 * Empty-string and whitespace-only values count as missing — this is the
 * Datalog-filter-mismatch failure mode that motivated the validator in
 * the first place (`recall_facts({scope:""}) → 0 rows silently`).
 */
export function validateRequiredArgs(
  toolDef: MinimalToolDef,
  args: Record<string, unknown>
): ValidationFailure | null {
  const required = toolDef.inputSchema.required ?? [];
  if (required.length === 0) return null;

  const missing = required.filter((field) => {
    const v = args[field];
    if (v === undefined || v === null) return true;
    if (typeof v === "string" && v.trim() === "") return true;
    return false;
  });
  if (missing.length === 0) return null;

  const props = toolDef.inputSchema.properties as Record<
    string,
    { description?: string } | undefined
  >;
  const details = missing
    .map((m) => {
      const desc = props[m]?.description?.trim();
      return desc ? `${m}: ${desc}` : `${m}: required`;
    })
    .join("; ");

  return {
    error: `${toolDef.name}: missing required parameter(s): ${missing.join(", ")}`,
    required: missing,
    details,
  };
}

/**
 * Convenience: normalize aliases then validate in one call. Use this in
 * the MCP dispatch loop right after destructuring the request.
 */
export function aliasAndValidate(
  toolDef: MinimalToolDef,
  args: Record<string, unknown>
): ValidationFailure | null {
  normalizeArgAliases(toolDef, args);
  return validateRequiredArgs(toolDef, args);
}
