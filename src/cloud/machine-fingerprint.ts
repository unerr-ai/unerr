/**
 * Stable per-machine fingerprint for login dedup.
 *
 * The login token rotates on every `unerr login`, so the server cannot tell
 * "same laptop, new session" from "a brand-new machine" on the token alone —
 * every login would mint a fresh machine record. This module gives each login
 * a value that is the SAME across logins on one physical machine, so the server
 * can collapse them onto one machine with a login history.
 *
 * The fingerprint mixes two stable inputs:
 *   1. The OS/hardware GUID — macOS `IOPlatformUUID`, Linux `/etc/machine-id`,
 *      Windows registry `MachineGuid`. Stable across reinstalls of unerr; tied
 *      to the OS install.
 *   2. A UUID we generate once and persist in `~/.unerr/machine.json` (0600),
 *      OUTSIDE the credential file so it SURVIVES logout. This is the fallback
 *      when no OS GUID is readable, and it also de-collides cloned VM/container
 *      images that share one `/etc/machine-id`.
 *
 * The two are concatenated and hashed one-way (sha256, namespaced prefix, same
 * style as repo-identity.ts), then truncated to 16 hex chars — the RAW OS GUID
 * never leaves the machine. Every function is best-effort and never throws:
 * fingerprinting must never break login.
 *
 * @sem domain=cloud role=identity
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

/** 0600 — owner read/write only, same as the credential file. */
const FILE_MODE = 0o600;

/** Length of the emitted fingerprint in hex chars (64 bits — ample for dedup). */
const FINGERPRINT_HEX_LEN = 16;

/** Persisted per-machine identity, the UUID fallback that survives logout. */
interface MachineIdentity {
  /** Random UUID minted once on this machine; never the raw OS GUID. */
  machine_uuid: string;
}

/** `~/.unerr/machine.json` — sibling of credentials.json, mode 0600. */
export function machineIdentityPath(): string {
  return join(homedir(), ".unerr", "machine.json");
}

/** Ensure `~/.unerr` exists (0700) before writing into it. */
function ensureHomeDir(): void {
  const dir = dirname(machineIdentityPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Read the persisted machine UUID, minting + writing one on first use. Best
 * effort: if the file can't be written (read-only FS), returns an in-memory
 * UUID so the fingerprint still computes this session (less stable, but never
 * throws).
 */
function loadOrCreateMachineUuid(): string {
  const path = machineIdentityPath();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as MachineIdentity;
      if (parsed?.machine_uuid) return parsed.machine_uuid;
    } catch {
      /* corrupt file — fall through and rewrite it */
    }
  }
  const uuid = randomUUID();
  try {
    ensureHomeDir();
    const body = JSON.stringify(
      { machine_uuid: uuid } satisfies MachineIdentity,
      null,
      2
    );
    writeFileSync(path, `${body}\n`, { mode: FILE_MODE });
    try {
      chmodSync(path, FILE_MODE);
    } catch {
      /* mode reassert is best-effort (Windows / odd FS) */
    }
  } catch {
    /* read-only FS — use the in-memory UUID for this session only */
  }
  return uuid;
}

/**
 * Read the OS/hardware GUID for the current platform. Best-effort: returns null
 * when the command isn't available, times out, or the value can't be parsed —
 * the caller falls back to the persisted UUID alone.
 */
function readOsMachineGuid(): string | null {
  try {
    switch (platform()) {
      case "darwin": {
        const out = execFileSync(
          "/usr/sbin/ioreg",
          ["-rd1", "-c", "IOPlatformExpertDevice"],
          { encoding: "utf-8", timeout: 2000 }
        );
        const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        return m?.[1] ?? null;
      }
      case "linux": {
        for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
          try {
            const id = readFileSync(p, "utf-8").trim();
            if (id) return id;
          } catch {
            /* try the next path */
          }
        }
        return null;
      }
      case "win32": {
        const out = execFileSync(
          "reg",
          [
            "query",
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography",
            "/v",
            "MachineGuid",
          ],
          { encoding: "utf-8", timeout: 2000 }
        );
        const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
        return m?.[1] ?? null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Process-lifetime cache — the fingerprint is stable, so compute it once. */
let cachedFingerprint: string | null = null;

/**
 * Compute the salted machine fingerprint sent on login AND stamped onto every
 * event envelope at drain. Mixes the OS GUID (when readable) with the persisted
 * UUID, hashes one-way, and truncates to 16 hex chars. Stable across logins on
 * one machine; never exposes the raw GUID. Never throws — returns a UUID-only
 * fingerprint if the OS GUID is unavailable. Memoized for the process lifetime,
 * so the per-drain-tick call never re-spawns the OS GUID lookup (e.g. ioreg).
 */
export function computeMachineFingerprint(): string {
  if (cachedFingerprint !== null) return cachedFingerprint;
  const osGuid = readOsMachineGuid() ?? "";
  const uuid = loadOrCreateMachineUuid();
  cachedFingerprint = createHash("sha256")
    .update(`machine:${osGuid}:${uuid}`)
    .digest("hex")
    .slice(0, FINGERPRINT_HEX_LEN);
  return cachedFingerprint;
}
