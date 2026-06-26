/**
 * unerr cloud — credential storage.
 *
 * Reads, writes, and deletes the CLI's login file at
 * `~/.unerr/credentials.json` (mode 0600), exactly per the frozen v1
 * contract in unerr-web-service `docs/CLI_API.md`:
 *
 *   { api_url, token, organization_id, machine_id, machine_name }
 *
 * The plain machine token (`unerr_sk_...`) is sensitive: it is never
 * logged, never printed, and the file is owner-read/write only.
 *
 * `UNERR_TOKEN` (optionally with `UNERR_ORG_ID`) overrides the file for
 * CI and locked-down environments. When the env override is present the
 * file on disk is ignored entirely.
 *
 * This module is part of `src/cloud/` — the one auditable surface that
 * talks to the cloud. It performs no network calls itself.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clearAuthEvents } from "./auth-events.js";
import { getKeychainBackend } from "./keychain.js";

/** The default cloud control-plane URL. */
export const DEFAULT_API_URL = "https://app.unerr.dev";

/** Owner read/write only. */
const FILE_MODE = 0o600;

/**
 * The keychain account is the API host (e.g. `app.unerr.ai`) so a machine
 * connected to two deployments (prod + a preview) keeps two distinct
 * secrets under the one `unerr` service. Falls back to a fixed label when
 * the URL can't be parsed.
 */
function keychainAccount(apiUrl: string): string {
  try {
    return new URL(apiUrl).host || "default";
  } catch {
    return "default";
  }
}

/** Print the plain-file fallback warning at most once per process. */
let _fileFallbackWarned = false;
function warnFileFallbackOnce(): void {
  if (_fileFallbackWarned) return;
  _fileFallbackWarned = true;
  // The gh CLI #10108 lesson: never fall back to a plain file silently.
  // Goes to stderr; carries no token, ever.
  process.stderr.write(
    `  Heads up: storing your unerr token in a plain file (${credentialsPath()}) — no system keychain was found.\n  The file is locked to your user account (mode 0600). Install a\n  system keyring to upgrade automatically next time you log in.\n`
  );
}

/** Test seam: reset the one-time fallback-warning latch. */
export function __resetFileFallbackWarning(): void {
  _fileFallbackWarned = false;
}

/**
 * The credential file shape — the frozen v1 contract. Extra fields a
 * future server adds are ignored (the contract's "ignore unknown" rule).
 */
export interface Credentials {
  api_url: string;
  token: string;
  organization_id: string;
  machine_id: string;
  machine_name: string;
}

/** `~/.unerr` — the per-user state directory shared with the daemon. */
function unerrHomeDir(): string {
  return join(homedir(), ".unerr");
}

/** Absolute path to the credential file. */
export function credentialsPath(): string {
  return join(unerrHomeDir(), "credentials.json");
}

/** Absolute path to the entitlement cache (written in Sprint I3). */
export function entitlementsCachePath(): string {
  return join(unerrHomeDir(), "entitlements.json");
}

/** Absolute path to the synced team-conventions document (Sprint I4). */
export function teamConventionsPath(): string {
  return join(unerrHomeDir(), "team-conventions.json");
}

/**
 * Read login credentials.
 *
 * Resolution order:
 *  1. `UNERR_TOKEN` env (with optional `UNERR_ORG_ID`, `UNERR_API_URL`) —
 *     the CI path. When set, neither the file nor the keychain is touched.
 *  2. The OS keychain (token) + `~/.unerr/credentials.json` (non-secret
 *     metadata: org / machine ids and name, api_url). The metadata always
 *     lives in the JSON file so `whoami`/`status` work without a keychain
 *     prompt; only the secret token moves into the keychain when one exists.
 *  3. A token still inside the JSON file (older CLI, or no keychain). On
 *     first read, if a keychain IS available the token is migrated into it
 *     and stripped from the file — silently, best-effort.
 *
 * Returns `null` when there is no usable credential. On a successful file
 * read, if the file mode is looser than 0600 it is tightened in place. The
 * keychain read is bounded (3s timeout, see keychain.ts) and degrades to the
 * file on any failure — a locked keychain never hangs the daemon.
 */
