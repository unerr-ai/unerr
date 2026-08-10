/**
 * Work-mode `fetch_url` — a thin adapter over the existing implementation.
 *
 * The whole fetch stack (DOM extraction, markdown conversion, passage split,
 * relevance ranking, bulk mode, content-hash cache, anti-bot detection) already
 * lives in `src/tools/web/` and needs no graph: its only context argument is a
 * working directory. So work mode calls the same entry point code mode calls —
 * `runFetchUrlRequest`, which owns the `url` XOR `urls` decision — and does not
 * fork a second copy of any of it.
 */

import { runFetchUrlRequest } from "../../tools/web/index.js";

/**
 * Loose on purpose. `runFetchUrlRequest` owns the `url` XOR `urls` decision and
 * returns a typed correction body for a bad shape instead of throwing, so this
 * adapter must not pre-reject anything the shared entry point can explain
 * better.
 */
export type WorkFetchArgs = Record<string, unknown>;

/**
 * Run a single-page or bulk fetch and render the result as the response body.
 *
 * Validation failures come back as a typed body from `runFetchUrlRequest` (it
 * never throws for a bad request shape), so they are serialized like any other
 * result and the agent reads the correction inline.
 */
export async function runWorkFetchUrl(
  args: WorkFetchArgs,
  ctx: { readonly cwd: string }
): Promise<string> {
  const result = await runFetchUrlRequest(
    args as unknown as Parameters<typeof runFetchUrlRequest>[0],
    { cwd: ctx.cwd }
  );
  return JSON.stringify(result);
}
