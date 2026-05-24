import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ClientProfile,
  getAllProfiles,
  getClientProfile,
  isKnownClient,
} from "../router/client-profiles.js";

import {
  type CapabilityOverride,
  type ClientCapabilities,
  type ClientInfo,
  createProbeMonitor,
  detectCapabilities,
  finalizeProbeResult,
} from "../router/client-capability.js";

// ── Client Profiles ──────────────────────────────────────────────

describe("Client Profiles", () => {
  it("returns correct profile for Claude Code", () => {
    const profile = getClientProfile("claude-code");
    expect(profile.listChanged).toBe(true);
    expect(profile.channel).toBe("dynamic");
  });

  it("returns correct profile for Claude Code CLI variant", () => {
    const profile = getClientProfile("claude_code_cli");
    expect(profile.listChanged).toBe(true);
    expect(profile.channel).toBe("dynamic");
  });

  it("returns correct profile for Cursor", () => {
    const profile = getClientProfile("cursor");
    expect(profile.listChanged).toBe(false);
    expect(profile.channel).toBe("soft-refuse");
  });

  it("returns correct profile for Cline", () => {
    const profile = getClientProfile("cline");
    expect(profile.listChanged).toBe(false);
    expect(profile.channel).toBe("soft-refuse");
  });

  it("returns correct profile for VS Code Copilot", () => {
    const profile = getClientProfile("vscode-copilot-chat");
    expect(profile.listChanged).toBe("probe");
    expect(profile.channel).toBe("auto-detect");
  });

  it("returns correct profile for Codex CLI", () => {
    const profile = getClientProfile("openai-codex");
    expect(profile.listChanged).toBe(false);
    expect(profile.channel).toBe("soft-refuse");
  });

  it("returns correct profile for Continue", () => {
    const profile = getClientProfile("continue-dev");
    expect(profile.listChanged).toBe("probe");
    expect(profile.channel).toBe("auto-detect");
  });

  it("returns correct profile for Windsurf", () => {
    const profile = getClientProfile("windsurf");
    expect(profile.listChanged).toBe(false);
    expect(profile.channel).toBe("soft-refuse");
  });

  it("returns correct profile for Zed", () => {
    const profile = getClientProfile("zed");
    expect(profile.listChanged).toBe("probe");
    expect(profile.channel).toBe("auto-detect");
  });

  it("returns correct profile for Gemini CLI", () => {
    const profile = getClientProfile("gemini-cli");
    expect(profile.listChanged).toBe(false);
    expect(profile.channel).toBe("soft-refuse");
  });

  it("returns unknown profile for unrecognized client", () => {
    const profile = getClientProfile("my-custom-ide");
    expect(profile.name).toBe("Unknown");
    expect(profile.listChanged).toBe("probe");
    expect(profile.channel).toBe("auto-detect");
  });

  it("returns unknown profile for undefined/null client name", () => {
    const profile = getClientProfile(undefined);
    expect(profile.name).toBe("Unknown");
    expect(profile.listChanged).toBe("probe");
  });

  it("is case-insensitive", () => {
    expect(getClientProfile("Cursor").listChanged).toBe(false);
    expect(getClientProfile("CLAUDE-CODE").listChanged).toBe(true);
    expect(getClientProfile("Cline").listChanged).toBe(false);
  });

  it("isKnownClient identifies known vs unknown", () => {
    expect(isKnownClient("cursor")).toBe(true);
    expect(isKnownClient("claude-code")).toBe(true);
    expect(isKnownClient("my-ide")).toBe(false);
  });

  it("getAllProfiles returns at least 10 entries", () => {
    const profiles = getAllProfiles();
    expect(profiles.size).toBeGreaterThanOrEqual(10);
  });
});

// ── Capability Detection ─────────────────────────────────────────

