/**
 * Merge unerr hooks into `.claude/settings.json`.
 *
 * PreToolUse hooks: Bash (rewrite), Read (nudge), Grep (nudge), Glob (nudge).
 * PostToolUse hooks: Read (enrich), Grep (enrich), Glob (enrich).
 * All hooks are installed on `unerr install claude-code` and removed on `unerr uninstall`.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Hook event type. */
type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit";

/**
 * Resolve the absolute path to the `unerr` binary.
 *
 * Tries (in order):
 * 1. `process.argv[1]` — the script currently running (works for global installs, pnpm link, npm link)
 * 2. `which unerr` — fallback to PATH lookup at install time
 * 3. `"unerr"` — bare name as last resort (relies on subprocess PATH)
 *
 * The resolved absolute path is written into settings.json so hooks work even when
 * the subprocess PATH doesn't include the package manager's global bin directory.
 */
function resolveUnerrBinary(): string {
  // process.argv[1] is the entry script — for global installs this is the real
  // binary path (e.g. /Users/jaswanth/Library/pnpm/unerr or /usr/local/bin/unerr).
  // Require the basename to actually look like the unerr binary so we don't
  // bake in a path to vitest, tsx, or some other wrapper that happened to spawn
  // the current process (which would write unrecognisable hook commands that
  // `isAnyUnerrHook` can't match for removal).
  const entryScript = process.argv[1];
  if (entryScript && existsSync(entryScript)) {
    const base = entryScript.split("/").pop() ?? "";
    if (base === "unerr" || base.startsWith("unerr.")) {
      return entryScript;
    }
  }

  // Fallback: `which unerr` at install time (captures current PATH)
  try {
    const resolved = execSync("which unerr", { encoding: "utf-8" }).trim();
    if (resolved && existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // which not found or unerr not on PATH — fall through
  }

  // Last resort: bare name (original behavior — `isAnyUnerrHook` still matches
  // `^unerr\s+hook\s+`).
  return "unerr";
}

/** Cached resolved binary path (computed once per process). */
let _resolvedBinary: string | undefined;
function getUnerrBinary(): string {
  if (_resolvedBinary === undefined) {
    _resolvedBinary = resolveUnerrBinary();
  }
  return _resolvedBinary;
}

/** Build hook command templates using the resolved binary path. */
function buildMatcherHooks(): {
  event: HookEvent;
  matcher: string;
  command: string;
}[] {
  const bin = getUnerrBinary();
  return [
    // PreToolUse — advisory nudges + Bash rewrite
    { event: "PreToolUse", matcher: "Bash", command: `${bin} hook pre-bash` },
    { event: "PreToolUse", matcher: "Read", command: `${bin} hook pre-read` },
    { event: "PreToolUse", matcher: "Grep", command: `${bin} hook pre-grep` },
    { event: "PreToolUse", matcher: "Glob", command: `${bin} hook pre-glob` },
    // PreToolUse — blast radius + convention validation for writes
    { event: "PreToolUse", matcher: "Write", command: `${bin} hook pre-write` },
    { event: "PreToolUse", matcher: "Edit", command: `${bin} hook pre-edit` },
    // PostToolUse — enrich tool output with graph navigation suggestions
    { event: "PostToolUse", matcher: "Read", command: `${bin} hook post-read` },
    { event: "PostToolUse", matcher: "Grep", command: `${bin} hook post-grep` },
    { event: "PostToolUse", matcher: "Glob", command: `${bin} hook post-glob` },
    {
      event: "PostToolUse",
      matcher: "Write",
      command: `${bin} hook post-write`,
    },
    { event: "PostToolUse", matcher: "Edit", command: `${bin} hook post-edit` },
  ];
}

/** Build global hook templates using the resolved binary path. */
function buildGlobalHooks(): { event: HookEvent; command: string }[] {
  const bin = getUnerrBinary();
  return [{ event: "UserPromptSubmit", command: `${bin} hook prompt-submit` }];
}

export interface MergePreToolResult {
  ok: boolean;
  path: string;
  action: "merged" | "already_present" | "failed";
}

/** Check if an entry is ANY unerr hook (for removal and dedup). */
function isAnyUnerrHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  const hs = e.hooks;
  if (!Array.isArray(hs)) return false;
  // Match any hook command that contains "unerr hook" (covers both bare and absolute paths)
  return hs.some((h) => {
    if (!h || typeof h !== "object") return false;
    const cmd = (h as Record<string, unknown>).command;
    return typeof cmd === "string" && /(?:^|\/)unerr\s+hook\s+/.test(cmd);
  });
}

/**
 * Merge all unerr hooks into `.claude/settings.json`.
 * Handles PreToolUse/PostToolUse (matcher-based) and UserPromptSubmit (global).
 * Idempotent — skips hooks that are already present.
 */
