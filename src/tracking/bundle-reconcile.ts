/**
 * E4 Layer B — REALIZED post-hoc reconciliation of a recon bundle's modeled
 * savings (Layer A is the emit-time upper bound; this is the credible number).
 *
 * A bundle claims to have saved the agent N discovery round-trips. Layer B
 * checks that claim against what the agent ACTUALLY did over the next few turns,
 * using the manifest Layer A persisted (the delivered entity keys + files, and
 * the speculative expand-ring caller keys):
 *
 *   - delivered item RE-FETCHED → MISS. The bundle already carried it; the agent
 *     read it again anyway, so that delivery was wasted. Claws back the claim.
 *   - expand-ring caller EDITED without a re-read → CONFIRMED avoided round-trip.
 *     The speculative pre-inline paid off: the agent edited the caller straight
 *     from the inlined body (exactly the blast-radius follow-on the ring targets).
 *   - delivered item EDITED without a re-read → the bundle was SUFFICIENT for
 *     that edit — a round-trip (the pre-edit read) the bundle confirmedly saved.
 *
 * From those it derives `bundle_hit_rate`, `expand_precision`, and
 * `confirmed_round_trips_saved`. This productizes the manual 7/13-fan-out
 * analysis as live telemetry.
 *
 * Pure + deterministic: every function here takes already-read event arrays (no
 * DB, no clock) so it unit-tests against synthetic rows. The projection that maps
 * `file_read` token-flow rows → read touches and edit-signal behavior rows → edit
 * touches lives here too (`reconcileBundleSavings` and its helpers); the dashboard
 * route adds only the two table reads.
 *
 */

import type { BehaviorEvent, BehaviorEventType } from "./behavior-events.js";
import type { TokenFlowEvent } from "./token-flow.js";

/** The Layer-A manifest one bundle persisted (parsed from a token_flow detail). */
export interface BundleManifest {
  readonly session_id: string;
  /** 1-indexed turn the bundle was served on. */
  readonly turn: number;
  /** Emit time (epoch ms) — touches strictly after this are the follow-on. */
  readonly ts: number;
  readonly delivered_entity_keys: string[];
  readonly delivered_files: string[];
  readonly expand_keys: string[];
  /** Layer-A modeled round-trips — the ceiling Layer B can confirm. */
  readonly round_trips_modeled: number;
}

/**
 * One later code-touch the proxy observed — a read (file_read / search) or an
 * edit. `file`/`entity` are whatever the source carried; either may be null.
 */
export interface CodeTouch {
  readonly session_id: string;
  readonly ts: number;
  readonly turn: number;
  readonly file: string | null;
  readonly entity: string | null;
  readonly kind: "read" | "edit";
}

export interface BundleRealized {
  /**
   * Fraction of delivered items the agent did NOT re-fetch within the window
   * (0..1). 1.0 = the bundle was sufficient; lower = it re-read what it had.
   */
  readonly bundle_hit_rate: number;
  /**
   * Fraction of expand-ring items the agent edited without re-reading (0..1), or
   * null when the bundle carried no expand ring (nothing to score).
   */
  readonly expand_precision: number | null;
  /** Round-trips the bundle is CONFIRMED to have saved (≤ round_trips_modeled). */
  readonly confirmed_round_trips_saved: number;
  /** Delivered items the agent re-fetched anyway (the waste count). */
  readonly refetched_items: number;
  /** Total distinct delivered items (files + entity keys) considered. */
  readonly delivered_items: number;
}

/** Default look-ahead window (turns) over which a bundle's claim is judged. */
export const DEFAULT_WINDOW_TURNS = 5;

/**
 * Reconcile one bundle's modeled savings against the touches that followed it.
 */
