/**
 * Stderr rendering for Ink components.
 *
 * Critical: MCP JSON-RPC owns stdout. All Ink output goes to stderr.
 * This wrapper ensures no Ink component accidentally writes to stdout.
 */

import type { Instance } from "ink";
import { render } from "ink";
import type React from "react";

/**
 * Render an Ink element to stderr, keeping stdout clean for MCP JSON-RPC.
 */
export function renderToStderr(element: React.ReactElement): Instance {
  return render(element, { stdout: process.stderr, stdin: process.stdin });
}
