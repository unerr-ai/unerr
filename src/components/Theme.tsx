/**
 * Theme system for Ink components.
 *
 * Semantic color palette — all components use useTheme() for consistent
 * styling across startup, status, session summary, and health displays.
 */

import type React from "react";
import { createContext, useContext } from "react";

export const theme = {
  success: "green",
  warning: "yellow",
  error: "red",
  info: "cyan",
  accent: "magenta",
  dim: "gray",
  brand: "cyanBright",
  grade: (g: string): string =>
    ({ A: "green", B: "cyan", C: "yellow", D: "red", F: "red" })[g[0] ?? ""] ??
    "gray",
} as const;

export type Theme = typeof theme;

const ThemeContext = createContext<Theme>(theme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function ThemeProvider({
  children,
}: { children: React.ReactNode }): React.ReactElement {
  return (
    <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
  );
}
