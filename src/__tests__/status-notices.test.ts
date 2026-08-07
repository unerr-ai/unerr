/**
 * status-notices — gatherNotices + render helpers.
 *
 * All tests use fully-injected deps (no real auth, no filesystem, no network).
 * The contract under test: both-null → empty strings; each notice slot carries
 * only its source's content; order is login-first then update; a throwing
 * source degrades to null without propagating; renderNoticesRed wraps each
 * present line in the exact ANSI escape that startupLog.fmt.red produces.
 */

import { describe, expect, it } from "vitest";
import type { AuthState } from "../cloud/auth/auth-state.js";
import type { AuthSignal } from "../cloud/auth/auth-surface.js";
import {
  type GatherNoticesDeps,
  type StatusNotices,
  gatherNotices,
  renderNoticesPlain,
  renderNoticesRed,
} from "../notices/status-notices.js";
import type { UpdateSignal } from "../update/update-surface.js";

// ── ANSI codes produced by startupLog.fmt.red ────────────────────────────────
// RED = fgRgb(248, 113, 113) = "\x1b[38;2;248;113;113m"
// RESET = "\x1b[0m"
const RED_OPEN = "\x1b[38;2;248;113;113m";
const RESET = "\x1b[0m";
function ansiRed(s: string): string {
  return `${RED_OPEN}${s}${RESET}`;
}

// ── Shared stub values ────────────────────────────────────────────────────────

const LOGIN_CONTENT =
  "RUN `unerr login` — this machine was removed from your unerr org; local features keep working";
const UPDATE_CONTENT =
  "run `unerr upgrade` — unerr 1.0.0 available (minor; release notes: https://example.com)";

function makeAuthState(state: AuthState["state"] = "logged_out"): AuthState {
  return {
    state,
    plan: "free",
    features: {},
    was_authenticated: false,
  };
}

function loginSignal(): AuthSignal {
  return { tag: "act", content: LOGIN_CONTENT, dedupKey: "revoked" };
}

function updateSignalStub(): UpdateSignal {
  return {
    tag: "act",
    content: UPDATE_CONTENT,
    dedupKey: "available:1.0.0",
    version: "1.0.0",
  };
}

// ── gatherNotices ─────────────────────────────────────────────────────────────

describe("gatherNotices", () => {
  it("both sources return null → both slots null", () => {
    const deps: GatherNoticesDeps = {
      authStateFn: () => makeAuthState("logged_out"),
      authSignalFn: () => null,
      updateSignalFn: () => null,
    };
    expect(gatherNotices(deps)).toEqual<StatusNotices>({
      login: null,
      update: null,
    });
  });

  it("login source returns a signal → login slot carries .content", () => {
    const deps: GatherNoticesDeps = {
      authStateFn: () => makeAuthState("revoked"),
      authSignalFn: () => loginSignal(),
      updateSignalFn: () => null,
    };
    const result = gatherNotices(deps);
    expect(result.login).toBe(LOGIN_CONTENT);
    expect(result.update).toBeNull();
  });

  it("update source returns a signal → update slot carries .content", () => {
    const deps: GatherNoticesDeps = {
      authStateFn: () => makeAuthState("logged_out"),
      authSignalFn: () => null,
      updateSignalFn: () => updateSignalStub(),
    };
    const result = gatherNotices(deps);
    expect(result.login).toBeNull();
    expect(result.update).toBe(UPDATE_CONTENT);
  });

  it("both present → both slots carry their respective content", () => {
    const deps: GatherNoticesDeps = {
      authStateFn: () => makeAuthState("revoked"),
      authSignalFn: () => loginSignal(),
      updateSignalFn: () => updateSignalStub(),
    };
    const result = gatherNotices(deps);
    expect(result.login).toBe(LOGIN_CONTENT);
    expect(result.update).toBe(UPDATE_CONTENT);
  });

  it("authStateFn throws → login is null, does not throw", () => {
    const deps: GatherNoticesDeps = {
      authStateFn: () => {
        throw new Error("keychain unavailable");
      },
      authSignalFn: () => loginSignal(),
      updateSignalFn: () => null,
    };
    expect(() => gatherNotices(deps)).not.toThrow();
    expect(gatherNotices(deps).login).toBeNull();
  });

  it("authSignalFn throws → login is null, does not throw", () => {
    const deps: GatherNoticesDeps = {
      authStateFn: () => makeAuthState("revoked"),
      authSignalFn: () => {
        throw new Error("unexpected");
      },
      updateSignalFn: () => null,
    };
    expect(() => gatherNotices(deps)).not.toThrow();
    expect(gatherNotices(deps).login).toBeNull();
  });

  it("updateSignalFn throws → update is null, does not throw", () => {
    const deps: GatherNoticesDeps = {
      authStateFn: () => makeAuthState("logged_out"),
      authSignalFn: () => null,
      updateSignalFn: () => {
        throw new Error("io error");
      },
    };
    expect(() => gatherNotices(deps)).not.toThrow();
    expect(gatherNotices(deps).update).toBeNull();
  });

  it("a throwing login source does not prevent update from being gathered", () => {
    const deps: GatherNoticesDeps = {
      authStateFn: () => {
        throw new Error("boom");
      },
      authSignalFn: () => null,
      updateSignalFn: () => updateSignalStub(),
    };
    const result = gatherNotices(deps);
    expect(result.login).toBeNull();
    expect(result.update).toBe(UPDATE_CONTENT);
  });
});

// ── renderNoticesPlain ────────────────────────────────────────────────────────

describe("renderNoticesPlain", () => {
  it("both null → empty string", () => {
    expect(renderNoticesPlain({ login: null, update: null })).toBe("");
  });

  it("login only → login content", () => {
    expect(renderNoticesPlain({ login: LOGIN_CONTENT, update: null })).toBe(
      LOGIN_CONTENT
    );
  });

  it("update only → update content", () => {
    expect(renderNoticesPlain({ login: null, update: UPDATE_CONTENT })).toBe(
      UPDATE_CONTENT
    );
  });

  it("both present → login first, then update, joined by newline", () => {
    const result = renderNoticesPlain({
      login: LOGIN_CONTENT,
      update: UPDATE_CONTENT,
    });
    expect(result).toBe(`${LOGIN_CONTENT}\n${UPDATE_CONTENT}`);
  });
});

// ── renderNoticesRed ─────────────────────────────────────────────────────────

describe("renderNoticesRed", () => {
  it("both null → empty string", () => {
    expect(renderNoticesRed({ login: null, update: null })).toBe("");
  });

  it("login only → wrapped in startupLog.fmt.red ANSI codes", () => {
    expect(renderNoticesRed({ login: LOGIN_CONTENT, update: null })).toBe(
      ansiRed(LOGIN_CONTENT)
    );
  });

  it("update only → wrapped in startupLog.fmt.red ANSI codes", () => {
    expect(renderNoticesRed({ login: null, update: UPDATE_CONTENT })).toBe(
      ansiRed(UPDATE_CONTENT)
    );
  });

  it("both present → login first then update, each wrapped in red, joined by newline", () => {
    const result = renderNoticesRed({
      login: LOGIN_CONTENT,
      update: UPDATE_CONTENT,
    });
    expect(result).toBe(
      `${ansiRed(LOGIN_CONTENT)}\n${ansiRed(UPDATE_CONTENT)}`
    );
  });

  it("red escape opens with \\x1b[38;2;248;113;113m and closes with \\x1b[0m", () => {
    const result = renderNoticesRed({ login: "x", update: null });
    expect(result.startsWith(RED_OPEN)).toBe(true);
    expect(result.endsWith(RESET)).toBe(true);
  });
});
