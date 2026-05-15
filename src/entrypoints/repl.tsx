/**
 * REPL Entry Point — launches the interactive AI assistant.
 *
 * Wires together:
 * - Ink terminal UI (App component)
 * - QueryEngine (streaming + tool loop) via ChatProvider
 * - Coding tools (file read/write/edit, bash, grep, glob)
 * - Intelligence tools (graph queries, if local graph available)
 * - Context assembly (system prompt with project + graph intelligence)
 *
 * Supports two modes:
 * - Default: Anthropic SDK via AnthropicChatProvider
 * - Local (--local or mode=local): BYO-LLM via LocalChatProvider
 */

import { render } from "ink";
import React from "react";
import { App } from "../components/App.js";
import { loadSettings } from "../config/settings.js";
import { assembleContext } from "../core/context-assembly.js";
import type { ChatProvider } from "../core/local-chat-provider.js";
import { codingTools } from "../tools/coding/index.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";

export interface ReplOptions {
  /** Override model from CLI flag */
  model?: string;
  /** Whether to load the code intelligence graph */
  loadGraph?: boolean;
  /** Force local mode */
  local?: boolean;
}

export async function launchRepl(opts: ReplOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const settings = loadSettings(cwd);

  let chatProvider: ChatProvider | undefined;
  let apiKey: string | undefined;
  let model: string;

  if (settings.localLlm) {
    // BYO-LLM via LocalChatProvider
    if (!settings.localLlm) {
      console.error(
        "BYO-LLM not configured.\n" +
          "Add localLlm configuration to ~/.unerr/settings.json:\n" +
          '  { "localLlm": { "provider": "ollama", "chatModel": "llama3" } }'
      );
      process.exit(1);
    }

    const { LocalChatProvider } = await import(
      "../core/local-chat-provider.js"
    );
    chatProvider = new LocalChatProvider(settings.localLlm);
    model = opts.model ?? settings.localLlm.chatModel;

    // Seal the firewall in local mode chat
    const { addAllowedHost, seal } = await import(
      "../proxy/network-firewall.js"
    );
    const allowedUrls: string[] = [];
    if (settings.localLlm.baseUrl) {
      allowedUrls.push(settings.localLlm.baseUrl);
    }
    if (settings.localLlm.provider === "anthropic-direct") {
      addAllowedHost("api.anthropic.com");
    }
    seal(allowedUrls);
  } else {
    // Anthropic SDK (BYO API key)
    apiKey = settings.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error(
        "No Anthropic API key found.\n" +
          "Set ANTHROPIC_API_KEY environment variable or add it to ~/.unerr/settings.json"
      );
      process.exit(1);
    }
    model = opts.model ?? settings.model;
  }

  // Register tools
  const registry = new ToolRegistry();

  // 1. Register coding tools (always available)
  for (const tool of codingTools) {
    registry.register(tool, "coding");
  }

  // 2. Register intelligence tools (if graph available)
  let graphLoaded = false;
  if (opts.loadGraph !== false) {
    try {
      graphLoaded = await loadIntelligenceTools(registry, cwd);
    } catch {
      // Graph not available — continue without intelligence tools
    }
  }

  // Assemble system prompt
  const { systemPrompt } = await assembleContext({
    cwd,
    additionalInstructions: buildInstructions(graphLoaded, true),
  });

  const allTools = registry.all();
  const welcomeMsg = buildWelcomeMessage(
    graphLoaded,
    allTools.length,
    !!settings.localLlm,
    chatProvider?.providerName,
    model
  );

  // Launch Ink UI
  const { waitUntilExit } = render(
    <App
      apiKey={apiKey}
      chatProvider={chatProvider}
      model={model}
      systemPrompt={systemPrompt}
      tools={allTools}
      cwd={cwd}
      welcomeMessage={welcomeMsg}
    />
  );

  await waitUntilExit();
}

/**
 * Attempt to load intelligence tools from the local graph.
 * Returns true if successful.
 */
async function loadIntelligenceTools(
  registry: ToolRegistry,
  cwd: string
): Promise<boolean> {
  try {
    // Open persistent CozoDB (SQLite-backed at .unerr/graph.db)
    const { openPersistentDb, hasPersistedGraph } = await import(
      "../intelligence/persistent-db.js"
    );
    if (!hasPersistedGraph(cwd)) return false;

    const { CozoGraphStore } = await import("../intelligence/local-graph.js");
    const { QueryRouter } = await import("../intelligence/query-router.js");
    const { createIntelligenceTools } = await import(
      "../tools/intelligence/index.js"
    );

    const { db } = await openPersistentDb(cwd);
    const graph = await CozoGraphStore.create(db);

    // Create router — all tools are local
    const router = new QueryRouter(graph);

    // Register intelligence tools
    const intelligenceTools = createIntelligenceTools(router);
    for (const tool of intelligenceTools) {
      registry.register(tool, "intelligence");
    }

    return true;
  } catch {
    return false;
  }
}

function buildInstructions(graphLoaded: boolean, isLocal: boolean): string {
  const lines = [
    "You are unerr, an AI coding assistant with deep code intelligence.",
    "You help developers understand, navigate, and modify their codebase.",
    "",
    "Available capabilities:",
    "- Read, write, and edit files",
    "- Execute bash commands",
    "- Search files by name (glob) or content (grep)",
  ];

  if (graphLoaded) {
    lines.push(
      "- Query the code intelligence graph for function/class details, callers/callees, imports",
      "- Search code entities semantically",
      "- Check coding rules and conventions",
      "- Get business context for code entities",
      "- Understand blast radius via caller/callee analysis",
      "",
      "IMPORTANT: Use the intelligence tools (get_function, get_callers, search_code, etc.) to understand",
      "the codebase architecture BEFORE making changes. These tools provide pre-computed analysis",
      "that is faster and more accurate than reading files manually."
    );
  }

  if (isLocal) {
    lines.push(
      "",
      "MODE: Local-only (fully offline). All processing happens on this machine.",
      "No data is sent to external servers."
    );
  }

  lines.push("", "Commands: /exit, /clear, /cost");

  return lines.join("\n");
}

function buildWelcomeMessage(
  graphLoaded: boolean,
  toolCount: number,
  isLocal: boolean,
  providerName?: string,
  model?: string
): string {
  const parts = [`${toolCount} tools available.`];
  if (graphLoaded) {
    parts.push("Code intelligence graph loaded.");
  } else {
    parts.push(
      "No graph loaded — run 'unerr pull' to enable intelligence tools."
    );
  }
  if (isLocal && providerName) {
    parts.push(`Local mode: ${providerName} (${model}).`);
  }
  parts.push("Type /exit to quit, /clear to reset, /cost for usage.");
  return parts.join(" ");
}
