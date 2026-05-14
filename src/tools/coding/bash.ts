/**
 * Bash Tool — execute shell commands.
 * Requires user permission for non-trivial commands. Streams output.
 */

import { exec } from "../../utils/exec.js";
import type { Tool, ToolContext, ToolOutput } from "../types.js";

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a bash command in the project directory. Returns stdout and stderr. " +
    "Use this for running tests, git commands, build scripts, and other shell operations. " +
    "Commands time out after 2 minutes.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds. Default: 120000 (2 minutes)",
      },
    },
    required: ["command"],
  },
  isReadOnly: false,
  requiresPermission: true,

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const command = args.command as string;
    const timeout = Math.min((args.timeout as number) ?? 120_000, 600_000);

    const result = await exec("bash", ["-c", command], {
      cwd: ctx.cwd,
      timeout,
    });

    if (result.exitCode === 0) {
      return { content: result.stdout || "(no output)" };
    }

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(result.stderr);
    if (parts.length === 0) parts.push("Command failed");

    return {
      content: `Exit code: ${result.exitCode}\n${parts.join("\n")}`,
      isError: true,
    };
  },
};
