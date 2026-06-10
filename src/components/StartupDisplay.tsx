/**
 * StartupDisplay — Three-Act proxy startup renderer.
 *
 * Act 1: Instant Competence (brand + fast checks ≤2s)
 * Act 2: Revelation (Health Shock card after graph load)
 * Act 3: Invitation (agent suggestion + deep link)
 *
 * Driven by StartupState — proxy updates state, component re-renders.
 */

import { Box, Text } from "ink";
import type React from "react";
import type { HealthGradeResult } from "../intelligence/health-grade.js";
import { Banner } from "./Banner.js";
import { HealthCard } from "./HealthCard.js";
import { Section } from "./Section.js";
import { StepLine } from "./StepLine.js";
import type { StepStatus } from "./StepLine.js";
import { useTheme } from "./Theme.js";

export interface StartupStep {
  label: string;
  value?: string;
  status: StepStatus;
}

/** Local Mode indexing statistics for Act 1 display. */
export interface LocalIndexStats {
  fileCount: number;
  entityCount: number;
  edgeCount: number;
  indexingTimeMs: number;
  communityCount: number;
  conventionCount: number;
  ruleCount: number;
}

export interface StartupState {
  steps: StartupStep[];
  health?: HealthGradeResult;
  firstBoot: boolean;
  deepLink?: string;
  invitationEntity?: string;
  proxyMode?: string;
  ready: boolean;
  /** When true, renders the Local Mode variant of all three acts. */
  localMode: boolean;
  /** Local Mode indexing stats for Act 1. */
  localIndexStats?: LocalIndexStats;
  /** Total tools ready (for Local Mode Act 3). */
  toolCount?: number;
}

export function StartupDisplay({
  state,
}: { state: StartupState }): React.ReactElement {
  const t = useTheme();

  return (
    <Box flexDirection="column">
      {/* ACT 1: Instant Competence */}
      <Banner />
      <Box flexDirection="column">
        {state.steps.map((step) => (
          <StepLine
            key={step.label}
            label={step.label}
            value={step.value}
            status={step.status}
          />
        ))}
      </Box>

      {/* ACT 2: Revelation — Health Shock */}
      {state.health && (
        <Box flexDirection="column" marginTop={1}>
          {state.localMode ? (
            <>
              <Section title="Health (locally computed)" />
              <HealthCard health={state.health} compact />
            </>
          ) : (
            <>
              <Section title="First Look" />
              <HealthCard health={state.health} compact={!state.firstBoot} />
            </>
          )}
        </Box>
      )}

      {/* ACT 3: Invitation */}
      {state.ready && state.localMode && (
        <Box flexDirection="column" marginTop={1}>
          <Box marginLeft={2}>
            <Text color={t.success}>{state.toolCount ?? 0} tools ready</Text>
            <Text color={t.dim}> · fully local, offline-capable</Text>
          </Box>

          <Box marginLeft={2} marginTop={1} flexDirection="column">
            <Text color={t.dim}>Try asking your agent:</Text>
            <Box marginLeft={2}>
              <Text color={t.info}>
                {state.invitationEntity
                  ? `"What depends on ${state.invitationEntity}?"`
                  : `"Show me the highest-impact functions in this codebase" (use unerr MCP tools & skills for best results)`}
              </Text>
            </Box>
          </Box>
        </Box>
      )}

      {state.ready && !state.localMode && (
        <Box flexDirection="column" marginTop={1}>
          {state.invitationEntity && (
            <Box marginLeft={2} flexDirection="column">
              <Text color={t.dim}>
                Your agent can now see the blast radius. Try asking:
              </Text>
              <Box marginLeft={2}>
                <Text color={t.info}>
                  "What depends on {state.invitationEntity}?"
                </Text>
              </Box>
            </Box>
          )}

          <Box marginLeft={2} marginTop={1}>
            <Text>
              Proxy ready. Serving MCP on stdio.
              {state.proxyMode && state.proxyMode !== "full"
                ? ` (${state.proxyMode} mode)`
                : ""}
            </Text>
          </Box>

          {state.deepLink && (
            <Box marginLeft={2}>
              <Text color={t.dim}>Health details → {state.deepLink}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
