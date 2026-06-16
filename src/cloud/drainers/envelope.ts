/**
 * unerr cloud — the shared wire envelope + the HR-2 detail pre-filter.
 *
 * Every events/trace record the C1 drainers push carries the same closed
 * envelope (`schema_version`, `repo`, `agent`, `event_id`, `ts`, `source`,
 * `session_id`, `turn`) plus an open `detail` tail. `buildEnvelope` stamps the
 * envelope; `sanitizeDetail` runs the client-side HR-2 firewall over the detail
 * tail so raw code / paths / secrets can never leave the machine. The server
 * firewall is the backstop, but pre-filtering here means a sloppy detail object
 * doesn't get the whole record rejected.
 *
 * See `unerr-web-service/docs/CLI_API.md` (ingest/events + trace streams) for
 * the contract this mirrors.
 */

import { createHash } from "node:crypto";
import { INGEST_SCHEMA_VERSION } from "@unerr-ai/contracts/events";
import { TRACE_SCHEMA_VERSION as CONTRACT_TRACE_SCHEMA_VERSION } from "@unerr-ai/contracts/traces";

/** events schema version — sourced from `@unerr-ai/contracts/events`
 *  (`INGEST_SCHEMA_VERSION`, currently `1-0-2`) so the CLI and web-service can
 *  never disagree. The SchemaVer history lives in the contract module. */
export const EVENTS_SCHEMA_VERSION = INGEST_SCHEMA_VERSION;
/** trace-stream schema version (ledger/router/transcripts) — sourced from
 *  `@unerr-ai/contracts/traces` (`TRACE_SCHEMA_VERSION`). */
export const TRACE_SCHEMA_VERSION = CONTRACT_TRACE_SCHEMA_VERSION;

/** Exact, case-insensitive key denylist — a detail key matching one is dropped. */
const DENYLIST = new Set<string>([
  "content",
  "code",
  "diff",
  "patch",
  "snippet",
  "source",
  "raw",
  "raw_text",
  "path",
  "file",
  "filename",
  "filepath",
  "dir",
  "directory",
  "entity",
  "entity_key",
  "command",
  "cmd",
  "prompt",
  "prompts",
  "text",
  "body",
  "message",
  "msg",
  "query",
  "input",
  "output",
  "completion",
  "transcript",
  "secret",
  "password",
  "credential",
  "token",
  "api_key",
  "email",
]);

/** Server caps mirrored client-side so a record is never rejected for shape. */
const MAX_STRING_LEN = 512;
const MAX_KEYS = 64;
const MAX_DEPTH = 4;

/** The closed envelope fields shared by every events/trace record. */
export interface Envelope {
  schema_version: string;
  repo: string;
  agent?: string;
  event_id: string;
  ts: string;
  source: string;
  session_id?: string;
  turn?: number;
  detail: Record<string, unknown>;
}

/** Inputs to {@link buildEnvelope} — the per-row fields a drainer resolves. */
export interface EnvelopeInput {
  schemaVersion: string;
  repo: string;
  agent?: string;
  eventId: string;
  ts: string;
  source: string;
  sessionId?: string;
  turn?: number;
  /** The pre-sanitize detail tail; passed through {@link sanitizeDetail}. */
  detail: Record<string, unknown>;
}

/**
 * Build a wire envelope: stamp the closed fields and run the detail tail
 * through {@link sanitizeDetail}. `agent`, `session_id`, and `turn` are omitted
 * when absent (the server treats them as optional). `type` is added by the
 * caller drainer since it is stream-specific.
 *
 * // @sem domain=cloud role=drainer
 */
export function buildEnvelope(input: EnvelopeInput): Envelope {
  const env: Envelope = {
    schema_version: input.schemaVersion,
    repo: input.repo,
    event_id: input.eventId,
    ts: input.ts,
    source: input.source,
    detail: sanitizeDetail(input.detail),
  };
  if (input.agent !== undefined && input.agent !== "") env.agent = input.agent;
  if (input.sessionId !== undefined && input.sessionId !== "")
    env.session_id = input.sessionId;
  if (input.turn !== undefined) env.turn = input.turn;
  return env;
}

/**
 * The client-side HR-2 firewall for a detail tail: drop denylisted keys
 * (case-insensitive), clip strings to 512 chars, cap the whole object at 64
 * keys and depth 4. Returns a fresh object — the input is never mutated.
 * Non-plain values (functions, symbols) are dropped; numbers/booleans/null pass.
 *
 * // @sem domain=cloud role=drainer
 */
export function sanitizeDetail(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const budget = { keys: 0 };
  return sanitizeObject(obj, 1, budget);
}

/**
 * Turn a real entity key (`src/foo.ts:bar`, a path + symbol — denylisted as
 * both `path` and `entity_key`) into an opaque 16-hex id that survives the
 * HR-2 firewall. The same key always hashes to the same id, so per-entity
 * rollups ("code that stuck" by entity) still group correctly cloud-side
 * without the real key or path ever leaving the machine. Returns undefined
 * for an empty / missing key so the caller omits the field.
 *
 * // @sem domain=cloud role=identity
 */
export function hashEntityKey(
  entityKey: string | null | undefined
): string | undefined {
  if (entityKey === null || entityKey === undefined || entityKey === "")
    return undefined;
  return createHash("sha256").update(entityKey).digest("hex").slice(0, 16);
}

function sanitizeObject(
  obj: Record<string, unknown>,
  depth: number,
  budget: { keys: number }
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (budget.keys >= MAX_KEYS) break;
    if (DENYLIST.has(key.toLowerCase())) continue;
    const clean = sanitizeValue(value, depth, budget);
    if (clean === DROP) continue;
    out[key] = clean;
    budget.keys += 1;
  }
  return out;
}

/** Sentinel marking a value that must be omitted entirely. */
const DROP = Symbol("drop");

function sanitizeValue(
  value: unknown,
  depth: number,
  budget: { keys: number }
): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return s.length > MAX_STRING_LEN ? s.slice(0, MAX_STRING_LEN) : s;
  }
  if (t === "number" || t === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return DROP;
    const arr: unknown[] = [];
    for (const item of value) {
      if (budget.keys >= MAX_KEYS) break;
      const clean = sanitizeValue(item, depth + 1, budget);
      if (clean === DROP) continue;
      arr.push(clean);
    }
    return arr;
  }
  if (t === "object") {
    if (depth >= MAX_DEPTH) return DROP;
    return sanitizeObject(value as Record<string, unknown>, depth + 1, budget);
  }
  // functions, symbols, undefined, bigint → drop.
  return DROP;
}
