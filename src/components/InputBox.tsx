/**
 * InputBox — user input component with prompt indicator.
 */

import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import React, { useState } from "react";

interface InputBoxProps {
  onSubmit: (value: string) => void;
  isDisabled?: boolean;
}

export function InputBox({ onSubmit, isDisabled }: InputBoxProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (input: string) => {
    if (isDisabled) return;
    onSubmit(input);
    setValue("");
  };

  return (
    <Box>
      <Text color={isDisabled ? "gray" : "cyan"} bold>
        {isDisabled ? "⏳ " : "❯ "}
      </Text>
      {isDisabled ? (
        <Text color="gray">Thinking...</Text>
      ) : (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="Ask anything about your code..."
        />
      )}
    </Box>
  );
}
