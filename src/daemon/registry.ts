/**
 * Daemon registry — CRUD operations on ~/.unerr/repos.json.
 *
 * The registry is the single source of truth for which repos are managed
 * by the unerrd supervisor. Each repo entry stores:
 *   - Absolute path (identity anchor — P3: directory is identity)
 *   - Timestamps (addedAt, lastStarted, lastActivity)
 *   - Derived label (basename for display, guaranteed unique in registry)
 *   - Settings (idleTimeout, javaBuildTool, autostart, future keys)
 *
 * All repo-specific artifacts live in <repo>/.unerr/. The registry only
 * stores paths + metadata. Deleting ~/.unerr/ loses registration, not
 * intelligence — each repo's .unerr/ is intact.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { UNLIMITED, checkRegisterRepo } from "../cloud/plan/index.js";
import {
  DEFAULT_IDLE_TIMEOUT_S,
  type NeedsInputSignal,
  type RegistryFile,
  type RepoEntry,
  type RepoSettings,
} from "./protocol.js";

// ── Paths ───────────────────────────────────────────────────────

/** Global unerr directory — supervisor state only. Respects UNERR_HOME for testing. */
export function globalDir(): string {
  const override = process.env.UNERR_HOME;
  if (override) return join(override, ".unerr");
  return join(homedir(), ".unerr");
}

/** Path to the registry file. */
export function registryPath(): string {
  return join(globalDir(), "repos.json");
}

// ── Read / Write ────────────────────────────────────────────────

/**
 * Expand a leading `~` to the home directory. Older versions persisted repo
 * paths in tilde form (`~/IdeaProjects/foo`); a literal `~` is never expanded
 * by the OS, so consumers that use a registry path verbatim as a spawn `cwd`
 * (warm-start) hit ENOENT, and path matchers comparing against `resolve()`
 * output never match. Expanding on read makes every consumer see one canonical
 * absolute path.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/** Read the registry from disk. Returns empty registry if missing. */
export function readRegistry(): RegistryFile {
  try {
    const raw = readFileSync(registryPath(), "utf-8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.repos)) {
      return { version: 1, repos: [] };
    }
    // Normalize legacy tilde-form paths to absolute. Every downstream consumer
    // (spawn cwd, status display, path matching) then sees one canonical form,
    // and the next writeRegistry() persists the absolute path back — so stored
    // tilde entries self-heal on the next mutation.
    for (const repo of parsed.repos) {
      repo.path = resolve(expandHome(repo.path));
    }
    return parsed;
  } catch {
    return { version: 1, repos: [] };
  }
}

/** Write the registry atomically (write-then-rename is overkill for <100 entries). */
export function writeRegistry(reg: RegistryFile): void {
  const dir = globalDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(registryPath(), `${JSON.stringify(reg, null, 2)}\n`);
}

// ── Label generation ────────────────────────────────────────────

/**
 * Derive a unique, human-friendly label from the repo path.
 * Falls back to `<parent>-<basename>` then `<basename>-<N>` on collision.
 */
