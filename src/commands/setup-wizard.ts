/**
 * Setup Wizard — first-run project initialization.
 *
 * Generates a repo ID, writes .unerr/config.json, installs skills.
 * All output goes to stderr (stdout is MCP-sacred).
 *
 * LLM configuration is disabled — unerr operates as an MCP proxy where
 * the calling agent (Claude Code, Cursor, etc.) provides the LLM.
 * The configure* functions are retained for future re-enablement.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { getRemoteUrl } from "../utils/git.js";

export type WizardResult =
  | { action: "setup"; repoId: string }
  | { action: "exit" };

/** @deprecated Use runSetup() directly. Kept for backward compat. */
export const promptLocalOrExit = runSetup;

/** @deprecated Use runSetup() directly. Kept for backward compat. */
export const enterLocalModeSetup = runSetup;

/**
 * First-run project setup. Generates repo ID, writes config, installs skills.
 */
export async function runSetup(cwd?: string): Promise<WizardResult> {
  const projectDir = cwd ?? process.cwd();

  clack.intro("unerr");
  clack.log.step("Project Setup");

  // Generate repo ID from git remote or cwd
  const repoId = await generateRepoId(projectDir);

  // Write config files
  const configDir = join(projectDir, ".unerr");
  mkdirSync(configDir, { recursive: true });

  const configPath = join(configDir, "config.json");
  const settingsPath = join(configDir, "settings.json");

  writeFileSync(configPath, `${JSON.stringify({ repoId }, null, 2)}\n`);

  // Write/merge settings.json
  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existingSettings = JSON.parse(
        readFileSync(settingsPath, "utf-8")
      ) as Record<string, unknown>;
    } catch {
      // Ignore parse errors
    }
  }
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ ...existingSettings }, null, 2)}\n`
  );

  // Install skills from bundled pack
  let skillCount = 0;
  let detectedIde = "unknown";
  try {
    const { detectIde } = await import("../utils/detect.js");
    const { resolveAndInstallSkills } = await import("../skills/resolver.js");
    const ide = await detectIde(projectDir);
    detectedIde = ide;
    const result = await resolveAndInstallSkills({ ide, cwd: projectDir });
    skillCount = result.installed.length;
    if (skillCount > 0) {
      clack.log.success(
        `🧠 ${skillCount} intelligence skills installed — your AI agent will now use graph tools before reading files`
      );
    }
  } catch {
    // Non-blocking — skills can self-heal on first boot
  }

  // Write MCP config for detected IDE only (project-level, never global)
  // Users add other agents manually via: unerr install <agent>
  let mcpConfigAction = "";
  try {
    const { writeMcpConfig } = await import("../config/mcp-config-writer.js");
    const mcpResult = writeMcpConfig(projectDir, detectedIde as any);
    if (mcpResult.action === "created") {
      mcpConfigAction = `MCP config written → ${mcpResult.path}`;
      clack.log.success(
        `🔌 MCP server registered for ${detectedIde} — AI agent will auto-connect to unerr intelligence`
      );
    } else if (mcpResult.action === "updated") {
      mcpConfigAction = `MCP config updated → ${mcpResult.path}`;
      clack.log.success(
        `🔌 MCP config updated for ${detectedIde} — unerr intelligence now wired in`
      );
    }
  } catch {
    // Non-blocking — MCP config can be written manually
  }

  // Summary
  const summaryLines = [
    `Mode:   MCP intelligence proxy (${detectedIde} detected)`,
    `Skills: ${skillCount} agent skills installed`,
  ];
  if (mcpConfigAction) {
    summaryLines.push(`MCP:    ${mcpConfigAction}`);
  }
  summaryLines.push("Config: .unerr/config.json");
  summaryLines.push("");
  summaryLines.push(
    "Your AI agent now has: blast radius, community detection,"
  );
  summaryLines.push("convention enforcement, and <5ms graph queries.");

  clack.note(summaryLines.join("\n"), "✅ Intelligence layer configured");
  clack.outro("🚀 Starting intelligence engine...");

  return { action: "setup", repoId };
}

// ── Internal Helpers ─────────────────────────────────────────

async function generateRepoId(cwd: string): Promise<string> {
  let repoIdentifier = cwd;
  const remote = await getRemoteUrl(cwd);
  if (remote) repoIdentifier = remote;
  return createHash("sha256").update(repoIdentifier).digest("hex").slice(0, 12);
}

// ── LLM Configuration (disabled, retained for future use) ────

type LlmProvider =
  | "ollama"
  | "openai-compatible"
  | "openai"
  | "anthropic"
  | "skip";

interface OllamaModel {
  name: string;
  size: string;
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}MB`;
  return `${bytes}B`;
}

