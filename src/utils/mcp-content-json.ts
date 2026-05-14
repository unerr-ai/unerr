/**
 * Layer 6 — Sprint FE-A (§43): MCP tool `content[].text` payloads use compact JSON only.
 * Pretty-printed JSON (`JSON.stringify(v, null, 2)`) inflates token count by ~15–25%
 * on structural whitespace (`LAYER_6_FORMAT_ENCODING.md`).
 */
export function stringifyMcpToolJson(value: unknown): string {
  return JSON.stringify(value);
}