export function reconcileBundle(
  manifest: BundleManifest,
  touches: readonly CodeTouch[],
  opts: { windowTurns?: number } = {}
): BundleRealized {
  const windowTurns = opts.windowTurns ?? DEFAULT_WINDOW_TURNS;
  const deliveredFiles = new Set(manifest.delivered_files);
  const deliveredKeys = new Set(manifest.delivered_entity_keys);
  const expandKeys = new Set(manifest.expand_keys);
  const deliveredItems = deliveredFiles.size + deliveredKeys.size;

  // Only same-session touches strictly after the bundle, inside the window.
  const window = touches.filter(
    (t) =>
      t.session_id === manifest.session_id &&
      t.ts > manifest.ts &&
      t.turn >= manifest.turn &&
      t.turn - manifest.turn <= windowTurns
  );

  // A delivered item the agent READ again = a wasted delivery (claw-back).
  const refetched = new Set<string>();
  // Items READ in-window — an edit preceded by a read is NOT a saved round-trip.
  const readItems = new Set<string>();
  for (const t of window) {
    if (t.kind !== "read") continue;
    if (t.file && deliveredFiles.has(t.file)) {
      refetched.add(`f:${t.file}`);
      readItems.add(`f:${t.file}`);
    }
    if (t.entity && deliveredKeys.has(t.entity)) {
      refetched.add(`e:${t.entity}`);
      readItems.add(`e:${t.entity}`);
    }
    if (t.entity && expandKeys.has(t.entity)) readItems.add(`x:${t.entity}`);
  }

  const bundle_hit_rate =
    deliveredItems === 0
      ? 1
      : (deliveredItems - refetched.size) / deliveredItems;

  // An EDIT of an item with no in-window read of that same item = the bundle's
  // inlined content was used directly → a confirmed avoided pre-edit read.
  const savedByEdit = new Set<string>();
  const usedExpand = new Set<string>();
  for (const t of window) {
    if (t.kind !== "edit") continue;
    if (t.file && deliveredFiles.has(t.file) && !readItems.has(`f:${t.file}`)) {
      savedByEdit.add(`f:${t.file}`);
    }
    if (
      t.entity &&
      deliveredKeys.has(t.entity) &&
      !readItems.has(`e:${t.entity}`)
    ) {
      savedByEdit.add(`e:${t.entity}`);
    }
    if (
      t.entity &&
      expandKeys.has(t.entity) &&
      !readItems.has(`x:${t.entity}`)
    ) {
      usedExpand.add(t.entity);
      savedByEdit.add(`x:${t.entity}`);
    }
  }

  const expand_precision =
    expandKeys.size === 0 ? null : usedExpand.size / expandKeys.size;

  // Never claim more than the Layer-A model said was on the table.
  const confirmed_round_trips_saved = Math.min(
    manifest.round_trips_modeled,
    savedByEdit.size
  );

  return {
    bundle_hit_rate,
    expand_precision,
    confirmed_round_trips_saved,
    refetched_items: refetched.size,
    delivered_items: deliveredItems,
  };
}

/** Aggregate realized metrics across many bundles (the global dashboard number). */
export interface BundleReconcileSummary {
  readonly bundles: number;
  /** Delivery-weighted hit rate (0..1); 1 when no deliveries were made. */
  readonly bundle_hit_rate: number;
  /** Mean expand precision across bundles that carried an expand ring; null if none did. */
  readonly expand_precision: number | null;
  readonly confirmed_round_trips_saved: number;
  readonly refetched_items: number;
  readonly delivered_items: number;
}

/**
 * Fold per-bundle realizations into one summary. Hit rate is weighted by
 * delivered items (a 1-item bundle does not outvote a 20-item one); expand
 * precision averages only over bundles that actually carried an expand ring.
 */
export function summarizeReconciliations(
  realized: readonly BundleRealized[]
): BundleReconcileSummary {
  let deliveredItems = 0;
  let refetchedItems = 0;
  let confirmed = 0;
  let expandSum = 0;
  let expandBundles = 0;
  for (const r of realized) {
    deliveredItems += r.delivered_items;
    refetchedItems += r.refetched_items;
    confirmed += r.confirmed_round_trips_saved;
    if (r.expand_precision !== null) {
      expandSum += r.expand_precision;
      expandBundles += 1;
    }
  }
  return {
    bundles: realized.length,
    bundle_hit_rate:
      deliveredItems === 0
        ? 1
        : (deliveredItems - refetchedItems) / deliveredItems,
    expand_precision: expandBundles === 0 ? null : expandSum / expandBundles,
    confirmed_round_trips_saved: confirmed,
    refetched_items: refetchedItems,
    delivered_items: deliveredItems,
  };
}

// ── Event → manifest/touch projection (the dashboard-route glue) ───────────
//
// Layer A persists each bundle as a `context_bundle` token_flow_event whose
// `detail` carries the manifest; the agent's later reads land as `file_read`
// token_flow_events (detail.file_path), and its caller-aware edits land as
// `cascade_guard` / `caller_check_enforced` behavior_events (entity_key). This
// section projects those already-read rows into the BundleManifest + CodeTouch
// shapes `reconcileBundle` consumes — pure (no DB, no clock), so the route does
// only the two table reads and the dashboard test drives synthetic arrays.

/**
 * Behavior-event types that mark a caller-aware EDIT of a specific entity — the
 * signal that the agent acted on inlined content. Both fire pre-edit on the
 * entity being changed and carry it in `entity_key`.
 */
export const EDIT_SIGNAL_TYPES: ReadonlySet<BehaviorEventType> = new Set([
  "cascade_guard",
  "caller_check_enforced",
]);

/** ISO → epoch ms; NaN (malformed/missing) collapses to 0 so it sorts before any real bundle. */
function tsMs(iso: string): number {
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
}

