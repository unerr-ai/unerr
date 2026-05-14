/**
 * Deterministic Entity Key Generation — stable across re-indexes.
 *
 * Keys are SHA-256 hashes of (filePath:kind:name:scope), truncated to 16 hex chars.
 * This ensures:
 *   - Same entity always gets the same key
 *   - Different entities in different files never collide
 *   - Nested entities (methods in classes) include parent scope
 */

import { createHash } from "node:crypto";

export function entityKey(
  filePath: string,
  kind: string,
  name: string,
  scope = "",
): string {
  const input = `${filePath}:${kind}:${name}:${scope}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function bodyHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
