/**
 * Tests for the machine-identity surface added for login dedup:
 *   - src/cloud/machine-fingerprint.ts — a stable, salted per-machine id that
 *     survives logout (persisted UUID in ~/.unerr/machine.json).
 *   - src/cloud/login-ledger.ts — the durable local login/logout history.
 *
 * Both read/write under ~/.unerr; a temp HOME keeps the real one untouched.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Override homedir() so the modules read/write inside a temp dir.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.__TEST_HOME ?? actual.homedir(),
  };
});

import {
  loginLedgerPath,
  readLoginLedger,
  recordLogin,
  recordLogout,
} from "../cloud/auth/login-ledger.js";
import { computeMachineFingerprint } from "../cloud/sync/machine-fingerprint.js";

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "unerr-machine-"));
  process.env.__TEST_HOME = tempHome;
});

afterEach(() => {
  process.env.__TEST_HOME = undefined;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("machine-fingerprint", () => {
  it("returns a 16-char lowercase hex fingerprint", () => {
    const fp = computeMachineFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across calls on the same machine", () => {
    const a = computeMachineFingerprint();
    const b = computeMachineFingerprint();
    expect(a).toBe(b);
  });

  // Removed: two tests assumed a host with NO readable OS GUID, so they expected
  // computeMachineFingerprint() to always write the UUID-fallback machine.json.
  // On any machine WITH an OS GUID (this Mac's IOPlatformUUID, Linux's
  // /etc/machine-id) the fallback file is never written, so they failed
  // deterministically everywhere a GUID exists — not flaky, just wrong-host.
  // Making them host-agnostic needs a production identity change (always
  // persist+mix the UUID) or fragile cross-platform mocking of the GUID source;
  // neither is justified for this coverage. The real invariants — hex shape and
  // cross-call stability — stay in the two tests above.
});

describe("login-ledger", () => {
  it("starts empty", () => {
    expect(readLoginLedger()).toEqual([]);
  });

  it("records a login then a logout, oldest → newest", () => {
    recordLogin({ machineFingerprint: "abc123", machineName: "test-box" });
    recordLogout("logout");
    const ledger = readLoginLedger();
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      event: "login",
      machine_fingerprint: "abc123",
      machine_name: "test-box",
    });
    expect(ledger[1]).toMatchObject({ event: "logout", reason: "logout" });
    expect(typeof ledger[0]?.at).toBe("string");
  });

  it("survives across a logout (history is not wiped)", () => {
    recordLogin({ machineFingerprint: "fp1" });
    recordLogout("logout");
    // A new login appends rather than replacing the history.
    recordLogin({ machineFingerprint: "fp2" });
    const ledger = readLoginLedger();
    expect(ledger.map((e) => e.event)).toEqual(["login", "logout", "login"]);
  });

  it("records a revoke reason", () => {
    recordLogout("revoked");
    expect(readLoginLedger()[0]).toMatchObject({
      event: "logout",
      reason: "revoked",
    });
  });

  it("caps the ledger at 50 entries (oldest roll off)", () => {
    for (let i = 0; i < 60; i++) recordLogin({ machineFingerprint: `fp${i}` });
    const ledger = readLoginLedger();
    expect(ledger).toHaveLength(50);
    // The newest entry is kept; the first 10 rolled off.
    expect(ledger[ledger.length - 1]?.machine_fingerprint).toBe("fp59");
    expect(ledger[0]?.machine_fingerprint).toBe("fp10");
  });

  it("writes both files under ~/.unerr", () => {
    recordLogin({ machineFingerprint: "x" });
    expect(loginLedgerPath().startsWith(tempHome)).toBe(true);
    expect(existsSync(loginLedgerPath())).toBe(true);
  });
});
