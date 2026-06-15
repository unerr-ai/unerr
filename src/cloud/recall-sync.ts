/**
 * unerr cloud — anti-forgetting recall round-trip (C5).
 *
 * This is the orchestration half of the spaced-recall loop. It is DISTINCT from
 * `src/hooks/recall-client.ts`, which is the UDS client for anchored Layer-B
 * NOTES (a subprocess→proxy hop, no network). This module is the CLOUD recall:
 * it fetches due recall PROMPTS over HTTPS, mints a stable answer id, submits
 * the developer's y/n self-report, and fetches the server-generated weekly
 * recap for display. The two share a name only — keeping them in separate
 * files avoids conflating the note-recall and decision-recall mechanisms.
 *
 * Paid gate (C5 is a paid feature):
 *  - Every network path here is fronted by `canSyncRecall()` — recall is the
 *    paid differentiator, so unlike plain telemetry (which now flows on every
 *    plan) it still gates on a paid plan (B5). A logged-out or free machine
 *    makes ZERO network calls;
 *    the function returns a `gated` / `not_logged_in` outcome and the local
 *    product stays fully usable (HR-B).
 *
 * Idempotency (B4-client):
 *  - The answer's `client_answer_id` is a deterministic UUIDv5 derived from the
 *    prompt identity (NEVER random), so a retried / spool-redrained answer
 *    upserts and writes ONCE against the P0/S3 route.
 *
 * HR-2:
 *  - The optional developer `note` is code-stripped via `stripCodeBearingProse`
 *    before it can ever leave the machine; raw code/paths never go up.
 *
 * Part of `src/cloud/` — the one auditable surface that talks to the cloud.
 *
 * @sem domain=cloud role=schedule
 */

import type {
  CloudClient,
  CloudResult,
  RecallAnswerAck,
  RecallPrompt,
} from "./client.js";
import { readCredentials } from "./credentials.js";
import { stripCodeBearingProse } from "./decision-record.js";
import { canSyncRecall } from "./entitlements.js";
import { deterministicId } from "./event-id.js";

/**
 * The weekly recap the server generates (one batched LLM call per active user)
 * and the CLI only DISPLAYS — it is never generated client-side. `synthesized_by`
 * tells the user whether prose was LLM-written or a deterministic fallback.
 *
 * NOTE — server route pending: CLI_API.md documents only `/api/v1/cli/sync/recall`
 * as a machine-token surface; the recap currently has a cookie route
 * (`GET /api/recap/me/latest`, browser-session only). This module reads the
 * machine-token recap path below; until the server adds it, `fetchWeeklyRecap`
 * degrades to `{ result: "unavailable" }` on the 404 and the CLI shows nothing.
 */
export interface WeeklyRecap {
  /** ISO date the recap window ends. */
  week_of: string;
  /** The recap narrative — already prose, ready to print. */
  narrative: string;
  /** Whether the narrative was LLM-written or a deterministic fallback. */
  synthesized_by: "llm" | "fallback";
  [key: string]: unknown;
}

/** Machine-token recap path (pending server route — see WeeklyRecap note). */
const RECAP_PATH = "/api/v1/cli/recap/latest";

/** The result of fetching due recall prompts. Never throws. */
export type FetchRecallOutcome =
  | { result: "gated"; message: string }
  | { result: "not_logged_in" }
  | { result: "network" }
  | { result: "error"; message: string }
  | { result: "ok"; prompts: RecallPrompt[] };

/** The result of submitting one recall answer. Never throws. */
export type AnswerRecallOutcome =
  | { result: "gated"; message: string }
  | { result: "not_logged_in" }
  | { result: "network" }
  | { result: "not_found" } // unknown / foreign prompt_id → 404
  | { result: "error"; message: string }
  | { result: "ok"; client_answer_id: string; ack: RecallAnswerAck };

/** The result of fetching the weekly recap. Never throws. */
export type RecapOutcome =
  | { result: "gated"; message: string }
  | { result: "not_logged_in" }
  | { result: "network" }
  | { result: "unavailable" } // server route not live yet (404)
  | { result: "error"; message: string }
  | { result: "ok"; recap: WeeklyRecap };

/**
 * The stable answer id for a recall answer. Derived from the prompt's identity
 * (and `decision_ref` when present) so a retried answer to the SAME prompt
 * re-derives the SAME id and the server upsert collapses the duplicate
 * (B4-client). NEVER random.
 *
 * @sem domain=cloud role=identity
 */
