/**
 * unerr cloud — HTTP client.
 *
 * A small wrapper around the global `fetch` for the cloud control plane.
 * Part of `src/cloud/` — the one auditable surface that talks to the
 * internet. It only ever calls the endpoints in unerr-web-service
 * `docs/CLI_API.md`, and it sends only what the contract specifies.
 *
 * Design choices (per the integration plan, §3.2 / Sprint I2):
 *  - Base URL comes from the credential file's `api_url`, overridable with
 *    `UNERR_API_URL` (preview testing). Default `https://app.unerr.dev`.
 *  - Bearer machine token on authenticated calls (`Authorization: Bearer …`).
 *  - The token is never logged or included in any error message.
 *  - Expected API errors do NOT throw — every call returns a typed result
 *    object the caller switches on. Only programmer misuse throws.
 *  - The `{ error: { code, message } }` envelope is parsed into the result.
 *  - Modest retry/backoff for *network* errors only (never for HTTP error
 *    responses — those are answers, not failures).
 *  - 10-second timeout per attempt via `AbortSignal.timeout`.
 *
 * No new dependencies: this uses the global `fetch` shipped with Node 20+.
 */

import { UNERR_VERSION } from "../version.js";
import { DEFAULT_API_URL } from "./credentials.js";

/** Per-request timeout. */
const TIMEOUT_MS = 10_000;
/** Network-error retries (HTTP error *responses* are never retried). */
const MAX_RETRIES = 2;
/** Base backoff; grows linearly: 300ms, 600ms. */
const BACKOFF_BASE_MS = 300;

/** The `{ error: { code, message } }` envelope for authenticated routes. */
export interface CloudErrorEnvelope {
  code: string;
  message: string;
}

/**
 * The result of a cloud call. Never throws for expected outcomes — the
 * caller switches on `ok`.
 *
 *  - `ok: true`  → `status` + parsed `data`.
 *  - `ok: false` with `error`     → the server answered with an
 *    `{ error: { code, message } }` body (or another HTTP error we mapped).
 *  - `ok: false` with `network: true` → could not reach the server at all
 *    (offline, DNS, TLS, timeout). The local product must keep working.
 */
export type CloudResult<T> =
  | {
      ok: true;
      status: number;
      data: T;
      /**
       * The server's `Date` response header, parsed to epoch milliseconds.
       * Used by the entitlement cache as a trusted clock for the
       * clock-rollback guard (Sprint I3). `undefined` if the header was
       * absent or unparseable.
       */
      serverTimeMs?: number;
      /**
       * The response `ETag` header, when present. The conventions sync
       * (Sprint I4) stores it and sends it back as `If-None-Match` so the
       * daemon polls cheaply. `undefined` when the header was absent.
       */
      etag?: string;
      /**
       * `304 Not Modified` — sent only when the caller passed an
       * `If-None-Match` that still matched the server's version. `data` is
       * undefined in this case; the caller keeps whatever it already had.
       * (Distinct from a normal `200`, where `notModified` is absent.)
       */
      notModified?: boolean;
    }
  | {
      ok: false;
      status: number;
      error: CloudErrorEnvelope;
      network?: false;
    }
  | {
      ok: false;
      status: 0;
      network: true;
      error: CloudErrorEnvelope;
    };

/**
 * Conventions response (`GET /api/v1/cli/conventions`). When the org has
 * never saved one: `content` is `""`, `version` is `0`, `updated_at` is
 * `null`.
 */
export interface ConventionsDoc {
  content: string;
  version: number;
  updated_at: string | null;
  [key: string]: unknown;
}

/** Entitlements response (`GET /api/v1/cli/entitlements`). */
export interface Entitlements {
  organization_id: string;
  machine_id: string;
  plan: string;
  limits: Record<string, unknown>;
  features: Record<string, boolean>;
  // Sprint I1 adds entitlement_token / fresh_until / grace_until; the
  // contract says ignore unknown fields, so we don't model them here yet.
  [key: string]: unknown;
}

