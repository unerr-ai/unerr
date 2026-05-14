/**
 * CI / container detection — prevents daemon side-effects in ephemeral environments.
 *
 * Used by:
 *   - Auto-install gating (skip platform service installation)
 *   - Bridge auto-spawn (skip unerrd launch in CI)
 *   - Warm-start scheduler (skip boot-time warm-up)
 *
 * Detection covers all major CI providers + container runtimes.
 */

import { existsSync, readFileSync } from "node:fs";

let cachedResult: boolean | null = null;

/**
 * Returns true if running in a CI environment or container.
 * Result is cached for the process lifetime.
 */
export function isCI(): boolean {
  if (cachedResult !== null) return cachedResult;
  cachedResult = detect();
  return cachedResult;
}

/** Reset cache (for testing). */
export function resetCICache(): void {
  cachedResult = null;
}

function detect(): boolean {
  // Generic CI env (set by most providers)
  if (env("CI")) return true;
  if (env("CONTINUOUS_INTEGRATION")) return true;
  if (env("BUILD_NUMBER")) return true;

  // Major CI providers
  if (env("GITHUB_ACTIONS")) return true;
  if (env("GITLAB_CI")) return true;
  if (env("CIRCLECI")) return true;
  if (env("BUILDKITE")) return true;
  if (env("JENKINS_URL")) return true;
  if (env("TRAVIS")) return true;
  if (env("CODEBUILD_BUILD_ID")) return true;
  if (env("TF_BUILD")) return true;
  if (env("BITBUCKET_PIPELINE_UUID")) return true;
  if (env("DRONE")) return true;
  if (env("WOODPECKER_CI")) return true;
  if (env("TEAMCITY_VERSION")) return true;
  if (env("HEROKU_TEST_RUN_ID")) return true;

  // Container detection
  if (existsSync("/.dockerenv")) return true;

  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (
      cgroup.includes("docker") ||
      cgroup.includes("kubepods") ||
      cgroup.includes("containerd")
    ) {
      return true;
    }
  } catch {
    // Not on Linux or no permission — fine
  }

  return false;
}

function env(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}
