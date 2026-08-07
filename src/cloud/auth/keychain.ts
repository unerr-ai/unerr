/**
 * unerr cloud — OS keychain abstraction (Sprint I5.1).
 *
 * Stores the machine token (`unerr_sk_…`) in the operating system's secret
 * store when one is available, so the secret never sits in a plain file:
 *
 *   - macOS:   `security` (login keychain, generic password)
 *   - Linux:   `secret-tool` (libsecret) — only when it's installed
 *   - Windows: PowerShell + the Windows Credential Manager via
 *              `cmdkey`/`vault`; we use a small PowerShell snippet over
 *              `CredentialManager`-style `cmdkey` for read/write/delete.
 *
 * Why shell out instead of a native binding: this CLI ships through npm and
 * must install cleanly on every machine with no build step. Native keyring
 * modules (`@napi-rs/keyring`, the old `keytar`) carry prebuilt binaries and
 * postinstall scripts — a packaging and supply-chain liability for a tool
 * whose whole pitch is "nothing leaves your machine". Shelling out to the
 * platform tool the user already trusts keeps the dependency surface at zero.
 *
 * Everything here is SYNCHRONOUS with a hard timeout. The credential helpers
 * (`readCredentials`/`writeCredentials`) are sync and called from sync code
 * paths including the daemon's refresh job. A keychain call that hangs (a
 * locked keychain prompting for unlock, a wedged helper) must never freeze a
 * background process — so every spawn has a 3s timeout and any failure (non-
 * zero exit, missing tool, timeout) falls back to "no keychain", never throws.
 *
 * The token is passed to the platform tool over argv/stdin only; it is never
 * logged, never printed, and never placed in an error message.
 */

import { execFileSync } from "node:child_process";

/** The keychain service name (constant across machines). */
export const KEYCHAIN_SERVICE = "unerr";

/** Hard timeout for any keychain subprocess — never hang a daemon. */
const KEYCHAIN_TIMEOUT_MS = 3_000;

/**
 * Injectable child-process runner so tests mock the keychain without ever
 * touching a real one. Returns stdout on success; throws on non-zero exit,
 * missing binary, or timeout (the caller treats any throw as "unavailable").
 */
export interface KeychainRunner {
  /** Run a command, optionally feeding `input` on stdin. Returns stdout. */
  run(command: string, args: string[], input?: string): string;
}

const defaultRunner: KeychainRunner = {
  run(command, args, input) {
    return execFileSync(command, args, {
      timeout: KEYCHAIN_TIMEOUT_MS,
      input,
      encoding: "utf-8",
      // Keep the secret off any inherited stderr; capture both streams.
      stdio: ["pipe", "pipe", "pipe"],
      // Don't let a hung child keep the process alive past the timeout.
      windowsHide: true,
    });
  },
};

let _runner: KeychainRunner = defaultRunner;
/** True once a test has explicitly installed a (mock) runner. */
let _runnerOverridden = false;

/** Test seam: swap the child-process runner. Pass nothing to reset. */
export function __setKeychainRunner(runner?: KeychainRunner): void {
  _runner = runner ?? defaultRunner;
  _runnerOverridden = runner !== undefined;
}

/**
 * Safety guard: under the test runner, NEVER touch a real OS keychain.
 * A backend is only resolved when a test has explicitly installed a mock
 * runner via `__setKeychainRunner`. This keeps `pnpm test` hermetic — no
 * test can read, write, or prompt the developer's real keychain.
 */
function keychainDisabledForTests(): boolean {
  return Boolean(process.env.VITEST) && !_runnerOverridden;
}

/**
 * A keychain backend for the current platform, or `null` when no supported
 * secret store is present (headless Linux without libsecret, etc.). Each
 * method returns a boolean/string and NEVER throws — failures degrade to
 * "no keychain" so the file fallback takes over.
 */
export interface KeychainBackend {
  /** Human label for the loud-fallback message and diagnostics. */
  readonly label: string;
  /** Store (or replace) the secret for `account`. Returns true on success. */
  set(account: string, secret: string): boolean;
  /** Read the secret for `account`, or null if absent/unavailable. */
  get(account: string): string | null;
  /** Delete the secret for `account`. Returns true if something was removed. */
  delete(account: string): boolean;
}

/** macOS Keychain via the `security` CLI (same-user, no prompt for own items). */
class MacKeychain implements KeychainBackend {
  readonly label = "macOS Keychain";