describe("detectCapabilities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects Claude Code as dynamic (static profile)", () => {
    const caps = detectCapabilities({ name: "claude-code" }, undefined);
    expect(caps.listChanged).toBe(true);
    expect(caps.channel).toBe("dynamic");
    expect(caps.detectionMethod).toBe("static-profile");
  });

  it("detects Cursor as soft-refuse (static profile)", () => {
    const caps = detectCapabilities({ name: "cursor" }, undefined);
    expect(caps.listChanged).toBe(false);
    expect(caps.channel).toBe("soft-refuse");
    expect(caps.detectionMethod).toBe("static-profile");
  });

  it("detects Cline as soft-refuse", () => {
    const caps = detectCapabilities({ name: "cline" }, undefined);
    expect(caps.listChanged).toBe(false);
    expect(caps.channel).toBe("soft-refuse");
  });

  it("detects Windsurf as soft-refuse", () => {
    const caps = detectCapabilities({ name: "windsurf" }, undefined);
    expect(caps.listChanged).toBe(false);
  });

  it("detects Gemini CLI as soft-refuse", () => {
    const caps = detectCapabilities({ name: "gemini-cli" }, undefined);
    expect(caps.listChanged).toBe(false);
  });

  it("detects Codex CLI as soft-refuse", () => {
    const caps = detectCapabilities({ name: "openai-codex" }, undefined);
    expect(caps.listChanged).toBe(false);
  });

  it("returns probe-pending for unknown clients", () => {
    const caps = detectCapabilities({ name: "unknown-ide" }, undefined);
    expect(caps.listChanged).toBe(false);
    expect(caps.detectionMethod).toBe("probe");
  });

  it("handles undefined clientInfo", () => {
    const caps = detectCapabilities(undefined, undefined);
    expect(caps.clientName).toBe("unknown");
    expect(caps.detectionMethod).toBe("probe");
  });

  // ── Per-repo overrides ─────────────────────────────────────────

  it("force-list-changed override bypasses profile", () => {
    const caps = detectCapabilities({ name: "cursor" }, "force-list-changed");
    expect(caps.listChanged).toBe(true);
    expect(caps.channel).toBe("dynamic");
    expect(caps.detectionMethod).toBe("override");
  });

  it("force-static override bypasses profile", () => {
    const caps = detectCapabilities({ name: "claude-code" }, "force-static");
    expect(caps.listChanged).toBe(false);
    expect(caps.channel).toBe("soft-refuse");
    expect(caps.detectionMethod).toBe("override");
  });

  it("undefined override falls through to normal detection", () => {
    const caps = detectCapabilities({ name: "claude-code" }, undefined);
    expect(caps.listChanged).toBe(true);
    expect(caps.detectionMethod).toBe("static-profile");
  });
});

// ── Probe Monitor ────────────────────────────────────────────────

describe("createProbeMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects refetch during probe window → supports list_changed", () => {
    const monitor = createProbeMonitor();
    let result: boolean | null = null;

    const callbacks = monitor.getCallbacks((supported) => {
      result = supported;
    });

    callbacks.sendListChanged();
    monitor.markRefetch();

    expect(result).toBe(true);
  });

  it("no refetch within window → does not support list_changed", () => {
    const monitor = createProbeMonitor();
    let result: boolean | null = null;

    const callbacks = monitor.getCallbacks((supported) => {
      result = supported;
    });

    callbacks.sendListChanged();
    callbacks.onProbeComplete(false);

    expect(result).toBe(false);
  });

  it("refetch after probe complete is ignored", () => {
    const monitor = createProbeMonitor();
    let callCount = 0;

    const callbacks = monitor.getCallbacks(() => {
      callCount++;
    });

    callbacks.sendListChanged();
    callbacks.onProbeComplete(false);
    monitor.markRefetch();

    expect(callCount).toBe(1);
  });

  it("multiple refetches only trigger callback once", () => {
    const monitor = createProbeMonitor();
    let callCount = 0;

    const callbacks = monitor.getCallbacks(() => {
      callCount++;
    });

    callbacks.sendListChanged();
    monitor.markRefetch();
    monitor.markRefetch();
    monitor.markRefetch();

    expect(callCount).toBe(1);
  });
});

// ── Finalize Probe Result ────────────────────────────────────────

describe("finalizeProbeResult", () => {
  it("creates capabilities with dynamic channel when probe succeeds", () => {
    const caps = finalizeProbeResult("vscode-copilot-chat", true);
    expect(caps.listChanged).toBe(true);
    expect(caps.channel).toBe("dynamic");
    expect(caps.detectionMethod).toBe("probe");
  });

  it("creates capabilities with soft-refuse when probe fails", () => {
    const caps = finalizeProbeResult("zed", false);
    expect(caps.listChanged).toBe(false);
    expect(caps.channel).toBe("soft-refuse");
    expect(caps.detectionMethod).toBe("probe");
  });

  it("includes timestamp", () => {
    const before = Date.now();
    const caps = finalizeProbeResult("test-client", true);
    expect(caps.detectedAt).toBeGreaterThanOrEqual(before);
  });
});
