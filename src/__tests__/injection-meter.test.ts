import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordInjectionTelemetry,
  recordOneShotEmit,
} from "../tracking/injection-meter.js";

describe("injection-meter (Issue 6/7 telemetry)", () => {
  let repoRoot: string;
  const savedSid = process.env.UNERR_SESSION_ID;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-inject-"));
    mkdirSync(join(repoRoot, ".unerr", "state"), { recursive: true });
    writeFileSync(join(repoRoot, ".unerr", "state", "session.id"), "sess-inj");
    process.env.UNERR_SESSION_ID = "";
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedSid === undefined)
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    else process.env.UNERR_SESSION_ID = savedSid;
  });

  it("emits one row per fired signal", () => {
    expect(
      recordInjectionTelemetry(repoRoot, {
        routed: "delegate",
        suppressed: "static-roster (already emitted this session)",
      })
    ).toBe(2);
  });

  it("emits only the routed row when suppression did not fire", () => {
    expect(recordInjectionTelemetry(repoRoot, { routed: "path-a-skill" })).toBe(
      1
    );
  });

  it("is a no-op when no signal fired", () => {
    expect(recordInjectionTelemetry(repoRoot, {})).toBe(0);
  });

  it("drops the rows when no live session id resolves", () => {
    rmSync(join(repoRoot, ".unerr", "state", "session.id"), { force: true });
    expect(recordInjectionTelemetry(repoRoot, { routed: "delegate" })).toBe(0);
  });

  it("recordOneShotEmit: first emit stamps (no refire), second is a refire", () => {
    // First time: stamps the durable session-keyed flag, returns false.
    expect(recordOneShotEmit(repoRoot, "static_boilerplate")).toBe(false);
    // Second time in the same session: the stamp exists → refire detected.
    expect(recordOneShotEmit(repoRoot, "static_boilerplate")).toBe(true);
  });

  it("recordOneShotEmit: distinct keys do not collide", () => {
    expect(recordOneShotEmit(repoRoot, "static_boilerplate")).toBe(false);
    expect(recordOneShotEmit(repoRoot, "mark_intent")).toBe(false);
  });
});
