/**
 * Merge unerr hooks into `.claude/settings.json`.
 *
 * PreToolUse hooks: Bash (rewrite), Read (nudge), Grep (nudge), Glob (nudge).
 * PostToolUse hooks: Read (enrich), Grep (enrich), Glob (enrich), Bash
 * (verify-awareness record + weak-verify nudge).
 * All hooks are installed on `unerr install claude-code` and removed on `unerr uninstall`.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/** Hook event type. */
type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart"
  | "Stop"
  | "SubagentStop";

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
    const base = basename(entryScript);
    if (base === "unerr" || base.startsWith("unerr.")) {
      return entryScript;
    }
  }

  // Fallback: `which unerr` / `where unerr` at install time (captures current PATH)
  const whichCmd = process.platform === "win32" ? "where unerr" : "which unerr";
  try {
    const resolved = execSync(whichCmd, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split(/\r?\n/)[0];
    if (resolved && existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // not found — fall through
  }

  // Last resort: bare name (original behavior — `isAnyUnerrHook` still matches
  // `^unerr\s+hook\s+`).
  return "unerr";
}

/** Cached resolved binary path (computed once per process). */
let _resolvedBinary: string | undefined;
export function getUnerrBinary(): string {
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
    // PreToolUse — blast radius + convention validation for writes. unerr's own
    // edit path is the single MCP tool `mcp__unerr__file_edit` (it does both
    // targeted edits AND whole-file writes), so the Edit matcher catches it and
    // routes it through the strong graph-backed pre-edit gate — including its
    // whole-file write mode. The built-in Write keeps its own pre-write nudge.
    // Claude Code matcher rule: a matcher containing only [A-Za-z0-9_|] is an
    // EXACT-string match per `|`-alternative (NOT a substring/regex match). So
    // the alternative must be the FULL MCP tool name `mcp__unerr__file_edit`
    // (the server is always registered as "unerr") — a bare `file_edit` would
    // exact-match a tool literally named "file_edit", which never exists, and
    // silently never fire.
    {
      event: "PreToolUse",
      matcher: "Write",
      command: `${bin} hook pre-write`,
    },
    {
      event: "PreToolUse",
      matcher: "Edit|mcp__unerr__file_edit",
      command: `${bin} hook pre-edit`,
    },
    // PreToolUse — redirect built-in WebFetch to fetch_url (DOM-extracted,
    // BM25-ranked, 5–10× fewer tokens; routes through the QueryRouter).
    {
      event: "PreToolUse",
      matcher: "WebFetch",
      command: `${bin} hook pre-webfetch`,
    },
    // PostToolUse — enrich tool output with graph navigation suggestions
    { event: "PostToolUse", matcher: "Read", command: `${bin} hook post-read` },
    { event: "PostToolUse", matcher: "Grep", command: `${bin} hook post-grep` },
    { event: "PostToolUse", matcher: "Glob", command: `${bin} hook post-glob` },
    // PostToolUse — verification awareness (W4): records a classified check
    // command's timestamp for the Stop-hook verify gate, and (autonomous mode
    // only) nudges a just-in-time correction for a weak verify shape.
    { event: "PostToolUse", matcher: "Bash", command: `${bin} hook post-bash` },
    // PostToolUse — after a web search returns result URLs, nudge one bulk
    // fetch_url({urls:[...]}) to read them all in a single roundtrip instead of
    // one fetch_url per page. Additive enrich only; WebSearch is never denied.
    {
      event: "PostToolUse",
      matcher: "WebSearch",
      command: `${bin} hook post-websearch`,
    },
    {
      event: "PostToolUse",
      matcher: "Write",
      command: `${bin} hook post-write`,
    },
    {
      event: "PostToolUse",
      matcher: "Edit|mcp__unerr__file_edit",
      command: `${bin} hook post-edit`,
    },
    // SessionStart — emits resume strip on session boot. Matcher alternation
    // fires for all four start modes (startup, resume, clear, compact).
    {
      event: "SessionStart",
      matcher: "startup|resume|clear|compact",
      command: `${bin} hook session-start`,
    },
  ];
}

