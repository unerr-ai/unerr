import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { NotificationEmitter, type NotificationSender } from "../router/notifications.js";
import {
  ExposureTracker,
  buildToolsList,
  type ToolDefinition,
} from "../router/tools-list.js";
import { UnlockDispatcher } from "../router/dispatch.js";
import { AliasRegistry, createAliasRegistry } from "../router/aliasing.js";
import type { JsonRpcNotification } from "../router/client/transport.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeAliasRegistry(): AliasRegistry {
  const aliases = new Map([
    ["github", "gh"],
    ["postgres", "pg"],
    ["slack", "slk"],
  ]);
  const registry = createAliasRegistry(aliases);

  registry.registerServer("github", [
    { name: "search", description: "Search GitHub" },
    { name: "create_issue", description: "Create issue" },
    { name: "list_prs", description: "List pull requests" },
  ]);
  registry.registerServer("postgres", [
    { name: "query", description: "Run SQL" },
    { name: "list_tables", description: "List tables" },
  ]);
  registry.registerServer("slack", [
    { name: "send_message", description: "Send message" },
  ]);

  return registry;
}

const UNERR_TOOLS: ToolDefinition[] = [
  { name: "search_code", description: "Search code", inputSchema: { type: "object" } },
  { name: "file_read", description: "Read file", inputSchema: { type: "object" } },
];

// ── NotificationEmitter ──────────────────────────────────────────

describe("NotificationEmitter", () => {
  let notifications: JsonRpcNotification[];
  let sender: NotificationSender;

  beforeEach(() => {
    vi.useFakeTimers();
    notifications = [];
    sender = (n) => notifications.push(n);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits list_changed notification", () => {
    const emitter = new NotificationEmitter(sender);
    emitter.notify();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.method).toBe("notifications/tools/list_changed");
    emitter.shutdown();
  });

  it("throttles rapid notifications to 250ms intervals", () => {
    const emitter = new NotificationEmitter(sender);

    emitter.notify();
    expect(notifications).toHaveLength(1);

    emitter.notify();
    emitter.notify();
    expect(notifications).toHaveLength(1);

    vi.advanceTimersByTime(250);
    expect(notifications).toHaveLength(2);

    emitter.shutdown();
  });

  it("coalesces rapid unlocks into single notification", () => {
    const emitter = new NotificationEmitter(sender);

    emitter.notify();
    expect(notifications).toHaveLength(1);

    emitter.notify();
    emitter.notify();
    emitter.notify();

    vi.advanceTimersByTime(250);
    expect(notifications).toHaveLength(2);

    emitter.shutdown();
  });

  it("allows notification after throttle window expires", () => {
    const emitter = new NotificationEmitter(sender);

    emitter.notify();
    vi.advanceTimersByTime(300);
    emitter.notify();

    expect(notifications).toHaveLength(2);
    emitter.shutdown();
  });

  it("markRefetch resets stale detection", () => {
    const emitter = new NotificationEmitter(sender);
    emitter.notify();
    emitter.markRefetch();

    vi.advanceTimersByTime(6000);
    expect(emitter.isDemoted).toBe(false);
    emitter.shutdown();
  });

  it("detects stale list after 5s without refetch", () => {
    let staleCount = 0;
    const emitter = new NotificationEmitter(sender, {
      onStaleDetected: (count) => { staleCount = count; },
    });

    emitter.notify();
    vi.advanceTimersByTime(5000);

    expect(staleCount).toBe(1);
    expect(emitter.totalStale).toBe(1);
    emitter.shutdown();
  });

  it("demotes to static after 3 consecutive stale notifications", () => {
    let demoted = false;
    const emitter = new NotificationEmitter(sender, {
      onDemotedToStatic: () => { demoted = true; },
    });

    emitter.notify();
    vi.advanceTimersByTime(5000);
    expect(demoted).toBe(false);

    vi.advanceTimersByTime(250);
    emitter.notify();
    vi.advanceTimersByTime(5000);
    expect(demoted).toBe(false);

    vi.advanceTimersByTime(250);
    emitter.notify();
    vi.advanceTimersByTime(5000);
    expect(demoted).toBe(true);
    expect(emitter.isDemoted).toBe(true);
    emitter.shutdown();
  });

  it("stops emitting after demotion", () => {
    const emitter = new NotificationEmitter(sender);

    for (let i = 0; i < 3; i++) {
      emitter.notify();
      vi.advanceTimersByTime(5250);
    }

    const countBefore = notifications.length;
    const result = emitter.notify();
    expect(result).toBe(false);
    expect(notifications.length).toBe(countBefore);
    emitter.shutdown();
  });

  it("refetch between notifications prevents demotion", () => {
    const emitter = new NotificationEmitter(sender);

    emitter.notify();
    vi.advanceTimersByTime(3000);
    emitter.markRefetch();
    vi.advanceTimersByTime(3000);

    expect(emitter.isDemoted).toBe(false);
    emitter.shutdown();
  });

  it("flush() sends pending throttled notification immediately", () => {
    const emitter = new NotificationEmitter(sender);

    emitter.notify();
    emitter.notify();
    expect(notifications).toHaveLength(1);

    emitter.flush();
    expect(notifications).toHaveLength(2);
    emitter.shutdown();
  });

  it("tracks total emitted count", () => {
    const emitter = new NotificationEmitter(sender);
    emitter.notify();
    vi.advanceTimersByTime(300);
    emitter.notify();
    expect(emitter.totalEmitted).toBe(2);
    emitter.shutdown();
  });
});

