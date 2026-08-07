import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState, AuthStateName } from "../cloud/auth/auth-state.js";

// The gate composes authState() — mock it so each test drives one exact state.
const authStateMock = vi.fn<(now?: number) => AuthState>();
vi.mock("../cloud/auth/auth-state.js", () => ({
  authState: (now?: number) => authStateMock(now),
}));

// loginBlocked() also requires real login PRESENCE (credential metadata), so a
// fresh-but-credential-less entitlement (a dev-minted token) can't satisfy it.
// Default each test to "credentials present"; the presence-specific tests flip it.
const credentialMetaMock = vi.fn<() => unknown>();
vi.mock("../cloud/auth/credentials.js", () => ({
  readCredentialMetadata: () => credentialMetaMock(),
}));

import {
  hasHeadlessToken,
  isInternalEntryShape,
  loginBlocked,
  loginGateNotice,
} from "../cloud/auth/login-gate.js";

function stateOf(name: AuthStateName): AuthState {
  return {
    state: name,
    plan: name === "active" ? "pro" : "free",
    features: {},
    was_authenticated: name !== "logged_out",
  };
}

const BLOCKING: AuthStateName[] = ["logged_out", "degraded_free", "revoked"];
const ALLOWING: AuthStateName[] = [
  "active",
  "stale_refreshing",
  "grace_expiring",
];

describe("login-gate", () => {
  const originalToken = process.env.UNERR_TOKEN;

  beforeEach(() => {
    authStateMock.mockReset();
    credentialMetaMock.mockReset();
    // Default: a real login is present, so loginBlocked() is driven by authState.
    credentialMetaMock.mockReturnValue({
      organization_id: "org_1",
      machine_name: "m1",
    });
    Reflect.deleteProperty(process.env, "UNERR_TOKEN");
  });

  afterEach(() => {
    if (originalToken === undefined)
      Reflect.deleteProperty(process.env, "UNERR_TOKEN");
    else process.env.UNERR_TOKEN = originalToken;
  });

  describe("loginBlocked", () => {
    for (const name of BLOCKING) {
      it(`blocks on ${name}`, () => {
        authStateMock.mockReturnValue(stateOf(name));
        expect(loginBlocked()).toBe(true);
      });
    }

    for (const name of ALLOWING) {
      it(`allows on ${name}`, () => {
        authStateMock.mockReturnValue(stateOf(name));
        expect(loginBlocked()).toBe(false);
      });
    }

    it("treats a logged-in free user (active) as allowed", () => {
      authStateMock.mockReturnValue({
        state: "active",
        plan: "free",
        features: {},
        was_authenticated: true,
      });
      expect(loginBlocked()).toBe(false);
    });

    it("allows when UNERR_TOKEN is set even if the state would block", () => {
      authStateMock.mockReturnValue(stateOf("logged_out"));
      process.env.UNERR_TOKEN = "ci-machine-token";
      expect(loginBlocked()).toBe(false);
    });

    it("ignores a blank UNERR_TOKEN", () => {
      authStateMock.mockReturnValue(stateOf("logged_out"));
      process.env.UNERR_TOKEN = "   ";
      expect(loginBlocked()).toBe(true);
    });

    it("blocks when no credential exists even if the state is active (dev-minted entitlement)", () => {
      // A fabricated dev tier makes authState() 'active', but with no real login
      // behind it the wall must still fire — a plan is not a login.
      authStateMock.mockReturnValue(stateOf("active"));
      credentialMetaMock.mockReturnValue(null);
      expect(loginBlocked()).toBe(true);
    });

    it("allows a credential-less machine when UNERR_TOKEN is set", () => {
      authStateMock.mockReturnValue(stateOf("active"));
      credentialMetaMock.mockReturnValue(null);
      process.env.UNERR_TOKEN = "ci-machine-token";
      expect(loginBlocked()).toBe(false);
    });
  });

  describe("hasHeadlessToken", () => {
    it("is false when unset", () => {
      expect(hasHeadlessToken()).toBe(false);
    });
    it("is true for a non-empty token", () => {
      process.env.UNERR_TOKEN = "tok";
      expect(hasHeadlessToken()).toBe(true);
    });
    it("is false for whitespace only", () => {
      process.env.UNERR_TOKEN = "  \t ";
      expect(hasHeadlessToken()).toBe(false);
    });
  });

  describe("isInternalEntryShape", () => {
    it("matches --mcp", () => {
      expect(isInternalEntryShape(["node", "unerr", "--mcp"])).toBe(true);
    });
    it("matches --daemon-child", () => {
      expect(isInternalEntryShape(["node", "unerr", "--daemon-child"])).toBe(
        true
      );
    });
    it("does not match a normal command", () => {
      expect(isInternalEntryShape(["node", "unerr", "review"])).toBe(false);
    });
  });

  describe("loginGateNotice", () => {
    it("uses reconnect copy when revoked", () => {
      authStateMock.mockReturnValue(stateOf("revoked"));
      expect(loginGateNotice()).toContain("disconnected by your team");
    });
    it("uses expiry copy when degraded_free", () => {
      authStateMock.mockReturnValue(stateOf("degraded_free"));
      expect(loginGateNotice()).toContain("session expired");
    });
    it("uses the conventions-specific copy otherwise", () => {
      authStateMock.mockReturnValue(stateOf("logged_out"));
      expect(loginGateNotice()).toContain(
        "Shared team conventions need an account"
      );
    });
  });
});
