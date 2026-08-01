/**
 * Tests for StartupDisplay (Task 1.3).
 *
 * Tests validate:
 *   - Step status progression: pending → active → done
 *   - Deep link included when repo ID available
 *   - Proxy mode displayed when not "full"
 */

import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import {
  StartupDisplay,
  type StartupState,
} from "../components/StartupDisplay.js";
import { ThemeProvider } from "../components/Theme.js";

function renderStartup(state: StartupState) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(StartupDisplay, { state })
    )
  );
}

describe("StartupDisplay (1.3)", () => {
  // ── Act 1: Instant Competence ──────────────────────────────────

  describe("Act 1: Banner + Steps", () => {
    it("renders brand banner", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        ready: false,
      });
      expect(lastFrame()).toContain("unerr");
      expect(lastFrame()).toContain("▸");
    });

    it("renders steps with correct status icons", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [
          { label: "Authenticated", value: "Org", status: "done" },
          { label: "Repository", value: "acme/repo", status: "done" },
          { label: "Graph loaded", status: "active" },
        ],
        ready: false,
      });
      const frame = lastFrame() ?? "";
      expect(frame).toContain("✓");
      expect(frame).toContain("Authenticated");
      expect(frame).toContain("Org");
      expect(frame).toContain("●");
      expect(frame).toContain("Graph loaded");
    });

    it("shows step values alongside labels", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [
          {
            label: "Graph loaded",
            value: "2,341 entities · 1,892 edges",
            status: "done",
          },
        ],
        ready: false,
      });
      expect(lastFrame()).toContain("2,341 entities");
      expect(lastFrame()).toContain("1,892 edges");
    });
  });

  // ── Act 3: Invitation ──────────────────────────────────────────

  describe("Act 3: Invitation", () => {
    it("renders invitation with specific entity name", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        ready: true,
        invitationEntity: "processPayment",
      });
      const frame = lastFrame() ?? "";
      expect(frame).toContain("What depends on processPayment?");
      expect(frame).toContain("blast radius");
    });

    it("renders proxy ready message", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        ready: true,
      });
      expect(lastFrame()).toContain("Proxy ready");
      expect(lastFrame()).toContain("MCP on stdio");
    });

    it("shows proxy mode when not full", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        ready: true,
        proxyMode: "parse",
      });
      expect(lastFrame()).toContain("parse mode");
    });

    it("shows local mode label when proxyMode is local", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        ready: true,
        proxyMode: "local",
      });
      expect(lastFrame()).toContain("local mode");
    });

    it("renders deep link when available", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        ready: true,
        deepLink: "https://app.unerr.dev/r/repo_123?utm_source=cli_startup",
      });
      expect(lastFrame()).toContain("https://app.unerr.dev/r/repo_123");
    });

    it("does not render invitation when not ready", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        ready: false,
        invitationEntity: "processPayment",
      });
      expect(lastFrame()).not.toContain("What depends on");
    });
  });

  // ── Full integration ───────────────────────────────────────────

  describe("Full integration", () => {
    it("renders banner, steps, and invitation together", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [
          { label: "Authenticated", value: "Jaswanth's Org", status: "done" },
          { label: "Repository", value: "unerr-server (main)", status: "done" },
          {
            label: "Graph loaded",
            value: "2,341 entities · 1,892 edges",
            status: "done",
          },
          {
            label: "MCP ready",
            value: "15 tools (all local)",
            status: "done",
          },
        ],
        ready: true,
        invitationEntity: "processPayment",
        deepLink: "https://app.unerr.dev/r/repo_123?utm_source=cli_startup",
      });
      const frame = lastFrame() ?? "";

      // Act 1
      expect(frame).toContain("unerr");
      expect(frame).toContain("Authenticated");
      expect(frame).toContain("Jaswanth's Org");

      // Act 3
      expect(frame).toContain("What depends on processPayment?");
      expect(frame).toContain("Proxy ready");
      expect(frame).toContain("https://app.unerr.dev/r/repo_123");
    });
  });
});