export function readCredentials(): Credentials | null {
  const envToken = process.env.UNERR_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return {
      api_url: resolveApiUrl(process.env.UNERR_API_URL),
      token: envToken.trim(),
      organization_id: process.env.UNERR_ORG_ID?.trim() ?? "",
      machine_id: "",
      machine_name: "",
    };
  }

  const path = credentialsPath();
  if (!existsSync(path)) return null;

  // Tighten permissions if the file is looser than 0600 (e.g. copied in,
  // or written by an older CLI). Best-effort — never fail the read on this.
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== FILE_MODE) chmodSync(path, FILE_MODE);
  } catch {
    /* ignore — chmod can fail on some filesystems / Windows */
  }

  let parsed: Partial<Credentials>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<Credentials>;
  } catch {
    return null;
  }

  const apiUrl = resolveApiUrl(parsed.api_url);
  const account = keychainAccount(apiUrl);
  const meta = {
    api_url: apiUrl,
    organization_id: parsed.organization_id ?? "",
    machine_id: parsed.machine_id ?? "",
    machine_name: parsed.machine_name ?? "",
  };

  // 1. Prefer the keychain when one is present and holds the token.
  const backend = getKeychainBackend();
  if (backend) {
    const fromKeychain = backend.get(account);
    if (fromKeychain && fromKeychain.trim().length > 0) {
      // If the file still carries a stale plaintext token (interrupted
      // earlier migration), strip it now so it never lingers in two places.
      if (typeof parsed.token === "string" && parsed.token.trim().length > 0) {
        writeMetadataFile(meta);
      }
      return { ...meta, token: fromKeychain };
    }
  }

  // 2. No usable keychain token — fall back to the token in the file.
  const fileToken = typeof parsed.token === "string" ? parsed.token.trim() : "";
  if (fileToken.length === 0) {
    return null;
  }

  // 3. Migrate: a keychain exists and accepts the token → move it in and
  //    strip it from the file. Silent + best-effort; on any failure we keep
  //    the file token exactly as before so nothing is lost.
  if (backend?.set(account, fileToken)) {
    const verify = backend.get(account);
    if (verify === fileToken) {
      writeMetadataFile(meta);
    }
  }

  return { ...meta, token: fileToken };
}

/**
 * Login metadata WITHOUT touching the keychain — presence plus the non-secret
 * org / machine fields, nothing else. Built for hot paths (the auth-state
 * derivation that runs on tool calls) that must never trigger a keychain
 * prompt or a migration write. Returns `null` when no login exists.
 *
 * The metadata file is written on every successful login (both the keychain
 * and plain-file paths call `writeMetadataFile`) and removed on logout, so its
 * presence is an exact, keychain-free signal of "is there a login?".
 */
export function readCredentialMetadata(): {
  organization_id: string;
  machine_id: string;
  machine_name: string;
} | null {
  const envToken = process.env.UNERR_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return {
      organization_id: process.env.UNERR_ORG_ID?.trim() ?? "",
      machine_id: process.env.UNERR_MACHINE_ID?.trim() ?? "",
      machine_name: "",
    };
  }

  const path = credentialsPath();
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf-8")
    ) as Partial<Credentials>;
    return {
      organization_id: parsed.organization_id ?? "",
      machine_id: parsed.machine_id ?? "",
      machine_name: parsed.machine_name ?? "",
    };
  } catch {
    return null;
  }
}

/** Write the non-secret metadata file (no token), mode 0600. */
function writeMetadataFile(meta: {
  api_url: string;
  organization_id: string;
  machine_id: string;
  machine_name: string;
}): void {
  ensureHomeDir();
  const body = JSON.stringify(meta, null, 2);
  writeFileSync(credentialsPath(), `${body}\n`, { mode: FILE_MODE });
  reassertFileMode();
}

