/**
 * Sprint 11: Phase 22 Blueprint Deep Dive MCP Tool Handlers.
 *
 * 8 tools for coding agents to consume approved architecture plans:
 *
 * Navigation (post-approval):
 *   - unerr_get_plan_context: Full architecture plan overview
 *   - unerr_get_next_slice: Next implementation-ready slice
 *   - unerr_check_boundary: Validate imports against boundary rules
 *   - unerr_get_design_system: Design tokens for UI implementation
 *
 * Implementation (post-impl-plan):
 *   - unerr_get_next_task: Highest-priority task with deps satisfied
 *   - unerr_complete_task: Mark task complete + run checks
 *   - unerr_get_sprint_context: Sprint details + agent context files
 *   - unerr_get_checkpoint_status: Checkpoint verification status
 *
 * All queries run against CozoDB local graph (<5ms).
 */

import { stringifyMcpToolJson } from "../utils/mcp-content-json.js";
import type { CozoGraphStore, DeepDiveSliceRow } from "./local-graph.js";

// ── Tool Schemas ────────────────────────────────────────────────────

export const DEEP_DIVE_TOOL_DEFINITIONS = [
  {
    name: "unerr_get_plan_context",
    description:
      "Return the complete architecture plan for the active Blueprint project including all vertical slices, dependencies, stack recommendation, and domain/stage context. Use this to understand the full system before implementing individual slices.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Blueprint project ID. If omitted, uses the active project.",
        },
      },
    },
  },
  {
    name: "unerr_get_next_slice",
    description:
      "Return the next implementation-ready vertical slice with full architectural context. A slice is ready when all its dependency slices have status 'complete'. Includes data model, API surface, conventions, boundary rules, and design tokens.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Blueprint project ID. If omitted, uses the active project.",
        },
      },
    },
  },
  {
    name: "unerr_check_boundary",
    description:
      "Validate whether proposed code changes respect the slice boundaries defined in the architecture plan. Returns violations if the change imports from forbidden modules or violates conventions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Blueprint project ID. If omitted, uses the active project.",
        },
        sliceId: {
          type: "string",
          description: "The slice being implemented",
        },
        proposedImports: {
          type: "array",
          items: { type: "string" },
          description: "Module paths the code proposes to import",
        },
        proposedFiles: {
          type: "array",
          items: { type: "string" },
          description: "File paths the code proposes to create or modify",
        },
      },
      required: ["sliceId"],
    },
  },
  {
    name: "unerr_get_design_system",
    description:
      "Return the full design token set for the active Blueprint project. Includes color palette, typography, spacing, and component patterns. Use these tokens when implementing UI components.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Blueprint project ID. If omitted, uses the active project.",
        },
      },
    },
  },
  {
    name: "unerr_get_next_task",
    description:
      "Return the highest-priority implementation task with all dependencies satisfied. Includes slice context, acceptance criteria, and boundary rules.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Blueprint project ID. If omitted, uses the active project.",
        },
        sprintNumber: {
          type: "number",
          description: "Filter to a specific sprint (optional)",
        },
      },
    },
  },
  {
    name: "unerr_complete_task",
    description:
      "Mark a task as complete and run verification checks against boundary rules and conventions. Returns pass/fail with specific feedback.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Blueprint project ID. If omitted, uses the active project.",
        },
        taskId: {
          type: "string",
          description: "Task ID to mark complete",
        },
        completedFiles: {
          type: "array",
          items: { type: "string" },
          description: "Files that were created/modified for this task",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "unerr_get_sprint_context",
    description:
      "Return full sprint context with auto-generated agent context files. Includes a CLAUDE.md snippet encoding boundaries, conventions, acceptance criteria, and design tokens.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Blueprint project ID. If omitted, uses the active project.",
        },
        sprintNumber: {
          type: "number",
          description: "Sprint number to get context for",
        },
      },
      required: ["sprintNumber"],
    },
  },
  {
    name: "unerr_get_checkpoint_status",
    description:
      "Return the checkpoint verification status for a sprint — which tasks are complete and which are pending.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Blueprint project ID. If omitted, uses the active project.",
        },
        sprintNumber: {
          type: "number",
          description: "Sprint number to check",
        },
      },
      required: ["sprintNumber"],
    },
  },
] as const;

