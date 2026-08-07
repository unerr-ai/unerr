/**
 * runLogin self-heal — a connected-but-expired machine must not dead-end.
 *
 * Reproduces the reported bug: a walled command (e.g. `conventions push`;
 * back when the wall also covered `install`) in a non-dev repo printed
 *   "Your unerr session expired — run `unerr login`"  (the wall)
 *   "This machine is already connected. Run unerr logout first."  (runLogin)
 *   "Login did not complete — run `unerr login`, then retry."  (the wall again)
 * A machine with credentials on disk but an expired/revoked entitlement
 * (`loginBlocked()` true) could never clear the wall, because runLogin()
 * short-circuited on `isLoggedIn()` and refused to act.
 *
 * The fix: when connected AND blocked, renew with the stored token; if that
 * clears the block, reconnect silently; if not, the credential is dead — drop
 * it and re-authenticate via the device flow. When connected and NOT blocked
 * (genuinely active), the "already connected, logout first" guard stays.
 *
 * Drives the real runLogin() with its cloud dependencies mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isLoggedIn = vi.fn<() => boolean>();
const readCredentials = vi.fn<() => unknown>();
const writeCredentials = vi.fn();
const deleteCredentials = vi.fn();
vi.mock("../cloud/credentials.js", () => ({
  DEFAULT_API_URL: "https://app.unerr.dev",
  isLoggedIn: () => isLoggedIn(),
  readCredentials: () => readCredentials(),
  writeCredentials: (c: unknown) => writeCredentials(c),
  deleteCredentials: () => deleteCredentials(),
}));

const loginBlocked = vi.fn<() => boolean>();
vi.mock("../cloud/login-gate.js", () => ({
  loginBlocked: () => loginBlocked(),
}));

const refreshEntitlements = vi.fn();
vi.mock("../cloud/entitlements.js", () => ({
  refreshEntitlements: (c: unknown) => refreshEntitlements(c),
}));

const runDeviceFlow = vi.fn();
vi.mock("../cloud/device-flow.js", () => ({
  runDeviceFlow: (u: string) => runDeviceFlow(u),
}));

vi.mock("../cloud/client.js", () => ({
  // Inert stand-in: refreshEntitlements (mocked above) is what consumes the
  // instance, so the client only needs to construct without throwing.
  CloudClient: class {},
  assertSafeBaseUrl: () => {},
}));

import { runLogin } from "../commands/login.js";

let stderrChunks: string[];

beforeEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(process.env, "UNERR_API_URL");
  process.exitCode = undefined;
  stderrChunks = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  readCredentials.mockReturnValue({
    api_url: "https://app.unerr.dev",
    token: "stored-token",
    organization_id: "org_1",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function stderr(): string {
  return stderrChunks.join("");
}

describe("runLogin — connected machine", () => {
  it("active (not blocked): confirms already-connected, no refresh, no device flow", async () => {
    isLoggedIn.mockReturnValue(true);
    loginBlocked.mockReturnValue(false);

    await runLogin();

    expect(stderr()).toContain("already connected");
    expect(stderr()).toContain("logout first");
    expect(refreshEntitlements).not.toHaveBeenCalled();
    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect(deleteCredentials).not.toHaveBeenCalled();
  });

  it("blocked but token still valid: renews and reconnects without a device flow", async () => {
    isLoggedIn.mockReturnValue(true);
    // First gate check (the short-circuit guard) is blocked; after the refresh
    // the entitlement is fresh, so the second check clears.
    loginBlocked.mockReturnValueOnce(true).mockReturnValueOnce(false);
    refreshEntitlements.mockResolvedValue({
      result: "ok",
      verified: true,
      plan: "pro",
    });

    await runLogin();

    expect(refreshEntitlements).toHaveBeenCalledTimes(1);
    expect(stderr()).toContain("Renewing your unerr session");
    expect(stderr()).toContain("Reconnected");
    expect(stderr()).not.toContain("already connected");
    expect(deleteCredentials).not.toHaveBeenCalled();
    expect(runDeviceFlow).not.toHaveBeenCalled();
  });

  it("blocked and refresh fails to clear: drops the dead credential and re-auths via device flow", async () => {
    isLoggedIn.mockReturnValue(true);
    loginBlocked.mockReturnValue(true); // stays blocked through the refresh
    refreshEntitlements.mockResolvedValue({ result: "auth_error" });
    runDeviceFlow.mockResolvedValue({
      status: "success",
      access_token: "new-token",
      organization_id: "org_1",
      machine_id: "m1",
      machine_name: "this-mac",
    });

    await runLogin();

    expect(stderr()).toContain("no longer valid");
    expect(deleteCredentials).toHaveBeenCalledTimes(1);
    expect(runDeviceFlow).toHaveBeenCalledTimes(1);
    // The device flow saved a fresh credential.
    expect(writeCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ token: "new-token" })
    );
  });

  it("logged out entirely: goes straight to the device flow (no renew path)", async () => {
    isLoggedIn.mockReturnValue(false);
    loginBlocked.mockReturnValue(true);
    runDeviceFlow.mockResolvedValue({
      status: "success",
      access_token: "fresh",
      organization_id: "org_1",
      machine_id: "m1",
      machine_name: "this-mac",
    });

    await runLogin();

    expect(refreshEntitlements).toHaveBeenCalledTimes(1); // only the post-login prime
    expect(runDeviceFlow).toHaveBeenCalledTimes(1);
    expect(deleteCredentials).not.toHaveBeenCalled();
    expect(stderr()).not.toContain("already connected");
  });
});
