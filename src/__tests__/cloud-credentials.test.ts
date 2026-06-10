/**
 * Tests for src/cloud/credentials.ts — read/write/delete, 0600 mode, and
 * the UNERR_TOKEN env override. Uses a temp HOME so the real
 * ~/.unerr/credentials.json is never touched.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Override homedir() so the module reads/writes inside a temp dir.
let tempHome: string;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.__TEST_HOME ?? actual.homedir(),
  };
});

import {
  type Credentials,
  __resetFileFallbackWarning,
  credentialsPath,
  deleteCredentials,
  deleteEntitlementsCache,
  entitlementsCachePath,
  isLoggedIn,
  readCredentials,
  writeCredentials,
} from "../cloud/credentials.js";
import {
  type KeychainRunner,
  __resetKeychainBackend,
  __setKeychainRunner,
} from "../cloud/keychain.js";

/**
 * A runner that fails every keychain call. On any platform this makes the
 * backend's set/get/delete return false/null, so credentials fall back to
 * the plain 0600 file — exactly the pre-I5 behavior these tests assert.
 */
const noKeychainRunner: KeychainRunner = {
  run() {
    throw new Error("no keychain in test");
  },
};

/**
 * An in-memory fake keychain keyed by `${command} ${account}` semantics. It
 * understands the macOS `security` argv shape used by MacKeychain so tests
 * can run deterministically regardless of the host OS (tests force darwin).
 */
function makeFakeKeychain() {
  const store = new Map<string, string>();
  const accountFromArgs = (args: string[]): string => {
    const i = args.indexOf("-a");
    return i >= 0 ? (args[i + 1] ?? "") : "";
  };
  const runner: KeychainRunner = {
    run(command, args) {
      if (command !== "security")
        throw new Error(`unexpected command ${command}`);
      const sub = args[0];
      const account = accountFromArgs(args);
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
        if (!store.has(account)) throw new Error("not found");
        store.delete(account);
        return "";
      }
      throw new Error(`unexpected security subcommand ${sub}`);
    },
  };
  return { store, runner };
}

const sample: Credentials = {
  api_url: "https://app.unerr.ai",
  token: "unerr_sk_secrettokenvalue",
  organization_id: "org_abc",
  machine_id: "mac_123",
  machine_name: "Test Laptop",
};

const OVERRIDE_KEYS = [
  "__TEST_HOME",
  "UNERR_TOKEN",
  "UNERR_ORG_ID",
  "UNERR_API_URL",
] as const;

describe("cloud credentials", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of OVERRIDE_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-cred-"));
    process.env.__TEST_HOME = tempHome;
    // Default to "no keychain present" so this block asserts the plain-file
    // fallback contract. Keychain-specific behavior is its own describe block.
    __setKeychainRunner(noKeychainRunner);
    __resetKeychainBackend();
    __resetFileFallbackWarning();
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    __setKeychainRunner();
    __resetKeychainBackend();
    __resetFileFallbackWarning();
    for (const k of OVERRIDE_KEYS) {
      if (saved[k] === undefined) {
        if (process.env[k] !== undefined) delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("writes, reads back, and deletes credentials", () => {
    expect(readCredentials()).toBeNull();
    expect(isLoggedIn()).toBe(false);

    writeCredentials(sample);
    expect(existsSync(credentialsPath())).toBe(true);

    const read = readCredentials();
    expect(read).toEqual(sample);
    expect(isLoggedIn()).toBe(true);

    expect(deleteCredentials()).toBe(true);
    expect(existsSync(credentialsPath())).toBe(false);
    expect(readCredentials()).toBeNull();
    // Deleting again is a no-op, not an error.
    expect(deleteCredentials()).toBe(false);
  });

  it("writes the file with mode 0600", () => {
    writeCredentials(sample);
    const mode = statSync(credentialsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens a loose-mode file to 0600 on read", () => {
    // Simulate a file written with too-loose permissions.
    const dir = join(tempHome, ".unerr");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "credentials.json");
    writeFileSync(p, JSON.stringify(sample), { mode: 0o644 });
    expect(statSync(p).mode & 0o777).toBe(0o644);

    const read = readCredentials();
    expect(read?.token).toBe(sample.token);
    // Permissions tightened in place.
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("UNERR_TOKEN env overrides the file and ignores disk", () => {
    writeCredentials(sample);
    process.env.UNERR_TOKEN = "unerr_sk_fromenv";
    process.env.UNERR_ORG_ID = "org_env";
    process.env.UNERR_API_URL = "https://preview.unerr.ai";

    const read = readCredentials();
    expect(read?.token).toBe("unerr_sk_fromenv");
    expect(read?.organization_id).toBe("org_env");
    expect(read?.api_url).toBe("https://preview.unerr.ai");
    expect(isLoggedIn()).toBe(true);
  });

  it("UNERR_API_URL overrides the stored api_url and strips trailing slash", () => {
    writeCredentials(sample);
    process.env.UNERR_API_URL = "https://preview.unerr.ai/";
    const read = readCredentials();
    expect(read?.api_url).toBe("https://preview.unerr.ai");
    expect(read?.token).toBe(sample.token);
  });

  it("returns null for a malformed or token-less file", () => {
    const dir = join(tempHome, ".unerr");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), "{ not json", { mode: 0o600 });
    expect(readCredentials()).toBeNull();

    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({ api_url: "x", organization_id: "org" }),
      { mode: 0o600 }
    );
    expect(readCredentials()).toBeNull();
  });

  it("deletes the entitlement cache (logout path)", () => {
    const p = entitlementsCachePath();
    require("node:fs").mkdirSync(join(tempHome, ".unerr"), { recursive: true });
    writeFileSync(p, "{}", { mode: 0o600 });
    expect(existsSync(p)).toBe(true);
    expect(deleteEntitlementsCache()).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(deleteEntitlementsCache()).toBe(false);
  });

  it("never writes the token outside the credential file path", () => {
    writeCredentials(sample);
    // Sanity: the credential file lives under the temp HOME, not the real one.
    expect(credentialsPath().startsWith(tempHome)).toBe(true);
    expect(credentialsPath().startsWith(homedir())).toBe(true);
  });

  it("warns loudly (once) when falling back to the plain file", () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      writeCredentials(sample);
      writeCredentials(sample);
    } finally {
      spy.mockRestore();
    }
    const joined = writes.join("");
    expect(joined).toMatch(/plain file/i);
    expect(joined).toMatch(/no system keychain/i);
    // Warned at most once across two writes.
    expect((joined.match(/no system keychain/gi) ?? []).length).toBe(1);
    // The warning never contains the token.
    expect(joined).not.toContain(sample.token);
  });
});