// ── ExposureTracker ──────────────────────────────────────────────

describe("ExposureTracker", () => {
  it("tracks exposed tools (monotonic add)", () => {
    const tracker = new ExposureTracker();
    expect(tracker.expose("gh_search")).toBe(true);
    expect(tracker.expose("gh_search")).toBe(false);
    expect(tracker.isExposed("gh_search")).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it("exposeMany returns only newly exposed", () => {
    const tracker = new ExposureTracker();
    tracker.expose("gh_search");

    const newly = tracker.exposeMany(["gh_search", "pg_query", "slk_send_message"]);
    expect(newly).toEqual(["pg_query", "slk_send_message"]);
    expect(tracker.size).toBe(3);
  });

  it("getAll returns all exposed tools", () => {
    const tracker = new ExposureTracker();
    tracker.expose("a");
    tracker.expose("b");
    const all = tracker.getAll();
    expect(all.has("a")).toBe(true);
    expect(all.has("b")).toBe(true);
    expect(all.size).toBe(2);
  });
});

// ── buildToolsList ───────────────────────────────────────────────

describe("buildToolsList", () => {
  it("dynamic mode: only returns exposed tools + unerr own", () => {
    const registry = makeAliasRegistry();
    const tracker = new ExposureTracker();
    tracker.expose("gh_search");
    tracker.expose("pg_query");

    const result = buildToolsList(registry, tracker, UNERR_TOOLS, "dynamic");

    expect(result.mode).toBe("dynamic");
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("search_code");
    expect(names).toContain("file_read");
    expect(names).toContain("gh_search");
    expect(names).toContain("pg_query");
    expect(names).not.toContain("gh_create_issue");
    expect(names).not.toContain("slk_send_message");
    expect(result.totalExposed).toBe(4);
  });

  it("static mode: returns all tools with soft-refuse for locked ones", () => {
    const registry = makeAliasRegistry();
    const tracker = new ExposureTracker();
    tracker.expose("gh_search");

    const result = buildToolsList(registry, tracker, UNERR_TOOLS, "static");

    expect(result.mode).toBe("static");
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("search_code");
    expect(names).toContain("gh_search");
    expect(names).toContain("gh_create_issue");
    expect(names).toContain("pg_query");
    expect(names).toContain("slk_send_message");

    const locked = result.tools.find((t) => t.name === "pg_query")!;
    expect(locked.description).toContain("[locked]");
    expect(locked.description).toContain("unlock instructions");

    const exposed = result.tools.find((t) => t.name === "gh_search")!;
    expect(exposed.description).not.toContain("[locked]");
  });

  it("dynamic mode with no exposures only shows unerr own tools", () => {
    const registry = makeAliasRegistry();
    const tracker = new ExposureTracker();

    const result = buildToolsList(registry, tracker, UNERR_TOOLS, "dynamic");
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name)).toEqual(["search_code", "file_read"]);
  });

  it("reports correct totalAvailable including all aliased + own", () => {
    const registry = makeAliasRegistry();
    const tracker = new ExposureTracker();

    const result = buildToolsList(registry, tracker, UNERR_TOOLS, "static");
    expect(result.totalAvailable).toBe(8);
  });
});

// ── UnlockDispatcher ─────────────────────────────────────────────

