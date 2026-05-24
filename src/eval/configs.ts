/**
 * The two agent configs used by the smoke harness. Sprint D's live eval
 * may add configs C (instructed + surface 2/3 receipts) and D
 * (cross-session), but the smoke and ship-gate phases only need A and B.
 *
 * See ACTIVE_COGNITION_REASON_LAYER.md §18.2.
 */

import type { AgentConfig } from "./types.js";

export const CONFIG_A_NAIVE: AgentConfig = {
  id: "a-naive",
  label: "Naive baseline — agent with no unerr install",
  install_unerr: false,
  agent_cli: "noop",
};

export const CONFIG_B_INSTRUCTED: AgentConfig = {
  id: "b-instructed",
  label: "Instructed — agent with unerr install run for claude-code",
  install_unerr: true,
  agent_cli: "noop",
};

export const ALL_CONFIGS: readonly AgentConfig[] = [
  CONFIG_A_NAIVE,
  CONFIG_B_INSTRUCTED,
];

export function getConfig(id: string): AgentConfig {
  const match = ALL_CONFIGS.find((c) => c.id === id);
  if (!match) {
    throw new Error(
      `unknown config '${id}' — valid ids: ${ALL_CONFIGS.map((c) => c.id).join(", ")}`
    );
  }
  return match;
}
