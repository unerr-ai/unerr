/**
 * Unified Tool Interface — used by both the MCP server (serving tools to external agents)
 * and the local QueryEngine (tools the LLM calls during interactive sessions).
 *
 * This is the foundational abstraction that makes unerr's intelligence tools
 * available to both external agents (via MCP) and the built-in AI assistant.
 */

import type { z } from "zod";
import type { CozoGraphStore } from "../intelligence/local-graph.js";

// ── Tool Context ──────────────────────────────────────────────

/** Runtime context passed to every tool invocation. */
export interface ToolContext {
  /** Current working directory */
  cwd: string;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** unerr's code intelligence graph — the differentiator */
  graph?: CozoGraphStore;
}

// ── Tool Output ───────────────────────────────────────────────

/** Result returned by a tool execution. */
export interface ToolOutput {
  /** Tool result content — string for display, object for structured data */
  content: string | Record<string, unknown>;
  /** Whether the tool encountered an error */
  isError?: boolean;
  /** Optional metadata (latency, source, drift info, etc.) */
  metadata?: Record<string, unknown>;
}

// ── Tool Definition ───────────────────────────────────────────

/** Static definition of a tool (name, schema, capabilities). */
export interface ToolDefinition {
  /** Unique tool name (e.g., "get_function", "file_read", "bash") */
  name: string;
  /** Human-readable description for the LLM */
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: Record<string, unknown>;
  /** Whether this tool only reads state (no side effects) */
  isReadOnly: boolean;
  /** Whether this tool requires explicit user permission before execution */
  requiresPermission: boolean;
}

// ── Tool Interface ────────────────────────────────────────────

/** A tool that can be executed by the QueryEngine or served via MCP. */
export interface Tool extends ToolDefinition {
  /** Execute the tool with validated arguments. */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

// ── Tool Categories ───────────────────────────────────────────

/** Tool source category for routing and display. */
export type ToolCategory =
  | "intelligence" // unerr graph-backed tools (get_function, search_code, etc.)
  | "coding"; // File system + shell tools (file_read, file_edit, bash, grep, etc.)

/** Tool with category metadata for registry organization. */
export interface CategorizedTool extends Tool {
  category: ToolCategory;
}
