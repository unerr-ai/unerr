/**
 * unerr cloud — team-conventions sync.
 *
 * The team's shared conventions document flows DOWN to each laptop (the
 * Tailscale "policy flows down" model, integration plan §2.5). This module
 * pulls `GET /api/v1/cli/conventions` on the same cadence as the entitlement
 * refresh, using the cheap `If-None-Match`/ETag fast path so we only pay for
 * the document body when the version actually moves.
 *
 * It is GATED two ways: `gate("conventions_sync")` decides whether the plan
 * includes the feature, and the telemetry off-switch (`UNERR_NO_TELEMETRY`,
 * `DO_NOT_TRACK`, `telemetry: false`) can stop it outright regardless of
 * plan. Either denial skips the daemon's automatic pull silently (HR-B —
 * local work never depends on the cloud); an explicit `unerr conventions
 * pull` explains it in plain language instead.
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
import {
  isTelemetryDisabledByConfig,
  isTelemetryDisabledByEnv,
} from "./entitlements.js";
import { gate } from "./gate.js";
import { handleRevokedToken } from "./login-state.js";

/** Plain-language reason shown when the telemetry off-switch blocks a pull —
 *  reuses the `"gated"` outcome shape so every existing caller (the daemon's
 *  automatic cadence, `unerr conventions pull`) already renders it correctly. */
const TELEMETRY_OFF_MESSAGE =
  "Telemetry is off (UNERR_NO_TELEMETRY, DO_NOT_TRACK, or a telemetry:false config key) — remove it to pull team conventions.";

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
  // The token's scope cannot own a shared conventions document (a personal /
  // solo account). The server would answer `PUT /conventions` with
  // `400 scope_unsupported`; the guard (B6) skips the PUT before any network
  // call so a solo account never hits a guaranteed-400 loop.
  | { result: "scope_unsupported"; message: string }
  | { result: "error"; message: string };

/**
 * The token's conventions scope, read from the entitlements / authorize
 * surface. `team` (org-scoped) can own the shared document; `personal` (a solo
 * account) cannot — the server refuses its `PUT /conventions` with
 * `400 scope_unsupported`. `undefined` means the surface did not report a scope
 * (an older server); the guard treats that as "allowed" so a missing field
 * never blocks a legitimate team push (fail-open, the server is the backstop).
 */
export type ConventionsScope = "team" | "personal" | undefined;

/** The plain-language reason a personal-scope token cannot push conventions. */
export const PERSONAL_SCOPE_MESSAGE =
  "Shared conventions need a team account. This token is personal-scoped, so there's nothing to push to. Conventions still sync DOWN to this machine.";

/**
 * Decide whether a `PUT /conventions` may run for a token's scope. Only a
 * `personal` scope is refused; `team` and an absent scope (older server) are
 * allowed. Pure — read from the entitlements/authorize scope, no network call.
 *
 */
export function isPersonalScope(scope: ConventionsScope): boolean {
  return scope === "personal";
}

/**
 * Read the conventions scope out of a CLI entitlements response. The server
 * carries it as `scope` (or `scope_type`) on the entitlements/authorize
 * surface; both spellings are accepted. Returns `undefined` when neither field
 * is present (older server) so the guard fails open.
 *
 */
export function scopeFromEntitlements(
  ent: Record<string, unknown> | null | undefined
): ConventionsScope {
  if (!ent) return undefined;
  const raw = ent.scope ?? ent.scope_type;
  return raw === "team" || raw === "personal" ? raw : undefined;
}

/**
 * Push the team conventions document — guarded by the token's scope (B6). A
 * `personal` scope skips the `PUT` entirely (no network call) and returns
 * `"scope_unsupported"`, mirroring the gate-skip shape, so a solo account never
 * fires a guaranteed-`400` request. A `team` / unknown scope performs the PUT
 * and maps the response onto a {@link SyncOutcome}.
 *
 */
export async function pushTeamConventions(
  client: CloudClient,
  content: string,
  opts: { scope?: ConventionsScope; version?: number; now?: number } = {}
): Promise<SyncOutcome> {
  // Scope guard first — a personal token's PUT is a guaranteed 400. Skip it
  // before any network call (B6).
  if (isPersonalScope(opts.scope)) {
    return { result: "scope_unsupported", message: PERSONAL_SCOPE_MESSAGE };
  }

  const res = await client.putConventions(content, opts.version);

  if (!res.ok) {
    if (res.status === 0) return { result: "network" };
    if (res.status === 401 && res.error.code === "revoked_token") {
      const message = handleRevokedToken();
      return { result: "revoked", message };
    }
    // The server is the backstop: if it still reports a scope mismatch (e.g.
    // the local scope was unknown), surface it as the same outcome rather than
    // a generic error, so the caller can stay quiet about a solo account.
    if (res.status === 400 && res.error.code === "scope_unsupported") {
      return { result: "scope_unsupported", message: PERSONAL_SCOPE_MESSAGE };
    }
    return { result: "error", message: res.error.message };
  }

  const nowIso = new Date(opts.now ?? Date.now()).toISOString();
  const version = typeof res.data.version === "number" ? res.data.version : 0;
  writeTeamConventions({
    content,
    version,
    updated_at: nowIso,
    etag: `"v${version}"`,
    synced_at: nowIso,
  });
  return { result: "updated", version };
}

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
 *  - telemetry off-switch on      → `"gated"` (reused shape) explaining the
 *    switch; no network call. This is the pull side of the same GET the
 *    entitlement refresh makes, so it honors the same off-switch — see
 *    `src/cloud/refresh-job.ts`.
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
  // The telemetry off-switch stops this outright, even for an explicit
  // `unerr conventions pull` — the GET here still identifies the account to
  // the server, exactly the contact UNERR_NO_TELEMETRY/DO_NOT_TRACK and a
  // `telemetry: false` config key promise to stop.
  if (isTelemetryDisabledByEnv() || isTelemetryDisabledByConfig()) {
    return { result: "gated", message: TELEMETRY_OFF_MESSAGE };
  }

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