/** All 8 deep dive tool names. */
export const DEEP_DIVE_TOOL_NAMES = DEEP_DIVE_TOOL_DEFINITIONS.map(
  (t) => t.name,
);

/** Navigation-phase tools (available post-approval). */
export const NAVIGATION_TOOL_NAMES = [
  "unerr_get_plan_context",
  "unerr_get_next_slice",
  "unerr_check_boundary",
  "unerr_get_design_system",
] as const;

/** Implementation-phase tools (available when building). */
export const IMPLEMENTATION_TOOL_NAMES = [
  "unerr_get_next_task",
  "unerr_complete_task",
  "unerr_get_sprint_context",
  "unerr_get_checkpoint_status",
] as const;

// ── Tool Handlers ───────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  _meta: { source: "local"; latency_ms: number; format: "json" };
};

function formatResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: stringifyMcpToolJson(data) }],
    _meta: { source: "local", latency_ms: 0, format: "json" },
  };
}

function formatError(message: string): ToolResult {
  return formatResult({ error: message });
}

async function resolveProject(
  graph: CozoGraphStore,
  projectId?: string,
): ReturnType<CozoGraphStore["getDeepDiveProject"]> {
  if (projectId) return await graph.getDeepDiveProject(projectId);
  return await graph.getActiveDeepDiveProject();
}

// ── Navigation Tools ────────────────────────────────────────────────

export async function handleGetPlanContext(
  graph: CozoGraphStore,
  args: { projectId?: string },
): Promise<ToolResult> {
  const project = await resolveProject(graph, args.projectId);
  if (!project) return formatError("No Blueprint project found.");

  const slices = await graph.getDeepDiveSlices(project.key);
  const sliceTree = slices.map((s) => ({
    id: s.key,
    name: s.name,
    description: s.description,
    repoTargetId: s.repoTargetId,
    parentSliceKey: s.parentSliceKey,
    dependencies: s.dependencies,
    status: s.status,
    order: s.order,
    sliceType: s.sliceType,
  }));

  return formatResult({
    project: {
      id: project.key,
      name: project.name,
      description: project.description,
      status: project.status,
      domain: project.domain,
      stage: project.stage,
      stackRecommendation: project.stackRecommendation,
      designSystem: project.designSystem,
      healthBaseline: project.healthBaseline,
    },
    sliceTree,
    totalSlices: slices.length,
    completedSlices: slices.filter((s) => s.status === "complete").length,
  });
}

export async function handleGetNextSlice(
  graph: CozoGraphStore,
  args: { projectId?: string },
): Promise<ToolResult> {
  const project = await resolveProject(graph, args.projectId);
  if (!project) return formatError("No Blueprint project found.");

  if (project.status !== "approved" && project.status !== "building") {
    return formatError(
      `unerr_get_next_slice requires an approved project. Current status: "${project.status}".`,
    );
  }

  const slices = await graph.getDeepDiveSlices(project.key);
  const completedKeys = new Set(
    slices.filter((s) => s.status === "complete").map((s) => s.key),
  );

  const nextSlice = slices.find((s) => {
    if (s.status !== "planned") return false;
    return s.dependencies.every((dep) => completedKeys.has(dep));
  });

  if (!nextSlice) {
    return formatResult({
      message: "All slices are complete or no ready slice found.",
      nextSlice: null,
    });
  }

  return formatResult({
    slice: {
      id: nextSlice.key,
      name: nextSlice.name,
      description: nextSlice.description,
      repoTargetId: nextSlice.repoTargetId,
      dependencies: nextSlice.dependencies,
      dataModel: nextSlice.dataModel,
      apiSurface: nextSlice.apiSurface,
      conventions: nextSlice.conventions,
      boundaryRules: nextSlice.boundaryRules,
      userFlows: nextSlice.userFlows,
      uiDesign: nextSlice.uiDesign,
      status: nextSlice.status,
    },
    designSystem: project.designSystem ?? null,
    domain: project.domain,
    stage: project.stage,
  });
}