async function fetchOllamaModels(baseUrl: string): Promise<OllamaModel[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      models?: Array<{ name: string; size: number }>;
    };
    if (!body.models || !Array.isArray(body.models)) return [];
    return body.models.map((m) => ({
      name: m.name,
      size: formatSize(m.size),
    }));
  } catch {
    return [];
  }
}

/** @internal Retained for future LLM config re-enablement. */
export async function configureOllama(): Promise<Record<
  string,
  unknown
> | null> {
  const defaultUrl = "http://localhost:11434";

  const spinner = clack.spinner();
  spinner.start("Checking for Ollama...");

  let ollamaReachable = false;
  let models: OllamaModel[] = [];
  try {
    const response = await fetch(`${defaultUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    ollamaReachable = response.ok;
    if (ollamaReachable) {
      models = await fetchOllamaModels(defaultUrl);
    }
  } catch {
    ollamaReachable = false;
  }

  if (ollamaReachable && models.length > 0) {
    spinner.stop("Ollama detected at localhost:11434");

    const embeddingModel = await clack.select({
      message: "Select embedding model",
      options: models.map((m) => ({
        value: m.name,
        label: m.name,
        hint: m.size,
      })),
    });

    if (clack.isCancel(embeddingModel)) {
      clack.cancel("Setup cancelled.");
      return null;
    }

    const chatModel = await clack.select({
      message: "Select chat model (for 'unerr chat' and enrichment)",
      options: models.map((m) => ({
        value: m.name,
        label: m.name,
        hint: m.size,
      })),
    });

    if (clack.isCancel(chatModel)) {
      clack.cancel("Setup cancelled.");
      return null;
    }

    return {
      provider: "ollama",
      baseUrl: defaultUrl,
      embeddingModel: embeddingModel as string,
      chatModel: chatModel as string,
    };
  }

  if (ollamaReachable) {
    spinner.stop("Ollama detected but no models found");
    clack.log.warn(
      "No models installed. Run: ollama pull nomic-embed-text && ollama pull llama3"
    );
  } else {
    spinner.stop("Ollama not running");
    clack.log.warn(
      "Install from ollama.com and start it, or enter a custom URL."
    );
  }

  const baseUrl = await clack.text({
    message: "Ollama URL",
    defaultValue: defaultUrl,
    placeholder: defaultUrl,
  });

  if (clack.isCancel(baseUrl)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  return {
    provider: "ollama",
    baseUrl: baseUrl || defaultUrl,
    embeddingModel: "nomic-embed-text",
    chatModel: "llama3",
  };
}

/** @internal Retained for future LLM config re-enablement. */
export async function configureOpenAICompatible(): Promise<Record<
  string,
  unknown
> | null> {
  const splitChoice = await clack.select({
    message: "Same provider for embedding and inference?",
    options: [
      {
        value: "same" as const,
        label: "Yes — same base URL for both",
        hint: "Single provider, different models",
      },
      {
        value: "split" as const,
        label: "No — different URLs/providers",
        hint: "E.g., Ollama embedding + Fireworks inference",
      },
    ],
  });

  if (clack.isCancel(splitChoice)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  if (splitChoice === "split") {
    return configureSplitEndpoints();
  }

  const baseUrl = await clack.text({
    message: "API base URL",
    placeholder: "http://localhost:1234/v1",
  });

  if (clack.isCancel(baseUrl)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  const apiKey = await clack.password({
    message: "API key (leave empty if none)",
  });
  if (clack.isCancel(apiKey)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  const embeddingModel = await clack.text({
    message: "Embedding model name",
    placeholder: "nomic-embed-text",
    defaultValue: "nomic-embed-text",
  });

  if (clack.isCancel(embeddingModel)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  const chatModel = await clack.text({
    message: "Chat/inference model name",
    placeholder: "llama3",
    defaultValue: "llama3",
  });

  if (clack.isCancel(chatModel)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  return {
    provider: "openai-compatible",
    baseUrl: baseUrl as string,
    ...(apiKey ? { apiKey: apiKey as string } : {}),
    embeddingModel: embeddingModel as string,
    chatModel: chatModel as string,
  };
}

async function configureSplitEndpoints(): Promise<Record<
  string,
  unknown
> | null> {
  clack.log.step("Embedding endpoint");

  const embBaseUrl = await clack.text({
    message: "Embedding API base URL",
    placeholder: "http://localhost:11434",
  });
  if (clack.isCancel(embBaseUrl)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  const embApiKey = await clack.password({
    message: "Embedding API key (leave empty if none)",
  });
  if (clack.isCancel(embApiKey)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  const embModel = await clack.text({
    message: "Embedding model name",
    placeholder: "nomic-embed-text",
    defaultValue: "nomic-embed-text",
  });
  if (clack.isCancel(embModel)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  clack.log.step("Inference (chat) endpoint");

  const infProvider = await clack.select({
    message: "Inference provider type",
    options: [
      {
        value: "openai-compatible" as const,
        label: "OpenAI-compatible",
        hint: "Fireworks, Together, vLLM, etc.",
      },
      {
        value: "anthropic-direct" as const,
        label: "Anthropic",
        hint: "Claude API",
      },
      { value: "ollama" as const, label: "Ollama", hint: "Local Ollama" },
    ],
  });
  if (clack.isCancel(infProvider)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  const infBaseUrl = await clack.text({
    message: "Inference API base URL",
    placeholder:
      infProvider === "anthropic-direct"
        ? "https://api.anthropic.com"
        : infProvider === "ollama"
          ? "http://localhost:11434"
          : "https://api.fireworks.ai/inference/v1",
  });
  if (clack.isCancel(infBaseUrl)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  const infApiKey = await clack.password({
    message: "Inference API key (leave empty if none)",
  });
  if (clack.isCancel(infApiKey)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  const infModel = await clack.text({
    message: "Chat/inference model name",
    placeholder: "llama3",
    defaultValue: "llama3",
  });
  if (clack.isCancel(infModel)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  return {
    provider: "openai-compatible",
    embedding: {
      provider: "openai-compatible",
      baseUrl: embBaseUrl as string,
      model: embModel as string,
      ...(embApiKey ? { apiKey: embApiKey as string } : {}),
    },
    inference: {
      provider: infProvider as string,
      baseUrl: infBaseUrl as string,
      model: infModel as string,
      ...(infApiKey ? { apiKey: infApiKey as string } : {}),
    },
  };
}

/** @internal Retained for future LLM config re-enablement. */
export async function configureOpenAI(): Promise<Record<
  string,
  unknown
> | null> {
  const apiKey = await clack.password({
    message: "OpenAI API key",
  });

  if (clack.isCancel(apiKey)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  const embeddingModel = await clack.select({
    message: "Embedding model",
    options: [
      {
        value: "text-embedding-3-small",
        label: "text-embedding-3-small",
        hint: "Fast, cheap",
      },
      {
        value: "text-embedding-3-large",
        label: "text-embedding-3-large",
        hint: "Best quality",
      },
    ],
  });

  if (clack.isCancel(embeddingModel)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  return {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: apiKey as string,
    embeddingModel: embeddingModel as string,
    chatModel: "gpt-4o",
  };
}

/** @internal Retained for future LLM config re-enablement. */
export async function configureAnthropic(): Promise<Record<
  string,
  unknown
> | null> {
  const apiKey = await clack.password({
    message: "Anthropic API key",
  });

  if (clack.isCancel(apiKey)) {
    clack.cancel("Setup cancelled.");
    return null;
  }

  clack.log.info(
    "Note: Anthropic has no embedding API. Semantic search will use text matching."
  );

  return {
    provider: "anthropic-direct",
    apiKey: apiKey as string,
    chatModel: "claude-sonnet-4-20250514",
  };
}
