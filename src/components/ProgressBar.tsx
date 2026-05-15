/**
 * Sub-character Unicode progress bar.
 *
 * Uses 9 block elements for smooth fill: ' ▏▎▍▌▋▊▉█'
 * Used in health card, session summary, status displays.
 */

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "./Theme.js";

const BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

export interface ProgressBarProps {
  /** Value between 0 and 1 */
  value: number;
  /** Total width in characters */
  width?: number;
  /** Bar fill color */
  color?: string;
  /** Show percentage label */
  showLabel?: boolean;
}

export function ProgressBar({
  value,
  width = 20,
  color,
  showLabel = false,
}: ProgressBarProps): React.ReactElement {
  const t = useTheme();
  const clamped = Math.max(0, Math.min(1, value));
  const fillWidth = clamped * width;
  const fullBlocks = Math.floor(fillWidth);
  const partialIndex = Math.round(
    (fillWidth - fullBlocks) * (BLOCKS.length - 1)
  );
  const emptyBlocks = Math.max(
    0,
    width - fullBlocks - (partialIndex > 0 ? 1 : 0)
  );

  const bar =
    "█".repeat(fullBlocks) +
    (partialIndex > 0 ? (BLOCKS[partialIndex] ?? "") : "") +
    " ".repeat(emptyBlocks);

  const barColor = color ?? t.info;
  const pct = Math.round(clamped * 100);

  return (
    <Box>
      <Text color={barColor}>{bar}</Text>
      {showLabel && <Text color={t.dim}> {pct}%</Text>}
    </Box>
  );
}

/** Exported for testing */
export { BLOCKS };