describe("UnlockDispatcher", () => {
  let notifications: JsonRpcNotification[];
  let emitter: NotificationEmitter;
  let tracker: ExposureTracker;
  let dispatcher: UnlockDispatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    notifications = [];
    emitter = new NotificationEmitter((n) => notifications.push(n));
    tracker = new ExposureTracker();
    dispatcher = new UnlockDispatcher(tracker, emitter);
  });

  afterEach(() => {
    emitter.shutdown();
    vi.useRealTimers();
  });

  it("recordUnlock + flushUnlocks exposes tools and notifies", () => {
    dispatcher.recordUnlock("gh_search", "soft-refuse response");
    dispatcher.recordUnlock("pg_query", "tier unlock");
    expect(dispatcher.pendingCount).toBe(2);

    const newly = dispatcher.flushUnlocks();
    expect(newly).toEqual(["gh_search", "pg_query"]);
    expect(tracker.isExposed("gh_search")).toBe(true);
    expect(tracker.isExposed("pg_query")).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(dispatcher.pendingCount).toBe(0);
  });

  it("does not notify for already-exposed tools", () => {
    tracker.expose("gh_search");

    dispatcher.recordUnlock("gh_search", "duplicate");
    const newly = dispatcher.flushUnlocks();
    expect(newly).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it("coalesces multiple unlocks into single notification", () => {
    dispatcher.recordUnlock("gh_search", "a");
    dispatcher.recordUnlock("pg_query", "b");
    dispatcher.recordUnlock("slk_send_message", "c");
    dispatcher.flushUnlocks();

    expect(notifications).toHaveLength(1);
    expect(tracker.size).toBe(3);
  });

  it("flushUnlocks returns empty when nothing pending", () => {
    const newly = dispatcher.flushUnlocks();
    expect(newly).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it("recordUnlocks batch method works", () => {
    dispatcher.recordUnlocks([
      { prefixedName: "gh_search", reason: "a" },
      { prefixedName: "pg_query", reason: "b" },
    ]);
    expect(dispatcher.pendingCount).toBe(2);

    const newly = dispatcher.flushUnlocks();
    expect(newly).toEqual(["gh_search", "pg_query"]);
  });

  it("maintains unlock history across flushes", () => {
    dispatcher.recordUnlock("gh_search", "reason-1");
    dispatcher.flushUnlocks();

    vi.advanceTimersByTime(300);

    dispatcher.recordUnlock("pg_query", "reason-2");
    dispatcher.flushUnlocks();

    const history = dispatcher.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.prefixedName).toBe("gh_search");
    expect(history[1]!.prefixedName).toBe("pg_query");
  });

  it("wasUnlocked tracks cumulative state", () => {
    expect(dispatcher.wasUnlocked("gh_search")).toBe(false);

    dispatcher.recordUnlock("gh_search", "test");
    dispatcher.flushUnlocks();

    expect(dispatcher.wasUnlocked("gh_search")).toBe(true);
  });

  it("does not notify when emitter is demoted", () => {
    for (let i = 0; i < 3; i++) {
      emitter.notify();
      vi.advanceTimersByTime(5250);
    }
    expect(emitter.isDemoted).toBe(true);

    dispatcher.recordUnlock("gh_search", "post-demotion");
    const countBefore = notifications.length;
    dispatcher.flushUnlocks();

    expect(tracker.isExposed("gh_search")).toBe(true);
    expect(notifications.length).toBe(countBefore);
  });
});

// ── Integration: Full Dynamic Disclosure Flow ────────────────────

describe("Full Dynamic Disclosure Flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("unlock → notification → refetch → expanded list", () => {
    const notifications: JsonRpcNotification[] = [];
    const emitter = new NotificationEmitter((n) => notifications.push(n));
    const tracker = new ExposureTracker();
    const dispatcher = new UnlockDispatcher(tracker, emitter);
    const registry = makeAliasRegistry();

    tracker.expose("gh_search");

    const list1 = buildToolsList(registry, tracker, UNERR_TOOLS, "dynamic");
    expect(list1.tools.map((t) => t.name)).toContain("gh_search");
    expect(list1.tools.map((t) => t.name)).not.toContain("pg_query");

    dispatcher.recordUnlock("pg_query", "soft-refuse triggered");
    dispatcher.flushUnlocks();
    expect(notifications).toHaveLength(1);

    emitter.markRefetch();

    const list2 = buildToolsList(registry, tracker, UNERR_TOOLS, "dynamic");
    expect(list2.tools.map((t) => t.name)).toContain("gh_search");
    expect(list2.tools.map((t) => t.name)).toContain("pg_query");
    expect(list2.totalExposed).toBe(list1.totalExposed + 1);

    emitter.shutdown();
  });

  it("misbehaving client → demotion → static mode fallback", () => {
    let demoted = false;
    const emitter = new NotificationEmitter(
      () => {},
      { onDemotedToStatic: () => { demoted = true; } },
    );
    const tracker = new ExposureTracker();
    const dispatcher = new UnlockDispatcher(tracker, emitter);
    const registry = makeAliasRegistry();

    for (let i = 0; i < 3; i++) {
      dispatcher.recordUnlock(`tool_${i}`, "test");
      dispatcher.flushUnlocks();
      vi.advanceTimersByTime(5250);
    }

    expect(demoted).toBe(true);
    expect(emitter.isDemoted).toBe(true);

    const staticList = buildToolsList(registry, tracker, UNERR_TOOLS, "static");
    expect(staticList.mode).toBe("static");
    expect(staticList.tools.length).toBeGreaterThan(tracker.size);

    const lockedTool = staticList.tools.find(
      (t) => !tracker.isExposed(t.name) && t.name !== "search_code" && t.name !== "file_read",
    );
    expect(lockedTool?.description).toContain("[locked]");

    emitter.shutdown();
  });
});