export function recallAnswerId(prompt: Pick<RecallPrompt, "id">): string {
  return deterministicId("recall_answer", prompt.id);
}

/**
 * Fetch the caller's due/unanswered recall prompts. Gates on
 * `canSyncRecall()` first (no network when free/logged-out). Maps every
 * outcome to a typed result — the caller never sees an exception.
 *
 * @sem domain=cloud role=schedule
 */
export async function fetchRecallPrompts(
  client: CloudClient,
  opts: { now?: number } = {}
): Promise<FetchRecallOutcome> {
  if (!canSyncRecall(opts.now)) {
    return {
      result: "gated",
      message: "Spaced recall needs a paid plan — run unerr login to connect.",
    };
  }
  const res = await client.getRecallPrompts();
  if (!res.ok) return mapNetworkError(res);
  return { result: "ok", prompts: res.data.prompts ?? [] };
}

/**
 * Submit one recall answer. Mints a stable `client_answer_id` (B4-client),
 * code-strips the optional note (HR-2), and POSTs it. Gated on
 * `canSyncRecall()`. A `404` (unknown/foreign prompt) maps to `not_found`,
 * not a hot-retry loop.
 *
 * `note` is the developer's own words; pass `optInNote: true` only when the
 * user explicitly chose to send code-bearing prose (HR-2 default is to withhold
 * anything that looks like code).
 *
 * @sem domain=cloud role=schedule
 */
export async function answerRecallPrompt(
  client: CloudClient,
  input: {
    prompt: Pick<RecallPrompt, "id">;
    remembered: boolean;
    note?: string;
    optInNote?: boolean;
  },
  opts: { now?: number } = {}
): Promise<AnswerRecallOutcome> {
  if (!canSyncRecall(opts.now)) {
    return {
      result: "gated",
      message: "Spaced recall needs a paid plan — run unerr login to connect.",
    };
  }
  const client_answer_id = recallAnswerId(input.prompt);
  const note = stripCodeBearingProse(input.note, {
    optedIn: input.optInNote === true,
  });
  const res = await client.postRecallAnswer({
    prompt_id: input.prompt.id,
    remembered: input.remembered,
    client_answer_id,
    ...(note !== undefined ? { note } : {}),
  });
  if (!res.ok) {
    if (res.status === 404) return { result: "not_found" };
    return mapNetworkError(res);
  }
  return { result: "ok", client_answer_id, ack: res.data };
}

/**
 * Fetch the server-generated weekly recap for DISPLAY. The recap is one
 * server-side batched LLM call; the CLI only renders it — it is never generated
 * client-side. Gated on `canSyncRecall()`. A `404` means the server route is
 * not live yet (see WeeklyRecap note) → `unavailable`, shown as nothing.
 *
 * @sem domain=cloud role=schedule
 */
export async function fetchWeeklyRecap(
  client: CloudClient,
  opts: { now?: number } = {}
): Promise<RecapOutcome> {
  if (!canSyncRecall(opts.now)) {
    return {
      result: "gated",
      message:
        "The weekly recap needs a paid plan — run unerr login to connect.",
    };
  }
  const res = await client.request<WeeklyRecap>(RECAP_PATH, {
    method: "GET",
    auth: true,
  });
  if (!res.ok) {
    if (res.status === 404) return { result: "unavailable" };
    return mapNetworkError(res);
  }
  return { result: "ok", recap: res.data };
}

/**
 * Render the weekly recap to a plain-text block for the terminal (stderr —
 * stdout is MCP JSON-RPC only). Leads with "unerr" per the de-jargon
 * convention; returns `null` when there is nothing to show.
 *
 * @sem domain=cloud role=schedule
 */
export function renderWeeklyRecap(recap: WeeklyRecap): string | null {
  const narrative = recap.narrative?.trim();
  if (!narrative) return null;
  const tag = recap.synthesized_by === "fallback" ? " (auto-summary)" : "";
  return `unerr weekly recap — week of ${recap.week_of}${tag}\n${narrative}`;
}

/**
 * One recall sweep for the daemon cadence: build a client from current
 * credentials, fetch due prompts, and return them for surfacing. Skips silently
 * (no network) when not logged in or gated. Mirrors `runConventionsSyncOnce`.
 *
 * @sem domain=cloud role=schedule
 */
