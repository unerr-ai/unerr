/**
 * Settings Manager — user-level and project-level configuration.
 *
 * Hierarchy (last wins):
 *   1. Defaults (hardcoded)
 *   2. User settings: ~/.unerr/settings.json
 *   3. Project settings: .unerr/settings.json
 *   4. Environment variables: ANTHROPIC_API_KEY, UNERR_MODEL, etc.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────

const LlmConfigSchema = z.object({
  provider: z
    .enum(["anthropic", "openai", "google", "ollama", "openai-compatible"])
    .default("anthropic"),
  model: z.string().default("claude-sonnet-4-20250514"),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const FetchUrlConfigSchema = z.object({
  playwright: z
    .object({
      enabled: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
      waitUntil: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .default("networkidle"),
    })
    .default(() => ({
      enabled: false,
      timeoutMs: 15_000,
      waitUntil: "networkidle" as const,
    })),
  /**
   * Accept-Language header sent on every fetch. English-first default
   * matches the agent's prompt language and avoids hosts that geo-redirect
   * to localised pages with worse extraction yield. Override to opt into a
   * different locale.
   */
  acceptLanguage: z.string().default("en-US,en;q=0.9"),
});

export type FetchUrlConfig = z.infer<typeof FetchUrlConfigSchema>;

/** Comment-handling config (`comments.*` keys). */
export const CommentsConfigSchema = z.object({
  /**
   * Sprint SC-E.2: elide comment prose from `file_read` explore windows to
   * save tokens (the code stays; comment-only lines collapse to a `…` marker,
   * line numbers preserved). Default OFF — gated on a fidelity benchmark over
   * the frozen corpus before it can default on, since removing comments can
   * cost the agent context.
   */
  elide: z.boolean().default(false),
});

export type CommentsConfig = z.infer<typeof CommentsConfigSchema>;

/**
 * Auth-surfacing config. Tier-3 OS notifications are best-effort and, per
 * .internal/archive/LOGIN_UX_STRATEGY.md §9 decision 4, fire only on the high-signal `revoked`
 * transition by default. `notifyGrace` opts into a notification on the softer
 * `degraded_free` transition too (off by default to avoid noise on offline
 * work). Overridable per machine via the `UNERR_NOTIFY_GRACE` env var.
 */
export const AuthConfigSchema = z.object({
  notifyGrace: z.boolean().default(false),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/**
 * Auto-update config (.internal/archive/AUTO_UPDATE_STRATEGY.md §9). `mode`: `auto` (detect +
 * auto-apply minor/patch + notify for major), `notify` (detect + notify only),
 * `off` (fully disabled). Default `auto` for friction-free minor/patch upgrades.
 * There is no env opt-out — change the mode here (or via the dashboard) to opt out.
 * `channel`: `stable` reads the `latest` dist-tag (default); `beta` reads the
 * `beta` dist-tag but also checks `latest` so a newer stable always supersedes.
 */
export const UpdateConfigSchema = z.object({
  mode: z.enum(["auto", "notify", "off"]).default("auto"),
  channel: z.enum(["stable", "beta"]).default("stable"),
});

export type UpdateConfig = z.infer<typeof UpdateConfigSchema>;

export const SettingsSchema = z.object({
  /** Default Claude model for interactive sessions */
  model: z.string().default("claude-sonnet-4-20250514"),
  /** Anthropic API key (prefer env var ANTHROPIC_API_KEY) */
  anthropicApiKey: z.string().optional(),
  /** Permission mode for tool execution */
  permissionMode: z.enum(["prompt", "auto", "deny-all"]).default("prompt"),
  /** Maximum output tokens per LLM turn */
  maxTokens: z.number().default(8192),
  /** Enable verbose logging */
  verbose: z.boolean().default(false),
  /** AI SDK LLM configuration (Sprint D — unified multi-provider) */
  llm: LlmConfigSchema.optional(),
  /** Comment-handling config (file_read comment elision) */
  comments: CommentsConfigSchema.default(() => ({
    elide: false,
  })),
  /** fetch_url runtime config (Playwright SPA fallback, etc.) */
  fetchUrl: FetchUrlConfigSchema.default(() => ({
    playwright: {
      enabled: false,
      timeoutMs: 15_000,
      waitUntil: "networkidle" as const,
    },
    acceptLanguage: "en-US,en;q=0.9",
  })),
  /** Auth-surfacing config (Tier-3 OS notifications). */
  auth: AuthConfigSchema.default(() => ({ notifyGrace: false })),
  /** Auto-update policy (auto | notify | off) and release channel (stable | beta). */
  update: UpdateConfigSchema.default(() => ({
    mode: "auto" as const,
    channel: "stable" as const,
  })),
});

export type Settings = z.infer<typeof SettingsSchema>;

// ── Defaults ──────────────────────────────────────────────────

const DEFAULTS: Settings = SettingsSchema.parse({});

// ── Loader ────────────────────────────────────────────────────

function loadJsonFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Load merged settings from all layers.
 */
export function loadSettings(cwd?: string): Settings {
  const projectDir = cwd ?? process.cwd();

  // Layer 2: User settings
  const userSettings = loadJsonFile(join(homedir(), ".unerr", "settings.json"));

  // Layer 3: Project settings
  const projectSettings = loadJsonFile(
    join(projectDir, ".unerr", "settings.json")
  );

  // Layer 4: Environment overrides
  const envOverrides: Record<string, unknown> = {};
  if (process.env.ANTHROPIC_API_KEY)
    envOverrides.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.UNERR_MODEL) envOverrides.model = process.env.UNERR_MODEL;
  if (process.env.UNERR_VERBOSE === "true") envOverrides.verbose = true;

  // AI SDK LLM env overrides (Sprint D)
  if (process.env.UNERR_LLM_PROVIDER) {
    envOverrides.llm = {
      provider: process.env.UNERR_LLM_PROVIDER,
      ...(process.env.UNERR_MODEL && { model: process.env.UNERR_MODEL }),
      ...(process.env.UNERR_LLM_API_KEY && {
        apiKey: process.env.UNERR_LLM_API_KEY,
      }),
      ...(process.env.UNERR_LLM_BASE_URL && {
        baseUrl: process.env.UNERR_LLM_BASE_URL,
      }),
    };
  }

  // Merge: defaults ← user ← project ← env
  const merged = {
    ...DEFAULTS,
    ...userSettings,
    ...projectSettings,
    ...envOverrides,
  };

  return SettingsSchema.parse(merged);
}
