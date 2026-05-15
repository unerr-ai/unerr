/**
 * 2-Tier Skill Resolution System
 *
 * Cascade order (additive, later tiers override same-named skills):
 *   Tier 1: Bundled skills (local-pack.ts — compiled into dist/)
 *   Tier 2: Local directory skills (.unerr/skills/*.md + ~/.unerr/skills/*.md)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Skill } from "../schemas/index.js";
import type { IdeType } from "../utils/detect.js";
import { BUNDLED_SKILLS, LOCAL_SKILLS } from "./local-pack.js";
import type { TriggerSpec } from "./local-pack.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ResolvedSkill extends Skill {
  /** Which tier provided this skill */
  source: "bundled" | "local";
  /** Trigger specification for IDE-specific formatting */
  trigger?: TriggerSpec;
}

export interface SkillResolutionResult {
  installed: string[];
  source: string;
  skills: ResolvedSkill[];
}

// ── IDE Skill Directory ────────────────────────────────────────────

function getSkillDir(
  ide: IdeType,
  cwd: string
): { dir: string; ext: string; dirPerSkill: boolean } {
  switch (ide) {
    case "claude-code":
      // Claude Code uses directory-per-skill: .claude/skills/{name}/SKILL.md
      return {
        dir: join(cwd, ".claude", "skills"),
        ext: ".md",
        dirPerSkill: true,
      };
    case "cursor":
      return {
        dir: join(cwd, ".cursor", "rules"),
        ext: ".mdc",
        dirPerSkill: false,
      };
    case "vscode":
      return {
        dir: join(cwd, ".github", "copilot"),
        ext: ".md",
        dirPerSkill: false,
      };
    case "windsurf":
      return {
        dir: join(cwd, ".windsurf", "skills"),
        ext: ".md",
        dirPerSkill: true,
      };
    case "zed":
      return {
        dir: join(cwd, ".zed", "rules"),
        ext: ".md",
        dirPerSkill: false,
      };
    case "gemini-cli":
      return {
        dir: join(cwd, ".gemini", "skills"),
        ext: ".md",
        dirPerSkill: true,
      };
    case "github-copilot-cli":
      return {
        dir: join(cwd, ".github", "skills"),
        ext: ".md",
        dirPerSkill: true,
      };
    case "antigravity":
      return {
        dir: join(cwd, ".agents", "skills"),
        ext: ".md",
        dirPerSkill: true,
      };
    default:
      return {
        dir: join(cwd, ".unerr", "skills"),
        ext: ".md",
        dirPerSkill: false,
      };
  }
}

function writeSkillFile(
  skill: ResolvedSkill,
  ide: IdeType,
  skillDir: string,
  ext: string,
  dirPerSkill: boolean
): string {
  mkdirSync(skillDir, { recursive: true });

  // Strip existing "unerr-" prefix to avoid double-prefixing (e.g., from Tier 2 local skills)
  const baseName = skill.name.replace(/^unerr-/, "");
  const skillName = `unerr-${baseName}`;

  let filePath: string;
  let content: string;

  if (dirPerSkill && ide === "windsurf") {
    const skillSubDir = join(skillDir, skillName);
    mkdirSync(skillSubDir, { recursive: true });
    filePath = join(skillSubDir, "SKILL.md");
    content = formatWindsurfSkillMd(skill);
  } else if (dirPerSkill && ide === "gemini-cli") {
    const skillSubDir = join(skillDir, skillName);
    mkdirSync(skillSubDir, { recursive: true });
    filePath = join(skillSubDir, "SKILL.md");
    content = formatGeminiSkill(skill);
  } else if (dirPerSkill && ide === "github-copilot-cli") {
    const skillSubDir = join(skillDir, skillName);
    mkdirSync(skillSubDir, { recursive: true });
    filePath = join(skillSubDir, "SKILL.md");
    content = formatCopilotSkill(skill);
  } else if (dirPerSkill && ide === "antigravity") {
    const skillSubDir = join(skillDir, skillName);
    mkdirSync(skillSubDir, { recursive: true });
    filePath = join(skillSubDir, "SKILL.md");
    content = formatAntigravitySkill(skill);
  } else if (dirPerSkill) {
    // Claude Code: .claude/skills/{skill-name}/SKILL.md
    const skillSubDir = join(skillDir, skillName);
    mkdirSync(skillSubDir, { recursive: true });
    filePath = join(skillSubDir, "SKILL.md");
    content = formatClaudeCodeSkill(skill);
  } else if (ide === "cursor" && ext === ".mdc") {
    filePath = join(skillDir, `${skillName}${ext}`);
    content = formatCursorSkill(skill);
  } else {
    filePath = join(skillDir, `${skillName}${ext}`);
    content = formatMarkdownSkill(skill);
  }

  writeFileSync(filePath, content);
  return filePath;
}

