/**
 * Settings schema — allow-list + validation for per-repo daemon settings.
 *
 * Every key that `daemon add --<key>=<value>` or `daemon config --<key>=<value>`
 * accepts is registered here. The registry stores arbitrary `settings: Record<…>`
 * so new keys require zero schema migration — just add a row to SETTINGS_SCHEMA.
 */

import { JAVA_BUILD_TOOLS, type JavaBuildTool } from "./protocol.js";

// ── Schema definition ───────────────────────────────────────────

export interface SettingDef {
  /** CLI flag name (kebab-case, used as --<flag>=<value>). */
  flag: string;
  /** Key stored in RepoSettings / config.json (camelCase). */
  key: string;
  /** Human description for --help. */
  description: string;
  /** Parse and validate the raw CLI string. Throws on invalid input. */
  parse: (raw: string) => string | number | boolean;
}

const parsePositiveInt = (raw: string): number => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Expected non-negative integer, got "${raw}"`);
  }
  return n;
};

const parseJavaBuildTool = (raw: string): JavaBuildTool => {
  const normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  if (!(JAVA_BUILD_TOOLS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Invalid Java build tool "${raw}". Valid: ${JAVA_BUILD_TOOLS.join(", ")}`,
    );
  }
  return normalized as JavaBuildTool;
};

const parseAutostart = (raw: string): string => {
  const valid = ["eager", "auto", "never"];
  const lower = raw.toLowerCase();
  if (!valid.includes(lower)) {
    throw new Error(
      `Invalid autostart value "${raw}". Valid: ${valid.join(", ")}`,
    );
  }
  return lower;
};

export const SETTINGS_SCHEMA: readonly SettingDef[] = [
  {
    flag: "idle-timeout",
    key: "idleTimeout",
    description: "Idle timeout in seconds before auto-stop (0 = never)",
    parse: parsePositiveInt,
  },
  {
    flag: "java-build-tool",
    key: "javaBuildTool",
    description: `Java build tool override (${JAVA_BUILD_TOOLS.join("|")})`,
    parse: parseJavaBuildTool,
  },
  {
    flag: "autostart",
    key: "autostart",
    description: "Warm-start policy on daemon boot (eager|auto|never)",
    parse: parseAutostart,
  },
] as const;

/** Map from CLI flag name → SettingDef for O(1) lookup. */
export const SETTINGS_BY_FLAG = new Map<string, SettingDef>(
  SETTINGS_SCHEMA.map((s) => [s.flag, s]),
);

/** Map from camelCase key → SettingDef for config.json round-tripping. */
export const SETTINGS_BY_KEY = new Map<string, SettingDef>(
  SETTINGS_SCHEMA.map((s) => [s.key, s]),
);

/**
 * Parse raw CLI `--key=value` pairs into validated RepoSettings.
 * Returns only the keys that were explicitly provided.
 * Throws on the first invalid value with a descriptive error.
 */
export function parseSettingsFlags(
  raw: Record<string, string | undefined>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [flag, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const def = SETTINGS_BY_FLAG.get(flag);
    if (!def) {
      throw new Error(
        `Unknown setting "--${flag}". Valid flags: ${SETTINGS_SCHEMA.map((s) => `--${s.flag}`).join(", ")}`,
      );
    }
    result[def.key] = def.parse(value);
  }
  return result;
}
