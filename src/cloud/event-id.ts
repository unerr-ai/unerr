/**
 * unerr cloud — deterministic push ids.
 *
 * Every pushed row needs an idempotency key the server dedups on (`event_id`
 * for the ClickHouse streams; `client_fact_id` / `client_entry_id` /
 * `client_drift_id` for the relational streams). The key MUST be a pure
 * function of the source row, never random: when the daemon redrains a spool
 * after a crash it re-derives the same id, the server collapses the duplicate,
 * and at-least-once delivery becomes effectively exactly-once. A random UUID
 * per push would instead write the row twice.
 */

import { createHash } from "node:crypto";

/**
 * A fixed namespace UUID for unerr push ids. Any constant UUID works as a v5
 * namespace; this one is private to unerr so ids never collide with another
 * product's v5 space.
 */
const UNERR_PUSH_NAMESPACE = "6f1c2e4a-7b3d-4c8e-9a0f-1d2e3b4c5d6e";

/** A byte that never appears in a repo id / stream key / row key. */
const PART_SEPARATOR = String.fromCharCode(0);

function namespaceBytes(): Buffer {
  return Buffer.from(UNERR_PUSH_NAMESPACE.replace(/-/g, ""), "hex");
}

/**
 * A deterministic RFC-4122 v5 UUID built from stable parts (NUL-joined so
 * distinct part lists can never produce the same concatenation). Same parts in
 * → same UUID, which is exactly the idempotency the push pipeline relies on.
 *
 * // @sem domain=cloud role=identity
 */
export function deterministicId(...parts: string[]): string {
  const name = parts.join(PART_SEPARATOR);
  const bytes = createHash("sha1")
    .update(namespaceBytes())
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  // Stamp version (5) and the RFC-4122 variant bits.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
