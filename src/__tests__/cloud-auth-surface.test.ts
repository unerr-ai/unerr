/**
 * Tests for src/cloud/auth-surface.ts — the Tier-1 in-band line per state.
 *
 * Pins, for each of the six states: the exact wire tag (act vs fct = loud vs
 * quiet), that the body names `unerr login` for command states, that it always
 * states local features keep working, and that the silent states emit nothing.
 * Also verifies the per-state dedupe key so the proxy emits once per session
 * per state. Plus a small integration check against the real signal-dedup
 * table (once per session, re-emits on transition).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AuthState } from "../cloud/auth-state.js";
import {
  authBadge,
  authStateLine,
  authSurfaceSignal,
} from "../cloud/auth-surface.js";
import {
  getSignalDedup,
  resetSignalDedupSingleton,
} from "../proxy/signal-dedup.js";

function mk(partial: Partial<AuthState> & Pick<AuthState, "state">): AuthState {
  return {
    plan: "free",
    features: {},
    was_authenticated: false,
    ...partial,
  };
}

describe("auth-surface — per-state line", () => {
  it("active emits nothing (happy path is silent)", () => {
    expect(authSurfaceSignal(mk({ state: "active", plan: "pro" }))).toBeNull();
  });

  it("stale_refreshing emits nothing (refresh in flight, no alarm)", () => {
    expect(authSurfaceSignal(mk({ state: "stale_refreshing" }))).toBeNull();
  });

  it("logged_out emits nothing in-band (no arrival invite — §5)", () => {
    expect(authSurfaceSignal(mk({ state: "logged_out" }))).toBeNull();
  });

  it("revoked → loud act line naming unerr login", () => {
    const sig = authSurfaceSignal(mk({ state: "revoked", reason: "revoked" }));
    expect(sig?.tag).toBe("act");
    expect(sig?.content).toContain("unerr login");
    expect(sig?.content).toMatch(/local features keep working/);
    expect(sig?.dedupKey).toBe("revoked");
  });

  it("degraded_free → act line, includes expiry date when known", () => {
    const sig = authSurfaceSignal(
      mk({
        state: "degraded_free",
        was_authenticated: true,
        reconnect_by: "2026-06-16T00:00:00.000Z",
      })
    );
    expect(sig?.tag).toBe("act");
    expect(sig?.content).toContain("unerr login");
    expect(sig?.content).toContain("2026-06-16");
    expect(sig?.content).toContain("local features unaffected");
    expect(sig?.dedupKey).toBe("degraded_free");
  });

  it("degraded_free → act line works without a date", () => {
    const sig = authSurfaceSignal(
      mk({ state: "degraded_free", was_authenticated: true })
    );
    expect(sig?.tag).toBe("act");
    expect(sig?.content).toContain("unerr login");
    expect(sig?.content).not.toMatch(/expired (?!.)/); // no dangling "expired"
  });

  it("grace_expiring offline → quiet fct, no command, mentions offline", () => {
    const sig = authSurfaceSignal(
      mk({
        state: "grace_expiring",
        reason: "offline",
        plan: "pro",
        reconnect_by: "2026-06-16T00:00:00.000Z",
      })
    );
    expect(sig?.tag).toBe("fct");
    expect(sig?.content).toContain("offline");
    expect(sig?.content).not.toContain("unerr login"); // offline needs no action
    expect(sig?.dedupKey).toBe("grace_expiring:offline");
  });

  it("grace_expiring unauthorized → loud act, names unerr login", () => {
    const sig = authSurfaceSignal(
      mk({
        state: "grace_expiring",
        reason: "unauthorized",
        plan: "pro",
        reconnect_by: "2026-06-16T00:00:00.000Z",
      })
    );
    expect(sig?.tag).toBe("act");
    expect(sig?.content).toContain("unerr login");
    expect(sig?.content).toContain("2026-06-16");
    expect(sig?.dedupKey).toBe("grace_expiring:unauthorized");
  });
});

describe("auth-surface — passive line + badge (A4)", () => {
  it("every state yields a non-empty resting line", () => {
    const states: AuthState["state"][] = [
      "logged_out",
      "active",
      "stale_refreshing",
      "grace_expiring",
      "degraded_free",
      "revoked",
    ];
    for (const state of states) {
      expect(authStateLine(mk({ state })).length).toBeGreaterThan(0);
    }
  });

  it("active names the org, machine, and plan", () => {
    const line = authStateLine(
      mk({
        state: "active",
        plan: "pro",
        organization_id: "org_acme",
        machine_name: "dev-laptop",
      })
    );
    expect(line).toContain("dev-laptop");
    expect(line).toContain("org_acme");
    expect(line).toContain("pro");
  });

  it("grace line includes the reconnect date", () => {
    const line = authStateLine(
      mk({
        state: "grace_expiring",
        reason: "offline",
        plan: "pro",
        reconnect_by: "2026-06-16T00:00:00.000Z",
      })
    );
    expect(line).toContain("2026-06-16");
  });

  it("badge severity escalates with the state", () => {
    expect(authBadge("active")).toBe("ok");
    expect(authBadge("logged_out")).toBe("info");
    expect(authBadge("stale_refreshing")).toBe("info");
    expect(authBadge("grace_expiring")).toBe("warn");
    expect(authBadge("degraded_free")).toBe("attention");
    expect(authBadge("revoked")).toBe("attention");
  });
});

describe("auth-surface — dedupe via the shared signal table", () => {
  beforeEach(() => resetSignalDedupSingleton());

  it("emits a state once per session, then suppresses the repeat", () => {
    const dedup = getSignalDedup();
    const sig = authSurfaceSignal(mk({ state: "revoked", reason: "revoked" }));
    if (!sig) throw new Error("expected a signal");
    const key = `auth:${sig.dedupKey}`;
    expect(dedup.shouldEmit(sig.tag, key, sig.content)).toBe(true);
    expect(dedup.shouldEmit(sig.tag, key, sig.content)).toBe(false);
  });

  it("re-emits when the state transitions (degraded → revoked)", () => {
    const dedup = getSignalDedup();
    const deg = authSurfaceSignal(
      mk({ state: "degraded_free", was_authenticated: true })
    );
    const rev = authSurfaceSignal(mk({ state: "revoked", reason: "revoked" }));
    if (!deg || !rev) throw new Error("expected signals");
    expect(dedup.shouldEmit(deg.tag, `auth:${deg.dedupKey}`, deg.content)).toBe(
      true
    );
    // A genuinely different state surfaces despite the first already firing.
    expect(dedup.shouldEmit(rev.tag, `auth:${rev.dedupKey}`, rev.content)).toBe(
      true
    );
  });
});
