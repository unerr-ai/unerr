/**
 * Query Engine — the LLM tool-call loop.
 *
 * Orchestrates: system prompt assembly → LLM streaming → tool execution → loop.
 * Decoupled from UI — emits events that any consumer (REPL, SDK, headless) can subscribe to.
 *
 * Supports both Anthropic SDK and BYO-LLM (local) via the ChatProvider interface.
 */

import type { Tool, ToolContext, ToolOutput } from "../tools/types.js";
import type {
  ChatMessage,
  ChatProvider,
  ChatResponse,
  ChatStreamChunk,
  ChatToolDef,
} from "./local-chat-provider.js";
import {
  AiSdkChatProvider,
  AnthropicChatProvider,
  toChatToolDefs,
} from "./local-chat-provider.js";

// ── Cost Table (per million tokens) ───────────────────────────

// ── Configuration ─────────────────────────────────────────────

export interface QueryEngineOptions {
  /** Model ID (e.g., "claude-sonnet-4-20250514", "gpt-4o") */
  model: string;
  /** API key — used when neither chatProvider nor languageModel is supplied */
  apiKey?: string;
  /** Chat provider — if supplied, apiKey and languageModel are ignored */
  chatProvider?: ChatProvider;
  /** AI SDK LanguageModel — if supplied, wraps in AiSdkChatProvider. Overrides apiKey. */
  languageModel?: unknown;
  /** Provider name hint for the AI SDK adapter (default: "ai-sdk") */
  providerName?: string;
  /** Available tools the LLM can call */
  tools: Tool[];
  /** Assembled system prompt (from ContextAssembler) */
  systemPrompt: string;
  /** Maximum output tokens per turn */
  maxTokens?: number;
  /** Tool execution context */
  toolContext: ToolContext;
}

// ── Events ────────────────────────────────────────────────────

export interface QueryEngineEvents {
  /** Streaming text token from the LLM */
  onToken?: (token: string) => void;
  /** LLM requested a tool call */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Tool execution completed */
  onToolResult?: (name: string, result: ToolOutput) => void;
  /** Full response complete */
  onDone?: (result: QueryResult) => void;
  /** Error occurred */
  onError?: (error: Error) => void;
}

// ── Result ────────────────────────────────────────────────────

export interface QueryResult {
  /** Final text response from the LLM */
  response: string;
  /** Tool calls made during this turn */
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: ToolOutput;
  }>;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ── Conversation Message Types ────────────────────────────────

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result: ToolOutput;
  }>;
}

export type ConversationMessage = UserMessage | AssistantMessage;

// ── Conversion Helpers ────────────────────────────────────────

/**
 * Convert our conversation messages to ChatMessage format.
 * Handles tool_use/tool_result pairs.
 */
function toChatMessages(messages: ConversationMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // Assistant message with tool calls
        const toolCallsFormatted = msg.toolCalls.map((tc) => ({
          id: `toolu_${Date.now()}_${tc.name}`,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        }));

        result.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: toolCallsFormatted,
        });

        // Add tool result messages
        for (let i = 0; i < msg.toolCalls.length; i++) {
          const tc = msg.toolCalls[i];
          if (!tc) continue;
          result.push({
            role: "tool",
            content:
              typeof tc.result.content === "string"
                ? tc.result.content
                : JSON.stringify(tc.result.content),
            tool_call_id: toolCallsFormatted[i]?.id,
          });
        }
      } else {
        result.push({ role: "assistant", content: msg.content });
      }
    }
  }

  return result;
}

// ── Engine ────────────────────────────────────────────────────

/**
 * Resolve the ChatProvider from options.
 * Priority: chatProvider > languageModel > apiKey (Anthropic fallback).
 */
function resolveProvider(options: QueryEngineOptions): ChatProvider {
  if (options.chatProvider) {
    return options.chatProvider;
  }
  if (options.languageModel) {
    return new AiSdkChatProvider(
      options.languageModel,
      options.providerName ?? "ai-sdk",
      options.model
    );
  }
  if (!options.apiKey) {
    throw new Error(
      "QueryEngine requires one of: chatProvider, languageModel, or apiKey"
    );
  }
  return new AnthropicChatProvider(options.apiKey, options.model);
}

/**
 * Execute a single query turn: send messages to the LLM, handle tool calls, return result.
 *
 * The loop:
 * 1. Send conversation + system prompt + tool defs to LLM (streaming)
 * 2. Accumulate text tokens, emit onToken events
 * 3. When the LLM requests tool calls, execute each tool
 * 4. Feed tool results back as a new turn, loop to step 1
 * 5. When the LLM produces no more tool calls, return the full result
 */
export async function executeQuery(
  messages: ConversationMessage[],
  options: QueryEngineOptions,
  events?: QueryEngineEvents
): Promise<QueryResult> {
  const provider = resolveProvider(options);
  const chatToolDefs = toChatToolDefs(options.tools);
  const toolMap = new Map(options.tools.map((t) => [t.name, t]));

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const allToolCalls: QueryResult["toolCalls"] = [];

  const workingMessages = toChatMessages(messages);
  let finalResponse = "";

  // Tool-call loop — keep going until the LLM produces no tool calls
  while (true) {
    const response = await provider.streamChat(
      workingMessages,
      chatToolDefs,
      options.systemPrompt,
      options.maxTokens ?? 8192,
      (chunk) => {
        if (chunk.type === "text_delta" && chunk.text) {
          events?.onToken?.(chunk.text);
        }
      }
    );

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    // If no tool calls, we're done
    if (response.toolCalls.length === 0) {
      finalResponse = response.text;
      break;
    }

    // Execute tool calls
    const toolCallMessages: ChatMessage[] = [];

    // Add assistant message with tool calls
    workingMessages.push({
      role: "assistant",
      content: response.text || "",
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        },
      })),
    });

    for (const toolCall of response.toolCalls) {
      const tool = toolMap.get(toolCall.name);
      events?.onToolCall?.(toolCall.name, toolCall.args);

      let result: ToolOutput;
      if (!tool) {
        result = { content: `Unknown tool: ${toolCall.name}`, isError: true };
      } else {
        try {
          result = await tool.execute(toolCall.args, options.toolContext);
        } catch (err) {
          result = {
            content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      events?.onToolResult?.(toolCall.name, result);
      allToolCalls.push({ name: toolCall.name, args: toolCall.args, result });

      const contentStr =
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content);

      workingMessages.push({
        role: "tool",
        content: contentStr,
        tool_call_id: toolCall.id,
      });
    }
  }

  const queryResult: QueryResult = {
    response: finalResponse,
    toolCalls: allToolCalls,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
  };

  events?.onDone?.(queryResult);
  return queryResult;
}
