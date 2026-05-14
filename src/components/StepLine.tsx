/**
 * Step status line: ✓ Label    Value
 *
 * Used in startup sequence and status displays.
 * Named StepLine to avoid conflict with existing StatusLine (REPL token display).
 */

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "./Theme.js";

export type StepStatus = "done" | "active" | "pending" | "error";

export interface StepLineProps {
  label: string;
  value?: string;
  status: StepStatus;
  labelWidth?: number;
}

const ICONS: Record<StepStatus, { char: string; colorKey: string }> = {
  done: { char: "✓", colorKey: "success" },
  active: { char: "●", colorKey: "info" },
  pending: { char: "○", colorKey: "dim" },
  error: { char: "✗", colorKey: "error" },
};

export function StepLine({
  label,
  value,
  status,
  labelWidth = 22,
}: StepLineProps): React.ReactElement {
  const t = useTheme();
  const icon = ICONS[status];
  const color = t[icon.colorKey as keyof typeof t] as string;
  const padded = label.padEnd(labelWidth);

  return (
    <Box marginLeft={2}>
      <Text color={color}>{icon.char}</Text>
      <Text> </Text>
      <Text color={status === "pending" ? t.dim : undefined}>{padded}</Text>
      {value && <Text>{value}</Text>}
    </Box>
  );
}
