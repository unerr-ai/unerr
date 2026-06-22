/**
 * unerr cloud — the per-repo drainer registry.
 *
 * One place that assembles every stream drainer for a repo. The daemon
 * scheduler (`src/daemon/push-reporter.ts`) calls {@link assembleDrainers} once
 * per repo per tick; `drainRepo` then runs each returned drainer. Rev-3 collapses
 * the old per-type drainers into a single unified {@link buildIngestDrainers}:
 * every producer now stamps a contract-shaped event into the repo's
 * `.unerr/events/` store, so one drainer per segment forwards those events
 * verbatim to `POST /api/v1/cli/ingest` — no per-type row→detail mapping.
 *
 * // @sem domain=cloud role=drainer
 */

import { computeMachineFingerprint } from "../machine-fingerprint.js";
import type { BuildDrainers, DrainerSet } from "../push-drainer.js";
import { buildIngestDrainers } from "./ingest.js";

/**
 * Build the drainer set for one repo — one unified drainer per segment file in
 * `.unerr/events/`. A build failure (a missing or corrupt store) yields an empty
 * set rather than sinking the repo's drain. The daemon scheduler runs each
 * returned drainer through `drainRepo`.
 *
 * // @sem domain=cloud role=drainer
 */
export const assembleDrainers: BuildDrainers = async (ctx) => {
  try {
    // Machine-global: stamp the salted machine fingerprint onto every row at
    // drain (the machine analogue of repo/branch/commit), so each stream is
    // self-attributing to a machine even under a shared token. Memoized, so the
    // per-tick call is free after the first.
    return await buildIngestDrainers({
      ...ctx,
      machineFingerprint: ctx.machineFingerprint ?? computeMachineFingerprint(),
    });
  } catch (err) {
    ctx.log?.(
      `push: ingest drainer build failed: ${err instanceof Error ? err.message : String(err)}`
    );
    const empty: DrainerSet = { drainers: [] };
    return empty;
  }
};
