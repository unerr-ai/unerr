/**
 * MessageList — renders conversation history.
 */

import { Box, Text } from "ink";
import React from "react";
import type { ConversationMessage } from "../core/query-engine.js";

interface MessageListProps {
  messages: ConversationMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageBubble key={`msg-${msg.role}-${i}`} message={msg} />
      ))}
    </Box>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  if (message.role === "user") {
    return (
      <Box marginBottom={1}>
        <Text bold color="blue">
          You:{" "}
        </Text>
        <Text>{message.content}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Tool calls summary */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <Box marginBottom={0}>
          {message.toolCalls.map((tc, i) => (
            <Box key={`tc-${tc.name}`} marginRight={1}>
              <Text color="yellow" dimColor>
                [{tc.name}]
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Assistant text */}
      <Box>
        <Text bold color="green">
          unerr:{" "}
        </Text>
        <Text>{message.content}</Text>
      </Box>
    </Box>
  );
}
