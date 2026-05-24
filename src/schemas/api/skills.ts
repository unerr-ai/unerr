/**
 * Zod schemas for the skill download & installation API.
 *
 * GET /api/cli/skills?ide={ide}&repoId={repoId}
 */

import { z } from "zod";

export const SkillSchema = z.object({
  /** Skill identifier (e.g. "unerr-atlas", "unerr-health") */
  name: z.string(),
  /** Human-readable description */
  description: z.string(),
  /** Skill content (Markdown) */
  content: z.string(),
  /** Skill version */
  version: z.string().optional(),
  /** Optional trigger phrases — emitted as `when_to_use:` frontmatter on Claude Code */
  whenToUse: z.string().optional(),
  /** Optional allow-list of tools — emitted as `allowed-tools:` frontmatter on Claude Code */
  allowedTools: z.string().optional(),
});

export type Skill = z.infer<typeof SkillSchema>;

export const SkillsResponseSchema = z.object({
  skills: z.array(SkillSchema),
});

export type SkillsResponse = z.infer<typeof SkillsResponseSchema>;
