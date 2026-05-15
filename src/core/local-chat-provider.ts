/**
 * Local Chat Provider — BYO-LLM streaming chat for the REPL.
 *
 * Implements the ChatProvider interface by routing to Ollama (/api/chat),
 * LM Studio / OpenAI-compatible (/v1/chat/completions), or anthropic-direct.
 * All providers use Server-Sent Events or NDJSON streaming.
 *
 * SECURITY: API keys are NEVER logged or included in MCP responses.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LocalLlmConfig } from "../config/settings.js";
import type { Tool, ToolOutput } from "../tools/types.js";

// ── ChatProvider Interface ──────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ChatToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatStreamChunk {
  type:
    | "text_delta"
    | "tool_use_start"
    | "tool_use_delta"
    | "tool_use_end"
    | "done";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
}

export interface ChatResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  inputTokens: number;
  outputTokens: number;
}

export interface ChatProvider {
  readonly providerName: string;
  readonly modelId: string;

  streamChat(
    messages: ChatMessage[],
    tools: ChatToolDef[],
    systemPrompt: string,
    maxTokens: number,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<ChatResponse>;
}

// ── Convert unerr Tool → ChatToolDef ────────────────────────

export function toChatToolDefs(tools: Tool[]): ChatToolDef[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ── Anthropic Chat Provider ─────────────────────────────────

export class AnthropicChatProvider implements ChatProvider {
  readonly providerName = "anthropic";
  readonly modelId: string;
  private readonly client: Anthropic;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.modelId = model;
  }

  async streamChat(
    messages: ChatMessage[],
    tools: ChatToolDef[],
    systemPrompt: string,
    maxTokens: number,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<ChatResponse> {
    // Convert ChatMessage[] → Anthropic format
    const anthropicMessages = this.toAnthropicMessages(messages);
    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    }));

    const stream = this.client.messages.stream({
      model: this.modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    let text = "";
    stream.on("text", (t) => {
      text += t;
      onChunk({ type: "text_delta", text: t });
    });

    const message = await stream.finalMessage();

    const toolCalls: ChatResponse["toolCalls"] = [];
    for (const block of message.content) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
      }
    }

    onChunk({ type: "done" });

    return {
      text,
      toolCalls,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }

  private toAnthropicMessages(
    messages: ChatMessage[]
  ): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];
    for (const msg of messages) {
      if (msg.role === "system") continue; // System prompt handled separately
      if (msg.role === "tool") {
        result.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id ?? "",
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === "assistant" && msg.tool_calls?.length) {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (msg.content) blocks.push({ type: "text", text: msg.content });
        for (const tc of msg.tool_calls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        result.push({ role: "assistant", content: blocks });
      } else {
        result.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }
    return result;
  }
}

// ── Local Chat Provider ─────────────────────────────────────

const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: "http://localhost:11434",
  "lm-studio": "http://localhost:1234",
  "openai-compatible": "http://localhost:8080",
  "anthropic-direct": "https://api.anthropic.com",
};

export class LocalChatProvider implements ChatProvider {
  readonly providerName: string;
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly useOllamaApi: boolean;

  constructor(config: LocalLlmConfig) {
    this.providerName = config.provider;
    this.modelId = config.chatModel;
    this.baseUrl = (
      config.baseUrl ??
      DEFAULT_BASE_URLS[config.provider] ??
      "http://localhost:8080"
    ).replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.useOllamaApi = config.provider === "ollama";
  }

  async streamChat(
    messages: ChatMessage[],
    tools: ChatToolDef[],
    systemPrompt: string,
    maxTokens: number,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<ChatResponse> {
    // anthropic-direct uses the Anthropic SDK directly
    if (this.providerName === "anthropic-direct") {
      return this.streamAnthropicDirect(
        messages,
        tools,
        systemPrompt,
        maxTokens,
        onChunk
      );
    }

    if (this.useOllamaApi) {
      return this.streamOllama(
        messages,
        tools,
        systemPrompt,
        maxTokens,
        onChunk
      );
    }
    return this.streamOpenAiCompatible(
      messages,
      tools,
      systemPrompt,
      maxTokens,
      onChunk
    );
  }

  private async streamAnthropicDirect(
    messages: ChatMessage[],
    tools: ChatToolDef[],
    systemPrompt: string,
    maxTokens: number,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<ChatResponse> {
    if (!this.apiKey) {
      throw new Error(
        "[LocalChatProvider] anthropic-direct requires an API key. " +
          "Set localLlm.apiKey in settings.json."
      );
    }
    const provider = new AnthropicChatProvider(this.apiKey, this.modelId);
    return provider.streamChat(
      messages,
      tools,
      systemPrompt,
      maxTokens,
      onChunk
    );
  }

  // ── Ollama: POST /api/chat with NDJSON streaming ──────────

  private async streamOllama(
    messages: ChatMessage[],
    tools: ChatToolDef[],
    systemPrompt: string,
    _maxTokens: number,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<ChatResponse> {
    const ollamaMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
      })),
    ];

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: ollamaMessages,
      stream: true,
    };

    // Ollama supports tools via the OpenAI-compatible format
    if (tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `[LocalChatProvider] Ollama chat failed: ${response.status} ${response.statusText}${errText ? ` — ${errText.slice(0, 200)}` : ""}`
      );
    }

    return this.parseNdjsonStream(response, onChunk);
  }

  private async parseNdjsonStream(
    response: Response,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<ChatResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("[LocalChatProvider] No response body");

    const decoder = new TextDecoder();
    let text = "";
    const toolCalls: ChatResponse["toolCalls"] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message?.content) {
            text += chunk.message.content;
            onChunk({ type: "text_delta", text: chunk.message.content });
          }
          if (chunk.message?.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              toolCalls.push({
                id: tc.id ?? `tool_${Date.now()}`,
                name: tc.function?.name ?? "",
                args:
                  typeof tc.function?.arguments === "string"
                    ? JSON.parse(tc.function.arguments)
                    : (tc.function?.arguments ?? {}),
              });
            }
          }
          if (chunk.eval_count) outputTokens = chunk.eval_count;
          if (chunk.prompt_eval_count) inputTokens = chunk.prompt_eval_count;
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    onChunk({ type: "done" });
    return { text, toolCalls, inputTokens, outputTokens };
  }

  // ── OpenAI-Compatible: POST /v1/chat/completions with SSE ──

  private async streamOpenAiCompatible(
    messages: ChatMessage[],
    tools: ChatToolDef[],
    systemPrompt: string,
    maxTokens: number,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<ChatResponse> {
    const openaiMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => {
        if (m.tool_calls) {
          return { role: m.role, content: m.content, tool_calls: m.tool_calls };
        }
        if (m.tool_call_id) {
          return {
            role: m.role,
            content: m.content,
            tool_call_id: m.tool_call_id,
          };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: openaiMessages,
      max_tokens: maxTokens,
      stream: true,
    };

    if (tools.length > 0) {
      body.tools = tools;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `[LocalChatProvider] Chat request failed: ${response.status} ${response.statusText}${errText ? ` — ${errText.slice(0, 200)}` : ""}`
      );
    }

    return this.parseSseStream(response, onChunk);
  }

  private async parseSseStream(
    response: Response,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<ChatResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("[LocalChatProvider] No response body");

    const decoder = new TextDecoder();
    let text = "";
    const toolCalls: ChatResponse["toolCalls"] = [];
    const pendingToolArgs = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            text += delta.content;
            onChunk({ type: "text_delta", text: delta.content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (tc.id) {
                pendingToolArgs.set(idx, {
                  id: tc.id,
                  name: tc.function?.name ?? "",
                  args: tc.function?.arguments ?? "",
                });
              } else if (pendingToolArgs.has(idx) && tc.function?.arguments) {
                const pending = pendingToolArgs.get(idx);
                if (pending) pending.args += tc.function.arguments;
              }
            }
          }
        } catch {
          // Skip malformed SSE data
        }
      }
    }

    // Finalize pending tool calls
    for (const [, pending] of pendingToolArgs) {
      try {
        toolCalls.push({
          id: pending.id,
          name: pending.name,
          args: pending.args ? JSON.parse(pending.args) : {},
        });
      } catch {
        toolCalls.push({
          id: pending.id,
          name: pending.name,
          args: {},
        });
      }
    }

    onChunk({ type: "done" });
    // OpenAI-compatible endpoints don't always return token counts in streamed responses
    return { text, toolCalls, inputTokens: 0, outputTokens: 0 };
  }
}

// ── AI SDK Chat Provider ─────────────────────────────────────

/**
 * Chat provider backed by Vercel AI SDK streamText().
 *
 * Works with any AI SDK-compatible LanguageModel (Anthropic, OpenAI, Google,
 * Ollama, any OpenAI-compatible). This is the recommended provider for new
 * integrations — it replaces both AnthropicChatProvider and LocalChatProvider.
 */
