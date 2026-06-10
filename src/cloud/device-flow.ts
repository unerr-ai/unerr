/**
 * unerr cloud — device authorization flow (RFC 8628 client).
 *
 * Implements the CLI side of `unerr login` per unerr-web-service
 * `docs/CLI_API.md`:
 *
 *   1. POST /api/v1/cli/device/authorize  (sends hostname as client_name)
 *   2. print the user code + verification URI, try to open the browser
 *   3. poll POST /api/v1/cli/device/token every `interval` seconds,
 *      honoring slow_down (+5s), authorization_pending, access_denied,
 *      expired_token, invalid_grant.
 *
 * The device endpoints are unauthenticated and use RFC 8628 bodies
 * (`{ error, error_description }`) — distinct from the `{ error: { code,
 * message } }` envelope used by authenticated routes. This module parses
 * the RFC 8628 shape directly.
 *
 * Part of `src/cloud/` — the one auditable cloud surface. Sends only the
 * device code and (optionally) the hostname. Never sends code, prompts, or
 * any project data.
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { CloudClient } from "./client.js";

/** Response from the authorize endpoint. */
interface AuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** Successful token response — the credential the CLI will store. */
export interface DeviceFlowSuccess {
  status: "success";
  access_token: string;
  organization_id: string;
  machine_id: string;
  machine_name: string;
}

/** Terminal failure outcomes (each is a normal, expected result). */
export interface DeviceFlowFailure {
  status: "denied" | "expired" | "network" | "error";
  message: string;
}

export type DeviceFlowResult = DeviceFlowSuccess | DeviceFlowFailure;

/** Hooks so the command layer (and tests) control I/O and timing. */
export interface DeviceFlowDeps {
  /** Print a user-facing line (defaults to stderr — stdout stays clean). */
  print?: (line: string) => void;
  /** Best-effort browser open (defaults to the platform open command). */
  openBrowser?: (url: string) => void;
  /** Sleep between polls (injectable for tests / fake timers). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the hostname sent as client_name. */
  clientName?: string;
}

const TOKEN_PATH = "/api/v1/cli/device/token";
const AUTHORIZE_PATH = "/api/v1/cli/device/authorize";

/**
 * Run the full device flow against `apiUrl`. Returns a typed result; never
 * throws for expected outcomes (denied / expired / offline).
 */
export async function runDeviceFlow(
  apiUrl: string,
  deps: DeviceFlowDeps = {}
): Promise<DeviceFlowResult> {
  const print =
    deps.print ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sleep = deps.sleep ?? defaultSleep;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const clientName = deps.clientName ?? safeHostname();

  const client = new CloudClient({ apiUrl });

  // ── 1. Authorize ──────────────────────────────────────────────
  const authRes = await client.request<AuthorizeResponse>(AUTHORIZE_PATH, {
    method: "POST",
    auth: false,
    body: { client_name: clientName },
  });

  if (!authRes.ok) {
    if (authRes.status === 0) {
      return { status: "network", message: authRes.error.message };
    }
    return {
      status: "error",
      message:
        "Could not start login. The unerr cloud rejected the request — try again in a moment.",
    };
  }

  const auth = authRes.data;
  const completeUri = auth.verification_uri_complete ?? auth.verification_uri;

  // ── 2. Show the code + open the browser ───────────────────────
  print("");
  print("  To connect this machine to your team:");
  print("");
  print(`    1. Open:  ${auth.verification_uri}`);
  print(`    2. Enter this code:  ${auth.user_code}`);
  print("");
  print("  Opening your browser now (if it doesn't open, use the link above).");
  print("");

  // Best-effort: never fail the flow if the browser can't open.
  try {
    openBrowser(completeUri);
  } catch {
    /* ignore — the user has the code + URL above */
  }

  // ── 3. Poll for the token ─────────────────────────────────────
  // `interval` is in seconds; honor slow_down by adding 5s.
  let intervalMs = Math.max(1, auth.interval || 5) * 1000;
  const deadline = Date.now() + Math.max(1, auth.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const tokenRes = await client.request<DeviceTokenResponse>(TOKEN_PATH, {
      method: "POST",
      auth: false,
      body: { device_code: auth.device_code },
    });

    if (tokenRes.ok) {
      const t = tokenRes.data;
      return {
        status: "success",
        access_token: t.access_token,
        organization_id: t.organization_id,
        machine_id: t.machine_id,
        machine_name: t.machine_name,
      };
    }

    if (tokenRes.status === 0) {
      // Transient network blip mid-poll — keep trying until the deadline.
      continue;
    }

    // RFC 8628 error body: { error: "<code>", error_description }. The
    // client's extractError() recognizes this string-`error` shape and
    // surfaces the RFC code in `error.code`.
    const code = tokenRes.error.code;

    switch (code) {
      case "authorization_pending":
        // Keep polling at the current interval.
        continue;
      case "slow_down":
        intervalMs += 5_000;
        continue;
      case "access_denied":
        return {
          status: "denied",
          message: "Login was denied in the browser. Nothing was connected.",
        };
      case "expired_token":
        return {
          status: "expired",
          message:
            "This login request expired. Run unerr login again to get a fresh code.",
        };
      case "invalid_grant":
        return {
          status: "expired",
          message:
            "This login request is no longer valid. Run unerr login again to get a fresh code.",
        };
      default:
        // Unknown 4xx — stop rather than loop forever.
        return {
          status: "error",
          message:
            "Login failed. The unerr cloud returned an unexpected response — try again in a moment.",
        };
    }
  }

  return {
    status: "expired",
    message:
      "This login request expired before it was approved. Run unerr login to try again.",
  };
}

/** Token endpoint success body. */
interface DeviceTokenResponse {
  access_token: string;
  token_type: string;
  organization_id: string;
  machine_id: string;
  machine_name: string;
}

/** A hostname, trimmed to the contract's 120-char cap; never empty. */
function safeHostname(): string {
  let name = "";
  try {
    name = hostname();
  } catch {
    name = "";
  }
  if (!name) name = "unerr CLI";
  return name.slice(0, 120);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a URL in the default browser using the platform command. Detached
 * and fully best-effort — any failure is swallowed by the caller.
 */
function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    // `start` is a cmd builtin; the empty title arg avoids quoting issues.
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, {
    stdio: "ignore",
    detached: true,
  });
  // Don't keep the event loop alive for the browser process.
  child.on("error", () => {
    /* ignore — browser open is best-effort */
  });
  child.unref();
}