export function deriveLabel(repoPath: string, existing: RepoEntry[]): string {
  const base = basename(repoPath);
  const taken = new Set(existing.map((e) => e.label));
  if (!taken.has(base)) return base;

  const parentBase = `${basename(dirname(repoPath))}-${base}`;
  if (!taken.has(parentBase)) return parentBase;

  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ── CRUD ────────────────────────────────────────────────────────

export interface AddResult {
  ok: true;
  entry: RepoEntry;
  created: boolean;
}

export interface AddConflict {
  ok: false;
  error: string;
  parentConflict?: string;
  childConflicts?: string[];
  /** Set when the refusal is the free-tier repo cap (vs a path conflict). */
  freeCapExceeded?: boolean;
}

/**
 * Add a repo to the registry.
 *
 * Steps:
 *   1. Resolve to absolute path
 *   2. Check if already registered (idempotent — returns existing entry)
 *   3. Parent-directory conflict check
 *   4. Child-directory overlap scan
 *   5. Add entry with settings
 *   6. Ensure <repo>/.unerr/ exists
 *   7. Mirror settings to <repo>/.unerr/config.json
 */
export function addRepo(
  rawPath: string,
  settings: Partial<RepoSettings> = {},
  opts: {
    skipParentCheck?: boolean;
    skipChildCheck?: boolean;
    /**
     * The plan's repo limit (`repoLimit(tierFromCache())`). Resolved by the
     * caller and injected so this module stays free of any cloud import (the
     * daemon client already imports registry — importing it back would cycle).
     * Omitted ⇒ no cap (treated as unlimited); `skipCap` also bypasses.
     */
    repoLimit?: number;
    skipCap?: boolean;
  } = {}
): AddResult | AddConflict {
  const absPath = resolve(expandHome(rawPath));
  const reg = readRegistry();

  // Already registered — idempotent (re-adding the current repo is always
  // allowed, so this short-circuits before the cap check below).
  const existing = reg.repos.find((r) => r.path === absPath);
  if (existing) {
    return { ok: true, entry: existing, created: false };
  }

  // Free-tier repo cap: refuse a new repo once the account is at its limit.
  // Runs after idempotency (above) and before the path-conflict checks.
  if (!opts.skipCap) {
    const verdict = checkRegisterRepo({
      limit: opts.repoLimit ?? UNLIMITED,
      currentCount: reg.repos.length,
    });
    if (!verdict.allowed) {
      return { ok: false, error: verdict.message, freeCapExceeded: true };
    }
  }

  // Parent-directory conflict: walk up from absPath checking for existing registrations
  if (!opts.skipParentCheck) {
    const parentConflict = detectParentConflict(absPath, reg.repos);
    if (parentConflict) {
      return {
        ok: false,
        error: `Parent directory ${parentConflict} already registered with unerrd. That process covers this subdirectory.`,
        parentConflict,
      };
    }
  }

  // Child-directory overlap: any registered repo that is a subdirectory of absPath
  if (!opts.skipChildCheck) {
    const childConflicts = detectChildConflicts(absPath, reg.repos);
    if (childConflicts.length > 0) {
      return {
        ok: false,
        error: `Subdirectories already registered: ${childConflicts.join(", ")}. Remove them first or use --skip-child-check.`,
        childConflicts,
      };
    }
  }

  const entry: RepoEntry = {
    path: absPath,
    addedAt: new Date().toISOString(),
    lastStarted: null,
    lastActivity: null,
    idleTimeout: (settings.idleTimeout as number) ?? DEFAULT_IDLE_TIMEOUT_S,
    label: deriveLabel(absPath, reg.repos),
    settings: buildSettings(settings),
  };

  reg.repos.push(entry);
  writeRegistry(reg);

  // Ensure <repo>/.unerr/ exists
  const unerrDir = join(absPath, ".unerr");
  if (!existsSync(unerrDir)) {
    mkdirSync(unerrDir, { recursive: true });
  }

  // Mirror settings to local config
  mirrorSettingsToLocal(absPath, entry.settings);

  return { ok: true, entry, created: true };
}

/** Remove a repo from the registry by absolute path. */
export function removeRepo(rawPath: string): boolean {
  const absPath = resolve(expandHome(rawPath));
  const reg = readRegistry();
  const before = reg.repos.length;
  reg.repos = reg.repos.filter((r) => r.path !== absPath);
  if (reg.repos.length === before) return false;
  writeRegistry(reg);
  return true;
}

/** Find a repo entry by path or label. */
export function findRepo(pathOrLabel: string): RepoEntry | undefined {
  const reg = readRegistry();
  const abs = resolve(expandHome(pathOrLabel));
  return (
    reg.repos.find((r) => r.path === abs) ??
    reg.repos.find((r) => r.label === pathOrLabel)
  );
}

/** List all registered repos. */
export function listRepos(): RepoEntry[] {
  return readRegistry().repos;
}

// ── Config update ───────────────────────────────────────────────

/**
 * Update settings on an existing repo entry.
 * Writes to both registry and <repo>/.unerr/config.json.
 * Returns the updated entry, or null if not found.
 */
export function updateRepoSettings(
  rawPath: string,
  patch: Record<string, string | number | boolean>
): RepoEntry | null {
  const absPath = resolve(expandHome(rawPath));
  const reg = readRegistry();
  const entry = reg.repos.find((r) => r.path === absPath);
  if (!entry) return null;

  // Apply patch
  for (const [k, v] of Object.entries(patch)) {
    entry.settings[k] = v;
    // Keep top-level shorthand fields in sync
    if (k === "idleTimeout" && typeof v === "number") {
      entry.idleTimeout = v;
    }
  }

  writeRegistry(reg);
  mirrorSettingsToLocal(absPath, entry.settings);
  return entry;
}

/**
 * Persist a repo's most-recent-activity timestamp to the registry. Called when
 * a proxy stops so the last-known activity survives a daemon restart and is
 * reportable for a stopped repo (the live in-memory value is gone once the
 * child exits). No-op when the repo isn't registered. Best-effort: a write
 * failure is swallowed by writeRegistry's caller contract.
 */
export function touchRepoActivity(rawPath: string, isoTimestamp: string): void {
  const absPath = resolve(expandHome(rawPath));
  const reg = readRegistry();
  const entry = reg.repos.find((r) => r.path === absPath);
  if (!entry) return;
  entry.lastActivity = isoTimestamp;
  writeRegistry(reg);
}

/**
 * Stamp a repo's `lastStarted` (the source for fleet `last_used_at`). Call when
 * a proxy begins serving via ANY path — a fresh fork OR adoption of an
 * already-live proxy. The adopt path historically skipped this, leaving
 * `last_used_at` null on every repo a long-lived daemon adopted rather than
 * forked. No-op when the repo isn't registered.
 */
export function touchRepoStarted(rawPath: string, isoTimestamp: string): void {
  const absPath = resolve(expandHome(rawPath));
  const reg = readRegistry();
  const entry = reg.repos.find((r) => r.path === absPath);
  if (!entry) return;
  entry.lastStarted = isoTimestamp;
  writeRegistry(reg);
}

// ── Parent / child detection ────────────────────────────────────

/**
 * Walk up from `target` checking if any parent directory is registered.
 * Returns the conflicting parent path, or null.
 */
export function detectParentConflict(
  target: string,
  repos: RepoEntry[]
): string | null {
  const registeredPaths = new Set(repos.map((r) => r.path));
  let current = dirname(target);
  const root = dirname(current) === current ? current : undefined;

  while (current !== root) {
    if (registeredPaths.has(current)) return current;
    // Also check for .unerr/ directory with a running process
    if (existsSync(join(current, ".unerr", "state", "proxy.pid"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Find registered repos that are subdirectories of `target`.
 * Returns paths of conflicting children.
 */
export function detectChildConflicts(
  target: string,
  repos: RepoEntry[]
): string[] {
  const normalized = target.endsWith("/") ? target : `${target}/`;
  return repos.filter((r) => r.path.startsWith(normalized)).map((r) => r.path);
}

// ── Needs-input signals ─────────────────────────────────────────

/**
 * Read needs_input signals from <repo>/.unerr/needs-input.json.
 * Written by the per-repo process when auto-detection picks under ambiguity.
 */
export function readNeedsInput(repoPath: string): NeedsInputSignal[] {
  try {
    const p = join(repoPath, ".unerr", "needs-input.json");
    return JSON.parse(readFileSync(p, "utf-8")) as NeedsInputSignal[];
  } catch {
    return [];
  }
}

/**
 * Write needs_input signals to <repo>/.unerr/needs-input.json.
 * Called by the per-repo process (e.g., Java build tool auto-detection).
 */
export function writeNeedsInput(
  repoPath: string,
  signals: NeedsInputSignal[]
): void {
  const dir = join(repoPath, ".unerr");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "needs-input.json"),
    `${JSON.stringify(signals, null, 2)}\n`
  );
}

/**
 * Remove a single needs_input signal by `key`, preserving any other subsystems'
 * signals. Used by the SCIP orchestrator after cascade retry resolves a prior
 * ambiguous javaBuildTool pick.
 */
export function clearNeedsInputKey(repoPath: string, key: string): void {
  const existing = readNeedsInput(repoPath);
  if (existing.length === 0) return;
  const remaining = existing.filter((s) => s.key !== key);
  if (remaining.length === existing.length) return;
  writeNeedsInput(repoPath, remaining);
}

// ── Internal helpers ────────────────────────────────────────────

/** Build a clean settings object from partial input. */
function buildSettings(partial: Partial<RepoSettings>): RepoSettings {
  const s: RepoSettings = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined && k !== "idleTimeout") {
      s[k] = v;
    }
  }
  return s;
}

/**
 * Mirror settings from registry into <repo>/.unerr/config.json.
 * Merges with any existing config (preserves repoId, mode, etc.).
 */
function mirrorSettingsToLocal(repoPath: string, settings: RepoSettings): void {
  const configPath = join(repoPath, ".unerr", "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // Fresh config
  }

  for (const [k, v] of Object.entries(settings)) {
    if (v !== undefined) {
      config[k] = v;
    }
  }

  const dir = join(repoPath, ".unerr");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
