/**
 * Inline confirm prompt: [Y/n] with context.
 *
 * Uses Ink's useInput() for keyboard handling.
 * Used for entity rewind, dead code removal confirmations.
 */

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useTheme } from "./Theme.js";

export interface ConfirmPromptProps {
  message: string;
  onConfirm: (confirmed: boolean) => void;
  defaultYes?: boolean;
}

export function ConfirmPrompt({
  message,
  onConfirm,
  defaultYes = true,
}: ConfirmPromptProps): React.ReactElement {
  const t = useTheme();
  const hint = defaultYes ? "[Y/n]" : "[y/N]";

  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      onConfirm(true);
    } else if (input === "n" || input === "N") {
      onConfirm(false);
    } else if (key.return) {
      onConfirm(defaultYes);
    }
  });

  return (
    <Box marginLeft={2}>
      <Text>{message} </Text>
      <Text color={t.dim}>{hint}</Text>
    </Box>
  );
}