/** Claude Code SKILL.md format — directory-per-skill with proper frontmatter */
function formatClaudeCodeSkill(skill: ResolvedSkill): string {
  const trigger = skill.trigger;
  const triggerType = trigger?.type ?? "always";

  // Map unerr trigger types to Claude Code frontmatter fields
  let disableModelInvocation = false;
  let userInvocable = true;
  let paths: string[] | undefined;

  switch (triggerType) {
    case "always":
      // Claude loads automatically, user can also invoke
      break;
    case "auto":
      // Claude loads when working with matching files
      paths = trigger?.globs;
      break;
    case "agent-requested":
      // Only Claude invokes, not shown in / menu
      userInvocable = false;
      break;
    case "manual":
      // Only user can invoke via /skill-name
      disableModelInvocation = true;
      break;
  }

  // Build frontmatter
  let frontmatter = `description: "${skill.description}"`;
  if (disableModelInvocation) {
    frontmatter += "\ndisable-model-invocation: true";
  }
  if (!userInvocable) {
    frontmatter += "\nuser-invocable: false";
  }
  if (paths && paths.length > 0) {
    frontmatter += `\npaths: ${paths.join(", ")}`;
  }

  return `---
${frontmatter}
---

${skill.content}
`;
}

/** Cursor .mdc format with trigger-aware frontmatter */
function formatCursorSkill(skill: ResolvedSkill): string {
  const trigger = skill.trigger;
  const triggerType = trigger?.type ?? "always";

  // Map unerr trigger types to Cursor .mdc fields
  let alwaysApply: boolean;
  let globs: string[];

  switch (triggerType) {
    case "always":
      alwaysApply = true;
      globs = [];
      break;
    case "auto":
      // Auto-triggered skills should always apply in Cursor — Cursor's glob matching
      // is unreliable, and these skills contain critical behavioral instructions
      alwaysApply = true;
      globs = [];
      break;
    case "agent-requested":
      // Cursor: not alwaysApply, no globs → description-based activation
      alwaysApply = false;
      globs = [];
      break;
    case "manual":
      alwaysApply = false;
      globs = [];
      break;
    default:
      alwaysApply = true;
      globs = [];
  }

  const globLine = globs.length > 0 ? `\nglobs: ${JSON.stringify(globs)}` : "";

  return `---
unerr_skill_version: "${skill.version ?? "1.0.0"}"
description: "${skill.description}"${globLine}
alwaysApply: ${alwaysApply}
---

${skill.content}
`;
}

/** Standard markdown format for Claude Code, VS Code, Zed */
function formatMarkdownSkill(skill: ResolvedSkill): string {
  const trigger = skill.trigger;
  const triggerType = trigger?.type ?? "always";
  const globLine =
    trigger?.globs && trigger.globs.length > 0
      ? `\nglobs: ${JSON.stringify(trigger.globs)}`
      : "";

  return `---
description: "${skill.description}"
trigger: ${triggerType}${globLine}
version: "${skill.version ?? "1.0.0"}"
---

# ${skill.name}

${skill.content}
`;
}

/**
 * Format a skill for Windsurf.
 * Windsurf skills use folder-per-skill: .windsurf/skills/{name}/SKILL.md
 * with YAML frontmatter (name, description).
 */
function formatWindsurfSkillMd(skill: ResolvedSkill): string {
  return `---
name: ${skill.name}
description: ${skill.description}
---

${skill.content}
`;
}

