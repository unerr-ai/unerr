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
 *  - Modest retry/backoff for *network* errors always; plus opt-in retries for
 *    transient HTTP statuses (`429`/`503`) on batch pushes, honoring
 *    `Retry-After`. Terminal statuses (`400`/`403`/`413`) are never retried.
 *  - 10-second timeout per attempt via `AbortSignal.timeout`.
 *
 * No new dependencies: this uses the global `fetch` shipped with Node 20+ and
 * the built-in `node:zlib` for gzip on batch pushes.
 */

import { gzipSync } from "node:zlib";
import type { MachineDisconnectInput } from "@unerr-ai/contracts/account";
import type {
  FleetReport,
  HeartbeatReport,
} from "../daemon/fleet-inventory.js";
import { UNERR_VERSION } from "../version.js";
import { DEFAULT_API_URL } from "./credentials.js";

/** Per-request timeout. */
const TIMEOUT_MS = 10_000;
/** Network-error retries (HTTP error *responses* are never retried). */
const MAX_RETRIES = 2;
/** Base backoff; grows linearly: 300ms, 600ms. */
const BACKOFF_BASE_MS = 300;
/** Ceiling on one retry backoff sleep; a larger `Retry-After` is clamped here. */
const RETRY_CAP_MS = 30_000;

/**
 * Fleet ingest endpoint paths. The machine is resolved server-side from the
 * bearer token, so no machine id appears in the path or the body.
 */
const CHECKIN_PATH = "/api/v1/cli/machine/checkin";
const INVENTORY_PATH = "/api/v1/cli/machine/inventory";
/** Logout/disconnect report — closes this machine's open login-history entry. */
const DISCONNECT_PATH = "/api/v1/cli/machine/disconnect";

/**
 * Batch push endpoints. The ClickHouse `ingest/*` streams take row arrays
 * (`sessions` takes one object); the Postgres `sync/*` streams carry the
 * developer's facts, timeline, and repo-state hashes. Exact bodies + caps are
 * in `docs/CLI_API.md`; the machine is resolved server-side from the token.
 */
const INGEST_EVENTS_PATH = "/api/v1/cli/ingest/events";
const INGEST_TRANSCRIPTS_PATH = "/api/v1/cli/ingest/transcripts";
const INGEST_LEDGER_PATH = "/api/v1/cli/ingest/ledger";
const INGEST_ROUTER_PATH = "/api/v1/cli/ingest/router";
const INGEST_SESSIONS_PATH = "/api/v1/cli/ingest/sessions";
const SYNC_FACTS_PATH = "/api/v1/cli/sync/facts";
const SYNC_TIMELINE_PATH = "/api/v1/cli/sync/timeline";
const SYNC_STATE_PATH = "/api/v1/cli/sync/state";
/**
 * The anti-forgetting (spaced-recall) machine-token surface. `GET` lists the
 * caller's due/unanswered prompts; `POST` answers one. Both are paid-gated and
 * self-scoped server-side (the cookie routes `/api/recall/*` stay web-only).
 */
const SYNC_RECALL_PATH = "/api/v1/cli/sync/recall";
/**
 * Server-model review request (P8 — built, DORMANT). The CLI POSTs a change set
 * + intent; the server runs unerr's server-side review models and returns
 * findings. unerr has no server review model wired today, so the endpoint is a
 * guarded stub that answers `{status:"unavailable"}` — nothing ships findings
 * over this path until a model exists AND the reviewer master switch is ON
 * (`UNERR_REVIEW_ENABLED` on the CLI, `REVIEWS_ENABLED` on the server). The
 * request/response shapes live CLI-local in `review-request.ts` for now; migrate
 * them to `@unerr-ai/contracts/review` at go-live (see that file's note).
 */
const REVIEW_REQUEST_PATH = "/api/v1/cli/review/request";

/**
 * The retry policy every batch push shares: retry a `429` (rate limited) or
 * `503` (server busy) up to 4 attempts total with full-jitter backoff that
 * honors `Retry-After`. `400`/`403`/`413` stay terminal — they mean the
 * request is wrong, not transiently failing.
 */
const BATCH_RETRY: RetryPolicy = {
  retryStatuses: [429, 503],
  maxAttempts: 4,
  baseMs: BACKOFF_BASE_MS,
  capMs: RETRY_CAP_MS,
};

/** Server's answer to a heartbeat — steers the next cadence centrally. */
export interface CheckinResponse {
  ack: boolean;
  /** Seconds the CLI should wait before the next checkin (server-driven). */
  next_checkin_after_seconds?: number;
}

/** Server's answer to a full inventory push. */
export interface InventoryAck {
  accepted: boolean;
  stored_at?: string;
}

