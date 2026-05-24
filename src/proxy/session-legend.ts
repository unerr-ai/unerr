/**
 * Layer 6 Sprint FE-E — session-scoped legend delivery (columnar protocol + output format).
 * Legends attach once per session until invalidated (e.g. retry detected).
 */

export interface SessionLegendTracker {
  /** Returns true the first time in a session; caller should emit columnar protocol text inline (drained from `meta` into a `ur|` prefix line). */
  consumeColumnarLegend(): boolean;
  /** Returns true the first time in a session; caller should emit output format guidance inline (drained from `meta` into a `ur|` prefix line). */
  consumeOutputFormatLegend(): boolean;
  /** Re-send legends on the next encoded response (quality / retry path). */
  invalidateAll(): void;
}

/** One-time output format legend text (~40 tokens). Advertises the once-per-session
 *  output conventions: unified diff for edits, path references over content, and
 *  the `ur|ctx` signal that means context already delivered — proceed without re-querying. */
export const OUTPUT_FORMAT_LEGEND =
  "Output conventions: use unified diff (---/+++/@@ hunks) for edits. " +
  "Prefer file path references over content repetition. " +
  "When a response carries `ur|ctx` for an entity, context is already delivered — do not re-query.";

export function createSessionLegendTracker(): SessionLegendTracker {
  let columnarSent = false;
  let outputFormatSent = false;

  return {
    consumeColumnarLegend(): boolean {
      if (columnarSent) return false;
      columnarSent = true;
      return true;
    },
    consumeOutputFormatLegend(): boolean {
      if (outputFormatSent) return false;
      outputFormatSent = true;
      return true;
    },
    invalidateAll(): void {
      columnarSent = false;
      outputFormatSent = false;
    },
  };
}
