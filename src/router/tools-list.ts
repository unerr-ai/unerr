/**
 * Dynamic tools/list response builder.
 *
 * Two modes based on client capability:
 *
 *   - Dynamic (listChanged: true):
 *     Only return tools that are currently exposed (unlocked).
 *     Locked tools are completely omitted — zero token overhead.
 *     When new tools unlock, NotificationEmitter sends list_changed.
 *
 *   - Static (listChanged: false):
 *     Return ALL tools, but locked tools get a soft-refuse description
 *     that tells the agent how to unlock them. The agent sees the tool
 *     exists but gets a structured error if it tries to call it.
 *
 * Both modes include unerr's own tools (always visible, no prefix).
 * Both modes apply alias prefixing from the AliasRegistry.
 */

import type { AliasRegistry, AliasedTool } from "./aliasing.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ExposedToolSet {
  readonly tools: readonly ToolDefinition[];
  readonly totalAvailable: number;
  readonly totalExposed: number;
  readonly mode: "dynamic" | "static";
}

/**
 * Session-scoped set of exposed (unlocked) tools.
 * Monotonic: tools can only be added, never removed within a session.
 */
export class ExposureTracker {
  private readonly exposed = new Set<string>();

  /**
   * Mark a tool as exposed (unlocked).
   * Returns true if this is a new exposure (not previously exposed).
   */
  expose(prefixedName: string): boolean {
    if (this.exposed.has(prefixedName)) return false;
    this.exposed.add(prefixedName);
    return true;
  }

  /**
   * Expose multiple tools at once. Returns the list of newly exposed names.
   */
  exposeMany(names: readonly string[]): readonly string[] {
    const newlyExposed: string[] = [];
    for (const name of names) {
      if (this.expose(name)) {
        newlyExposed.push(name);
      }
    }
    return newlyExposed;
  }

  isExposed(prefixedName: string): boolean {
    return this.exposed.has(prefixedName);
  }

  get size(): number {
    return this.exposed.size;
  }

  getAll(): ReadonlySet<string> {
    return this.exposed;
  }
}

/**
 * Build the tools/list response based on disclosure mode.
 */
export function buildToolsList(
  aliasRegistry: AliasRegistry,
  exposureTracker: ExposureTracker,
  unerrOwnTools: readonly ToolDefinition[],
  mode: "dynamic" | "static"
): ExposedToolSet {
  const allAliased = aliasRegistry.getAllTools();
  const totalAvailable = allAliased.length + unerrOwnTools.length;
  const tools: ToolDefinition[] = [];

  for (const ownTool of unerrOwnTools) {
    tools.push(ownTool);
  }

  if (mode === "dynamic") {
    for (const aliased of allAliased) {
      if (exposureTracker.isExposed(aliased.prefixedName)) {
        tools.push({
          name: aliased.prefixedName,
          description: aliased.description,
          inputSchema: aliased.inputSchema ?? {
            type: "object",
            properties: {},
          },
        });
      }
    }
  } else {
    for (const aliased of allAliased) {
      if (exposureTracker.isExposed(aliased.prefixedName)) {
        tools.push({
          name: aliased.prefixedName,
          description: aliased.description,
          inputSchema: aliased.inputSchema ?? {
            type: "object",
            properties: {},
          },
        });
      } else {
        tools.push({
          name: aliased.prefixedName,
          description: buildSoftRefuseDescription(aliased),
          inputSchema: aliased.inputSchema ?? {
            type: "object",
            properties: {},
          },
        });
      }
    }
  }

  return {
    tools,
    totalAvailable,
    totalExposed: tools.length,
    mode,
  };
}

function buildSoftRefuseDescription(tool: AliasedTool): string {
  return (
    `[locked] ${tool.description} — ` +
    `This tool is available but not yet unlocked for this session. ` +
    `Call it to receive unlock instructions.`
  );
}