/**
 * Per-batch result of a push to `/ingest/*` or `/sync/*`. The ClickHouse ingest
 * streams (events/transcripts/ledger/router) answer with `accepted`/`rejected`
 * COUNTS plus a `results[]` array carrying one `{ event_id, status, code }` per
 * record in request order; `sync/timeline` and `sync/state` answer with just
 * the two counts; `sync/facts` echoes the stored rows and `ingest/sessions`
 * returns `{ session_id, status }`. The index signature keeps those per-stream
 * extras. A `rejected` row is permanent (firewall / malformed) — the drain loop
 * counts it as a dead letter and advances past it rather than re-push (B7).
 */
export interface BatchAck {
  accepted?: number;
  /**
   * Rows the server could not process now but durably persisted to its
   * quarantine store for server-side replay (contract >= events 1-0-5). Parked
   * rows are NOT lost — the drainer advances its cursor and never dead-letters
   * them. Absent (read as 0) from a pre-accept-and-park server.
   */
  parked?: number;
  rejected?: number;
  results?: Array<{
    event_id: string;
    status: "accepted" | "parked" | "rejected";
    /**
     * Set only when status="rejected": "permanent" (poison — dead-letter and
     * advance) vs "retryable" (transient — hold the cursor, retry next tick).
     * Unspecified is treated as permanent (the pre-1-0-5 default).
     */
    disposition?: "permanent" | "retryable";
    code?: string;
  }>;
  [key: string]: unknown;
}

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

/**
 * One unanswered recall prompt from `GET /api/v1/cli/sync/recall`. The
 * anti-forgetting loop (C5) renders these as "3 weeks ago you chose X — still
 * remember why?". `due_at` may be `null`. `decision_ref` ties the prompt back
 * to a server-side decision record. Self-scoped to the token's user.
 */
export interface RecallPrompt {
  id: string;
  prompt: string;
  decision_ref: string | null;
  due_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** Body of `GET /api/v1/cli/sync/recall` — `{ prompts: [...] }`. */
export interface RecallPromptList {
  prompts: RecallPrompt[];
}

/**
 * The server's answer to `POST /api/v1/cli/sync/recall` — `{ answer_id,
 * prompt_id, remembered }`. `answer_id` is the server's id for the stored
 * answer; the CLI's idempotency key (`client_answer_id`) is what we SEND, not
 * what comes back.
 */
export interface RecallAnswerAck {
  answer_id: string;
  prompt_id: string;
  remembered: boolean;
  [key: string]: unknown;
}

/**
 * The POST body for a recall answer. `client_answer_id` is a CLI-stable
 * UUIDv5 (never random) so a retried / spool-redrained answer upserts and
 * writes ONCE (B4-client). `note` is optional, ≤2048 chars, code-stripped
 * client-side (HR-2) — never raw code.
 */
export interface RecallAnswerInput {
  prompt_id: string;
  remembered: boolean;
  note?: string;
  client_answer_id: string;
}

export interface CloudClientOptions {
  /** Base URL, e.g. `https://app.unerr.dev`. Trailing slash trimmed. */
  apiUrl: string;
  /** Machine token (`unerr_sk_…`) for authenticated calls. */
  token?: string;
}

/**
 * Retry policy for a single request. The default (no policy) preserves the
 * historical behavior: retry network failures only, with linear backoff, and
 * return any HTTP error response untouched. A batch push opts into HTTP-status
 * retries via `retryStatuses` — then a `429`/`503` is retried with full-jitter
 * backoff that honors a `Retry-After` header. Terminal statuses
 * (`400`/`403`/`413`) are never retried whatever the policy says.
 */
interface RetryPolicy {
  /** HTTP statuses to retry (e.g. `[429, 503]`). Absent/empty = none. */
  retryStatuses?: number[];
  /** Total attempts including the first (default `MAX_RETRIES + 1` = 3). */
  maxAttempts?: number;
  /** Base for full-jitter backoff in ms (default `BACKOFF_BASE_MS`). */
  baseMs?: number;
  /** Cap on a single backoff sleep in ms (default `RETRY_CAP_MS`). */
  capMs?: number;
}

/** Options for a single request. */
interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
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
  /**
   * Gzip the JSON body and set `Content-Encoding: gzip`. Used by the batch
   * pushes (`/ingest/*`, `/sync/*`) where up to thousands of rows compress
   * well; the small fleet/auth bodies leave it off.
   */
  gzip?: boolean;
  /** Opt into HTTP-status retries (see {@link RetryPolicy}). */
  retry?: RetryPolicy;
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
   * `POST …/checkin` — the lightweight fleet heartbeat. The response may carry
   * `next_checkin_after_seconds` to steer the next cadence centrally.
   */
  async postCheckin(
    beat: HeartbeatReport
  ): Promise<CloudResult<CheckinResponse>> {
    return this.request<CheckinResponse>(CHECKIN_PATH, {
      method: "POST",
      auth: true,
      body: beat,
    });
  }

