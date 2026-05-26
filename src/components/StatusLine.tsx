/**
 * StatusLine — shows token usage and cost at the bottom of the screen.
 */

import { Box, Text } from "ink";
import React from "react";
import type { QueryResult } from "../core/query-engine.js";

interface StatusLineProps {
  usage: QueryResult["usage"];
}

export function StatusLine({ usage }: StatusLineProps) {
  return (
    <Box marginTop={0} marginBottom={1}>
      <Text color="gray" dimColor>
        tokens: {usage.inputTokens} in / {usage.outputTokens} out
      </Text>
    </Box>
  );
}
