/**
 * App — root Ink component for the interactive REPL.
 *
 * Manages conversation state, dispatches user input to the QueryEngine,
 * and renders the message history with streaming responses.
 */

import { Box, Text, useApp, useInput } from "ink";
import React, { useState, useCallback } from "react";
import type { ChatProvider } from "../core/local-chat-provider.js";
import {
  type ConversationMessage,
  type QueryEngineOptions,
  type QueryResult,
  executeQuery,
} from "../core/query-engine.js";
import type { Tool } from "../tools/types.js";
import { InputBox } from "./InputBox.js";
import { MessageList } from "./MessageList.js";
import { StatusLine } from "./StatusLine.js";
import { ToolProgress } from "./ToolProgress.js";

export interface AppProps {
  /** Anthropic API key — used when chatProvider is not supplied */
  apiKey?: string;
  /** Chat provider — if supplied, apiKey is ignored */
  chatProvider?: ChatProvider;
  /** Claude model ID */
  model: string;
  /** System prompt */
  systemPrompt: string;
  /** Available tools */
  tools: Tool[];
  /** Working directory */
  cwd: string;
  /** Initial welcome message */
  welcomeMessage?: string;
}

interface ActiveToolCall {
  name: string;
  status: "running" | "done";
}

export function App({
  apiKey,
  chatProvider,
  model,
  systemPrompt,
  tools,
  cwd,
  welcomeMessage,
}: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTools, setActiveTools] = useState<ActiveToolCall[]>([]);
  const [lastUsage, setLastUsage] = useState<QueryResult["usage"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Handle Ctrl+C to exit
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim()) return;

      // Handle special commands
      if (input.trim() === "/exit" || input.trim() === "/quit") {
        exit();
        return;
      }
      if (input.trim() === "/clear") {
        setMessages([]);
        setLastUsage(null);
        setError(null);
        return;
      }
      if (input.trim() === "/cost") {
        if (lastUsage) {
          setError(
            `Session: ${lastUsage.inputTokens} in / ${lastUsage.outputTokens} out`
          );
        } else {
          setError("No usage data yet");
        }
        return;
      }

      const userMessage: ConversationMessage = { role: "user", content: input };
      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);
      setIsLoading(true);
      setStreamingText("");
      setActiveTools([]);
      setError(null);

      try {
        const options: QueryEngineOptions = {
          model,
          apiKey,
          chatProvider,
          tools,
          systemPrompt,
          toolContext: { cwd },
        };

        const result = await executeQuery(updatedMessages, options, {
          onToken: (token) => {
            setStreamingText((prev) => prev + token);
          },
          onToolCall: (name) => {
            setActiveTools((prev) => [...prev, { name, status: "running" }]);
          },
          onToolResult: (name) => {
            setActiveTools((prev) =>
              prev.map((t) =>
                t.name === name && t.status === "running"
                  ? { ...t, status: "done" }
                  : t
              )
            );
          },
        });

        const assistantMessage: ConversationMessage = {
          role: "assistant",
          content: result.response,
          toolCalls: result.toolCalls,
        };

        setMessages((prev) => [...prev, assistantMessage]);
        setLastUsage(result.usage);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
        setStreamingText("");
        setActiveTools([]);
      }
    },
    [
      messages,
      model,
      apiKey,
      chatProvider,
      tools,
      systemPrompt,
      cwd,
      exit,
      lastUsage,
    ]
  );

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          unerr
        </Text>
        <Text color="gray"> — AI assistant with code intelligence</Text>
        <Text color="gray"> ({model})</Text>
      </Box>

      {welcomeMessage && messages.length === 0 && (
        <Box marginBottom={1}>
          <Text color="gray">{welcomeMessage}</Text>
        </Box>
      )}

      {/* Message History */}
      <MessageList messages={messages} />

      {/* Streaming response */}
      {streamingText && (
        <Box marginBottom={1}>
          <Text color="green">{streamingText}</Text>
          <Text color="gray">▊</Text>
        </Box>
      )}

      {/* Tool progress */}
      {activeTools.length > 0 && <ToolProgress tools={activeTools} />}

      {/* Error display */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {/* Status line */}
      {lastUsage && <StatusLine usage={lastUsage} />}

      {/* Input */}
      <InputBox onSubmit={handleSubmit} isDisabled={isLoading} />
    </Box>
  );
}