  /**
   * `PUT …/inventory` — the full fleet snapshot. Idempotent upsert: resending
   * the same body leaves the same server-side state.
   */
  async putInventory(report: FleetReport): Promise<CloudResult<InventoryAck>> {
    return this.request<InventoryAck>(INVENTORY_PATH, {
      method: "PUT",
      auth: true,
      body: report,
    });
  }

  /**
   * `POST …/disconnect` — report a logout so the server closes this machine's
   * open login-history entry instead of leaving it looking online. The machine
   * is resolved from the bearer token; the body just records when + why + the
   * fingerprint for correlation. Best-effort: the caller wipes credentials
   * regardless of the result.
   */
  async postMachineDisconnect(
    body: MachineDisconnectInput
  ): Promise<CloudResult<{ ok: boolean }>> {
    return this.request<{ ok: boolean }>(DISCONNECT_PATH, {
      method: "POST",
      auth: true,
      body,
    });
  }

  /**
   * `POST …/ingest/events` — a batch of metric events (the five `type`s share
   * one array, ≤100/push). Each row carries a stable `event_id` so a retried
   * push de-dups server-side.
   */
  async ingestEvents(events: unknown[]): Promise<CloudResult<BatchAck>> {
    return this.postBatch(INGEST_EVENTS_PATH, { events });
  }

  /**
   * `POST …/ingest/transcripts` — per-turn reasoning prose (≤100/push),
   * code-stripped client-side before it is ever passed here (HR-2).
   */
  async ingestTranscripts(
    transcripts: unknown[]
  ): Promise<CloudResult<BatchAck>> {
    return this.postBatch(INGEST_TRANSCRIPTS_PATH, { transcripts });
  }

  /**
   * `POST …/ingest/ledger` — tool-call metadata rows (≤500/push): the tool, a
   * redacted args shape, status, timing. Never raw arguments.
   */
  async ingestLedger(ledger: unknown[]): Promise<CloudResult<BatchAck>> {
    return this.postBatch(INGEST_LEDGER_PATH, { ledger });
  }

  /** `POST …/ingest/router` — model-routing telemetry rows (≤200/push). */
  async ingestRouter(router: unknown[]): Promise<CloudResult<BatchAck>> {
    return this.postBatch(INGEST_ROUTER_PATH, { router });
  }

  /**
   * `POST …/ingest/sessions` — one session metadata object per push (totals
   * and counts, code-free). Unlike the other ingest streams this is a single
   * object, not an array.
   */
  async ingestSession(session: unknown): Promise<CloudResult<BatchAck>> {
    return this.postBatch(INGEST_SESSIONS_PATH, { session });
  }

  /**
   * `POST …/sync/facts` — upsert the developer's memory notes (≤500/push); a
   * row with the same id updates in place, never duplicates. Requires a team
   * scope — a personal token is refused with `400 scope_unsupported` (B6).
   */
  async syncFacts(facts: unknown[]): Promise<CloudResult<BatchAck>> {
    return this.postBatch(SYNC_FACTS_PATH, { facts });
  }

  /** `POST …/sync/timeline` — turn/intent/marker/signal entries (≤500/push). */
  async syncTimeline(timeline: unknown[]): Promise<CloudResult<BatchAck>> {
    return this.postBatch(SYNC_TIMELINE_PATH, { timeline });
  }

  /**
   * `POST …/sync/state?repo=<repoId>` — file content-hashes + co-change + drift
   * (hashes only, never file bodies). The `repo` query param is required; both
   * arrays are capped at 5000/push.
   */
  async syncState(
    repoId: string,
    state: unknown[],
    drift: unknown[]
  ): Promise<CloudResult<BatchAck>> {
    const path = `${SYNC_STATE_PATH}?repo=${encodeURIComponent(repoId)}`;
    return this.postBatch(path, { state, drift });
  }

  /**
   * `GET /api/v1/cli/sync/recall` — the caller's unanswered recall prompts,
   * due/oldest first, self-scoped to the token's user. Paid-gated server-side;
   * the caller pre-checks `canSyncRecall()` so a free machine never reaches
   * here. `due_at` may be `null`. Drives the anti-forgetting loop (C5).
   */
  async getRecallPrompts(): Promise<CloudResult<RecallPromptList>> {
    return this.request<RecallPromptList>(SYNC_RECALL_PATH, {
      method: "GET",
      auth: true,
    });
  }