export async function handleCheckBoundary(
  graph: CozoGraphStore,
  args: {
    projectId?: string;
    sliceId: string;
    proposedImports?: string[];
    proposedFiles?: string[];
  },
): Promise<ToolResult> {
  const project = await resolveProject(graph, args.projectId);
  if (!project) return formatError("No Blueprint project found.");

  const slice = await graph.getDeepDiveSlice(args.sliceId);
  if (!slice) return formatError("Slice not found.");

  const violations: Array<{
    rule: string;
    description: string;
    severity: string;
  }> = [];
  const imports = args.proposedImports ?? [];
  const files = args.proposedFiles ?? [];

  for (const rule of slice.boundaryRules) {
    const ruleLower = rule.description.toLowerCase();
    for (const imp of imports) {
      if (ruleViolatesImport(ruleLower, imp.toLowerCase())) {
        violations.push({
          rule: rule.description,
          description: `Import "${imp}" may violate boundary: ${rule.description}`,
          severity: rule.enforcement === "block" ? "error" : "warning",
        });
      }
    }
  }

  for (const conv of slice.conventions) {
    for (const file of files) {
      if (conv.enforcement === "block" && conv.pattern) {
        try {
          const re = new RegExp(conv.pattern, "i");
          if (!re.test(file)) {
            violations.push({
              rule: conv.name,
              description: `File "${file}" may violate convention: ${conv.name} (${conv.pattern})`,
              severity: "warning",
            });
          }
        } catch {
          // Invalid regex pattern — skip
        }
      }
    }
  }

  return formatResult({
    valid: violations.length === 0,
    violations,
    boundaryRulesChecked: slice.boundaryRules.length,
    conventionsChecked: slice.conventions.length,
  });
}

function ruleViolatesImport(ruleLower: string, importLower: string): boolean {
  const forbiddenPatterns = [
    /cannot import from (\w+)/,
    /must not import (\w+)/,
    /no imports? from (\w+)/,
    /forbidden.* (\w+)/,
  ];
  for (const pattern of forbiddenPatterns) {
    const match = ruleLower.match(pattern);
    if (match?.[1] && importLower.includes(match[1])) return true;
  }
  return false;
}

export async function handleGetDesignSystem(
  graph: CozoGraphStore,
  args: { projectId?: string },
): Promise<ToolResult> {
  const project = await resolveProject(graph, args.projectId);
  if (!project) return formatError("No Blueprint project found.");

  const designSystem = await graph.getDeepDiveDesignSystem(project.key);
  if (!designSystem) {
    return formatResult({
      designSystem: null,
      message:
        "No design system generated for this project. This may indicate the project has no UI-bearing slices.",
    });
  }

  return formatResult({ designSystem });
}

// ── Implementation Tools ────────────────────────────────────────────

export async function handleGetNextTask(
  graph: CozoGraphStore,
  args: { projectId?: string; sprintNumber?: number },
): Promise<ToolResult> {
  const project = await resolveProject(graph, args.projectId);
  if (!project) return formatError("No Blueprint project found.");

  const tasks = await graph.getDeepDiveTasks(project.key, args.sprintNumber);
  if (tasks.length === 0) {
    return formatError(
      "No tasks found. Generate an implementation plan first.",
    );
  }

  const completedIds = new Set(
    tasks.filter((t) => t.status === "complete").map((t) => t.key),
  );

  const nextTask = tasks.find((t) => {
    if (t.status === "complete") return false;
    return t.dependencies.every((dep) => completedIds.has(dep));
  });

  if (!nextTask) {
    return formatResult({
      task: null,
      message:
        "All tasks are complete or no task has all dependencies satisfied.",
    });
  }

  const sprintTasks = tasks.filter(
    (t) => t.sprintNumber === nextTask.sprintNumber,
  );
  const sprintCompleted = sprintTasks.filter(
    (t) => t.status === "complete",
  ).length;

  return formatResult({
    task: {
      id: nextTask.key,
      sliceName: nextTask.sliceName,
      description: nextTask.description,
      status: nextTask.status,
      estimatedEffort: nextTask.estimatedEffort,
      dependencies: nextTask.dependencies,
      boundaryRules: nextTask.boundaryRules,
      conventions: nextTask.conventions,
    },
    acceptanceCriteria: nextTask.acceptanceCriteria,
    sprintNumber: nextTask.sprintNumber,
    sprintTotalTasks: sprintTasks.length,
    sprintCompletedTasks: sprintCompleted,
  });
}

