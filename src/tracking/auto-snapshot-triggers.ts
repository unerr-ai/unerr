/**
 * Auto-Snapshot Triggers — detects when to auto-create working snapshots.
 *
 * Three trigger types:
 *   1. test_pass: tool call result contains a test command + exit code 0
 *   2. session_end: graceful shutdown detected
 *   3. pre_critical_change: before modifying entity with fan_in above threshold
 *
 * Stateless per-call: each function evaluates the trigger condition independently
 * and returns a trigger descriptor or null.
 */

import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("auto-snapshot");

export interface AutoSnapshotTrigger {
  type: "test_pass" | "session_end" | "pre_critical_change";
  triggerTool?: string;
  entityKey?: string;
}

const TEST_COMMANDS = [
  "test",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "cargo test",
  "go test",
  "npm test",
  "pnpm test",
  "yarn test",
  "npx vitest",
  "npx jest",
  "pnpm run test",
  "npm run test",
  "pnpm exec vitest",
  "pnpm exec jest",
  "make test",
  "rake test",
  "rspec",
  "phpunit",
  "dotnet test",
  "mvn test",
  "gradle test",
];

const TEST_PATTERNS = [
  /\bvitest\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bnpm\s+(?:run\s+)?test\b/,
  /\bpnpm\s+(?:run\s+|exec\s+)?(?:vitest|jest|test)\b/,
  /\byarn\s+(?:run\s+)?test\b/,
  /\bnpx\s+(?:vitest|jest)\b/,
  /\brspec\b/,
  /\bphpunit\b/,
  /\bdotnet\s+test\b/,
  /\bmvn\s+test\b/,
  /\bgradle\s+test\b/,
  /\bmake\s+test\b/,
  /\brake\s+test\b/,
];

const DEFAULT_FAN_IN_THRESHOLD = 50;

/**
 * Determines if a string is a test command based on known patterns.
 */
export function isTestCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();

  for (const known of TEST_COMMANDS) {
    if (trimmed === known || trimmed.startsWith(`${known} `)) {
      return true;
    }
  }

  for (const pattern of TEST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  if (
    /\btest[_\-.]?(?:suite|run|all|unit|int|e2e|integration)\b/i.test(trimmed)
  ) {
    return true;
  }

  return false;
}

/**
 * Evaluates whether the given tool call + result should trigger an auto-snapshot.
 *
 * Returns a trigger descriptor if a snapshot should be taken, null otherwise.
 */
export function shouldAutoSnapshot(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  fanInThreshold?: number
): AutoSnapshotTrigger | null {
  const testTrigger = checkTestPass(toolName, args, result);
  if (testTrigger) return testTrigger;

  const criticalTrigger = checkPreCriticalChange(
    toolName,
    args,
    result,
    fanInThreshold ?? DEFAULT_FAN_IN_THRESHOLD
  );
  if (criticalTrigger) return criticalTrigger;

  return null;
}

/**
 * Creates a session-end trigger. Called during graceful shutdown.
 */
export function createSessionEndTrigger(): AutoSnapshotTrigger {
  return { type: "session_end" };
}

function checkTestPass(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown
): AutoSnapshotTrigger | null {
  const command = extractCommand(toolName, args);
  if (!command) return null;

  if (!isTestCommand(command)) return null;

  const exitCode = extractExitCode(result);
  if (exitCode !== 0) return null;

  log.info(`Test pass detected: ${command}`);
  return {
    type: "test_pass",
    triggerTool: toolName,
  };
}

function checkPreCriticalChange(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  threshold: number
): AutoSnapshotTrigger | null {
  const modifyTools = ["sync_local_diff", "unerr_revert_to_working_state"];

  if (!modifyTools.includes(toolName)) return null;

  const entityKey = extractTargetEntity(args);
  if (!entityKey) return null;

  const fanIn = extractFanIn(args, result);
  if (fanIn === null || fanIn < threshold) return null;

  log.info(
    `Pre-critical-change trigger: ${entityKey} (fan_in=${fanIn}, threshold=${threshold})`
  );
  return {
    type: "pre_critical_change",
    triggerTool: toolName,
    entityKey,
  };
}

function extractCommand(
  toolName: string,
  args: Record<string, unknown>
): string | null {
  if (typeof args.command === "string") return args.command;

  if (toolName === "run_terminal_command" || toolName === "execute_command") {
    if (typeof args.cmd === "string") return args.cmd;
    if (typeof args.shell_command === "string") return args.shell_command;
  }

  if (typeof args.script === "string") return args.script;

  return null;
}

function extractExitCode(result: unknown): number | null {
  if (result === null || result === undefined) return null;

  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;

    if (typeof obj.exitCode === "number") return obj.exitCode;
    if (typeof obj.exit_code === "number") return obj.exit_code;
    if (typeof obj.code === "number") return obj.code;

    if (typeof obj.content === "string") {
      return parseExitCodeFromText(obj.content);
    }

    if (Array.isArray(obj.content)) {
      for (const item of obj.content) {
        if (typeof item === "object" && item !== null) {
          const textItem = item as Record<string, unknown>;
          if (typeof textItem.text === "string") {
            const code = parseExitCodeFromText(textItem.text);
            if (code !== null) return code;
          }
        }
      }
    }
  }

  if (typeof result === "string") {
    return parseExitCodeFromText(result);
  }

  return null;
}

function parseExitCodeFromText(text: string): number | null {
  const passPatterns = [
    /all\s+(?:\d+\s+)?tests?\s+passed/i,
    /\d+\s+passing/i,
    /tests?\s+passed/i,
    /exit\s+code[:\s]+0/i,
    /exited\s+with\s+0/i,
    /✓\s+\d+\s+tests?/i,
    /Tests:\s+\d+\s+passed,\s+\d+\s+total/i,
  ];

  for (const pattern of passPatterns) {
    if (pattern.test(text)) return 0;
  }

  const failPatterns = [
    /\d+\s+failing/i,
    /tests?\s+failed/i,
    /exit\s+code[:\s]+([1-9]\d*)/i,
    /FAIL/,
  ];

  for (const pattern of failPatterns) {
    const match = pattern.exec(text);
    if (match) {
      if (match[1]) return Number.parseInt(match[1], 10);
      return 1;
    }
  }

  return null;
}

function extractTargetEntity(args: Record<string, unknown>): string | null {
  if (typeof args.entity_key === "string") return args.entity_key;
  if (typeof args.entityKey === "string") return args.entityKey;
  if (typeof args.file === "string") return args.file;
  if (typeof args.path === "string") return args.path;
  return null;
}

function extractFanIn(
  args: Record<string, unknown>,
  result: unknown
): number | null {
  if (typeof args.fan_in === "number") return args.fan_in;
  if (typeof args.fanIn === "number") return args.fanIn;

  if (result !== null && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.fan_in === "number") return obj.fan_in;
    if (typeof obj.fanIn === "number") return obj.fanIn;

    if (typeof obj.entity === "object" && obj.entity !== null) {
      const entity = obj.entity as Record<string, unknown>;
      if (typeof entity.fan_in === "number") return entity.fan_in;
      if (typeof entity.fanIn === "number") return entity.fanIn;
    }

    if (typeof obj.blast_radius === "object" && obj.blast_radius !== null) {
      const br = obj.blast_radius as Record<string, unknown>;
      if (typeof br.direct_callers === "number") return br.direct_callers;
    }
  }

  return null;
}
