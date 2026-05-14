/**
 * Health grade card — bordered box with grade, progress bar, and top issues.
 *
 * Used in startup (Act 2: Revelation), status, and first-connect displays.
 */

import { Box, Text } from "ink";
import type React from "react";
import type { HealthGradeResult } from "../intelligence/health-grade.js";
import { GradeBadge } from "./GradeBadge.js";
import { ProgressBar } from "./ProgressBar.js";
import { useTheme } from "./Theme.js";

export interface HealthCardProps {
  health: HealthGradeResult;
  /** Show compact single-line instead of full card */
  compact?: boolean;
}

export function HealthCard({
  health,
  compact = false,
}: HealthCardProps): React.ReactElement {
  const t = useTheme();
  const gradeColor = t.grade(health.grade);

  if (compact) {
    return (
      <Box marginLeft={2}>
        <GradeBadge grade={health.grade} score={health.score} />
        <Text> </Text>
        <ProgressBar value={health.score / 100} width={16} color={gradeColor} />
        <Text color={t.dim}>
          {" "}
          {health.totalEntities} entities · {health.totalEdges} edges
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text> </Text>
        <GradeBadge grade={health.grade} score={health.score} />
        <Text> </Text>
        <ProgressBar
          value={health.score / 100}
          width={20}
          color={gradeColor}
          showLabel
        />
      </Box>

      {health.deadFunctionCount > 0 && (
        <Box marginLeft={2}>
          <Text color={t.warning}>
            ⚡ {health.deadFunctionCount} dead function
            {health.deadFunctionCount !== 1 ? "s" : ""} — your agent reads these
            but nothing calls them
          </Text>
        </Box>
      )}

      {health.highRiskEntities.map((entity) => (
        <Box key={entity.name} marginLeft={2}>
          <Text color={t.warning}>
            ⚠ {entity.name} → {entity.fan_in} caller
            {entity.fan_in !== 1 ? "s" : ""}, {entity.fan_out} callee
            {entity.fan_out !== 1 ? "s" : ""} (chokepoint)
          </Text>
        </Box>
      ))}
    </Box>
  );
}