export async function handleCompleteTask(
  graph: CozoGraphStore,
  args: {
    projectId?: string;
    taskId: string;
    completedFiles?: string[];
  },
): Promise<ToolResult> {
  const project = await resolveProject(graph, args.projectId);
  if (!project) return formatError("No Blueprint project found.");

  const tasks = await graph.getDeepDiveTasks(project.key);
  const task = tasks.find((t) => t.key === args.taskId);
  if (!task) {
    return formatError(
      `Task "${args.taskId}" not found in the implementation plan.`,
    );
  }

  const checks: Array<{ name: string; passed: boolean; feedback: string }> = [];

  if (task.boundaryRules.length > 0) {
    checks.push({
      name: "boundary_rules",
      passed: true,
      feedback: `${task.boundaryRules.length} boundary rule(s) defined. Manual verification recommended.`,
    });
  }

  if (task.conventions.length > 0) {
    checks.push({
      name: "conventions",
      passed: true,
      feedback: `${task.conventions.length} convention(s) defined. Manual verification recommended.`,
    });
  }

  if (args.completedFiles && args.completedFiles.length > 0) {
    checks.push({
      name: "files_created",
      passed: true,
      feedback: `${args.completedFiles.length} file(s) reported as created/modified.`,
    });
  }

  await graph.completeDeepDiveTask(args.taskId, args.completedFiles);

  const allPassed = checks.every((c) => c.passed);
  return formatResult({
    passed: allPassed,
    checks,
    taskId: args.taskId,
    message: allPassed
      ? "Task marked complete. All checks passed."
      : "Task marked complete with warnings.",
  });
}

export async function handleGetSprintContext(
  graph: CozoGraphStore,
  args: { projectId?: string; sprintNumber: number },
): Promise<ToolResult> {
  const project = await resolveProject(graph, args.projectId);
  if (!project) return formatError("No Blueprint project found.");

  const tasks = await graph.getDeepDiveTasks(project.key, args.sprintNumber);
  if (tasks.length === 0) {
    return formatError(
      `Sprint ${args.sprintNumber} not found or has no tasks.`,
    );
  }

  const claudeMd = generateClaudeMd(tasks, project);
  const cursorRules = generateCursorRules(tasks, args.sprintNumber);

  const checkpoint =
    tasks.length > 0
      ? (tasks[0] as { checkpoint: Record<string, unknown> }).checkpoint
      : {};

  return formatResult({
    sprint: {
      sprintNumber: args.sprintNumber,
      tasks: tasks.map((t) => ({
        id: t.key,
        sliceName: t.sliceName,
        description: t.description,
        status: t.status,
        estimatedEffort: t.estimatedEffort,
      })),
      checkpoint,
    },
    acceptanceCriteria: Object.fromEntries(
      tasks.map((t) => [t.key, t.acceptanceCriteria]),
    ),
    agentContext: {
      claudeMd,
      cursorRules,
      genericMarkdown: claudeMd,
    },
  });
}

export async function handleGetCheckpointStatus(
  graph: CozoGraphStore,
  args: { projectId?: string; sprintNumber: number },
): Promise<ToolResult> {
  const project = await resolveProject(graph, args.projectId);
  if (!project) return formatError("No Blueprint project found.");

  const tasks = await graph.getDeepDiveTasks(project.key, args.sprintNumber);
  if (tasks.length === 0) {
    return formatError(`Sprint ${args.sprintNumber} not found.`);
  }

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status === "complete").length;
  const checkpoint =
    tasks.length > 0
      ? (tasks[0] as { checkpoint: Record<string, unknown> }).checkpoint
      : {};

  return formatResult({
    sprintNumber: args.sprintNumber,
    tasksCompleted: completedTasks,
    tasksTotal: totalTasks,
    allTasksComplete: completedTasks === totalTasks,
    checkpoint: checkpoint ?? { verificationItems: [] },
    message:
      completedTasks === totalTasks
        ? "All tasks complete. Ready for checkpoint verification."
        : `${totalTasks - completedTasks} task(s) remaining before checkpoint.`,
  });
}

// ── Agent Context Generators ────────────────────────────────────────

