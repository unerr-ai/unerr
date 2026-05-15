/**
 * Native watcher tests — @parcel/watcher integration with debounced events.
 */

import {
  mkdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type NativeWatcher,
  type WatchEvent,
  createNativeWatcher,
} from "../tracking/native-watcher.js";

let tempDir: string;
let watcher: NativeWatcher | null = null;

function makeTempDir(): string {
  const raw = join(
    tmpdir(),
    `unerr-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

/**
 * Wait until the predicate matches at least one event, or timeout.
 * Returns all collected events at the time the predicate was satisfied.
 */
function waitForMatch(
  collected: WatchEvent[],
  predicate: (e: WatchEvent) => boolean,
  timeoutMs = 3000
): Promise<WatchEvent[]> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (collected.some(predicate)) {
        resolve([...collected]);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve([...collected]);
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start watcher and drain the initial FSEvents directory-creation event
 * that fires when subscribing to a newly-created temp directory.
 */
async function startAndDrain(
  w: NativeWatcher,
  events: WatchEvent[]
): Promise<void> {
  await w.start();
  await delay(500);
  events.length = 0;
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(async () => {
  if (watcher?.isRunning()) {
    await watcher.stop();
  }
  watcher = null;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("NativeWatcher", () => {
  it("can be created and started without errors", async () => {
    const events: WatchEvent[] = [];
    watcher = createNativeWatcher({
      projectRoot: tempDir,
      onEvents: (batch) => events.push(...batch),
    });

    await watcher.start();
    expect(watcher.isRunning()).toBe(true);

    await watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });

  it("detects file creation", async () => {
    const events: WatchEvent[] = [];
    watcher = createNativeWatcher({
      projectRoot: tempDir,
      debounceMs: 30,
      onEvents: (batch) => events.push(...batch),
    });

    await startAndDrain(watcher, events);

    writeFileSync(join(tempDir, "new-file.txt"), "hello");

    const result = await waitForMatch(events, (e) =>
      e.path.includes("new-file.txt")
    );

    const createEvent = result.find((e) => e.path.includes("new-file.txt"));
    expect(createEvent).toBeDefined();
    expect(createEvent?.type).toBe("create");
  });

  it("detects file modification", async () => {
    const filePath = join(tempDir, "existing.txt");
    writeFileSync(filePath, "initial content");

    const events: WatchEvent[] = [];
    watcher = createNativeWatcher({
      projectRoot: tempDir,
      debounceMs: 30,
      onEvents: (batch) => events.push(...batch),
    });

    await startAndDrain(watcher, events);

    writeFileSync(filePath, "updated content");

    const result = await waitForMatch(events, (e) =>
      e.path.includes("existing.txt")
    );

    const updateEvent = result.find((e) => e.path.includes("existing.txt"));
    expect(updateEvent).toBeDefined();
    expect(["create", "update"]).toContain(updateEvent?.type);
  });

  it("detects file deletion", async () => {
    const filePath = join(tempDir, "to-delete.txt");
    writeFileSync(filePath, "will be deleted");

    const events: WatchEvent[] = [];
    watcher = createNativeWatcher({
      projectRoot: tempDir,
      debounceMs: 30,
      onEvents: (batch) => events.push(...batch),
    });

    await startAndDrain(watcher, events);

    unlinkSync(filePath);

    const result = await waitForMatch(events, (e) =>
      e.path.includes("to-delete.txt")
    );

    const deleteEvent = result.find((e) => e.path.includes("to-delete.txt"));
    expect(deleteEvent).toBeDefined();
    expect(deleteEvent?.type).toBe("delete");
  });

  it("debounces rapid writes into a single batch", async () => {
    const batches: WatchEvent[][] = [];
    watcher = createNativeWatcher({
      projectRoot: tempDir,
      debounceMs: 150,
      onEvents: (batch) => batches.push([...batch]),
    });

    await watcher.start();
    await delay(500);
    batches.length = 0;

    for (let i = 0; i < 5; i++) {
      writeFileSync(join(tempDir, `rapid-${i}.txt`), `content-${i}`);
    }

    await delay(500);

    expect(batches.length).toBeLessThanOrEqual(2);

    const allEvents = batches.flat();
    expect(allEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores .git directory changes", async () => {
    const gitDir = join(tempDir, ".git");
    mkdirSync(gitDir, { recursive: true });

    const events: WatchEvent[] = [];
    watcher = createNativeWatcher({
      projectRoot: tempDir,
      debounceMs: 30,
      onEvents: (batch) => events.push(...batch),
    });

    await startAndDrain(watcher, events);

    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main");
    writeFileSync(join(tempDir, "tracked.txt"), "should see this");

    const result = await waitForMatch(events, (e) =>
      e.path.includes("tracked.txt")
    );

    const gitEvents = result.filter(
      (e) => e.path.includes("/.git/") || e.path.endsWith("/.git")
    );
    expect(gitEvents.length).toBe(0);

    const trackedEvent = result.find((e) => e.path.includes("tracked.txt"));
    expect(trackedEvent).toBeDefined();
  });

  it("ignores node_modules directory changes", async () => {
    const nmDir = join(tempDir, "node_modules", "some-pkg");
    mkdirSync(nmDir, { recursive: true });

    const events: WatchEvent[] = [];
    watcher = createNativeWatcher({
      projectRoot: tempDir,
      debounceMs: 30,
      onEvents: (batch) => events.push(...batch),
    });

    await startAndDrain(watcher, events);

    writeFileSync(join(nmDir, "index.js"), "module.exports = {}");
    writeFileSync(join(tempDir, "src-file.ts"), "export const x = 1;");

    const result = await waitForMatch(events, (e) =>
      e.path.includes("src-file.ts")
    );

    const nmEvents = result.filter((e) => e.path.includes("node_modules"));
    expect(nmEvents.length).toBe(0);

    const srcEvent = result.find((e) => e.path.includes("src-file.ts"));
    expect(srcEvent).toBeDefined();
  });

  it("stops cleanly and flushes pending events", async () => {
    const events: WatchEvent[] = [];
    watcher = createNativeWatcher({
      projectRoot: tempDir,
      debounceMs: 5000,
      onEvents: (batch) => events.push(...batch),
    });

    await startAndDrain(watcher, events);

    writeFileSync(join(tempDir, "pending.txt"), "content");

    await delay(300);

    await watcher.stop();
    expect(watcher.isRunning()).toBe(false);

    const pendingEvent = events.find((e) => e.path.includes("pending.txt"));
    expect(pendingEvent).toBeDefined();
  });
});
