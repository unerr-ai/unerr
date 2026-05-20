/**
 * Shared compression-ratio helpers used by the fetch_url response envelope
 * AND the compression_events telemetry row. Kept in its own file so telemetry
 * and the protocol can both import without a circular dep (the protocol
 * imports telemetry to record events).
 *
 * The "safe" prefix means the value is clamped at zero when extracted ≥ raw
 * (an inflation signal, not real negative compression). Both the envelope's
 * `compression_ratio` and telemetry's `saved_pct` are computed from the same
 * source so the dashboard never disagrees with what the agent saw.
 */

/**
 * Compression ratio as a 0..1 number rounded to 2 decimals. Clamps at 0 when
 * extracted_bytes ≥ raw_bytes — happens on SPA pages whose hydrated content
 * exceeds the raw HTML shell. Returning -3.76 from a Stripe-shaped page would
 * make the agent think extraction failed; clamping at 0 + flipping
 * quality.inflated on the envelope is the honest report: "extraction worked,
 * the size comparison just isn't meaningful here."
 */
export function safeCompressionRatio(
  rawBytes: number,
  compressedBytes: number
): number {
  if (rawBytes <= 0) return 0;
  const ratio = 1 - compressedBytes / rawBytes;
  if (ratio < 0) return 0;
  return Math.round(ratio * 100) / 100;
}

/**
 * Same clamp as `safeCompressionRatio` but expressed as an integer percent
 * (0..100). Used for telemetry's `saved_pct` column so dashboard aggregates
 * agree with what the agent saw in the response envelope.
 */
export function safeSavedPct(
  rawBytes: number,
  compressedBytes: number
): number {
  return Math.round(safeCompressionRatio(rawBytes, compressedBytes) * 100);
}