  /**
   * `POST /api/v1/cli/sync/recall` — answer one recall prompt. The body's
   * `client_answer_id` is a CLI-stable UUIDv5 (never random): the server
   * UPSERTS on it, so a retried / spool-redrained answer writes ONCE
   * (B4-client; idempotent against the P0/S3 upsert). An unknown / foreign
   * `prompt_id` → `404`. `note` (when present) is already code-stripped (HR-2).
   * Retries `429`/`503` via `BATCH_RETRY`; `404`/`403` stay terminal.
   */
  async postRecallAnswer(
    answer: RecallAnswerInput
  ): Promise<CloudResult<RecallAnswerAck>> {
    return this.request<RecallAnswerAck>(SYNC_RECALL_PATH, {
      method: "POST",
      auth: true,
      body: answer,
      retry: BATCH_RETRY,
    });
  }

  /**
   * `POST /api/v1/cli/review/request` — server-model review (P8, DORMANT). Sends
   * a change set + intent; expects findings back. The server runs no review model
   * today, so this returns `{status:"unavailable"}` — kept BUILT so the wire path
   * is exercised end-to-end, but it ships no findings until a model is wired AND
   * the reviewer master switch is ON. Body/response are typed `unknown` here;
   * `review-request.ts` owns the CLI-local shapes (migrate to the contract at
   * go-live). Retries `429`/`503` like the batch pushes.
   */
  async postReviewRequest(body: unknown): Promise<CloudResult<unknown>> {
    return this.request<unknown>(REVIEW_REQUEST_PATH, {
      method: "POST",
      auth: true,
      gzip: true,
      body,
      retry: BATCH_RETRY,
    });
  }

  /**
   * Shared batch POST: bearer auth, gzip the body, and the `BATCH_RETRY`
   * policy (retry `429`/`503` with `Retry-After`). Every `/ingest/*` and
   * `/sync/*` method routes through here so they share one transport.
   */
  private postBatch<T = BatchAck>(
    path: string,
    body: unknown
  ): Promise<CloudResult<T>> {
    return this.request<T>(path, {
      method: "POST",
      auth: true,
      gzip: true,
      body,
      retry: BATCH_RETRY,
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
    // Serialize the body, gzipping it for batch pushes that opt in. Small
    // fleet/auth bodies stay plain JSON.
    let payload: string | Uint8Array | undefined;
    if (opts.body !== undefined) {
      const json = JSON.stringify(opts.body);
      if (opts.gzip) {
        payload = gzipSync(Buffer.from(json));
        headers["Content-Encoding"] = "gzip";
      } else {
        payload = json;
      }
    }
    // `Uint8Array` (the gzip case) is a valid `fetch` body at runtime under
    // Node's undici but isn't in the DOM `BodyInit` lib type — cast past it.
    const init: RequestInit = {
      method,
      headers,
      body: payload as BodyInit | undefined,
    };

    const maxAttempts = Math.max(1, opts.retry?.maxAttempts ?? MAX_RETRIES + 1);
    const retryStatuses = opts.retry?.retryStatuses ?? [];
    let lastNetworkMessage = "Could not reach the unerr cloud.";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const isLast = attempt === maxAttempts - 1;
      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        // Network-level failure (offline, DNS, TLS, timeout/abort). Retry
        // with linear backoff, then give up with a network result. Never
        // include the token (it is only in headers, never in the message).
        lastNetworkMessage = describeNetworkError(err);
        if (!isLast) {
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

      // A transient HTTP status the caller opted into (429/503) is retried with
      // full-jitter backoff that honors `Retry-After`; every other status —
      // success or terminal 4xx — is returned as-is, never retried.
      if (!isLast && retryStatuses.includes(res.status)) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        const capMs = opts.retry?.capMs ?? RETRY_CAP_MS;
        const baseMs = opts.retry?.baseMs ?? BACKOFF_BASE_MS;
        const delay =
          retryAfterMs !== undefined
            ? Math.min(retryAfterMs, capMs)
            : fullJitter(attempt, baseMs, capMs);
        await sleep(delay);
        continue;
      }

      // A response we won't retry — parse the body and return.
      return this.toResult<T>(res);
    }

    // Unreachable (the last attempt always returns), but satisfies the type
    // checker.
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

/**
 * Parse a `Retry-After` header into milliseconds. The header is either a delay
 * in whole seconds or an HTTP date; both are handled. Returns `undefined` when
 * the header is absent or unparseable so the caller falls back to jittered
 * backoff.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;
  // A bare integer is a delay in seconds.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Otherwise an HTTP date — convert to a delay from now, floored at 0.
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/**
 * Full-jitter backoff (AWS "Exponential Backoff and Jitter"): a random delay in
 * `[0, min(cap, base * 2^attempt)]`. The randomness spreads retries from many
 * machines so a shared `503` doesn't resynchronize them into a thundering herd.
 */
export function fullJitter(
  attempt: number,
  baseMs: number,
  capMs: number
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
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
