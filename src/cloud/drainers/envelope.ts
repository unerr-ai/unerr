/**
 * unerr cloud — the client-side HR-2 detail firewall.
 *
 * Envelope stamping now lives at emit (`src/events/enqueue.ts` `stampEvent`),
 * so this module is only the HR-2 firewall: `sanitizeDetail` strips raw code /
 * paths / secrets, `hashEntityKey` turns a real entity key into an opaque id
 * that survives the firewall. Under the sanitize-at-drain model the local
 * `.unerr/events` JSONL keeps the full detail (command / file / tee_file — what
 * the dashboard reads), and the unified ingest drainer runs `sanitizeDetail`
 * over each non-fleet row's detail just before push, so those path-ish keys
 * never leave the machine. The server firewall is the backstop.
 *
 */

import { createHash } from "node:crypto";

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
  "tee_file",
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

/**
 * The client-side HR-2 firewall for a detail tail: drop denylisted keys
 * (case-insensitive), clip strings to 512 chars, cap the whole object at 64
 * keys and depth 4. Returns a fresh object — the input is never mutated.
 * Non-plain values (functions, symbols) are dropped; numbers/booleans/null pass.
 *
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
