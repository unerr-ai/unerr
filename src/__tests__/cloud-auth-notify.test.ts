/**
 * Tests for src/cloud/auth-notify.ts — the Tier-3 transition notifier policy.
 *
 * Pins LOGIN_UX_STRATEGY.md §9 decision 4: `revoked` notifies by default,
 * `degraded_free` only when grace notifications are enabled, healthy states
 * reset the latch (so the next degrade re-notifies), `grace_expiring` is a
 * no-op, and a transition is announced exactly once (no re-fire on the next
 * tick). All deps are injected — no real OS notifier, filesystem, or settings.
 */

import { describe, expect, it, vi } from "vitest";
import { maybeNotifyAuthTransition } from "../cloud/auth-notify.js";
import type { AuthStateName } from "../cloud/auth-state.js";

/** In-memory harness over the injectable seams. Tracks the latch + notify. */
function harness(notifyGrace = false) {
  let latch: string | undefined;
  const notify = vi.fn<(title: string, body: string) => void>();
  const run = (state: AuthStateName): void =>
    maybeNotifyAuthTransition({
      getState: () => state,
      readLatch: () => latch,
      writeLatch: (s) => {
        latch = s;
      },
      notify,
      notifyGrace,
    });
  return { run, notify, latch: () => latch };
}

describe("auth-notify — transition policy", () => {
  it("revoked → notifies once, names unerr login + local features, latches", () => {
    const h = harness();
    h.run("revoked");
    expect(h.notify).toHaveBeenCalledTimes(1);
    const [title, body] = h.notify.mock.calls[0]!;
    expect(title.toLowerCase()).toContain("unerr");
    expect(body).toContain("unerr login");
    expect(body).toMatch(/local features keep working/i);
    expect(h.latch()).toBe("revoked");
  });

  it("revoked again while latched → no re-fire", () => {
    const h = harness();
    h.run("revoked");
    h.run("revoked");
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("degraded_free with grace OFF → no toast, but latches (consumed)", () => {
    const h = harness(false);
    h.run("degraded_free");
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.latch()).toBe("degraded_free");
  });

  it("degraded_free with grace ON → notifies once", () => {
    const h = harness(true);
    h.run("degraded_free");
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![1]).toContain("unerr login");
  });

  it("healthy state resets the latch so the next degrade re-notifies", () => {
    const h = harness();
    h.run("revoked"); // latch=revoked, 1 notify
    h.run("active"); // healthy → latch cleared, no notify
    expect(h.latch()).toBeUndefined();
    h.run("revoked"); // fresh transition → notifies again
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("grace_expiring is a no-op (Tier-1/2 warning, not a Tier-3 toast)", () => {
    const h = harness();
    h.run("grace_expiring");
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.latch()).toBeUndefined(); // latch untouched, not reset
  });

  it("logged_out / stale_refreshing are healthy → no toast", () => {
    const h = harness();
    h.run("logged_out");
    h.run("stale_refreshing");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("never throws when the OS notifier throws (best-effort)", () => {
    let latch: string | undefined;
    expect(() =>
      maybeNotifyAuthTransition({
        getState: () => "revoked",
        readLatch: () => latch,
        writeLatch: (s) => {
          latch = s;
        },
        notify: () => {
          throw new Error("dbus down");
        },
      })
    ).not.toThrow();
  });
});
