/**
 * Branded banner: unerr ▸ Code intelligence for AI agents
 *
 * Used in startup and setup displays. Renders to stderr via Ink.
 */

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "./Theme.js";

export function Banner(): React.ReactElement {
  const t = useTheme();
  return (
    <Box marginLeft={2}>
      <Text bold color={t.brand}>
        unerr
      </Text>
      <Text color={t.dim}> ▸ </Text>
      <Text color={t.dim}>Code intelligence for your AI agents</Text>
    </Box>
  );
}