/** True when a string names a file (path separator or a known source extension) rather than an entity key. */
function isPathLike(s: string): boolean {
  return (
    s.includes("/") ||
    /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|md|json|yaml|yml|toml)$/.test(s)
  );
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/**
 * Project the `context_bundle` token_flow_events into manifests paired with the
 * Layer-A modeled tokens each one claimed (`tokens_saved`). Non-bundle
 * mechanisms are ignored.
 */
export function bundleManifestsFromEvents(
  tokenFlow: readonly TokenFlowEvent[]
): Array<{ manifest: BundleManifest; modeled_tokens_saved: number }> {
  const out: Array<{ manifest: BundleManifest; modeled_tokens_saved: number }> =
    [];
  for (const ev of tokenFlow) {
    if (ev.mechanism !== "context_bundle") continue;
    const d = ev.detail ?? {};
    out.push({
      manifest: {
        session_id: ev.session_id,
        turn: ev.turn,
        ts: tsMs(ev.ts),
        delivered_entity_keys: asStringArray(d.delivered_entity_keys),
        delivered_files: asStringArray(d.delivered_files),
        expand_keys: asStringArray(d.expand_keys),
        round_trips_modeled:
          typeof d.round_trips_modeled === "number" ? d.round_trips_modeled : 0,
      },
      modeled_tokens_saved: ev.tokens_saved,
    });
  }
  return out;
}

/**
 * Project later code-touches from both event streams: `file_read` token-flow
 * rows → read touches (claw-back candidates), edit-signal behavior rows → edit
 * touches (confirmed-saved candidates).
 */
export function codeTouchesFromEvents(
  tokenFlow: readonly TokenFlowEvent[],
  behavior: readonly BehaviorEvent[]
): CodeTouch[] {
  const touches: CodeTouch[] = [];
  for (const ev of tokenFlow) {
    if (ev.mechanism !== "file_read") continue;
    const file = (ev.detail?.file_path as string | undefined) ?? null;
    touches.push({
      session_id: ev.session_id,
      ts: tsMs(ev.ts),
      turn: ev.turn,
      file,
      entity: null,
      kind: "read",
    });
  }
  for (const ev of behavior) {
    if (!EDIT_SIGNAL_TYPES.has(ev.type)) continue;
    const key = ev.entity_key;
    const file = key && isPathLike(key) ? key : null;
    const entity = key && !isPathLike(key) ? key : null;
    touches.push({
      session_id: ev.session_id,
      ts: tsMs(ev.ts),
      turn: ev.turn,
      file,
      entity,
      kind: "edit",
    });
  }
  return touches;
}

/**
 * Realized bundle savings across every `context_bundle` event — the credible
 * number the dashboard shows next to the Layer-A modeled origin. Realized tokens
 * scale each bundle's modeled `tokens_saved` by the fraction of its modeled
 * round-trips Layer B confirmed (0 when none were modeled).
 */
export interface BundleSavingsReport {
  /** Number of bundles reconciled (the `context_bundle` event count). */
  readonly bundles: number;
  /** Σ Layer-A modeled tokens saved (the emit-time upper bound). */
  readonly modeled_tokens_saved: number;
  /** Σ realized tokens saved (modeled × confirmed/modeled round-trips per bundle). */
  readonly realized_tokens_saved: number;
  /** realized / modeled (0..1); 0 when nothing was modeled. */
  readonly realization_ratio: number;
  /** The folded per-bundle reconciliation (hit rate, expand precision, …). */
  readonly summary: BundleReconcileSummary;
}

/**
 * Reconcile every modeled bundle against the touches that followed it and fold
 * the result into the dashboard report. Pure over already-read event arrays.
 */
export function reconcileBundleSavings(
  tokenFlow: readonly TokenFlowEvent[],
  behavior: readonly BehaviorEvent[],
  opts: { windowTurns?: number } = {}
): BundleSavingsReport {
  const manifests = bundleManifestsFromEvents(tokenFlow);
  const touches = codeTouchesFromEvents(tokenFlow, behavior);

  const realized: BundleRealized[] = [];
  let modeledTokens = 0;
  let realizedTokens = 0;
  for (const { manifest, modeled_tokens_saved } of manifests) {
    const r = reconcileBundle(manifest, touches, opts);
    realized.push(r);
    modeledTokens += modeled_tokens_saved;
    if (manifest.round_trips_modeled > 0) {
      realizedTokens +=
        modeled_tokens_saved *
        (r.confirmed_round_trips_saved / manifest.round_trips_modeled);
    }
  }

  return {
    bundles: manifests.length,
    modeled_tokens_saved: modeledTokens,
    realized_tokens_saved: Math.round(realizedTokens),
    realization_ratio: modeledTokens > 0 ? realizedTokens / modeledTokens : 0,
    summary: summarizeReconciliations(realized),
  };
}