/**
 * Format a skill for Gemini CLI.
 * Gemini CLI skills use folder-per-skill: .gemini/skills/{name}/SKILL.md
 * with YAML frontmatter (name, description).
 */
function formatGeminiSkill(skill: ResolvedSkill): string {
  return `---
name: ${skill.name}
description: ${skill.description}
---

${skill.content}
`;
}

/**
 * Format a skill for GitHub Copilot CLI.
 * Copilot skills use folder-per-skill: .github/skills/{name}/SKILL.md
 * with YAML frontmatter (name, description, allowed-tools).
 */
function formatCopilotSkill(skill: ResolvedSkill): string {
  return `---
name: ${skill.name}
description: ${skill.description}
---

${skill.content}
`;
}

/**
 * Format a skill for Google Antigravity.
 * Antigravity skills use folder-per-skill: .agents/skills/{name}/SKILL.md
 * with YAML frontmatter (name, description).
 */
function formatAntigravitySkill(skill: ResolvedSkill): string {
  const trigger = skill.trigger;
  const triggerType = trigger?.type ?? "always";
  let globs: string[] = [];
  if (trigger?.globs) {
    globs = trigger.globs;
  }

  let frontmatter = `---\nname: ${skill.name}\ndescription: ${skill.description}`;
  if (globs.length > 0) {
    frontmatter += `\nglobs:\n${globs.map((g) => `  - ${g}`).join("\n")}`;
  }
  if (triggerType === "manual") {
    frontmatter += "\nuser_invocable: true";
  }
  frontmatter += "\n---";

  return `${frontmatter}\n\n${skill.content}\n`;
}

// ── Tier 1: Bundled Skills ─────────────────────────────────────────

function loadBundledSkills(): ResolvedSkill[] {
  return LOCAL_SKILLS.map((s) => ({
    name: s.id,
    description: s.description,
    content: s.instructions,
    version: s.version,
    source: "bundled" as const,
    trigger: s.trigger,
  }));
}

// ── Tier 2: Local Directory Skills ─────────────────────────────────

/**
 * Parse optional YAML-like frontmatter from a .md skill file.
 * Supports: name, description, version in `---` delimited block.
 */
function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  content: string;
} {
  const meta: Record<string, string> = {};

  if (!raw.startsWith("---")) {
    return { meta, content: raw };
  }

  const endIdx = raw.indexOf("---", 3);
  if (endIdx === -1) {
    return { meta, content: raw };
  }

  const frontBlock = raw.slice(3, endIdx).trim();
  for (const line of frontBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && value) meta[key] = value;
  }

  const content = raw.slice(endIdx + 3).trim();
  return { meta, content };
}

/**
 * Scan a directory for .md skill files.
 * Returns skills with optional YAML frontmatter parsed.
 */
export function scanSkillDirectory(dir: string): ResolvedSkill[] {
  if (!existsSync(dir)) return [];

  const skills: ResolvedSkill[] = [];

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), "utf-8");
        const { meta, content } = parseFrontmatter(raw);

        const name = meta.name ?? file.replace(/\.md$/, "");
        skills.push({
          name,
          description: meta.description ?? `Local skill: ${name}`,
          content,
          version: meta.version,
          source: "local",
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory unreadable
  }

  return skills;
}

/**
 * Load Tier 2 skills from project (.unerr/skills/) and user (~/.unerr/skills/).
 * Project-level overrides user-level on same name.
 */
function loadLocalDirectorySkills(cwd: string): ResolvedSkill[] {
  const userDir = join(homedir(), ".unerr", "skills");
  const projectDir = join(cwd, ".unerr", "skills");

  const userSkills = scanSkillDirectory(userDir);
  const projectSkills = scanSkillDirectory(projectDir);

  // Project overrides user on same name
  const byName = new Map<string, ResolvedSkill>();
  for (const s of userSkills) byName.set(s.name, s);
  for (const s of projectSkills) byName.set(s.name, s);

  return Array.from(byName.values());
}

// ── Cascade Resolution ─────────────────────────────────────────────

