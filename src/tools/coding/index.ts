/**
 * Coding Tools — standard filesystem and shell tools for the AI assistant.
 */

export { bashTool } from "./bash.js";
export { fileEditTool } from "./file-edit.js";
export { fileOutlineTool } from "./file-outline.js";
export { fileReadTool } from "./file-read.js";
export { globTool } from "./glob-tool.js";
export { grepTool } from "./grep.js";

import type { Tool } from "../types.js";
import { bashTool } from "./bash.js";
import { fileEditTool } from "./file-edit.js";
import { fileOutlineTool } from "./file-outline.js";
import { fileReadTool } from "./file-read.js";
import { globTool } from "./glob-tool.js";
import { grepTool } from "./grep.js";

/** All coding tools in registration order. */
export const codingTools: Tool[] = [
  fileOutlineTool,
  fileReadTool,
  fileEditTool,
  bashTool,
  grepTool,
  globTool,
];
