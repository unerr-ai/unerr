/**
 * Native file watcher — @parcel/watcher with debounced event emission.
 *
 * Uses OS-level file watching (FSEvents on macOS, inotify on Linux, ReadDirectoryChanges on Windows)
 * for millisecond-scale change detection. Events are debounced into batches (default 50ms window)
 * and deduplicated before emission.
 *
 * Respects .gitignore patterns and always excludes .unerr/, node_modules/, .git/.
 */

import fs from "node:fs";
import path from "node:path";
import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("native-watcher");

export type WatchEventType = "create" | "update" | "delete";

export interface WatchEvent {
  type: WatchEventType;
  path: string;
}

export interface NativeWatcherOptions {
  projectRoot: string;
  /** Debounce window in ms (default: 50) */
  debounceMs?: number;
  /** Additional ignore patterns beyond .gitignore */
  ignorePatterns?: string[];
  /** Callback for batched events */
  onEvents: (events: WatchEvent[]) => void;
}

export interface NativeWatcher {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

const ALWAYS_IGNORE_DIRS = [".unerr", "node_modules", ".git"];

function loadGitignorePatterns(projectRoot: string): string[] {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  try {
    if (!fs.existsSync(gitignorePath)) return [];
    const content = fs.readFileSync(gitignorePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Build ignore list for @parcel/watcher. Uses relative directory names
 * so the wrapper resolves them against the (real) watched directory,
 * avoiding symlink mismatches (e.g. /tmp → /private/tmp on macOS).
 */
function buildIgnoreList(projectRoot: string, extra: string[] = []): string[] {
  const patterns: string[] = [...ALWAYS_IGNORE_DIRS];

  for (const pattern of loadGitignorePatterns(projectRoot)) {
    patterns.push(pattern.startsWith("/") ? pattern.slice(1) : pattern);
  }

  for (const pattern of extra) {
    patterns.push(pattern);
  }

  return patterns;
}

export function createNativeWatcher(opts: NativeWatcherOptions): NativeWatcher {
  const { projectRoot, debounceMs = 50, ignorePatterns = [], onEvents } = opts;

  let subscription: { unsubscribe(): Promise<void> } | null = null;
  let running = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEvents: WatchEvent[] = [];

  function flushEvents(): void {
    if (pendingEvents.length === 0) return;

    const deduped = new Map<string, WatchEvent>();
    for (const evt of pendingEvents) {
      deduped.set(evt.path, evt);
    }

    const batch = Array.from(deduped.values());
    pendingEvents = [];

    try {
      onEvents(batch);
    } catch (err) {
      log.error("Error in onEvents callback:", err);
    }
  }

  function scheduleFlush(): void {
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flushEvents();
    }, debounceMs);
    debounceTimer.unref();
  }

  async function start(): Promise<void> {
    if (running) return;

    let subscribeFn: typeof import("@parcel/watcher").subscribe;
    try {
      const mod = await import("@parcel/watcher");
      subscribeFn = mod.subscribe;
    } catch (err) {
      log.warn(
        "@parcel/watcher native bindings unavailable — file watching disabled.",
        err instanceof Error ? err.message : String(err)
      );
      return;
    }

    const resolvedRoot = fs.realpathSync(projectRoot);
    const ignore = buildIgnoreList(resolvedRoot, ignorePatterns);
    log.debug("Starting native watcher", { projectRoot: resolvedRoot, ignore });

    subscription = await subscribeFn(
      resolvedRoot,
      (err: Error | null, events: Array<{ type: string; path: string }>) => {
        if (err) {
          log.error("Watcher error:", err);
          return;
        }
        for (const evt of events) {
          const rel = path.relative(resolvedRoot, evt.path);
          const segs = rel.split(path.sep);
          if (segs.some((s) => ALWAYS_IGNORE_DIRS.includes(s))) continue;
          pendingEvents.push({
            type: evt.type as WatchEventType,
            path: evt.path,
          });
        }
        if (pendingEvents.length > 0) scheduleFlush();
      },
      { ignore }
    );

    running = true;
    log.debug("Native watcher started");
  }

  async function stop(): Promise<void> {
    if (!running) return;

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      flushEvents();
    }

    if (subscription) {
      await subscription.unsubscribe();
      subscription = null;
    }

    running = false;
    log.debug("Native watcher stopped");
  }

  function isRunning(): boolean {
    return running;
  }

  return { start, stop, isRunning };
}
