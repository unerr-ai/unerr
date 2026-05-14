import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { createLifecycleActor } from "../proxy/lifecycle-actor.js";
import {
  type ProxyStateValue,
  proxyMachine,
} from "../proxy/lifecycle-machine.js";

function makeActor() {
  return createActor(proxyMachine, { input: { repoPath: "/test/repo" } });
}

function stateOf(actor: ReturnType<typeof makeActor>): ProxyStateValue {
  return actor.getSnapshot().value as ProxyStateValue;
}

describe("Proxy Lifecycle Machine", () => {
  it("starts in idle state", () => {
    const actor = makeActor();
    actor.start();
    expect(stateOf(actor)).toBe("idle");
    actor.stop();
  });

  it("transitions idle → detecting on START_DETECT", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    expect(stateOf(actor)).toBe("detecting");
    actor.stop();
  });

  it("transitions detecting → setup when needsSetup is true", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "DETECT_COMPLETE", needsSetup: true });
    expect(stateOf(actor)).toBe("setup");
    actor.stop();
  });

  it("transitions detecting → indexing when needsSetup is false", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({
      type: "DETECT_COMPLETE",
      needsSetup: false,
      repoId: "repo-123",
    });
    expect(stateOf(actor)).toBe("indexing");
    expect(actor.getSnapshot().context.repoId).toBe("repo-123");
    actor.stop();
  });

  it("transitions setup → indexing on SETUP_COMPLETE", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "DETECT_COMPLETE", needsSetup: true });
    actor.send({ type: "SETUP_COMPLETE", repoId: "new-repo" });
    expect(stateOf(actor)).toBe("indexing");
    expect(actor.getSnapshot().context.repoId).toBe("new-repo");
    actor.stop();
  });

  it("transitions indexing → ready on INDEX_COMPLETE", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "DETECT_COMPLETE", needsSetup: false });
    actor.send({ type: "INDEX_COMPLETE" });
    expect(stateOf(actor)).toBe("ready");
    actor.stop();
  });

  it("transitions ready → running on MCP_READY", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "DETECT_COMPLETE", needsSetup: false });
    actor.send({ type: "INDEX_COMPLETE" });
    actor.send({ type: "MCP_READY" });
    expect(stateOf(actor)).toBe("running");
    expect(actor.getSnapshot().context.mcpReady).toBe(true);
    actor.stop();
  });

  it("handles GRAPH_LOADED during indexing without state change", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "DETECT_COMPLETE", needsSetup: false });
    actor.send({ type: "GRAPH_LOADED" });
    expect(stateOf(actor)).toBe("indexing");
    expect(actor.getSnapshot().context.graphLoaded).toBe(true);
    actor.stop();
  });

  it("transitions running → shutdown on SHUTDOWN", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "DETECT_COMPLETE", needsSetup: false });
    actor.send({ type: "INDEX_COMPLETE" });
    actor.send({ type: "MCP_READY" });
    actor.send({ type: "SHUTDOWN" });
    expect(stateOf(actor)).toBe("shutdown");
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });

  it("transitions running → error on ERROR", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "DETECT_COMPLETE", needsSetup: false });
    actor.send({ type: "INDEX_COMPLETE" });
    actor.send({ type: "MCP_READY" });
    actor.send({ type: "ERROR", message: "something broke" });
    expect(stateOf(actor)).toBe("error");
    expect(actor.getSnapshot().context.error).toBe("something broke");
    actor.stop();
  });

  it("transitions error → shutdown on SHUTDOWN", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "DETECT_COMPLETE", needsSetup: false });
    actor.send({ type: "INDEX_COMPLETE" });
    actor.send({ type: "MCP_READY" });
    actor.send({ type: "ERROR", message: "fail" });
    actor.send({ type: "SHUTDOWN" });
    expect(stateOf(actor)).toBe("shutdown");
    actor.stop();
  });

  it("handles ERROR during indexing", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "DETECT_COMPLETE", needsSetup: false });
    actor.send({ type: "ERROR", message: "index failure" });
    expect(stateOf(actor)).toBe("error");
    expect(actor.getSnapshot().context.error).toBe("index failure");
    actor.stop();
  });

  it("handles ERROR during detecting", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "START_DETECT" });
    actor.send({ type: "ERROR", message: "git not found" });
    expect(stateOf(actor)).toBe("error");
    actor.stop();
  });

  it("records bootStartedAt in context", () => {
    const before = Date.now();
    const actor = makeActor();
    actor.start();
    const after = Date.now();
    const ctx = actor.getSnapshot().context;
    expect(ctx.bootStartedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.bootStartedAt).toBeLessThanOrEqual(after);
    actor.stop();
  });

  it("ignores invalid events for current state", () => {
    const actor = makeActor();
    actor.start();
    actor.send({ type: "MCP_READY" });
    expect(stateOf(actor)).toBe("idle");
    actor.stop();
  });
});

