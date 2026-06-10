/**
 * unerr cloud — team-conventions sync.
 *
 * The team's shared conventions document flows DOWN to each laptop (the
 * Tailscale "policy flows down" model, integration plan §2.5). This module
 * pulls `GET /api/v1/cli/conventions` on the same cadence as the entitlement
 * refresh, using the cheap `If-None-Match`/ETag fast path so we only pay for
 * the document body when the version actually moves.
 *
 * It is GATED: `gate("conventions_sync")` decides whether the sync runs. When
 * denied, the daemon skips silently (HR-B — local work never depends on the
 * cloud); an explicit `unerr conventions pull` explains it in plain language.
 *
 * The synced doc is stored at `~/.unerr/team-conventions.json` (mode 0600) as
 * a DISTINCT, READ-ONLY team layer. It is NEVER auto-merged into the locally
 * learned conventions and NEVER feeds enforcement — display/advisory only
 * (auto-apply is parked with the policy pillar, open question #6).
 *
 * Part of `src/cloud/` — the one auditable surface that talks to the cloud.
 * The only thing this module ever sends up is the auth handshake + CLI
 * version header (added by the shared client); it pulls, it never pushes.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { CloudClient } from "./client.js";
import { readCredentials, teamConventionsPath } from "./credentials.js";
import { gate } from "./gate.js";
import { handleRevokedToken } from "./login-state.js";

/** Owner read/write only — matches the credential + entitlement files. */
const FILE_MODE = 0o600;

/** The feature key in the plan's `features` map that gates this sync. */
export const CONVENTIONS_FEATURE = "conventions_sync";

/**
 * What we persist to `~/.unerr/team-conventions.json` (mode 0600).
 *
 * `etag` is the `"v<version>"` string the server returns; we send it back as
 * `If-None-Match` on the next poll. `synced_at` is bumped on every successful
 * poll (including a `304`, where the content is left untouched).
 */
export interface TeamConventions {
  /** The full human-written document. Empty string when the team has none. */
  content: string;
  /** The server's monotonic version number (0 when never saved). */
  version: number;
  /** When the document was last saved server-side (ISO), or null. */
  updated_at: string | null;
  /** The server ETag (`"v<version>"`), for the next If-None-Match poll. */
  etag: string | null;
  /** When this laptop last pulled it (ISO, our clock). */
  synced_at: string;
}

/** The outcome of one sync attempt — so callers can branch + message. */
export type SyncOutcome =
  | { result: "updated"; version: number }
  | { result: "unchanged"; version: number }
  | { result: "gated"; message: string }
  | { result: "not_logged_in" }
  | { result: "revoked"; message: string }
  | { result: "network" }
  | { result: "error"; message: string };

/** Read the stored team-conventions doc. Returns null when absent/corrupt. */
export function readTeamConventions(): TeamConventions | null {
  const path = teamConventionsPath();
  if (!existsSync(path)) return null;

  let parsed: Partial<TeamConventions>;
  try {
    parsed = JSON.parse(
      readFileSync(path, "utf-8")
    ) as Partial<TeamConventions>;
  } catch {
    return null;
  }
  if (typeof parsed.content !== "string") return null;

  return {
    content: parsed.content,
    version: typeof parsed.version === "number" ? parsed.version : 0,
    updated_at:
      typeof parsed.updated_at === "string" ? parsed.updated_at : null,
    etag: typeof parsed.etag === "string" ? parsed.etag : null,
    synced_at:
      typeof parsed.synced_at === "string"
        ? parsed.synced_at
        : new Date(0).toISOString(),
  };
}

/** Write the team-conventions doc with mode 0600. Creates `~/.unerr`. */
export function writeTeamConventions(doc: TeamConventions): void {
  const path = teamConventionsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const body = JSON.stringify(doc, null, 2);
  writeFileSync(path, `${body}\n`, { mode: FILE_MODE });
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    /* ignore — chmod can fail on some filesystems / Windows */
  }
}

