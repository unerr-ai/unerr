/**
 * Tests for StatusDashboard Ink component (Task 1.5).
 *
 * Tests validate:
 *   - Repo name, branch, commits ahead/behind display
 *   - Proxy state (running/stopped) with color
 *   - Graph stats (entity count, edge count, age)
 *   - Drift summary
 *   - Health grade with score
 *   - Live session stats with local rate bar
 *   - Latency display with budget warning
 *   - Deep link display
 */

import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import {
  StatusDashboard,
  type StatusData,
} from "../components/StatusDashboard.js";
import { ThemeProvider } from "../components/Theme.js";

function renderStatus(data: StatusData) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(StatusDashboard, { data })
    )
  );
}

const baseData: StatusData = {
  repoName: "acme/monorepo",
  repoId: "repo_abc123",
  branch: "main",
  branchDetail: "main (3 ahead, 1 behind)",
  proxyStatus: "Running (PID 12345)",
  proxyRunning: true,
  graphInfo: "2,341 entities, 1,892 edges (pulled 2h ago)",
};

describe("StatusDashboard", () => {
  it("renders section header", () => {
    const { lastFrame } = renderStatus(baseData);
    expect(lastFrame()).toContain("unerr status");
  });

  it("renders repo name and ID", () => {
    const { lastFrame } = renderStatus(baseData);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("acme/monorepo");
    expect(frame).toContain("repo_abc123");
  });

  it("renders branch with detail", () => {
    const { lastFrame } = renderStatus(baseData);
    expect(lastFrame()).toContain("main (3 ahead, 1 behind)");
  });

  it("renders proxy running status", () => {
    const { lastFrame } = renderStatus(baseData);
    expect(lastFrame()).toContain("Running (PID 12345)");
  });

  it("renders proxy not running", () => {
    const { lastFrame } = renderStatus({
      ...baseData,
      proxyStatus: "Not running",
      proxyRunning: false,
    });
    expect(lastFrame()).toContain("Not running");
  });

  it("renders graph info", () => {
    const { lastFrame } = renderStatus(baseData);
    expect(lastFrame()).toContain("2,341 entities");
    expect(lastFrame()).toContain("1,892 edges");
  });

  it("renders health grade", () => {
    const { lastFrame } = renderStatus({
      ...baseData,
      healthGrade: "B+",
      healthScore: 78,
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("B+");
    expect(frame).toContain("78/100");
  });

  it("renders drift summary", () => {
    const { lastFrame } = renderStatus({
      ...baseData,
      drift: { modified: 5, added: 2, deleted: 1 },
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("5 modified");
    expect(frame).toContain("2 added");
    expect(frame).toContain("1 deleted");
  });

  it("renders live session tool calls", () => {
    const { lastFrame } = renderStatus({
      ...baseData,
      liveToolCalls: { local: 80 },
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("80 calls");
    expect(frame).toContain("all local");
    expect(frame).toContain("Local rate");
  });

  it("renders latency stats", () => {
    const { lastFrame } = renderStatus({
      ...baseData,
      latency: {
        localP50: 0.8,
        localP99: 3.2,
      },
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("0.8ms");
  });

  it("shows budget warning when local p99 exceeds 5ms", () => {
    const { lastFrame } = renderStatus({
      ...baseData,
      latency: {
        localP50: 2.0,
        localP99: 7.5,
        localBudgetExceeded: true,
      },
    });
    expect(lastFrame()).toContain("⚠ >5ms");
  });

  it("renders deep link", () => {
    const { lastFrame } = renderStatus({
      ...baseData,
      deepLink: "https://app.unerr.dev/r/repo_abc123?view=drift",
    });
    expect(lastFrame()).toContain("https://app.unerr.dev/r/repo_abc123");
  });

  it("renders indexing status", () => {
    const { lastFrame } = renderStatus({
      ...baseData,
      indexingStatus: "Ready",
    });
    expect(lastFrame()).toContain("Ready");
  });

  it("renders minimal data gracefully", () => {
    const { lastFrame } = renderStatus({
      repoName: "(no repo)",
      branch: "unknown",
      proxyStatus: "Not running",
      proxyRunning: false,
      graphInfo: "No local graph",
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("(no repo)");
    expect(frame).toContain("No local graph");
    expect(frame).not.toContain("undefined");
  });
});
