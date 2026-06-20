/**
 * unerr cloud — the per-repo drainer registry.
 *
 * One place that assembles every stream drainer for a repo. The daemon
 * scheduler (`src/daemon/push-reporter.ts`) calls {@link assembleDrainers} once
 * per repo per tick; `drainRepo` then runs each returned drainer. C1 registers
 * the ClickHouse ingest streams (events, transcripts, ledger, router); C2 the
 * relational sync streams (sessions, facts, timeline, state). Keeping the wiring
 * in one function means the scheduler never imports a stream module directly.
 */

import type {
  BuildDrainers,
  DrainerContext,
  DrainerSet,
  StreamDrainer,
} from "../push-drainer.js";
import { buildEventsDrainers } from "./events.js";
import { buildFactsDrainers } from "./facts.js";
import { buildLedgerDrainers } from "./ledger.js";
import { buildReviewDrainers } from "./review.js";
import { buildRouterDrainers } from "./router.js";
import { buildSessionsDrainers } from "./sessions.js";
import { buildStateDrainers } from "./state.js";
import { buildTimelineDrainers } from "./timeline.js";
import { buildTranscriptDrainers } from "./transcripts.js";

/** Every stream builder. Each opens its own store handle and returns drainers. */
const BUILDERS: Array<(ctx: DrainerContext) => Promise<DrainerSet>> = [
  // C1 — ClickHouse ingest streams.
  buildEventsDrainers,
  buildTranscriptDrainers,
  buildLedgerDrainers,
  buildRouterDrainers,
  // P9 — review findings stream (review_finding events).
  buildReviewDrainers,
  // C2 — relational sync streams.
  buildSessionsDrainers,
  buildFactsDrainers,
  buildTimelineDrainers,
  buildStateDrainers,
];

/**
 * Build the drainer set for one repo. Each stream module opens its own store
 * handle (a metrics.db read connection, a cozo read connection, a jsonl reader)
 * from `ctx.unerrDir` and returns its {@link StreamDrainer}s; `dispose` closes
 * every handle after the tick. A builder that throws (a missing or corrupt
 * store) is skipped — one bad stream never sinks the rest of the repo's drain.
 *
 * // @sem domain=cloud role=drainer
 */
export const assembleDrainers: BuildDrainers = async (ctx) => {
  const drainers: StreamDrainer[] = [];
  const disposers: Array<() => void | Promise<void>> = [];

  for (const build of BUILDERS) {
    try {
      const set = await build(ctx);
      drainers.push(...set.drainers);
      if (set.dispose) disposers.push(set.dispose);
    } catch (err) {
      ctx.log?.(
        `push: drainer build failed (${build.name}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const set: DrainerSet = { drainers };
  if (disposers.length > 0) {
    set.dispose = async () => {
      for (const d of disposers) await d();
    };
  }
  return set;
};