/**
 * Pull the team conventions once and update the local store. Pass `now`
 * only in tests.
 *
 * Behaviour:
 *  - gate denied                  → `"gated"` with the gate's plain-language
 *    explanation; no network call.
 *  - not logged in                → `"not_logged_in"`.
 *  - `200` with new content        → store `{content,version,updated_at,etag}`
 *    + `synced_at`, return `"updated"`.
 *  - `304` Not Modified            → bump `synced_at` only, leave content +
 *    version untouched, return `"unchanged"`.
 *  - `401 revoked_token`           → `handleRevokedToken()` (wipes state),
 *    return `"revoked"`.
 *  - offline / network error       → `"network"`; the stored doc covers it.
 */
export async function syncConventions(
  client: CloudClient,
  opts: { now?: number } = {}
): Promise<SyncOutcome> {
  // Gate first — the sync is a paid feature. A denial returns the gate's
  // plain-language explanation and makes no network call.
  const decision = gate(CONVENTIONS_FEATURE, opts.now);
  if (!decision.allowed) {
    return { result: "gated", message: decision.message };
  }

  const existing = readTeamConventions();
  const res = await client.getConventions(existing?.etag ?? undefined);

  if (!res.ok) {
    if (res.status === 0) return { result: "network" };
    if (res.status === 401 && res.error.code === "revoked_token") {
      const message = handleRevokedToken();
      return { result: "revoked", message };
    }
    return { result: "error", message: res.error.message };
  }

  const nowIso = new Date(opts.now ?? Date.now()).toISOString();

  // 304 — nothing changed. Bump synced_at only; never touch the content.
  if (res.notModified) {
    if (existing) {
      writeTeamConventions({ ...existing, synced_at: nowIso });
      return { result: "unchanged", version: existing.version };
    }
    // 304 with no stored doc shouldn't happen (we sent no If-None-Match),
    // but treat it as "nothing to store".
    return { result: "unchanged", version: 0 };
  }

  // 200 — store the fresh document.
  const doc = res.data;
  writeTeamConventions({
    content: doc.content ?? "",
    version: typeof doc.version === "number" ? doc.version : 0,
    updated_at: doc.updated_at ?? null,
    etag: res.etag ?? `"v${typeof doc.version === "number" ? doc.version : 0}"`,
    synced_at: nowIso,
  });
  return {
    result: "updated",
    version: typeof doc.version === "number" ? doc.version : 0,
  };
}

/**
 * Run one conventions sync for the daemon refresh cadence. Builds a client
 * from the current credentials; skips silently when not logged in or when
 * the gate denies the feature (daemon stays quiet — HR-B). Used by the
 * refresh job after entitlements refresh; offline failures are silent.
 */
export async function runConventionsSyncOnce(deps: {
  makeClient?: (apiUrl: string, token: string) => CloudClient;
  log?: (msg: string) => void;
}): Promise<SyncOutcome> {
  const creds = readCredentials();
  if (!creds) return { result: "not_logged_in" };

  if (!deps.makeClient) {
    // Lazy import keeps the cloud surface self-contained and avoids a cycle.
    const { CloudClient: Client } = await import("./client.js");
    deps.makeClient = (apiUrl, token) => new Client({ apiUrl, token });
  }
  const client = deps.makeClient(creds.api_url, creds.token);

  const outcome = await syncConventions(client);
  switch (outcome.result) {
    case "updated":
      deps.log?.(`conventions: updated to version ${outcome.version}`);
      break;
    case "unchanged":
      // Silent — nothing moved.
      break;
    case "gated":
      // Feature off for this plan — skip silently in the daemon.
      break;
    case "revoked":
      deps.log?.("conventions: machine revoked — credentials cleared");
      break;
    case "network":
      // Offline — the stored doc covers it. Stay silent.
      break;
    case "error":
      deps.log?.(`conventions: sync failed — ${outcome.message}`);
      break;
    case "not_logged_in":
      break;
  }
  return outcome;
}
