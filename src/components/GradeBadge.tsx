/**
 * Colored grade badge: A, B+, C, D, F
 *
 * Color mapped by theme.grade() — A=green, C=yellow, F=red.
 * Used in health card, status, first-connect displays.
 */

import { Text } from "ink";
import type React from "react";
import { useTheme } from "./Theme.js";

export interface GradeBadgeProps {
  grade: string;
  score?: number;
  bold?: boolean;
}

export function GradeBadge({
  grade,
  score,
  bold = true,
}: GradeBadgeProps): React.ReactElement {
  const t = useTheme();
  const color = t.grade(grade);
  const label = score !== undefined ? `${grade}  (${score}/100)` : grade;

  return (
    <Text bold={bold} color={color}>
      {label}
    </Text>
  );
}
