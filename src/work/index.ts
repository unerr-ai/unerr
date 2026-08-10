/**
 * Work mode — the single facade for unerr's graph-free MCP server.
 *
 * Work mode exists for hosts that have no codebase at all: a document sandbox
 * with a folder, a shell, and a network. It keeps the three unerr capabilities
 * that never needed the call graph — web fetching, shell output compression,
 * and plain file work — and drops everything that did.
 *
 * ISOLATION RULE (load-bearing, a guard test enforces it):
 * nothing under `src/work/` may import from `src/intelligence/`,
 * `src/behaviors/`, or `src/tracking/`. That is what lets work mode run in a
 * sandbox with no graph database native module, no file watchers, and no process
 * manager. Reuse across the boundary goes the other way only: work mode calls
 * the existing graph-free implementations in `src/tools/web/`,
 * `src/tools/coding/edit-core.ts`, `src/proxy/output-compressor.ts`, and
 * `src/proxy/shell-tee.ts` rather than forking them.
 *
 * Entry point: `unerr work --mcp` (`src/commands/work.ts`).
 */

export {
  MAX_WORK_CATALOG_SERIALIZED_CHARS,
  MAX_WORK_TOOLS,
  WORK_CATALOG_JSON,
  WORK_CATALOG_SHA256,
  WORK_TOOL_DEFINITIONS,
  WORK_TOOL_NAMES,
  isWorkToolName,
} from "./catalog.js";
export type { WorkToolDefinition, WorkToolName } from "./catalog.js";
export { startWorkServer } from "./server.js";
export type { WorkServerHandle, WorkServerOptions } from "./server.js";
export {
  PLUGIN_DATA_ENV,
  WORK_STATE_DIRNAME,
  WORK_STATE_ENV,
  ensureWorkStateDir,
  resolveWorkState,
} from "./state.js";
export type { WorkState } from "./state.js";
export {
  buildWorkFetchSignal,
  resetWorkSteeringForTest,
  withWorkFetchSignal,
} from "./steering.js";
