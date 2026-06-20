/**
 * P8 — server-model review request path. BUILT, DORMANT.
 *
 * The local review engine (`reviewScopedChanges`) runs entirely on-device. This
 * module is the other half: ask unerr's *server* models to review a change set,
 * for cases the local checkers can't reach. unerr has NO server review model
 * wired today (none planned short-term), so the server endpoint is a guarded
 * stub that answers `{status:"unavailable"}`. The path is kept complete and
 * reachable (CLI builds the request, posts it, parses the reply) so it can be
 * turned on by wiring a model server-side — nothing here fires unless the
 * reviewer master switch is ON (`isReviewEnabled`) AND the caller opts in
 * (`unerr review --server`).
 *
 * WIRE SHAPES ARE CLI-LOCAL ON PURPOSE. Per the contract single-source rule,
 * anything that crosses the wire belongs in `@unerr-ai/contracts`. While this
 * path is dormant NOTHING crosses the wire, so the shapes live here to avoid a
 * premature contract bump + double-submodule publish. AT GO-LIVE: lift
 * `ReviewServerRequest` / `ReviewServerResponse` / `ServerReviewFinding` into a
 * new `@unerr-ai/contracts/review` subpath (zod-only, additive SchemaVer bump),
 * bump the `vendor/contracts` submodule in BOTH repos, then have the web side
 * implement against the shared shape. Until then this is the only copy and it is
 * intentionally not on any live request.
 *
 * @sem domain=review role=cloud-request
 */

import type { CloudClient, CloudResult } from "../cloud/client.js";
import type { ChangeFile } from "./types.js";

/** Wire schema version for the dormant server-review request (CLI-local). */
export const REVIEW_REQUEST_SCHEMA_VERSION = "1-0-0";

/** One changed file on the server-review request. Firewall-safe names only. */
export interface ReviewRequestChange {
  /** Repo-relative path (firewall-safe wire name, not `file_path`). */
  target_file: string;
  /** Pre-change content; omitted for an added file. */
  old_content?: string;
  /** Post-change content; omitted for a deleted file. */
  new_content?: string;
}

/** Request body for `POST /api/v1/cli/review/request` (CLI-local; see file note). */
export interface ReviewServerRequest {
  schema_version: string;
  /** Salted repo id (never a path / origin URL). */
  repo: string;
  /** Native session id when known — ties findings to the agent session. */
  session_id?: string;
  /** What the change is trying to do, for intent-aware review. */
  intent?: string;
  /** Severity floor the caller wants surfaced. */
  min_severity: string;
  /** The change set under review (whole-file content). */
  changes: ReviewRequestChange[];
}

/** One server-produced finding (CLI-local; mirrors the local review finding). */
export interface ServerReviewFinding {
  finding_key: string;
  checker_id: string;
  severity: string;
  title: string;
  action: string;
  target_file: string;
  start_line?: number;
  entity_id?: string;
}

/** Response from `POST /api/v1/cli/review/request` (CLI-local; see file note). */
export interface ReviewServerResponse {
  /** `unavailable` while no server model is wired (the dormant default). */
  status: "ok" | "unavailable" | "error";
  findings: ServerReviewFinding[];
  /** Identifier of the server model that ran, when `status === "ok"`. */
  model?: string;
  /** Human-readable reason for `unavailable` / `error`. */
  reason?: string;
}

/**
 * Assemble a {@link ReviewServerRequest} from a resolved change set. Maps each
 * reviewable `ChangeFile` to the firewall-safe wire shape; `null` content
 * (added/deleted) is dropped to an absent key rather than sent as `null`.
 */
export function buildReviewRequest(args: {
  repo: string;
  minSeverity: string;
  files: ChangeFile[];
  sessionId?: string;
  intent?: string;
}): ReviewServerRequest {
  const changes: ReviewRequestChange[] = args.files.map((f) => ({
    target_file: f.path,
    ...(f.oldContent !== null ? { old_content: f.oldContent } : {}),
    ...(f.newContent !== null ? { new_content: f.newContent } : {}),
  }));
  return {
    schema_version: REVIEW_REQUEST_SCHEMA_VERSION,
    repo: args.repo,
    ...(args.sessionId ? { session_id: args.sessionId } : {}),
    ...(args.intent ? { intent: args.intent } : {}),
    min_severity: args.minSeverity,
    changes,
  };
}

/**
 * POST a built request to the server-review endpoint and parse the reply.
 * Returns the typed {@link ReviewServerResponse} on a `200`, or a synthesized
 * `unavailable` result on any non-OK / network / shape error — the dormant path
 * must never throw into the command. The CALLER gates this behind
 * `isReviewEnabled` + `--server`; nothing here checks the switch.
 */
export async function requestServerReview(
  client: CloudClient,
  request: ReviewServerRequest
): Promise<ReviewServerResponse> {
  const result: CloudResult<unknown> = await client.postReviewRequest(request);
  if (!result.ok) {
    return {
      status: "unavailable",
      findings: [],
      reason:
        result.status === 0
          ? "could not reach the unerr server"
          : `server returned ${result.status}`,
    };
  }
  const body = result.data;
  if (
    body &&
    typeof body === "object" &&
    "status" in body &&
    typeof (body as { status: unknown }).status === "string"
  ) {
    const parsed = body as Partial<ReviewServerResponse>;
    return {
      status: parsed.status ?? "unavailable",
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
  }
  return {
    status: "unavailable",
    findings: [],
    reason: "server review is not available yet",
  };
}