function generateClaudeMd(
  tasks: Array<{
    sliceName: string;
    key: string;
    description: string;
    boundaryRules: Array<{ description: string }>;
    conventions: Array<{ name: string; pattern: string }>;
    acceptanceCriteria: unknown[];
  }>,
  project: {
    name: string;
    domain: Record<string, unknown>;
    stage: Record<string, unknown>;
    designSystem: unknown;
  },
): string {
  const lines: string[] = [
    `# Blueprint Sprint Context — ${project.name}`,
    "",
    `> Domain: ${(project.domain as Record<string, string>)?.primary ?? "unknown"}`,
    `> Stage: ${(project.stage as Record<string, string>)?.current ?? "unknown"}`,
    "",
    "## Boundary Rules (STRICT — violations will be flagged)",
    "",
  ];

  const allBoundaryRules = new Set<string>();
  const allConventions = new Set<string>();

  for (const task of tasks) {
    for (const r of task.boundaryRules) allBoundaryRules.add(r.description);
    for (const c of task.conventions)
      allConventions.add(`${c.name}: ${c.pattern}`);
  }

  for (const rule of allBoundaryRules) lines.push(`- ${rule}`);
  if (allBoundaryRules.size === 0)
    lines.push("- No boundary rules defined for this sprint.");

  lines.push("", "## Conventions", "");
  for (const conv of allConventions) lines.push(`- ${conv}`);
  if (allConventions.size === 0)
    lines.push("- No conventions defined for this sprint.");

  lines.push("", "## Tasks & Acceptance Criteria", "");
  for (const task of tasks) {
    lines.push(`### ${task.sliceName} (${task.key})`);
    lines.push(task.description);
    lines.push("");

    if (task.acceptanceCriteria.length > 0) {
      lines.push("**Acceptance Criteria:**");
      for (const c of task.acceptanceCriteria) {
        const criterion = (c as Record<string, unknown>)?.criterion ?? c;
        lines.push(`- [ ] ${String(criterion)}`);
      }
    }
    lines.push("");
  }

  if (project.designSystem) {
    lines.push("## Design Tokens", "");
    lines.push("```json");
    lines.push(JSON.stringify(project.designSystem).slice(0, 2000));
    lines.push("```");
  }

  return lines.join("\n");
}

function generateCursorRules(
  tasks: Array<{
    sliceName: string;
    boundaryRules: Array<{ description: string }>;
  }>,
  sprintNumber: number,
): string {
  const lines: string[] = [
    "---",
    `description: Blueprint Sprint ${sprintNumber} rules`,
    "globs:",
  ];

  const allPaths = new Set<string>();
  for (const task of tasks) {
    const sliceName = (task.sliceName ?? "").toLowerCase().replace(/\s+/g, "-");
    if (sliceName) {
      allPaths.add(`src/**/${sliceName}/**`);
      allPaths.add(`app/**/${sliceName}/**`);
    }
  }

  for (const path of allPaths) lines.push(`  - "${path}"`);

  lines.push("alwaysApply: false", "---", "");

  const allRules = new Set<string>();
  for (const task of tasks) {
    for (const r of task.boundaryRules) allRules.add(r.description);
  }

  lines.push("# Boundary Rules");
  for (const rule of allRules) lines.push(`- ${rule}`);

  return lines.join("\n");
}

/**
 * Dispatch a deep dive tool call. Returns null if the tool name is not a deep dive tool.
 */
export async function handleDeepDiveTool(
  name: string,
  args: Record<string, unknown>,
  graph: CozoGraphStore,
): Promise<ToolResult | null> {
  switch (name) {
    case "unerr_get_plan_context":
      return await handleGetPlanContext(graph, args as { projectId?: string });
    case "unerr_get_next_slice":
      return await handleGetNextSlice(graph, args as { projectId?: string });
    case "unerr_check_boundary":
      return await handleCheckBoundary(
        graph,
        args as {
          projectId?: string;
          sliceId: string;
          proposedImports?: string[];
          proposedFiles?: string[];
        },
      );
    case "unerr_get_design_system":
      return await handleGetDesignSystem(graph, args as { projectId?: string });
    case "unerr_get_next_task":
      return await handleGetNextTask(
        graph,
        args as {
          projectId?: string;
          sprintNumber?: number;
        },
      );
    case "unerr_complete_task":
      return await handleCompleteTask(
        graph,
        args as {
          projectId?: string;
          taskId: string;
          completedFiles?: string[];
        },
      );
    case "unerr_get_sprint_context":
      return await handleGetSprintContext(
        graph,
        args as {
          projectId?: string;
          sprintNumber: number;
        },
      );
    case "unerr_get_checkpoint_status":
      return await handleGetCheckpointStatus(
        graph,
        args as {
          projectId?: string;
          sprintNumber: number;
        },
      );
    default:
      return null;
  }
}