export interface CloudClientOptions {
  /** Base URL, e.g. `https://app.unerr.dev`. Trailing slash trimmed. */
  apiUrl: string;
  /** Machine token (`unerr_sk_…`) for authenticated calls. */
  token?: string;
}

/** Options for a single request. */
interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  /** JSON body to send. */
  body?: unknown;
  /** Send the bearer token (default true when a token is configured). */
  auth?: boolean;
  /**
   * Extra request headers, e.g. `If-None-Match` for the conventions ETag
   * fast path (Sprint I4). Never carries the token (that's the bearer
   * header, set separately and never logged).
   */
  extraHeaders?: Record<string, string>;
}

export class CloudClient {
  private readonly apiUrl: string;
  private readonly token?: string;

  constructor(opts: CloudClientOptions) {
    this.apiUrl = (opts.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
    this.token = opts.token;
    // TLS-only: refuse a plain http:// control-plane URL unless it points at
    // localhost (the only place a dev preview legitimately runs over http).
    // Catching this at construction means no token is ever attached to an
    // unencrypted request. Throws — a misconfigured base URL is programmer
    // error, not an expected network outcome.
    assertSafeBaseUrl(this.apiUrl);
  }

  /** `GET /api/v1/cli/entitlements`. */
  async getEntitlements(): Promise<CloudResult<Entitlements>> {
    return this.request<Entitlements>("/api/v1/cli/entitlements", {
      method: "GET",
      auth: true,
    });
  }

  /**
   * `GET /api/v1/cli/conventions`. Pass the last-seen `etag` to use the
   * cheap `If-None-Match` fast path — the server answers `304` (an `ok`
   * result with `notModified: true` and no `data`) when nothing changed.
   */
  async getConventions(etag?: string): Promise<CloudResult<ConventionsDoc>> {
    return this.request<ConventionsDoc>("/api/v1/cli/conventions", {
      method: "GET",
      auth: true,
      extraHeaders: etag ? { "If-None-Match": etag } : undefined,
    });
  }

  /**
   * `PUT /api/v1/cli/conventions`. Replaces the document. Pass the
   * last-seen `version` for the optimistic lock — a mismatch returns `409`
   * with `error.code = "version_conflict"`. `content` is the full human-
   * written document; nothing generated from code scanning ever goes here.
   */
  async putConventions(
    content: string,
    version?: number
  ): Promise<CloudResult<{ version: number }>> {
    return this.request<{ version: number }>("/api/v1/cli/conventions", {
      method: "PUT",
      auth: true,
      body: version === undefined ? { content } : { content, version },
    });
  }

  /**
   * Low-level request. Public so device-flow can reuse the same fetch +
   * timeout + retry discipline for the unauthenticated device endpoints.
   *
   * Retries are for network failures only and use linear backoff. An HTTP
   * error *response* (4xx/5xx) is returned, not retried.
   */
  async request<T>(
    path: string,
    opts: RequestOptions = {}
  ): Promise<CloudResult<T>> {
    const url = `${this.apiUrl}${path}`;
    const method = opts.method ?? "GET";

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const wantsAuth = opts.auth ?? Boolean(this.token);
    if (wantsAuth && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
      // Tell the server which CLI version is talking — shown on the Machines
      // page so teams can spot outdated installs (contract: optional header,
      // sent on every authenticated request). Carries no sensitive data.
      headers["X-Unerr-Cli-Version"] = UNERR_VERSION;
    }
    // Caller-supplied headers last (e.g. If-None-Match). Never the token.
    if (opts.extraHeaders) {
      for (const [k, v] of Object.entries(opts.extraHeaders)) headers[k] = v;
    }
    const init: RequestInit = {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    };

    let lastNetworkMessage = "Could not reach the unerr cloud.";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        // Network-level failure (offline, DNS, TLS, timeout/abort). Retry
        // with backoff, then give up with a network result. Never include
        // the token (it is only in headers, never in the message).
        lastNetworkMessage = describeNetworkError(err);
        if (attempt < MAX_RETRIES) {
          await sleep(BACKOFF_BASE_MS * (attempt + 1));
          continue;
        }
        return {
          ok: false,
          status: 0,
          network: true,
          error: { code: "network_error", message: lastNetworkMessage },
        };
      }

      // We got an HTTP response — parse the body and return. No retry.
      return this.toResult<T>(res);
    }

