/**
 * Animated spinner with status text.
 *
 * Named InkSpinner to avoid conflict with ora-based spinners.
 * Uses Ink's useEffect for frame animation.
 */

import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { useTheme } from "./Theme.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface InkSpinnerProps {
  label: string;
  /** Interval between frames in ms */
  interval?: number;
}

export function InkSpinner({
  label,
  interval = 80,
}: InkSpinnerProps): React.ReactElement {
  const t = useTheme();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, interval);
    return () => clearInterval(timer);
  }, [interval]);

  return (
    <Box marginLeft={2}>
      <Text color={t.info}>{SPINNER_FRAMES[frame]}</Text>
      <Text> {label}</Text>
    </Box>
  );
}