/** Build global hook templates using the resolved binary path. */
function buildGlobalHooks(): { event: HookEvent; command: string }[] {
  const bin = getUnerrBinary();
  return [
    { event: "UserPromptSubmit", command: `${bin} hook prompt-submit` },
    // Stop — surface the close-out economy line at turn end (replaces the
    // agent calling unerr_turn_summary and pasting the result).
    { event: "Stop", command: `${bin} hook stop` },
    // SubagentStop — same receipt as Stop but without the master-only leak
    // detector, so sub-agents sharing the master's cwd don't false-fire it.
    { event: "SubagentStop", command: `${bin} hook subagent-stop` },
  ];
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
      "SessionStart",
      "Stop",
      "SubagentStop",
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
 * Built-in tools unerr added to `permissions.deny` in past versions.
 * `permissions.deny` is a DEAD-END block: Claude Code refuses the tool with a
 * generic error that names no alternative, so the model falls back to `Bash`
 * (`grep`/`rg`/`find`) — the deny diverts a blocked code search to bash instead
 * of to `search_code`. Redirection is handled instead by the PreToolUse
 * pre-grep/pre-glob/pre-read hooks (their deny-once reason NAMES the unerr tool,
 * e.g. `search_code(...)`) plus the injected instruction. So unerr now denies
 * NOTHING at the permission layer and only strips these legacy entries.
 */
const LEGACY_UNERR_DENIES = ["Read", "Grep", "Glob"];

/**
 * Reconcile `.claude/settings.json` `permissions.deny`: strip any legacy
 * unerr-added entries (Read / Grep / Glob) and add nothing. A force-deny of
 * Grep/Glob sends blocked searches to bash, not to `search_code`; the
 * redirecting PreToolUse hooks + instruction do the steering now.
 *
 * Called by default on `unerr install claude-code`. Idempotent.
 */
export function addDisallowedTools(cwd: string): {
  added: number;
  removed: number;
  path: string;
} {
  const dir = join(cwd, ".claude");
  const settingsPath = join(dir, "settings.json");

  try {
    if (!existsSync(settingsPath)) {
      // Nothing to reconcile — unerr no longer writes a deny list, so a fresh
      // repo needs no settings.json touch for permissions.
      return { added: 0, removed: 0, path: settingsPath };
    }

    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      return { added: 0, removed: 0, path: settingsPath };
    }

    const permissions = settings.permissions as
      | Record<string, unknown>
      | undefined;
    if (!permissions || !Array.isArray(permissions.deny)) {
      return { added: 0, removed: 0, path: settingsPath };
    }

    const before = (permissions.deny as string[]).length;
    permissions.deny = (permissions.deny as string[]).filter(
      (tool: string) => !LEGACY_UNERR_DENIES.includes(tool)
    );
    const removed = before - (permissions.deny as string[]).length;

    if (removed === 0) {
      return { added: 0, removed: 0, path: settingsPath };
    }

    // Clean up empty deny array / permissions object so we don't leave noise.
    if ((permissions.deny as string[]).length === 0)
      Reflect.deleteProperty(permissions, "deny");
    if (Object.keys(permissions).length === 0)
      Reflect.deleteProperty(settings, "permissions");

    writeFileSync(
      settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf-8"
    );
    return { added: 0, removed, path: settingsPath };
  } catch {
    return { added: 0, removed: 0, path: settingsPath };
  }
}

/**
 * Remove any legacy unerr-added `permissions.deny` entries (Read / Grep / Glob)
 * from `.claude/settings.json`. Returns true if any entries were removed.
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
      (tool: string) => !LEGACY_UNERR_DENIES.includes(tool)
    );
    const removed = before - (permissions.deny as string[]).length;

    if (removed === 0) return false;

    // Clean up empty deny array and permissions object
    if ((permissions.deny as string[]).length === 0)
      Reflect.deleteProperty(permissions, "deny");
    if (Object.keys(permissions).length === 0)
      Reflect.deleteProperty(settings, "permissions");

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

/**
 * Tools unerr's Claude Code sub-agents (`unerr-worker` / `unerr-junior`) call.
 * Pre-approving them in `permissions.allow` stops each sub-agent tool call from
 * prompting — the allow-list IS inherited by Task sub-agents, whereas
 * `--dangerously-skip-permissions` is not. `mcp__unerr` covers unerr's own
 * guardrailed MCP tools (search_code / file_read / file_edit / get_references /
 * fetch_url / unerr_track); the rest are the standard tools a worker/junior
 * needs to do real work. Added by default on `unerr install claude-code`;
 * stripped on uninstall.
 */
export const UNERR_AGENT_ALLOWS = [
  "mcp__unerr",
  "Read",
  "Edit",
  "Write",
  "Bash",
  "WebSearch",
  "WebFetch",
];

/** `.gitignore` entry for the personal Claude Code settings file. */
const LOCAL_SETTINGS_IGNORE = ".claude/settings.local.json";