    // Unreachable (loop always returns), but satisfies the type checker.
    return {
      ok: false,
      status: 0,
      network: true,
      error: { code: "network_error", message: lastNetworkMessage },
    };
  }

  /** Turn a `Response` into a typed `CloudResult`. */
  private async toResult<T>(res: Response): Promise<CloudResult<T>> {
    const raw = await res.text();
    let parsed: unknown = undefined;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }

    const dateHeader = res.headers.get("date");
    const ms = dateHeader ? Date.parse(dateHeader) : Number.NaN;
    const serverTimeMs = Number.isFinite(ms) ? ms : undefined;
    const etag = res.headers.get("etag") ?? undefined;

    // 304 Not Modified — the If-None-Match still matched. `fetch` reports
    // this as not-ok, but it's a success for our purposes: the caller keeps
    // whatever it already had. No body.
    if (res.status === 304) {
      return {
        ok: true,
        status: 304,
        data: undefined as unknown as T,
        serverTimeMs,
        etag,
        notModified: true,
      };
    }

    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        data: parsed as T,
        serverTimeMs,
        etag,
      };
    }

    return {
      ok: false,
      status: res.status,
      error: extractError(parsed, res.status),
    };
  }
}

/**
 * Extract a `code` + `message` from an error body. Handles BOTH shapes the
 * contract uses (`docs/CLI_API.md`):
 *
 *  - Authenticated routes:  `{ "error": { "code", "message" } }`
 *  - Device flow (RFC 8628): `{ "error": "<code>", "error_description": "…" }`
 *
 * Falls back to a generic `http_<status>` envelope when the body is missing
 * or shaped differently, so the caller always has a `code` to switch on.
 */
export function extractError(
  parsed: unknown,
  status: number
): CloudErrorEnvelope {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const e = (parsed as { error: unknown }).error;

    // Authenticated-route envelope: error is an object with code/message.
    if (e && typeof e === "object") {
      const code = (e as { code?: unknown }).code;
      const message = (e as { message?: unknown }).message;
      if (typeof code === "string") {
        return {
          code,
          message:
            typeof message === "string" && message.length > 0 ? message : code,
        };
      }
    }

    // RFC 8628 device-flow body: error is a string code, with an optional
    // error_description alongside it.
    if (typeof e === "string" && e.length > 0) {
      const desc = (parsed as { error_description?: unknown })
        .error_description;
      return {
        code: e,
        message: typeof desc === "string" && desc.length > 0 ? desc : e,
      };
    }
  }
  return {
    code: `http_${status}`,
    message: `The unerr cloud returned an unexpected response (HTTP ${status}).`,
  };
}

/** Plain-language description of a network failure (no token, ever). */
function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "The unerr cloud did not respond in time.";
    }
  }
  return "Could not reach the unerr cloud — check your internet connection.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hostnames that are allowed to be reached over plain http:// (dev only). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Enforce TLS on the control-plane base URL. `https://` is always fine;
 * `http://` is allowed ONLY for localhost (a dev preview). Anything else —
 * a remote `http://` host, or a non-http(s) scheme — throws a clear error
 * before any token can be attached to a request.
 */
export function assertSafeBaseUrl(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error(
      `Invalid unerr API URL: "${apiUrl}". Set UNERR_API_URL to an https:// address.`
    );
  }

  if (url.protocol === "https:") return;

  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return;

  if (url.protocol === "http:") {
    throw new Error(
      `Refusing to talk to the unerr cloud over an unencrypted connection (${apiUrl}). Use an https:// address — plain http:// is allowed only for localhost.`
    );
  }

  throw new Error(
    `Unsupported unerr API URL scheme "${url.protocol}" in "${apiUrl}". Use https://.`
  );
}
