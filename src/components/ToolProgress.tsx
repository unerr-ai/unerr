/**
 * ToolProgress — shows active tool calls with status indicators.
 */

import { Box, Text } from "ink";
import React from "react";

interface ToolCall {
  name: string;
  status: "running" | "done";
}

interface ToolProgressProps {
  tools: ToolCall[];
}

export function ToolProgress({ tools }: ToolProgressProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {tools.map((tool) => (
        <Box key={`${tool.name}-${tool.status}`}>
          <Text color={tool.status === "running" ? "yellow" : "green"}>
            {tool.status === "running" ? "⟳ " : "✓ "}
          </Text>
          <Text color={tool.status === "running" ? "yellow" : "gray"}>
            {tool.name}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
