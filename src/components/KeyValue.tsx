/**
 * Aligned key-value display: Label:  Value
 *
 * Label is dimmed, value is normal. Used in status, session summary.
 */

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "./Theme.js";

export interface KeyValueProps {
  label: string;
  value: string;
  labelWidth?: number;
  valueColor?: string;
}

export function KeyValue({
  label,
  value,
  labelWidth = 20,
  valueColor,
}: KeyValueProps): React.ReactElement {
  const t = useTheme();
  const padded = label.padEnd(labelWidth);

  return (
    <Box marginLeft={4}>
      <Text color={t.dim}>{padded}</Text>
      <Text color={valueColor}>{value}</Text>
    </Box>
  );
}
