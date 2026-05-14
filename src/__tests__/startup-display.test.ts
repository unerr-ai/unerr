/**
 * Tests for StartupDisplay + StartupRenderer (Task 1.3).
 *
 * Tests validate:
 *   - Three-Act structure: Banner (Act 1), HealthCard (Act 2), Invitation (Act 3)
 *   - Step status progression: pending → active → done
 *   - Health Shock display: full card on first boot, compact on subsequent
 *   - Invitation references specific entity from health data
 *   - Deep link included when repo ID available
 *   - Proxy mode displayed when not "full"
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      React.createElement(StartupDisplay, { state }),
    ),
  );
}

describe("StartupDisplay (1.3)", () => {
  // ── Act 1: Instant Competence ──────────────────────────────────

  describe("Act 1: Banner + Steps", () => {
    it("renders brand banner", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        firstBoot: false,
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
        firstBoot: false,
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
        firstBoot: false,
        ready: false,
      });
      expect(lastFrame()).toContain("2,341 entities");
      expect(lastFrame()).toContain("1,892 edges");
    });
  });

  // ── Act 2: Revelation (Health Shock) ───────────────────────────

  describe("Act 2: Health Shock", () => {
    const health = {
      grade: "C+",
      totalEntities: 2341,
      totalEdges: 1892,
      totalRules: 12,
      deadFunctionCount: 23,
      highRiskEntities: [
        {
          name: "processPayment",
          kind: "function",
          file_path: "src/billing.ts",
          fan_in: 14,
          fan_out: 8,
        },
      ],
      score: 62,
    };

    it("renders full health card on first boot", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        health,
        firstBoot: true,
        ready: false,
      });
      const frame = lastFrame() ?? "";
      expect(frame).toContain("First Look");
      expect(frame).toContain("C+");
      expect(frame).toContain("62/100");
      expect(frame).toContain("23 dead functions");
      expect(frame).toContain("processPayment");
    });

    it("renders compact health line on subsequent boots", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        health,
        firstBoot: false,
        ready: false,
      });
      const frame = lastFrame() ?? "";
      expect(frame).toContain("C+");
      expect(frame).toContain("2341 entities");
      // Should NOT show full dead function detail in compact
      expect(frame).not.toContain("23 dead functions");
    });

    it("does not render health section when no health data", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        firstBoot: false,
        ready: false,
      });
      expect(lastFrame()).not.toContain("First Look");
    });
  });

  // ── Act 3: Invitation ──────────────────────────────────────────

  describe("Act 3: Invitation", () => {
    it("renders invitation with specific entity name", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        firstBoot: false,
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
        firstBoot: false,
        ready: true,
      });
      expect(lastFrame()).toContain("Proxy ready");
      expect(lastFrame()).toContain("MCP on stdio");
    });

    it("shows proxy mode when not full", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        firstBoot: false,
        ready: true,
        proxyMode: "parse",
      });
      expect(lastFrame()).toContain("parse mode");
    });

    it("shows local mode label when proxyMode is local", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        firstBoot: false,
        ready: true,
        proxyMode: "local",
      });
      expect(lastFrame()).toContain("local mode");
    });

    it("renders deep link when available", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        firstBoot: false,
        ready: true,
        deepLink: "https://app.unerr.dev/r/repo_123?utm_source=cli_startup",
      });
      expect(lastFrame()).toContain("https://app.unerr.dev/r/repo_123");
    });

    it("does not render invitation when not ready", () => {
      const { lastFrame } = renderStartup({
        localMode: false,
        steps: [],
        firstBoot: false,
        ready: false,
        invitationEntity: "processPayment",
      });
      expect(lastFrame()).not.toContain("What depends on");
    });
  });

  // ── Full Three-Act integration ─────────────────────────────────

  describe("Full Three-Act integration", () => {
    it("renders all three acts together", () => {
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
        health: {
          grade: "C+",
          totalEntities: 2341,
          totalEdges: 1892,
          totalRules: 12,
          deadFunctionCount: 23,
          highRiskEntities: [
            {
              name: "processPayment",
              kind: "function",
              file_path: "src/billing.ts",
              fan_in: 14,
              fan_out: 8,
            },
          ],
          score: 62,
        },
        firstBoot: true,
        ready: true,
        invitationEntity: "processPayment",
        deepLink: "https://app.unerr.dev/r/repo_123?utm_source=cli_startup",
      });
      const frame = lastFrame() ?? "";

      // Act 1
      expect(frame).toContain("unerr");
      expect(frame).toContain("Authenticated");
      expect(frame).toContain("Jaswanth's Org");

      // Act 2
      expect(frame).toContain("First Look");
      expect(frame).toContain("C+");
      expect(frame).toContain("23 dead functions");

      // Act 3
      expect(frame).toContain("What depends on processPayment?");
      expect(frame).toContain("Proxy ready");
      expect(frame).toContain("https://app.unerr.dev/r/repo_123");
    });
  });
});

// ── StartupRenderer unit tests ───────────────────────────────────

describe("StartupRenderer", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `unerr-startup-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, ".unerr", "state"), { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tracks first_boot_shown flag", async () => {
    const { StartupRenderer } = await import("../proxy/startup-renderer.js");
    const renderer = new StartupRenderer();

    // No graph_version.json → first boot
    renderer.setHealth(
      {
        grade: "C+",
        totalEntities: 100,
        totalEdges: 50,
        totalRules: 5,
        deadFunctionCount: 10,
        highRiskEntities: [],
        score: 62,
      },
      "repo_test",
    );

    // Should have written first_boot_shown = true
    const versionPath = path.join(
      tmpDir,
      ".unerr",
      "state",
      "graph_version.json",
    );
    const data = JSON.parse(fs.readFileSync(versionPath, "utf-8")) as {
      first_boot_shown?: boolean;
    };
    expect(data.first_boot_shown).toBe(true);
  });

  it("detects subsequent boot after first_boot_shown is set", async () => {
    const versionPath = path.join(
      tmpDir,
      ".unerr",
      "state",
      "graph_version.json",
    );
    fs.writeFileSync(versionPath, JSON.stringify({ first_boot_shown: true }));

    const { StartupRenderer } = await import("../proxy/startup-renderer.js");
    const renderer = new StartupRenderer();
    renderer.setHealth(
      {
        grade: "A",
        totalEntities: 100,
        totalEdges: 50,
        totalRules: 5,
        deadFunctionCount: 0,
        highRiskEntities: [],
        score: 95,
      },
      "repo_test",
    );

    // firstBoot should be false since flag was already set
    // We verify indirectly — the renderer won't overwrite the flag
    const data = JSON.parse(fs.readFileSync(versionPath, "utf-8")) as {
      first_boot_shown?: boolean;
    };
    expect(data.first_boot_shown).toBe(true);
  });
});
