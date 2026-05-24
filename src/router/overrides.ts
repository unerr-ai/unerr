/**
 * Sprint P2-3: Session-scoped family overrides.
 *
 * Overrides let users force-expose or force-mask families for the
 * current IDE session. They persist to a small JSON file under
 * `.unerr/router/overrides.json` and are cleared on process restart
 * (the daemon writes a fresh file on startup).
 *
 * Semantics:
 *   - `unmask <family>` → family is exposed regardless of intent score
 *   - `unmask all` → ALL families exposed (disables masking entirely)
 *   - `mask <family>` → family is hidden regardless of intent score
 *   - Overrides are applied AFTER the intent scorer + mask engine run
 *   - `unmask` beats `mask` if both are set for the same family
 *
 * The file format is intentionally simple (JSON, not JSONL) because
 * overrides are small (max = number of families) and fully rewritten
 * on each mutation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OverrideState {
  readonly unmasked: readonly string[];
  readonly masked: readonly string[];
  readonly unmaskAll: boolean;
  readonly updatedAt: string;
}

const OVERRIDES_FILE = "overrides.json";

function overridesPath(unerrDir: string): string {
  return join(unerrDir, "router", OVERRIDES_FILE);
}

/**
 * Read current override state from disk.
 * Returns a default empty state if the file doesn't exist.
 */
export function readOverrides(unerrDir: string): OverrideState {
  const filePath = overridesPath(unerrDir);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OverrideState>;
    return {
      unmasked: parsed.unmasked ?? [],
      masked: parsed.masked ?? [],
      unmaskAll: parsed.unmaskAll ?? false,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return {
      unmasked: [],
      masked: [],
      unmaskAll: false,
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Write override state to disk (atomic rewrite).
 */
export function writeOverrides(unerrDir: string, state: OverrideState): void {
  const filePath = overridesPath(unerrDir);
  const dir = join(unerrDir, "router");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Add an unmask override for a family (or "all").
 * Removes conflicting mask entry if present.
 */
export function addUnmaskOverride(
  unerrDir: string,
  familyOrAll: string
): OverrideState {
  const current = readOverrides(unerrDir);

  if (familyOrAll === "all") {
    const next: OverrideState = {
      unmasked: [],
      masked: [],
      unmaskAll: true,
      updatedAt: new Date().toISOString(),
    };
    writeOverrides(unerrDir, next);
    return next;
  }

  const newUnmasked = current.unmasked.includes(familyOrAll)
    ? [...current.unmasked]
    : [...current.unmasked, familyOrAll];
  const newMasked = current.masked.filter((f) => f !== familyOrAll);

  const next: OverrideState = {
    unmasked: newUnmasked,
    masked: newMasked,
    unmaskAll: current.unmaskAll,
    updatedAt: new Date().toISOString(),
  };
  writeOverrides(unerrDir, next);
  return next;
}

/**
 * Add a mask override for a family.
 * Removes conflicting unmask entry if present.
 */
export function addMaskOverride(
  unerrDir: string,
  family: string
): OverrideState {
  const current = readOverrides(unerrDir);

  const newMasked = current.masked.includes(family)
    ? [...current.masked]
    : [...current.masked, family];
  const newUnmasked = current.unmasked.filter((f) => f !== family);

  const next: OverrideState = {
    unmasked: newUnmasked,
    masked: newMasked,
    unmaskAll: false,
    updatedAt: new Date().toISOString(),
  };
  writeOverrides(unerrDir, next);
  return next;
}

/**
 * Clear all overrides (reset to default state).
 */
export function clearOverrides(unerrDir: string): OverrideState {
  const next: OverrideState = {
    unmasked: [],
    masked: [],
    unmaskAll: false,
    updatedAt: new Date().toISOString(),
  };
  writeOverrides(unerrDir, next);
  return next;
}

/**
 * Apply overrides to a mask engine's state.
 * Returns the set of families that should be exposed after overrides.
 *
 * Logic:
 *   1. If unmaskAll=true → return ALL known families
 *   2. For each unmasked family → add to exposed set
 *   3. For each masked family → remove from exposed set
 */
export function applyOverrides(
  currentExposed: ReadonlySet<string>,
  knownFamilies: ReadonlySet<string>,
  overrides: OverrideState
): ReadonlySet<string> {
  if (overrides.unmaskAll) {
    return new Set(knownFamilies);
  }

  const result = new Set(currentExposed);

  for (const family of overrides.unmasked) {
    if (knownFamilies.has(family)) {
      result.add(family);
    }
  }

  for (const family of overrides.masked) {
    result.delete(family);
  }

  return result;
}