export class AiSdkChatProvider implements ChatProvider {
  readonly providerName: string;
  readonly modelId: string;
  private readonly model: unknown;

  constructor(model: unknown, providerName: string, modelId: string) {
    this.model = model;
    this.providerName = providerName;
    this.modelId = modelId;
  }

  async streamChat(
    messages: ChatMessage[],
    tools: ChatToolDef[],
    systemPrompt: string,
    maxTokens: number,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<ChatResponse> {
    const { streamText } = await import("ai");

    const modelMessages = this.toModelMessages(messages);
    const aiTools = this.toAiTools(tools);

    const result = streamText({
      model: this.model as any,
      system: systemPrompt,
      messages: modelMessages as any,
      tools: Object.keys(aiTools).length > 0 ? (aiTools as any) : undefined,
      maxOutputTokens: maxTokens,
      toolChoice: tools.length > 0 ? ("auto" as const) : undefined,
    });

    let text = "";
    const collectedToolCalls: ChatResponse["toolCalls"] = [];

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        const delta =
          ((part as Record<string, unknown>).text as string) ??
          ((part as Record<string, unknown>).textDelta as string) ??
          "";
        text += delta;
        onChunk({ type: "text_delta", text: delta });
      } else if (part.type === "tool-call") {
        const tc = part as Record<string, unknown>;
        const toolCallId = (tc.toolCallId as string) ?? "";
        const toolName = (tc.toolName as string) ?? "";
        const args = tc.args ?? tc.input ?? {};
        onChunk({ type: "tool_use_start", toolCallId, toolName });
        onChunk({
          type: "tool_use_delta",
          toolCallId,
          toolArgs: JSON.stringify(args),
        });
        onChunk({ type: "tool_use_end", toolCallId });
        collectedToolCalls.push({
          id: toolCallId,
          name: toolName,
          args: args as Record<string, unknown>,
        });
      }
    }

    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const usage = await result.usage;
      const u = usage as unknown as Record<string, number>;
      inputTokens = u?.promptTokens ?? 0;
      outputTokens = u?.completionTokens ?? 0;
    } catch {
      /* token counts unavailable for some providers */
    }

    onChunk({ type: "done" });

    return { text, toolCalls: collectedToolCalls, inputTokens, outputTokens };
  }

  private toModelMessages(
    messages: ChatMessage[]
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === "system") continue;
      if (msg.role === "user") {
        result.push({ role: "user", content: msg.content });
      } else if (msg.role === "tool") {
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: msg.tool_call_id ?? "",
              result: msg.content,
            },
          ],
        });
      } else if (msg.role === "assistant") {
        if (msg.tool_calls?.length) {
          const parts: Array<Record<string, unknown>> = [];
          if (msg.content) {
            parts.push({ type: "text", text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            parts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.function.name,
              args: JSON.parse(tc.function.arguments),
            });
          }
          result.push({ role: "assistant", content: parts });
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      }
    }

    return result;
  }

  private toAiTools(
    tools: ChatToolDef[]
  ): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const t of tools) {
      result[t.function.name] = {
        description: t.function.description,
        parameters: t.function.parameters,
      };
    }
    return result;
  }
}
