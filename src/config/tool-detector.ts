/**
 * AI Tool Auto-Detection — detects installed AI coding tools in a project.
 *
 * Registry-driven: scans directory markers and environment variables
 * from agent-registry.ts to identify all AI tools present.
 *
 * Returns all detected tools so `unerr init` can configure each one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IdeType } from "../utils/detect.js";
import { AGENT_REGISTRY, type AgentDefinition } from "./agent-registry.js";

export interface DetectedTool {
  ide: IdeType;
  configDir: string;
  hasExistingConfig: boolean;
  agent: AgentDefinition;
}

/**
 * Detect all AI coding tools present in the project directory.
 * Checks directory markers and environment variables from the agent registry.
 */
export function detectTools(cwd: string): DetectedTool[] {
  const detected: DetectedTool[] = [];

  for (const agent of AGENT_REGISTRY) {
    // Check directory markers
    const hasDirMarker = agent.dirMarkers.some((dir) =>
      existsSync(join(cwd, dir))
    );

    // Check environment variables
    const hasEnvVar = agent.envVars.some((envVar) => !!process.env[envVar]);

    if (hasDirMarker || hasEnvVar) {
      const configPath = join(cwd, agent.projectConfigPath);
      detected.push({
        ide: agent.id,
        configDir: join(cwd, agent.dirMarkers[0] ?? ""),
        hasExistingConfig: existsSync(configPath),
        agent,
      });
    }
  }

  return detected;
}

/**
 * Get a human-readable summary of detected tools.
 */
export function formatDetectedTools(tools: DetectedTool[]): string {
  if (tools.length === 0) return "No AI tools detected";
  return tools.map((t) => t.agent.name).join(", ");
}
