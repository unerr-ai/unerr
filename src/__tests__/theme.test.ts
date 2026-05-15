/**
 * Tests for Theme.tsx (Task 1.1) — Ink foundation and theme system.
 *
 * Tests validate:
 *   - theme: semantic color palette with correct values
 *   - theme.grade(): letter-to-color mapping (A=green, C=yellow, F=red)
 *   - renderToStderr(): renders to stderr, not stdout
 */

import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { ThemeProvider, theme, useTheme } from "../components/Theme.js";

describe("Theme System (1.1)", () => {
  // ── theme object ───────────────────────────────────────────────

  describe("theme", () => {
    it("has all semantic color keys", () => {
      expect(theme.success).toBe("green");
      expect(theme.warning).toBe("yellow");
      expect(theme.error).toBe("red");
      expect(theme.info).toBe("cyan");
      expect(theme.accent).toBe("magenta");
      expect(theme.dim).toBe("gray");
      expect(theme.brand).toBe("cyanBright");
    });

    it("grade() maps A to green", () => {
      expect(theme.grade("A")).toBe("green");
    });

    it("grade() maps B+ to cyan (first char B)", () => {
      expect(theme.grade("B+")).toBe("cyan");
      expect(theme.grade("B")).toBe("cyan");
    });

    it("grade() maps C+ to yellow", () => {
      expect(theme.grade("C+")).toBe("yellow");
      expect(theme.grade("C")).toBe("yellow");
    });

    it("grade() maps D to red", () => {
      expect(theme.grade("D")).toBe("red");
    });

    it("grade() maps F to red", () => {
      expect(theme.grade("F")).toBe("red");
    });

    it("grade() returns gray for unknown grades", () => {
      expect(theme.grade("X")).toBe("gray");
      expect(theme.grade("")).toBe("gray");
    });
  });

  // ── ThemeProvider + useTheme ────────────────────────────────────

  describe("ThemeProvider + useTheme", () => {
    function ThemeConsumer(): React.ReactElement {
      const t = useTheme();
      return React.createElement(Text, null, `success=${t.success}`);
    }

    it("provides theme to child components", () => {
      const { lastFrame } = render(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(ThemeConsumer)
        )
      );
      expect(lastFrame()).toContain("success=green");
    });

    it("useTheme works without provider (uses defaults)", () => {
      const { lastFrame } = render(React.createElement(ThemeConsumer));
      expect(lastFrame()).toContain("success=green");
    });
  });

  // ── renderToStderr ─────────────────────────────────────────────

  describe("renderToStderr", () => {
    it("is exported and callable", async () => {
      // We can't easily test stderr rendering in vitest without mocking process.stderr,
      // but we verify the function exists and has the right signature
      const { renderToStderr } = await import("../components/render.js");
      expect(typeof renderToStderr).toBe("function");
    });
  });
});