describe("Lifecycle Actor wrapper", () => {
  it("provides imperative getState() API", () => {
    const lifecycle = createLifecycleActor("/test");
    expect(lifecycle.getState()).toBe("idle");
    lifecycle.send({ type: "START_DETECT" });
    expect(lifecycle.getState()).toBe("detecting");
    lifecycle.stop();
  });

  it("provides getSnapshot() with value and context", () => {
    const lifecycle = createLifecycleActor("/test");
    const snap = lifecycle.getSnapshot();
    expect(snap.value).toBe("idle");
    expect(snap.context.repoPath).toBe("/test");
    lifecycle.stop();
  });

  it("subscribe() receives state transition notifications", () => {
    const lifecycle = createLifecycleActor("/test");
    const states: string[] = [];

    const sub = lifecycle.subscribe((state) => {
      states.push(state);
    });

    lifecycle.send({ type: "START_DETECT" });
    lifecycle.send({ type: "DETECT_COMPLETE", needsSetup: false });

    expect(states).toContain("detecting");
    expect(states).toContain("indexing");

    sub.unsubscribe();
    lifecycle.stop();
  });

  it("waitForState() resolves when target state is reached", async () => {
    const lifecycle = createLifecycleActor("/test");
    lifecycle.send({ type: "START_DETECT" });

    const promise = lifecycle.waitForState("indexing", 1000);
    lifecycle.send({ type: "DETECT_COMPLETE", needsSetup: false });

    await expect(promise).resolves.toBeUndefined();
    lifecycle.stop();
  });

  it("waitForState() resolves immediately if already in target state", async () => {
    const lifecycle = createLifecycleActor("/test");
    await lifecycle.waitForState("idle", 100);
    lifecycle.stop();
  });

  it("full happy path: idle → running", () => {
    const lifecycle = createLifecycleActor("/test");
    lifecycle.send({ type: "START_DETECT" });
    lifecycle.send({
      type: "DETECT_COMPLETE",
      needsSetup: false,
      repoId: "r1",
    });
    lifecycle.send({ type: "GRAPH_LOADED" });
    lifecycle.send({ type: "INDEX_COMPLETE" });
    lifecycle.send({ type: "MCP_READY" });
    expect(lifecycle.getState()).toBe("running");
    expect(lifecycle.getContext().graphLoaded).toBe(true);
    expect(lifecycle.getContext().mcpReady).toBe(true);
    lifecycle.stop();
  });

  it("full setup path: idle → setup → running", () => {
    const lifecycle = createLifecycleActor("/test");
    lifecycle.send({ type: "START_DETECT" });
    lifecycle.send({ type: "DETECT_COMPLETE", needsSetup: true });
    lifecycle.send({ type: "SETUP_COMPLETE", repoId: "new-repo" });
    lifecycle.send({ type: "INDEX_COMPLETE" });
    lifecycle.send({ type: "MCP_READY" });
    expect(lifecycle.getState()).toBe("running");
    expect(lifecycle.getContext().repoId).toBe("new-repo");
    lifecycle.stop();
  });
});
