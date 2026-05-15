/**
 * Section divider: ── Title ─────────────
 *
 * Used to separate visual sections in all displays.
 */

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "./Theme.js";

export interface SectionProps {
  title: string;
  width?: number;
}

export function Section({
  title,
  width = 50,
}: SectionProps): React.ReactElement {
  const t = useTheme();
  const prefix = "── ";
  const suffix = " ";
  const remaining = Math.max(
    0,
    width - prefix.length - title.length - suffix.length
  );
  const line = "─".repeat(remaining);

  return (
    <Box marginLeft={2}>
      <Text color={t.dim}>
        {prefix}
        {title}
        {suffix}
        {line}
      </Text>
    </Box>
  );
}
