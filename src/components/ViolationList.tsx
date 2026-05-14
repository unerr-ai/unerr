/**
 * Rule violation list with severity indicators.
 *
 * Used in post-flight checks and pre-commit displays.
 */

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "./Theme.js";

export type ViolationSeverity = "error" | "warning" | "info";

export interface Violation {
  message: string;
  severity: ViolationSeverity;
  file?: string;
  suggestion?: string;
}

export interface ViolationListProps {
  violations: Violation[];
  title?: string;
}

const SEVERITY_ICONS: Record<ViolationSeverity, string> = {
  error: "✗",
  warning: "⚠",
  info: "ℹ",
};

export function ViolationList({
  violations,
  title,
}: ViolationListProps): React.ReactElement {
  const t = useTheme();

  if (violations.length === 0) {
    return (
      <Box marginLeft={4}>
        <Text color={t.success}>✓ No violations</Text>
      </Box>
    );
  }

  const severityColor = (s: ViolationSeverity): string =>
    ({ error: t.error, warning: t.warning, info: t.info })[s];

  return (
    <Box flexDirection="column">
      {title && (
        <Box marginLeft={2}>
          <Text bold>
            {violations.length} violation{violations.length !== 1 ? "s" : ""}
          </Text>
        </Box>
      )}
      {violations.map((v) => (
        <Box
          key={`${v.severity}-${v.message}`}
          flexDirection="column"
          marginLeft={4}
        >
          <Box>
            <Text color={severityColor(v.severity)}>
              {SEVERITY_ICONS[v.severity]}
            </Text>
            <Text> {v.message}</Text>
            {v.file && <Text color={t.dim}> ({v.file})</Text>}
          </Box>
          {v.suggestion && (
            <Box marginLeft={2}>
              <Text color={t.dim}>→ {v.suggestion}</Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
