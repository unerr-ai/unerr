/**
 * Web tools — fetch_url and friends.
 */

import type { Tool } from "../types.js";
import { fetchUrlTool } from "./fetch-url.js";

export { fetchUrlTool } from "./fetch-url.js";
export { runFetchUrl } from "./fetch-url-protocol.js";
export type {
  FetchUrlArgs,
  FetchUrlContext,
  FetchUrlResult,
} from "./fetch-url-protocol.js";

export const webTools: Tool[] = [fetchUrlTool];
