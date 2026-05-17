/**
 * Tool Registry — central catalog of all available tools.
 *
 * Tools are registered by category (intelligence, coding) and can be
 * looked up by name. The registry provides the tool list for both the MCP
 * server and the QueryEngine's tool definitions sent to the LLM.
 */

import type {
  CategorizedTool,
  Tool,
  ToolCategory,
  ToolDefinition,
} from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, CategorizedTool>();

  /** Register a tool. Throws if a tool with the same name already exists. */
  register(tool: Tool, category: ToolCategory): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, { ...tool, category });
  }

  /** Look up a tool by name. Returns undefined if not found. */
  get(name: string): CategorizedTool | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tools. */
  all(): CategorizedTool[] {
    return [...this.tools.values()];
  }

  /** Get tools filtered by category. */
  byCategory(category: ToolCategory): CategorizedTool[] {
    return this.all().filter((t) => t.category === category);
  }

  /** Get tool definitions for LLM consumption (name, description, inputSchema). */
  definitions(): ToolDefinition[] {
    return this.all().map(
      ({ name, description, inputSchema, isReadOnly, requiresPermission }) => ({
        name,
        description,
        inputSchema,
        isReadOnly,
        requiresPermission,
      })
    );
  }
}