export async function runRecallFetchOnce(
  deps: {
    makeClient?: (apiUrl: string, token: string) => CloudClient;
    now?: number;
  } = {}
): Promise<FetchRecallOutcome> {
  const creds = readCredentials();
  if (!creds) return { result: "not_logged_in" };
  if (!canSyncRecall(deps.now)) {
    return {
      result: "gated",
      message: "Spaced recall needs a paid plan — run unerr login to connect.",
    };
  }
  let makeClient = deps.makeClient;
  if (!makeClient) {
    const { CloudClient: Client } = await import("./client.js");
    makeClient = (apiUrl, token) => new Client({ apiUrl, token });
  }
  const client = makeClient(creds.api_url, creds.token);
  return fetchRecallPrompts(client, { now: deps.now });
}

/**
 * One recall sweep for the daemon refresh cadence that ALSO persists the result
 * to the local recall store so `unerr status` can surface due prompts offline.
 * Wraps `runRecallFetchOnce`: on `ok` it replaces the stored due-prompt snapshot
 * (best-effort — a persist failure is swallowed so it never affects the refresh
 * outcome). Skips silently (no network, no write) when not logged in or gated —
 * mirrors `runConventionsSyncOnce`. Never throws.
 *
 * @sem domain=cloud role=schedule
 */
export async function runRecallSyncOnce(
  deps: {
    makeClient?: (apiUrl: string, token: string) => CloudClient;
    now?: number;
  } = {}
): Promise<FetchRecallOutcome> {
  const outcome = await runRecallFetchOnce(deps);
  if (outcome.result === "ok") {
    try {
      const { saveDuePrompts } = await import("./recall-store.js");
      await saveDuePrompts(outcome.prompts, { now: deps.now });
    } catch {
      // Persisting the snapshot is best-effort; the fetch already succeeded.
    }
  }
  return outcome;
}

/**
 * Answer one due recall prompt by id — the concrete round-trip the surface
 * invokes (the answer reaches the cloud here). Builds a client from the current
 * credentials, mints the stable `client_answer_id` (B4-client) via
 * `answerRecallPrompt`, and on a server `ok` drops the prompt from the local
 * store so it stops being re-surfaced. Gated on `canSyncRecall()` inside
 * `answerRecallPrompt` (free / logged-out → no network). Never throws.
 *
 * The optional `note` is the developer's own words; it is code-stripped (HR-2)
 * inside `answerRecallPrompt` unless `optInNote` is set. The `remembered` y/n is
 * what feeds the "decisions you can explain" metric.
 *
 * @sem domain=cloud role=schedule
 */
export async function answerDuePrompt(
  input: {
    promptId: string;
    remembered: boolean;
    note?: string;
    optInNote?: boolean;
  },
  deps: {
    makeClient?: (apiUrl: string, token: string) => CloudClient;
    now?: number;
  } = {}
): Promise<AnswerRecallOutcome> {
  const creds = readCredentials();
  if (!creds) return { result: "not_logged_in" };
  if (!canSyncRecall(deps.now)) {
    return {
      result: "gated",
      message: "Spaced recall needs a paid plan — run unerr login to connect.",
    };
  }
  let makeClient = deps.makeClient;
  if (!makeClient) {
    const { CloudClient: Client } = await import("./client.js");
    makeClient = (apiUrl, token) => new Client({ apiUrl, token });
  }
  const client = makeClient(creds.api_url, creds.token);
  const outcome = await answerRecallPrompt(
    client,
    {
      prompt: { id: input.promptId },
      remembered: input.remembered,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.optInNote !== undefined ? { optInNote: input.optInNote } : {}),
    },
    { now: deps.now }
  );
  // Both an accepted answer and a `not_found` (foreign / already-gone prompt)
  // mean the prompt should no longer be surfaced locally; drop it either way.
  if (outcome.result === "ok" || outcome.result === "not_found") {
    try {
      const { removeDuePrompt } = await import("./recall-store.js");
      await removeDuePrompt(input.promptId);
    } catch {
      // Best-effort cleanup; the answer already reached the server.
    }
  }
  return outcome;
}

/**
 * Collapse a non-ok `CloudResult` to the `network` / `error` recall outcome.
 * A `status: 0` is a real network failure (offline) — the local product covers
 * it; any other non-ok status is the server's typed error.
 */
function mapNetworkError(
  res: Extract<CloudResult<unknown>, { ok: false }>
): { result: "network" } | { result: "error"; message: string } {
  if (res.status === 0) return { result: "network" };
  return { result: "error", message: res.error.message };
}
