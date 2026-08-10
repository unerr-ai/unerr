/**
 * Work-mode MCP server — stdio, graph-free.
 *
 * Mirrors the transport setup the per-repo proxy uses (`src/proxy/proxy.ts`
 * step 7: dynamic-import the SDK, one `Server`, `tools/list` served from a
 * frozen catalog, `tools/call` through a single dispatcher, `StdioServerTransport`)
 * and strips everything that needed a repository:
 *
 *   no graph database    no PID lock          no process manager
 *   no file watchers     no branch poller     no drift tracker
 *   no shadow ledger     no session resume    no behaviors
 *
 * What is left is the three capabilities that never needed the graph: web
 * fetching, shell output compression, and plain file work.
 *
 * stdout carries MCP JSON-RPC and nothing else. Every log line goes to stderr
 * through `startupLog`. The file-log sink is deliberately NOT initialised —
 * `initFileLog` would create a `.unerr/logs` directory in the host's folder at
 * startup, and work mode creates nothing on disk until a tool asks it to.
 */

import { startupLog } from "../utils/startup-log.js";
import { UNERR_VERSION } from "../version.js";
import {
  MAX_WORK_TOOLS,
  WORK_CATALOG_SHA256,
  WORK_TOOL_DEFINITIONS,
  type WorkToolName,
  isWorkToolName,
} from "./catalog.js";
import { type WorkState, resolveWorkState } from "./state.js";
import { withWorkFetchSignal } from "./steering.js";
import { runWorkFetchUrl } from "./tools/fetch.js";
import { runWorkFileEdit, runWorkFileRead } from "./tools/file-ops.js";
import { runWorkFindFiles } from "./tools/find-files.js";
import { runWorkCommand } from "./tools/run-command.js";

export interface WorkServerOptions {
  /** Working folder. Defaults to the process cwd. */
  readonly root?: string;
}

export interface WorkServerHandle {
  readonly state: WorkState;
  close(): Promise<void>;
}

type ToolArgs = Record<string, unknown>;

/** Route one tool call to its implementation. Throws only on an unknown name. */
async function dispatch(
  name: WorkToolName,
  args: ToolArgs,
  state: WorkState
): Promise<string> {
  switch (name) {
    case "fetch_url":
      return await runWorkFetchUrl(args, { cwd: state.workRoot });
    case "file_read":
      return runWorkFileRead(args, { workRoot: state.workRoot });
    case "file_edit":
      return runWorkFileEdit(args, { workRoot: state.workRoot });
    case "find_files":
      return runWorkFindFiles(args, { workRoot: state.workRoot });
    case "run_command":
      return await runWorkCommand(args, state);
  }
}

/**
 * Start the work-mode MCP server on stdio and resolve once it is serving.
 */
export async function startWorkServer(
  options: WorkServerOptions = {}
): Promise<WorkServerHandle> {
  const state = resolveWorkState({ root: options.root });

  // Dynamic imports, matching the proxy: the SDK is only paid for by a process
  // that actually serves MCP.
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const server = new Server(
    { name: "unerr-work", version: UNERR_VERSION },
    { capabilities: { tools: {} } }
  );

  // The catalog is a frozen constant, so this answer is byte-identical on every
  // call. A tools/list that changes bytes mid-session re-bills the whole cached
  // prefix — see the note at the top of `catalog.ts`.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...WORK_TOOL_DEFINITIONS],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    // The SDK types the handler against its own inferred request shape; the two
    // fields work mode reads are declared here and the cast is confined to the
    // registration call, exactly as the proxy's stdio handler does it.
    (async (request: {
      params?: { name?: unknown; arguments?: unknown };
    }) => {
      const name = String(request.params?.name ?? "");
      const args = (request.params?.arguments ?? {}) as ToolArgs;

      if (!isWorkToolName(name)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${name} is not a work-mode tool. Call one of: ${WORK_TOOL_DEFINITIONS.map((t) => t.name).join(", ")}.`,
            },
          ],
          isError: true,
        };
      }

      try {
        const body = await dispatch(name, args, state);
        // Task 4c: name the fetch_url call whenever a response surfaced a URL
        // the agent has not fetched yet.
        return {
          content: [
            { type: "text" as const, text: withWorkFetchSignal(body, name) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        startupLog.warn(`work tool ${name} failed: ${message}`);
        return {
          content: [
            { type: "text" as const, text: `${name} failed: ${message}` },
          ],
          isError: true,
        };
      }
    }) as never
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  startupLog.done(
    `unerr work — ${MAX_WORK_TOOLS} tools (catalog ${WORK_CATALOG_SHA256}), no graph`
  );
  startupLog.detail(`folder ${state.workRoot}`);
  startupLog.detail(`state  ${state.stateDir} (${state.stateSource}, lazy)`);

  return {
    state,
    async close() {
      await server.close();
    },
  };
}