/**
 * Ensure `.claude/settings.local.json` is gitignored so the personal permission
 * grant unerr writes there (including an unprompted `Bash` allow) never reaches
 * a shared commit. Appends to an existing `.gitignore`, or creates one when
 * absent — unerr may write settings.local.json before Claude Code does, so we
 * can't rely on Claude Code's own ignore entry existing yet. Best-effort; a
 * `.claude/` or `.claude` blanket ignore already covers it.
 */
function ensureLocalSettingsIgnored(cwd: string): void {
  try {
    const gitignorePath = join(cwd, ".gitignore");
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      const already = content.split("\n").some((line) => {
        const t = line.trim();
        return (
          t === LOCAL_SETTINGS_IGNORE ||
          t === `/${LOCAL_SETTINGS_IGNORE}` ||
          t === ".claude/" ||
          t === ".claude"
        );
      });
      if (already) return;
      const newline = content.endsWith("\n") ? "" : "\n";
      writeFileSync(
        gitignorePath,
        `${content}${newline}\n# unerr: personal Claude Code permission grant\n${LOCAL_SETTINGS_IGNORE}\n`,
        "utf-8"
      );
    } else {
      writeFileSync(
        gitignorePath,
        `# unerr: personal Claude Code permission grant\n${LOCAL_SETTINGS_IGNORE}\n`,
        "utf-8"
      );
    }
  } catch {
    // Best-effort — a failure here must not break install.
  }
}

/**
 * Pre-approve unerr's sub-agent tool set in `.claude/settings.local.json`
 * `permissions.allow` (personal + gitignored; inherited by Task sub-agents).
 * Without it every worker/junior tool call hits Claude Code's permission
 * resolver and prompts — delegation stalls. Idempotent: merges into any
 * existing allow list without duplicating or dropping the user's own entries;
 * creates the file when absent; never clobbers a malformed personal settings
 * file. Called by default on `unerr install claude-code`.
 */
export function addAgentToolAllows(cwd: string): {
  added: number;
  path: string;
} {
  const dir = join(cwd, ".claude");
  const settingsPath = join(dir, "settings.local.json");

  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        // Malformed personal settings — don't clobber the user's file.
        return { added: 0, path: settingsPath };
      }
    }

    let permissions = settings.permissions as
      | Record<string, unknown>
      | undefined;
    if (
      !permissions ||
      typeof permissions !== "object" ||
      Array.isArray(permissions)
    ) {
      permissions = {};
      settings.permissions = permissions;
    }

    const allow = Array.isArray(permissions.allow)
      ? (permissions.allow as string[])
      : [];
    const have = new Set(allow);
    let added = 0;
    for (const tool of UNERR_AGENT_ALLOWS) {
      if (!have.has(tool)) {
        allow.push(tool);
        have.add(tool);
        added += 1;
      }
    }

    if (added === 0) return { added: 0, path: settingsPath };
    permissions.allow = allow;

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf-8"
    );
    // The file we just wrote carries an unprompted Bash/Write grant — keep it
    // out of any shared commit.
    ensureLocalSettingsIgnored(cwd);
    return { added, path: settingsPath };
  } catch {
    return { added: 0, path: settingsPath };
  }
}

/**
 * Remove the unerr sub-agent tool grants ({@link UNERR_AGENT_ALLOWS}) from
 * `.claude/settings.local.json` `permissions.allow` — revokes the unprompted
 * shell + write grant on uninstall. Strips exactly the tokens unerr adds; a
 * user who wants any of them independently re-adds it. Deletes the file if it
 * becomes empty. Returns true if any entry was removed.
 */
export function removeAgentToolAllows(cwd: string): boolean {
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const permissions = settings.permissions as
      | Record<string, unknown>
      | undefined;
    if (!permissions || !Array.isArray(permissions.allow)) return false;

    const before = (permissions.allow as string[]).length;
    permissions.allow = (permissions.allow as string[]).filter(
      (tool: string) => !UNERR_AGENT_ALLOWS.includes(tool)
    );
    const removed = before - (permissions.allow as string[]).length;
    if (removed === 0) return false;

    // Clean up empty allow array / permissions object so we leave no noise.
    if ((permissions.allow as string[]).length === 0)
      Reflect.deleteProperty(permissions, "allow");
    if (Object.keys(permissions).length === 0)
      Reflect.deleteProperty(settings, "permissions");

    // If unerr created this file solely for the grant, remove it entirely.
    if (Object.keys(settings).length === 0) {
      rmSync(settingsPath, { force: true });
      return true;
    }

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
      "SessionStart",
      "Stop",
      "SubagentStop",
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
      if ((hooks[eventType] as unknown[]).length === 0)
        Reflect.deleteProperty(hooks, eventType);
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