/**
 * Resolve skills from Tier 1 (bundled) and Tier 2 (local directories),
 * then install them into the IDE skill directory.
 *
 * Tiers are ADDITIVE: Tier 1 → Tier 2 supplements/overrides.
 */
export async function resolveAndInstallSkills(opts: {
  ide: IdeType;
  cwd: string;
}): Promise<SkillResolutionResult> {
  const byName = new Map<string, ResolvedSkill>();

  // Tier 1: Bundled
  for (const s of loadBundledSkills()) byName.set(s.name, s);

  // Tier 2: Local directories
  for (const s of loadLocalDirectorySkills(opts.cwd)) byName.set(s.name, s);

  // Install resolved skills into IDE directory
  const skills = Array.from(byName.values());
  const { dir, ext, dirPerSkill } = getSkillDir(opts.ide, opts.cwd);
  const installed: string[] = [];

  for (const skill of skills) {
    try {
      writeSkillFile(skill, opts.ide, dir, ext, dirPerSkill);
      installed.push(skill.name);
    } catch {
      // Non-blocking: skip failed installs
    }
  }

  // Build source attribution string
  const sources = new Set(skills.map((s) => s.source));
  const source = Array.from(sources).join("+");

  return { installed, source, skills };
}

/**
 * Check if skills are present in the IDE directory.
 * If missing, run the full cascade silently.
 *
 * Called on every proxy boot for self-healing.
 * Returns the number of skills installed (0 = already present).
 */
export async function ensureSkillsPresent(opts: {
  ide: IdeType;
  cwd: string;
}): Promise<number> {
  const { dir, ext, dirPerSkill } = getSkillDir(opts.ide, opts.cwd);

  // Check if any unerr skills exist
  if (existsSync(dir)) {
    try {
      const entries = readdirSync(dir);
      let hasSkills: boolean;
      if (dirPerSkill) {
        // Claude Code: check for unerr-*/SKILL.md directories
        hasSkills = entries.some(
          (f) => f.startsWith("unerr-") && existsSync(join(dir, f, "SKILL.md"))
        );
      } else {
        hasSkills = entries.some(
          (f) => f.startsWith("unerr-") && f.endsWith(ext)
        );
      }
      if (hasSkills) return 0; // Skills present, nothing to do
    } catch {
      // Directory unreadable, reinstall
    }
  }

  // Skills missing — run cascade
  const result = await resolveAndInstallSkills(opts);
  return result.installed.length;
}

/**
 * List installed skills from the IDE directory with source detection.
 */
export function listInstalledSkills(
  ide: IdeType,
  cwd: string
): { name: string; path: string }[] {
  const { dir, ext, dirPerSkill } = getSkillDir(ide, cwd);

  if (!existsSync(dir)) return [];

  try {
    if (dirPerSkill) {
      // Claude Code: .claude/skills/unerr-{name}/SKILL.md
      return readdirSync(dir)
        .filter(
          (f) => f.startsWith("unerr-") && existsSync(join(dir, f, "SKILL.md"))
        )
        .map((f) => ({
          name: f.replace("unerr-", ""),
          path: join(dir, f, "SKILL.md"),
        }));
    }
    return readdirSync(dir)
      .filter((f) => f.startsWith("unerr-") && f.endsWith(ext))
      .map((f) => ({
        name: f.replace("unerr-", "").replace(ext, ""),
        path: join(dir, f),
      }));
  } catch {
    return [];
  }
}

/**
 * Remove all unerr-installed skills for an IDE.
 * Returns the number of skills removed.
 */
export function removeInstalledSkills(ide: IdeType, cwd: string): number {
  const skills = listInstalledSkills(ide, cwd);
  const { dirPerSkill } = getSkillDir(ide, cwd);
  let removed = 0;

  for (const skill of skills) {
    try {
      if (dirPerSkill) {
        // Claude Code: remove the entire unerr-{name}/ directory
        rmSync(dirname(skill.path), { recursive: true, force: true });
      } else {
        unlinkSync(skill.path);
      }
      removed++;
    } catch {
      // Non-blocking
    }
  }

  return removed;
}
