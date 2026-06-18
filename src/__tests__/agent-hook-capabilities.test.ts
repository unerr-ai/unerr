/**
 * Guard for the granular hook-capability matrix in src/config/agent-registry.ts.
 *
 * Phase-2 mechanism selection lifts capabilities onto hooks ONLY for agents
 * whose hook system can actually carry agent-readable context. This locks the
 * facts that drive that decision so a registry edit can't silently regress an
 * agent into the wrong catalog (e.g. assuming Cursor can inject prompt context
 * when its beforeSubmitPrompt can only edit the user message).
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_REGISTRY,
  DEFAULT_NO_HOOKS,
  getHookCapabilities,
} from "../config/agent-registry.js";

describe("agent hook-capability matrix", () => {
  it("declares granular hooks for exactly the hookSupport agents", () => {
    for (const agent of AGENT_REGISTRY) {
      if (agent.hookSupport) {
        expect(
          agent.hooks,
          `${agent.id} hookSupport=true needs hooks`
        ).toBeDefined();
      } else {
        expect(
          agent.hooks,
          `${agent.id} hookSupport=false must omit hooks`
        ).toBeUndefined();
      }
    }
  });

  it("getHookCapabilities falls back to DEFAULT_NO_HOOKS for hook-less agents", () => {
    expect(getHookCapabilities("vscode")).toEqual(DEFAULT_NO_HOOKS);
    expect(getHookCapabilities("zed")).toEqual(DEFAULT_NO_HOOKS);
  });

  it("Claude Code can inject context at every moment", () => {
    const cc = getHookCapabilities("claude-code");
    expect(cc.promptContextInject).toBe(true);
    expect(cc.toolContextInject).toBe(true);
    expect(cc.sessionStart).toBe(true);
    expect(cc.stop).toBe(true);
    expect(cc.adapter).toBe("built");
  });

  it("Cursor has hooks but cannot inject prompt-submit context", () => {
    const cur = getHookCapabilities("cursor");
    expect(cur.promptContextInject).toBe(false); // beforeSubmitPrompt = user_message only
    expect(cur.toolContextInject).toBe(true);
    expect(cur.adapter).toBe("built");
  });

  it("Gemini adapter is still planned, Windsurf adapter is now built", () => {
    expect(getHookCapabilities("gemini-cli").adapter).toBe("planned");
    expect(getHookCapabilities("windsurf").adapter).toBe("built");
  });

  it("every hooks profile names a valid adapter status", () => {
    for (const agent of AGENT_REGISTRY) {
      if (agent.hooks) {
        expect(["built", "planned", "none"]).toContain(agent.hooks.adapter);
      }
    }
  });
});
