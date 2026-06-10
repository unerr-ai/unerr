/**
 * Tests for src/cloud/keychain.ts — the OS-keychain abstraction. The child
 * process layer is mocked; no real keychain is ever touched. The macOS
 * `security` argv shape is exercised because tests force `darwin`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KEYCHAIN_SERVICE,
  type KeychainRunner,
  __resetKeychainBackend,
  __setKeychainRunner,
  getKeychainBackend,
} from "../cloud/keychain.js";

/** Force `process.platform` for the duration of a test. */
function forcePlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
const REAL_PLATFORM = process.platform;

afterEach(() => {
  __setKeychainRunner();
  __resetKeychainBackend();
  forcePlatform(REAL_PLATFORM);
});

describe("keychain backend selection", () => {
  it("uses the macOS backend on darwin", () => {
    forcePlatform("darwin");
    __setKeychainRunner({ run: () => "" });
    __resetKeychainBackend();
    expect(getKeychainBackend()?.label).toMatch(/macOS/i);
  });

  it("returns null on Linux when secret-tool is absent", () => {
    forcePlatform("linux");
    __setKeychainRunner({
      run() {
        throw new Error("command not found: secret-tool");
      },
    });
    __resetKeychainBackend();
    expect(getKeychainBackend()).toBeNull();
  });

  it("uses the Linux backend when secret-tool is present", () => {
    forcePlatform("linux");
    __setKeychainRunner({
      run(_cmd, args) {
        if (args[0] === "--version") return "secret-tool 0.20\n";
        return "";
      },
    });
    __resetKeychainBackend();
    expect(getKeychainBackend()?.label).toMatch(/libsecret/i);
  });

  it("returns null on an unsupported platform", () => {
    forcePlatform("freebsd" as NodeJS.Platform);
    __resetKeychainBackend();
    expect(getKeychainBackend()).toBeNull();
  });
});

describe("macOS keychain round-trip", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    forcePlatform("darwin");
    store = new Map();
    const runner: KeychainRunner = {
      run(command, args) {
        expect(command).toBe("security");
        const sub = args[0];
        const ai = args.indexOf("-a");
        const account = ai >= 0 ? (args[ai + 1] ?? "") : "";
        // Service flag must always be the constant.
        const si = args.indexOf("-s");
        if (si >= 0) expect(args[si + 1]).toBe(KEYCHAIN_SERVICE);
        if (sub === "add-generic-password") {
          const wi = args.indexOf("-w");
          store.set(account, args[wi + 1] ?? "");
          return "";
        }
        if (sub === "find-generic-password") {
          const v = store.get(account);
          if (v === undefined) throw new Error("not found");
          return `${v}\n`;
        }
        if (sub === "delete-generic-password") {
          if (!store.delete(account)) throw new Error("not found");
          return "";
        }
        throw new Error(`unexpected ${sub}`);
      },
    };
    __setKeychainRunner(runner);
    __resetKeychainBackend();
  });

  it("sets, gets, and deletes a secret", () => {
    const kc = getKeychainBackend();
    expect(kc).not.toBeNull();
    if (!kc) return;

    expect(kc.get("host.example")).toBeNull();
    expect(kc.set("host.example", "unerr_sk_value")).toBe(true);
    expect(kc.get("host.example")).toBe("unerr_sk_value");
    expect(kc.delete("host.example")).toBe(true);
    expect(kc.get("host.example")).toBeNull();
    // Deleting a missing entry is a graceful false, not a throw.
    expect(kc.delete("host.example")).toBe(false);
  });

  it("never throws on a wedged keychain — degrades to false/null", () => {
    __setKeychainRunner({
      run() {
        throw new Error("keychain locked / timed out");
      },
    });
    __resetKeychainBackend();
    const kc = getKeychainBackend();
    expect(kc).not.toBeNull();
    if (!kc) return;
    expect(kc.set("h", "t")).toBe(false);
    expect(kc.get("h")).toBeNull();
    expect(kc.delete("h")).toBe(false);
  });
});