  set(account: string, secret: string): boolean {
    try {
      // -U updates if it already exists; -w sets the password value. Passing
      // the secret as an argv value is acceptable here (same-user process);
      // it is never logged. Trailing `-A` is intentionally omitted so other
      // apps can't read it without prompting.
      _runner.run("security", [
        "add-generic-password",
        "-U",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
        secret,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  get(account: string): string | null {
    try {
      const out = _runner.run("security", [
        "find-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      const value = out.replace(/\r?\n$/, "");
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  delete(account: string): boolean {
    try {
      _runner.run("security", [
        "delete-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
      ]);
      return true;
    } catch {
      return false;
    }
  }
}

/** Linux secret store via libsecret's `secret-tool` (only if installed). */
class LinuxKeychain implements KeychainBackend {
  readonly label = "system keyring (libsecret)";

  set(account: string, secret: string): boolean {
    try {
      // secret-tool reads the secret from stdin (never argv) and stores it
      // against the service+account attribute pair.
      _runner.run(
        "secret-tool",
        [
          "store",
          "--label=unerr machine token",
          "service",
          KEYCHAIN_SERVICE,
          "account",
          account,
        ],
        secret
      );
      return true;
    } catch {
      return false;
    }
  }

  get(account: string): string | null {
    try {
      const out = _runner.run("secret-tool", [
        "lookup",
        "service",
        KEYCHAIN_SERVICE,
        "account",
        account,
      ]);
      // secret-tool prints the secret with no trailing newline.
      const value = out.replace(/\r?\n$/, "");
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  delete(account: string): boolean {
    try {
      _runner.run("secret-tool", [
        "clear",
        "service",
        KEYCHAIN_SERVICE,
        "account",
        account,
      ]);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Windows Credential Manager via PowerShell's `CredentialManager`-free
 * primitives. We use `cmdkey` for storage and a tiny PowerShell snippet for
 * retrieval (cmdkey cannot print a stored secret back). The target name is
 * `unerr:<account>`. The secret is passed via an environment variable, never
 * on the command line, so it does not appear in the process list.
 */
class WindowsKeychain implements KeychainBackend {
  readonly label = "Windows Credential Manager";

  private target(account: string): string {
    return `${KEYCHAIN_SERVICE}:${account}`;
  }

  set(account: string, secret: string): boolean {
    try {
      // PowerShell stores the secret in the Credential Manager (Generic).
      // The secret comes in through the UNERR_KC_SECRET env var (set on the
      // child only), not as an argument — keeps it out of the command line.
      const ps = [
        "$ErrorActionPreference='Stop';",
        "Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null;",
        `cmdkey /generic:${this.target(account)} /user:${KEYCHAIN_SERVICE} /pass:$env:UNERR_KC_SECRET | Out-Null;`,
      ].join(" ");
      execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        {
          timeout: KEYCHAIN_TIMEOUT_MS,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, UNERR_KC_SECRET: secret },
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  get(account: string): string | null {
    try {
      // cmdkey can't reveal a secret; read it back through the Windows
      // Credential API via PowerShell. Returns the raw secret on stdout.
      const ps = [
        "$ErrorActionPreference='Stop';",
        "Add-Type -Namespace U -Name C -MemberDefinition '",
        '[DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);',
        '[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
        "[StructLayout(LayoutKind.Sequential)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }';",
        `$p=[IntPtr]::Zero; if(-not [U.C]::CredRead('${this.target(account)}',1,0,[ref]$p)){ exit 1 };`,
        "$c=[System.Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][U.C+CREDENTIAL]);",
        "$s=[System.Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob,$c.CredentialBlobSize/2);",
        "[U.C]::CredFree($p); [Console]::Out.Write($s);",
      ].join(" ");
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        {
          timeout: KEYCHAIN_TIMEOUT_MS,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }
      );
      const value = out.replace(/\r?\n$/, "");
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  delete(account: string): boolean {
    try {
      execFileSync("cmdkey", [`/delete:${this.target(account)}`], {
        timeout: KEYCHAIN_TIMEOUT_MS,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
}

let _backendResolved = false;
let _backend: KeychainBackend | null = null;

/**
 * The keychain backend for this platform, or null when none is usable.
 * Resolved once and cached. A platform tool that is installed but broken
 * still counts as "present" — its calls just fail and degrade to the file.
 */
export function getKeychainBackend(): KeychainBackend | null {
  // Hermetic tests: no real keychain unless a mock runner is installed.
  if (keychainDisabledForTests()) return null;
  if (_backendResolved) return _backend;
  _backendResolved = true;

  // Tests can force a backend by swapping the runner and platform.
  const platform = process.platform;
  if (platform === "darwin") {
    _backend = new MacKeychain();
  } else if (platform === "win32") {
    _backend = new WindowsKeychain();
  } else if (platform === "linux") {
    // Only claim a Linux keyring if secret-tool actually exists; otherwise
    // headless servers would loop on a missing binary. `--version` is cheap.
    _backend = secretToolPresent() ? new LinuxKeychain() : null;
  } else {
    _backend = null;
  }
  return _backend;
}

/** True if `secret-tool` is on PATH and runnable. Never throws. */
function secretToolPresent(): boolean {
  try {
    _runner.run("secret-tool", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: reset the cached backend resolution. */
export function __resetKeychainBackend(): void {
  _backendResolved = false;
  _backend = null;
}
