/**
 * Drift summary — modified/added/deleted counts.
 *
 * Used in status and startup displays.
 */

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "./Theme.js";

export interface DriftCounts {
  modified: number;
  added: number;
  deleted: number;
}

export interface DriftSummaryProps {
  drift: DriftCounts;
}

export function DriftSummary({ drift }: DriftSummaryProps): React.ReactElement {
  const t = useTheme();
  const total = drift.modified + drift.added + drift.deleted;

  if (total === 0) {
    return (
      <Box marginLeft={4}>
        <Text color={t.dim}>No drift detected</Text>
      </Box>
    );
  }

  const parts: string[] = [];
  if (drift.modified > 0) parts.push(`${drift.modified} modified`);
  if (drift.added > 0) parts.push(`${drift.added} added`);
  if (drift.deleted > 0) parts.push(`${drift.deleted} deleted`);

  return (
    <Box marginLeft={4}>
      <Text color={t.warning}>
        {total} drifted entit{total !== 1 ? "ies" : "y"}: {parts.join(", ")}
      </Text>
    </Box>
  );
}
