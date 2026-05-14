/**
 * Barrel export for shared Zod schemas.
 *
 * Local-first edition: only entity, edge, rule schemas and skill types.
 */

// ── Entity Schemas ─────────────────────────────────────────────────────

export {
  EntityDocSchema,
  type EntityDoc,
} from "./entities/entity.js";

export {
  EdgeDocSchema,
  type EdgeDoc,
} from "./entities/edge.js";

export {
  RuleDocSchema,
  type RuleDoc,
} from "./entities/rule.js";

// ── Skill Schema ──────────────────────────────────────────────────────

export {
  SkillSchema,
  SkillsResponseSchema,
  type Skill,
  type SkillsResponse,
} from "./api/skills.js";

// ── Common ─────────────────────────────────────────────────────────────

export {
  ErrorResponseSchema,
  type ErrorResponse,
} from "./common/errors.js";

export {
  HEADER_SESSION_ID,
  HEADER_INTENT_ID,
} from "./common/headers.js";
