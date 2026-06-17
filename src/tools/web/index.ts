/**
 * Web tools — fetch_url and friends.
 *
 * The fetch_url tool is registered the standard way: its schema lives in
 * `src/proxy/tool-definitions.ts` and its dispatch in QueryRouter's `fetch_url`
 * case, which calls `runFetchUrlRequest` (the single entry point for both the
 * single-page and bulk modes). There is no separate `Tool` object here — that
 * would be a second, unwired copy of the same surface.
 */

export {
  runFetchUrl,
  runFetchUrlBatch,
  runFetchUrlRequest,
} from "./fetch-url-protocol.js";
export type {
  FetchUrlArgs,
  FetchUrlBatchResult,
  FetchUrlBlocked,
  FetchUrlContext,
  FetchUrlHttpError,
  FetchUrlInvalidRequest,
  FetchUrlOk,
  FetchUrlResult,
} from "./fetch-url-protocol.js";
