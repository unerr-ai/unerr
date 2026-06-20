/**
 * unerr cloud — local login/logout history.
 *
 * The credential file and `auth-events.json` are both WIPED on logout, so on
 * their own they cannot answer "when did this machine last connect, and how
 * many times?". This file keeps a small append-only ledger of login/logout
 * events in `~/.unerr/login-ledger.json` that DELIBERATELY survives logout —
 * it is the machine's own copy of the login history the server reconstructs
 * from the rotating tokens via the stable machine_fingerprint.
 *
 * It is local provenance only (powers `unerr status` / `whoami` history and a
 * future fleet field); it is never required for any code path. Every function
 * is best-effort and never throws (HR-B).
 *
 * @sem domain=cloud role=identity
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 0600 — owner read/write only, same as the credential file. */
const FILE_MODE = 0o600;

/** Keep the most recent N events; older ones roll off. */
const MAX_ENTRIES = 50;

/** Why a logout entry was written. */
export type LogoutReason = "logout" | "revoked" | "reset";

/** One login or logout event. */
export interface LoginLedgerEntry {
  event: "login" | "logout";
  /** ISO-8601 UTC time of the event. */
  at: string;
  /** Salted machine fingerprint at the time (same value the server dedups on). */
  machine_fingerprint?: string;
  /** Human label (hostname) at the time, for display. */
  machine_name?: string;
  /** Only on logout entries — why the session ended. */
  reason?: LogoutReason;
}

/** `~/.unerr/login-ledger.json` — sibling of credentials.json, mode 0600. */
export function loginLedgerPath(): string {
  return join(homedir(), ".unerr", "login-ledger.json");
}

/** Ensure `~/.unerr` exists (0700) before writing into it. */
function ensureHomeDir(): void {
  const dir = dirname(loginLedgerPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Read the ledger (oldest → newest). Empty array on any error/absence. */
export function readLoginLedger(): LoginLedgerEntry[] {
  const path = loginLedgerPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as LoginLedgerEntry[]) : [];
  } catch {
    return [];
  }
}

/** Append one entry, cap to MAX_ENTRIES, write 0600. Best-effort, never throws. */
function append(entry: LoginLedgerEntry): void {
  try {
    const next = [...readLoginLedger(), entry].slice(-MAX_ENTRIES);
    ensureHomeDir();
    const body = JSON.stringify(next, null, 2);
    writeFileSync(loginLedgerPath(), `${body}\n`, { mode: FILE_MODE });
    try {
      chmodSync(loginLedgerPath(), FILE_MODE);
    } catch {
      /* mode reassert is best-effort (Windows / odd FS) */
    }
  } catch {
    /* history is non-critical — never break a caller on a write failure */
  }
}

/** Record a successful login. */
export function recordLogin(opts: {
  machineFingerprint?: string;
  machineName?: string;
}): void {
  append({
    event: "login",
    at: new Date().toISOString(),
    machine_fingerprint: opts.machineFingerprint,
    machine_name: opts.machineName,
  });
}

/** Record a logout/disconnect. */
export function recordLogout(reason: LogoutReason): void {
  append({ event: "logout", at: new Date().toISOString(), reason });
}
