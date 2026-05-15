/**
 * Context Assembler — builds the system prompt for the interactive assistant.
 *
 * This is unerr's key differentiator: the system prompt includes graph-powered
 * intelligence about the codebase — conventions, high-risk entities, business context,
 * architecture overview — that no other coding assistant can provide without manual
 * CLAUDE.md authoring.
 *
 * Context layers:
 *   1. Environment: OS, shell, Node version, git branch
 *   2. Project: package.json, README, file structure summary
 *   3. Intelligence: conventions, risk entities, community structure (from CozoDB graph)
 *   4. Memory: .unerr/memory.md or equivalent persistent context
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { basename, join } from "node:path";

import type { CozoGraphStore } from "../intelligence/local-graph.js";
import { getCurrentBranch } from "../utils/git.js";

// ── Types ─────────────────────────────────────────────────────

export interface AssembledContext {
  /** Full system prompt string ready for the LLM */
  systemPrompt: string;
  /** Individual context sections (for debugging/inspection) */
  sections: ContextSection[];
}

export interface ContextSection {
  name: string;
  content: string;
}

// ── Environment Context ───────────────────────────────────────

async function getEnvironmentContext(cwd: string): Promise<ContextSection> {
  const os = `${platform()} ${release()}`;
  const shell = process.env.SHELL ?? "unknown";
  const nodeVersion = process.version;
  const gitBranch = (await getCurrentBranch(cwd)) ?? "unknown";

  return {
    name: "Environment",
    content: [
      `OS: ${os}`,
      `Shell: ${shell}`,
      `Node: ${nodeVersion}`,
      `Working directory: ${cwd}`,
      `Git branch: ${gitBranch}`,
    ].join("\n"),
  };
}

// ── Project Context ───────────────────────────────────────────

function getProjectContext(cwd: string): ContextSection | null {
  const lines: string[] = [];

  // package.json
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      lines.push(
        `Project: ${pkg.name ?? basename(cwd)} v${pkg.version ?? "0.0.0"}`
      );
      if (pkg.description) lines.push(`Description: ${pkg.description}`);
      if (pkg.scripts)
        lines.push(`Scripts: ${Object.keys(pkg.scripts).join(", ")}`);
    } catch {
      // Malformed package.json
    }
  }

  // README presence
  for (const name of ["README.md", "readme.md", "README"]) {
    if (existsSync(join(cwd, name))) {
      lines.push(`README: ${name} exists`);
      break;
    }
  }

  return lines.length > 0
    ? { name: "Project", content: lines.join("\n") }
    : null;
}

// ── Graph Intelligence Context (the differentiator) ───────────

/**
 * Build intelligence context from the local CozoDB graph.
 *
 * TODO: Implement graph queries for:
 * - Top conventions and adherence rates (get_conventions)
 * - High-risk entities with blast radius (fan_in > threshold)
 * - Business context for key modules
 * - Community/feature structure
 */
async function getIntelligenceContext(
  _graph: CozoGraphStore
): Promise<ContextSection | null> {
  // TODO: Query the graph for conventions, risk entities, architecture overview
  // This is what makes unerr's assistant unique — the LLM starts with codebase knowledge
  return null;
}

// ── Assembly ──────────────────────────────────────────────────

export interface AssembleOptions {
  /** Current working directory */
  cwd: string;
  /** Local graph store (if available) */
  graph?: CozoGraphStore;
  /** Additional instructions to append */
  additionalInstructions?: string;
}

/**
 * Assemble the full system prompt from all context layers.
 */
export async function assembleContext(
  opts: AssembleOptions
): Promise<AssembledContext> {
  const sections: ContextSection[] = [];

  // Layer 1: Environment
  sections.push(await getEnvironmentContext(opts.cwd));

  // Layer 2: Project
  const project = getProjectContext(opts.cwd);
  if (project) sections.push(project);

  // Layer 3: Graph intelligence (unerr's moat)
  if (opts.graph) {
    const intelligence = await getIntelligenceContext(opts.graph);
    if (intelligence) sections.push(intelligence);
  }

  // Layer 4: Additional instructions
  if (opts.additionalInstructions) {
    sections.push({
      name: "Instructions",
      content: opts.additionalInstructions,
    });
  }

  const systemPrompt = sections
    .map((s) => `# ${s.name}\n${s.content}`)
    .join("\n\n---\n\n");

  return { systemPrompt, sections };
}