export function mergePreToolUseBashHook(cwd: string): MergePreToolResult {
  const dir = join(cwd, ".claude");
  const settingsPath = join(dir, "settings.json");

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        settings = {};
      }
    }

    const hooks = (settings.hooks as Record<string, unknown>) ?? {};

    let added = 0;

    const matcherHooks = buildMatcherHooks();
    const globalHooks = buildGlobalHooks();

    // Remove any existing unerr hooks first (handles upgrades from bare to absolute paths)
    for (const eventType of [
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
    ] as HookEvent[]) {
      if (Array.isArray(hooks[eventType])) {
        hooks[eventType] = (hooks[eventType] as unknown[]).filter(
          (entry: unknown) => !isAnyUnerrHook(entry)
        );
      }
    }

    // Register matcher-based hooks (PreToolUse, PostToolUse) with resolved binary path
    for (const hookDef of matcherHooks) {
      const eventArray = Array.isArray(hooks[hookDef.event])
        ? [...(hooks[hookDef.event] as unknown[])]
        : [];

      eventArray.push({
        matcher: hookDef.matcher,
        hooks: [{ type: "command", command: hookDef.command }],
      });
      hooks[hookDef.event] = eventArray;
      added++;
    }

    // Register global hooks (UserPromptSubmit — no matcher) with resolved binary path
    for (const hookDef of globalHooks) {
      const eventArray = Array.isArray(hooks[hookDef.event])
        ? [...(hooks[hookDef.event] as unknown[])]
        : [];

      if (!eventArray.some((entry) => isAnyUnerrHook(entry))) {
        eventArray.push({
          hooks: [{ type: "command", command: hookDef.command }],
        });
        hooks[hookDef.event] = eventArray;
        added++;
      }
    }

    if (added === 0) {
      return { ok: true, path: settingsPath, action: "already_present" };
    }

    settings.hooks = hooks;

    writeFileSync(
      settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf-8"
    );
    return { ok: true, path: settingsPath, action: "merged" };
  } catch {
    return { ok: false, path: settingsPath, action: "failed" };
  }
}

/**
 * Remove ALL unerr hook entries from `.claude/settings.json`.
 * Handles PreToolUse, PostToolUse, and UserPromptSubmit.
 * Returns true if any entries were removed.
 */
/**
 * S8: Built-in tools to deny when --force-tools is active.
 * These tools have unerr MCP equivalents (file_read, search_code, file_outline).
 */
const DISALLOWED_TOOLS = ["Grep", "Glob"];

/**
 * S8: Add `permissions.deny` entries to `.claude/settings.json`.
 * Denies Read, Grep, Glob when unerr MCP tools are confirmed available.
 *
 * Called by default on `unerr install claude-code`. Opt out with `--no-force-tools`.
 * Idempotent — skips tools already denied.
 */
export function addDisallowedTools(cwd: string): {
  added: number;
  path: string;
} {
  const dir = join(cwd, ".claude");
  const settingsPath = join(dir, "settings.json");

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        settings = {};
      }
    }

    const permissions = (settings.permissions as Record<string, unknown>) ?? {};
    const deny = Array.isArray(permissions.deny)
      ? [...(permissions.deny as string[])]
      : [];

    // Migration: remove "Read" if it was previously denied by unerr
    // (Read is needed for the Edit workflow — deny breaks native editing across all agents)
    const readIdx = deny.indexOf("Read");
    if (readIdx >= 0) {
      deny.splice(readIdx, 1);
    }

    let added = 0;
    for (const tool of DISALLOWED_TOOLS) {
      if (!deny.includes(tool)) {
        deny.push(tool);
        added++;
      }
    }

    if (added === 0) {
      return { added: 0, path: settingsPath };
    }

    permissions.deny = deny;
    settings.permissions = permissions;

    writeFileSync(
      settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf-8"
    );
    return { added, path: settingsPath };
  } catch {
    return { added: 0, path: settingsPath };
  }
}

/**
 * S8: Remove unerr-added `permissions.deny` entries from `.claude/settings.json`.
 * Removes Read, Grep, Glob from deny list.
 * Returns true if any entries were removed.
 */
export function removeDisallowedTools(cwd: string): boolean {
  const settingsPath = join(cwd, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const permissions = settings.permissions as
      | Record<string, unknown>
      | undefined;
    if (!permissions || !Array.isArray(permissions.deny)) return false;

    const before = (permissions.deny as string[]).length;
    permissions.deny = (permissions.deny as string[]).filter(
      (tool: string) => !DISALLOWED_TOOLS.includes(tool)
    );
    const removed = before - (permissions.deny as string[]).length;

    if (removed === 0) return false;

    // Clean up empty deny array and permissions object
    if ((permissions.deny as string[]).length === 0)
      permissions.deny = undefined;
    if (Object.keys(permissions).length === 0) settings.permissions = undefined;

    writeFileSync(
      settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf-8"
    );
    return true;
  } catch {
    return false;
  }
}

export function removePreToolUseBashHook(cwd: string): boolean {
  const settingsPath = join(cwd, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (!hooks) return false;

    let totalRemoved = 0;
    const eventTypes: HookEvent[] = [
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
    ];

    for (const eventType of eventTypes) {
      if (!Array.isArray(hooks[eventType])) continue;

      const before = (hooks[eventType] as unknown[]).length;
      hooks[eventType] = (hooks[eventType] as unknown[]).filter(
        (entry: unknown) => !isAnyUnerrHook(entry)
      );

      const removed = before - (hooks[eventType] as unknown[]).length;
      totalRemoved += removed;

      // Clean up empty arrays
      if ((hooks[eventType] as unknown[]).length === 0) delete hooks[eventType];
    }

    if (totalRemoved === 0) return false;

    // Clean up empty hooks object
    if (Object.keys(hooks).length === 0) settings.hooks = undefined;

    writeFileSync(
      settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf-8"
    );
    return true;
  } catch {
    return false;
  }
}