/** Ensure `~/.unerr` exists with mode 0700. */
function ensureHomeDir(): void {
  const dir = dirname(credentialsPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Re-assert 0600 on the credential file (writeFileSync `mode` only applies on create). */
function reassertFileMode(): void {
  try {
    chmodSync(credentialsPath(), FILE_MODE);
  } catch {
    /* ignore */
  }
}

/**
 * Write login credentials.
 *
 * Keychain-first: when the OS has a usable secret store, the token goes into
 * the keychain (service "unerr", account = api_url host) and the JSON file
 * holds only the non-secret metadata. With no keychain, the token is written
 * into the 0600 file as before — and a LOUD one-time warning is printed so
 * the user knows the secret is on disk (the gh CLI #10108 lesson). Either
 * way `~/.unerr/credentials.json` carries the metadata so `whoami`/`status`
 * work without a keychain prompt.
 */
export function writeCredentials(creds: Credentials): void {
  ensureHomeDir();

  // A fresh credential is a fresh start: drop any stale revoked marker or last
  // refresh result so `authState()` reads the new login as `active`, never as a
  // lingering `revoked`/`degraded_free` from the previous one. This is the one
  // chokepoint every login path passes through, so no path can forget it.
  clearAuthEvents();

  const meta = {
    api_url: creds.api_url,
    organization_id: creds.organization_id,
    machine_id: creds.machine_id,
    machine_name: creds.machine_name,
  };
  const account = keychainAccount(creds.api_url);

  const backend = getKeychainBackend();
  if (backend?.set(account, creds.token)) {
    // Token lives in the keychain — write metadata only, with no token field.
    writeMetadataFile(meta);
    return;
  }

  // No keychain (or it refused): fall back to a plain 0600 file. Warn loudly,
  // once. The token is included in the file in this path only.
  warnFileFallbackOnce();
  const body = JSON.stringify({ ...meta, token: creds.token }, null, 2);
  writeFileSync(credentialsPath(), `${body}\n`, { mode: FILE_MODE });
  reassertFileMode();
}

/**
 * Delete the stored credential — BOTH the keychain entry (if any) and the
 * JSON file. Returns true if either side removed something. Never throws.
 */
export function deleteCredentials(): boolean {
  const path = credentialsPath();

  // Best-effort: read the api_url from the file (if present) so we target the
  // right keychain account, then clear the keychain entry.
  let removedKeychain = false;
  const backend = getKeychainBackend();
  if (backend) {
    let apiUrl = DEFAULT_API_URL;
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
          api_url?: string;
        };
        apiUrl = resolveApiUrl(parsed.api_url);
      }
    } catch {
      /* ignore — fall back to the default account below */
    }
    try {
      removedKeychain = backend.delete(keychainAccount(apiUrl));
    } catch {
      removedKeychain = false;
    }
  }

  if (!existsSync(path)) return removedKeychain;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return removedKeychain;
  }
}

/**
 * Delete the entitlement cache file (written in Sprint I3). Logout removes
 * it so no stale tier survives a sign-out. Never throws.
 */
export function deleteEntitlementsCache(): boolean {
  const path = entitlementsCachePath();
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the synced team-conventions document (written in Sprint I4).
 * Logout and revocation remove it so no stale team doc survives a sign-out.
 * Never throws.
 */
export function deleteTeamConventionsCache(): boolean {
  const path = teamConventionsPath();
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** True when a usable credential exists (env override or file). */
export function isLoggedIn(): boolean {
  return readCredentials() !== null;
}

/**
 * Resolve the API base URL. `UNERR_API_URL` always wins (preview testing);
 * then the stored value; then the default. Trailing slashes are stripped.
 *
 * Exported so URL builders in other modules (e.g. `utils/deep-link.ts`) can
 * resolve through the same chain — including dev-mode overrides injected via
 * `applyDevConfig` — without duplicating the logic.
 */
export function resolveApiUrl(stored?: string): string {
  const envUrl = process.env.UNERR_API_URL?.trim();
  const url = envUrl || stored?.trim() || DEFAULT_API_URL;
  return url.replace(/\/+$/, "");
}
