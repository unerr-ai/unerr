/**
 * Tests for Sprint L7 — Local Mode TUI components.
 *
 * Covers:
 *   - StartupDisplay Local Mode variant (Three-Act structure)
 *   - SessionSummaryCard Local Mode variant (proof-of-value shutdown)
 *   - StartupRenderer local mode methods
 *   - Latency advantage injection
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionSummaryCard } from "../components/SessionSummaryCard.js";
import {
  StartupDisplay,
  type StartupState,
} from "../components/StartupDisplay.js";
import { ThemeProvider } from "../components/Theme.js";
import type { SessionStats } from "../proxy/session-stats.js";
import {
  createLatencyTracker,
  createLocalModeStats,
  createSessionEvents,
  recordLatencyAdvantage,
} from "../proxy/session-stats.js";

function renderWithTheme(el: React.ReactElement) {
  return render(React.createElement(ThemeProvider, null, el));
}

function renderStartup(state: StartupState) {
  return renderWithTheme(React.createElement(StartupDisplay, { state }));
}

function makeLocalStats(): SessionStats {
  return {
    toolCallsLocal: 25,
    estimatedTokensSaved: 0,
    violationsCaught: 2,
    riskWarningsIssued: 1,
    sessionStartedAt: Date.now() - 300_000, // 5 min ago
    latency: createLatencyTracker(),
    events: {
      ...createSessionEvents(),
      conventionViolationsCaught: 2,
      chokepointWarningsIssued: 1,
    },
    isResumedSession: false,
    previousSession: null,
    localMode: {
      ...createLocalModeStats(),
      blastRadiusComputations: 3,
      communityContextsInjected: 5,
      correctionPatternsInjected: 2,
      tokensSavedByTruncation: 12000,
      truncatedResponses: 4,
      semanticSearches: 7,
      cumulativeLatencySavedMs: 4850,
      firewallBlockedCount: 0,
    },
  };
}

// ── StartupDisplay Local Mode ─────────────────────────────────────

describe("StartupDisplay Local Mode (L7.1)", () => {
  it("renders locally computed health title instead of First Look", () => {
    const { lastFrame } = renderStartup({
      steps: [],
      firstBoot: false,
      ready: false,
      localMode: true,
      health: {
        grade: "B",
        totalEntities: 500,
        totalEdges: 300,
        totalRules: 8,
        deadFunctionCount: 5,
        highRiskEntities: [],
        score: 78,
      },
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Health (locally computed)");
    expect(frame).not.toContain("First Look");
  });

  it("shows tool count and zero cloud deps in Act 3", () => {
    const { lastFrame } = renderStartup({
      steps: [],
      firstBoot: false,
      ready: true,
      localMode: true,
      toolCount: 11,
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("11 tools ready");
    expect(frame).toContain("offline-capable");
  });

  it("shows agent invitation with entity name in Local Mode", () => {
    const { lastFrame } = renderStartup({
      steps: [],
      firstBoot: false,
      ready: true,
      localMode: true,
      invitationEntity: "processPayment",
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("What depends on processPayment?");
  });

  it("shows default invitation when no entity", () => {
    const { lastFrame } = renderStartup({
      steps: [],
      firstBoot: false,
      ready: true,
      localMode: true,
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain(
      "Show me the highest-impact functions in this codebase"
    );
  });

  it("never shows deep link in Local Mode", () => {
    const { lastFrame } = renderStartup({
      steps: [],
      firstBoot: false,
      ready: true,
      localMode: true,
      deepLink: "https://app.unerr.dev/r/repo_123",
    });
    // Deep link is in state but Local Mode Act 3 doesn't render it
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Health details");
    expect(frame).not.toContain("Proxy ready. Serving MCP on stdio");
  });

  it("does not show standard Act 3 when in local mode", () => {
    const { lastFrame } = renderStartup({
      steps: [],
      firstBoot: false,
      ready: true,
      localMode: true,
      proxyMode: "full",
    });
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Proxy ready");
  });
});

// ── SessionSummaryCard Local Mode ─────────────────────────────────

describe("SessionSummaryCard Local Mode (L7.2)", () => {
  it("renders all-local tool calls with 100% progress bar", () => {
    const stats = makeLocalStats();
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("25 (all local)");
    expect(frame).toContain("Local rate");
  });

  it("shows caught section when violations exist", () => {
    const stats = makeLocalStats();
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Caught:");
    expect(frame).toContain("2 convention violations before commit");
    expect(frame).toContain("1 chokepoint modification");
  });

  it("shows Intelligence Applied section", () => {
    const stats = makeLocalStats();
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Intelligence Applied:");
    expect(frame).toContain("3 blast radius computations");
    expect(frame).toContain("5 community contexts injected");
    expect(frame).toContain("2 correction patterns applied");
  });

  it("shows Token Discipline section", () => {
    const stats = makeLocalStats();
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Token Discipline:");
    expect(frame).toContain("12.0k tokens saved via smart truncation");
    expect(frame).toContain("4 responses budget-trimmed");
  });

  it("shows Semantic Intelligence when BYO-LLM used", () => {
    const stats = makeLocalStats();
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Semantic Intelligence:");
    expect(frame).toContain("7 queries via local embeddings");
  });

  it("shows Network Isolation section with firewall sealed", () => {
    const stats = makeLocalStats();
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Network Isolation:");
    expect(frame).toContain("Outbound: 0 calls (firewall sealed)");
    expect(frame).toContain("Blocked attempts: 0 (clean)");
  });

  it("shows latency advantage when accumulated and latency samples exist", () => {
    const stats = makeLocalStats();
    // Populate latency samples so localP is non-null
    for (let i = 0; i < 10; i++) {
      stats.latency.localSamples[i] = 3.0;
    }
    stats.latency.localCursor = 10;
    stats.latency.localTotalSamples = 10;
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("4.8s saved vs remote");
  });

  it("never shows dollar savings in Local Mode (TL-19)", () => {
    const stats = makeLocalStats();
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("$");
    expect(frame).not.toContain("Saved:");
  });

  it("never shows deep link in Local Mode", () => {
    const stats = makeLocalStats();
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, {
        stats,
        deepLink: "https://app.unerr.dev/r/repo_123",
      })
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Session →");
    expect(frame).not.toContain("unerr.dev");
  });

  it("renders compact line for short sessions (<=10 calls)", () => {
    const stats = makeLocalStats();
    stats.toolCallsLocal = 5;
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("unerr local session:");
    expect(frame).toContain("5 tool calls (all local)");
  });

  it("renders empty box for zero tool calls", () => {
    const stats = makeLocalStats();
    stats.toolCallsLocal = 0;
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, { stats })
    );
    const frame = lastFrame() ?? "";
    // Should be basically empty
    expect(frame).not.toContain("Tool calls");
    expect(frame).not.toContain("unerr local session");
  });

  it("shows cumulative This week line when >1 session", () => {
    const stats = makeLocalStats();
    const { lastFrame } = renderWithTheme(
      React.createElement(SessionSummaryCard, {
        stats,
        cumulativeLocal: {
          weekStartDate: "2026-04-13",
          totalSessions: 5,
          totalToolCalls: 120,
          totalTokensSaved: 45000,
          totalViolationsCaught: 8,
          totalCorrectionsApplied: 3,
          totalFilesIndexed: 200,
          totalSemanticSearches: 15,
          avgLatencyP50: 2.1,
        },
      })
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("This week:");
    expect(frame).toContain("5 sessions");
    expect(frame).toContain("45k tokens saved");
    expect(frame).toContain("8 caught");
  });
});

// ── Latency Advantage ─────────────────────────────────────────────

describe("Latency advantage (L7.3)", () => {
  it("recordLatencyAdvantage accumulates correctly", () => {
    const lm = createLocalModeStats();
    recordLatencyAdvantage(lm, 195); // 5ms actual → 195ms saved
    recordLatencyAdvantage(lm, 198); // 2ms actual → 198ms saved
    expect(lm.cumulativeLatencySavedMs).toBe(393);
  });

  it("cumulativeLatencySavedMs starts at 0", () => {
    const lm = createLocalModeStats();
    expect(lm.cumulativeLatencySavedMs).toBe(0);
  });
});

// ── StartupRenderer Local Mode ────────────────────────────────────

describe("StartupRenderer Local Mode (L7.4)", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `unerr-l7-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, ".unerr", "state"), { recursive: true });
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("setLocalMode suppresses deep link in setHealth", async () => {
    const { StartupRenderer } = await import("../proxy/startup-renderer.js");
    const renderer = new StartupRenderer();
    renderer.setLocalMode(true);
    renderer.setHealth(
      {
        grade: "B",
        totalEntities: 100,
        totalEdges: 50,
        totalRules: 5,
        deadFunctionCount: 0,
        highRiskEntities: [],
        score: 80,
      },
      "repo_test"
    );
    // Access internal state to verify no deep link
    // @ts-expect-error accessing private for test
    expect(renderer.state.deepLink).toBeUndefined();
    // @ts-expect-error accessing private for test
    expect(renderer.state.localMode).toBe(true);
  });

  it("setLocalMode suppresses deep link in setReady", async () => {
    const { StartupRenderer } = await import("../proxy/startup-renderer.js");
    const renderer = new StartupRenderer();
    renderer.setLocalMode(true);
    // @ts-expect-error accessing private for test
    renderer.repoId = "repo_test";
    renderer.setReady("local");
    // @ts-expect-error accessing private for test
    expect(renderer.state.deepLink).toBeUndefined();
  });

  it("setToolCount sets the tool count", async () => {
    const { StartupRenderer } = await import("../proxy/startup-renderer.js");
    const renderer = new StartupRenderer();
    renderer.setToolCount(11);
    // @ts-expect-error accessing private for test
    expect(renderer.state.toolCount).toBe(11);
  });

  it("setByoLlmStatus sets BYO-LLM fields", async () => {
    const { StartupRenderer } = await import("../proxy/startup-renderer.js");
    const renderer = new StartupRenderer();
    renderer.setByoLlmStatus("connected", "ollama", "nomic-embed-text");
    // @ts-expect-error accessing private for test
    expect(renderer.state.byoLlmStatus).toBe("connected");
    // @ts-expect-error accessing private for test
    expect(renderer.state.byoLlmProvider).toBe("ollama");
    // @ts-expect-error accessing private for test
    expect(renderer.state.byoLlmModel).toBe("nomic-embed-text");
  });

  it("setLocalIndexStats sets indexing stats", async () => {
    const { StartupRenderer } = await import("../proxy/startup-renderer.js");
    const renderer = new StartupRenderer();
    renderer.setLocalIndexStats({
      fileCount: 100,
      entityCount: 500,
      edgeCount: 300,
      indexingTimeMs: 1200,
      communityCount: 12,
      conventionCount: 8,
      ruleCount: 5,
    });
    // @ts-expect-error accessing private for test
    expect(renderer.state.localIndexStats?.fileCount).toBe(100);
    // @ts-expect-error accessing private for test
    expect(renderer.state.localIndexStats?.entityCount).toBe(500);
  });
});