describe("cloud credentials — keychain backend", () => {
  let saved: Record<string, string | undefined>;
  let fake: ReturnType<typeof makeFakeKeychain>;
  const platformSpy = vi.spyOn(process, "platform", "get");

  beforeEach(() => {
    saved = {};
    for (const k of OVERRIDE_KEYS) {
      saved[k] = process.env[k];
      if (process.env[k] !== undefined) delete process.env[k];
    }
    tempHome = mkdtempSync(join(tmpdir(), "unerr-cred-kc-"));
    process.env.__TEST_HOME = tempHome;
    // Force a macOS-style keychain regardless of the host OS, backed by the
    // in-memory fake — no real keychain is ever touched.
    platformSpy.mockReturnValue("darwin");
    fake = makeFakeKeychain();
    __setKeychainRunner(fake.runner);
    __resetKeychainBackend();
    __resetFileFallbackWarning();
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    __setKeychainRunner();
    __resetKeychainBackend();
    __resetFileFallbackWarning();
    for (const k of OVERRIDE_KEYS) {
      if (saved[k] === undefined) {
        if (process.env[k] !== undefined) delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("stores the token in the keychain, not the file", () => {
    writeCredentials(sample);

    // The token is in the keychain under the api_url host…
    expect(fake.store.get("app.unerr.ai")).toBe(sample.token);
    // …and the file holds metadata only — no token on disk.
    const onDisk = JSON.parse(
      require("node:fs").readFileSync(credentialsPath(), "utf-8")
    );
    expect(onDisk.token).toBeUndefined();
    expect(onDisk.organization_id).toBe(sample.organization_id);

    // readCredentials reassembles the full record.
    expect(readCredentials()).toEqual(sample);
  });

  it("does not print the file-fallback warning when a keychain is present", () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      writeCredentials(sample);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).not.toMatch(/no system keychain/i);
  });

  it("migrates a legacy file token into the keychain on first read", () => {
    // Simulate a pre-I5 file that still carries the plaintext token.
    const dir = join(tempHome, ".unerr");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(sample), {
      mode: 0o600,
    });
    expect(fake.store.has("app.unerr.ai")).toBe(false);

    const read = readCredentials();
    expect(read).toEqual(sample);

    // The token moved into the keychain…
    expect(fake.store.get("app.unerr.ai")).toBe(sample.token);
    // …and was stripped from the file.
    const onDisk = JSON.parse(
      require("node:fs").readFileSync(credentialsPath(), "utf-8")
    );
    expect(onDisk.token).toBeUndefined();
    expect(onDisk.machine_name).toBe(sample.machine_name);
  });

  it("logout deletes both the keychain entry and the file", () => {
    writeCredentials(sample);
    expect(fake.store.get("app.unerr.ai")).toBe(sample.token);
    expect(existsSync(credentialsPath())).toBe(true);

    expect(deleteCredentials()).toBe(true);
    expect(fake.store.has("app.unerr.ai")).toBe(false);
    expect(existsSync(credentialsPath())).toBe(false);
    expect(readCredentials()).toBeNull();
  });

  it("UNERR_TOKEN env still overrides the keychain", () => {
    writeCredentials(sample);
    process.env.UNERR_TOKEN = "unerr_sk_fromenv";
    const read = readCredentials();
    expect(read?.token).toBe("unerr_sk_fromenv");
  });
});
