/**
 * Session-keying for nudge-state one-shots. Each Claude Code hook and each
 * `unerr exec` is a fresh short-lived process; without pinning the stable
 * proxy session id they key the flags file on `pid-<pid>` and every
 * session-scoped one-shot re-fires every turn / every Bash call. These tests
 * lock in `pinSessionIdEnv`: it resolves `.unerr/state/session.id` so all such
 * processes share ONE `nudge-<sessionId>.flags`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinSessionIdEnv, updateNudgeState } from "../proxy/nudge-state.js";

describe("nudge-state session keying — pinSessionIdEnv", () => {
  // Variable-key delete (not `delete process.env.X`) per the repo lint
  // convention — biome's noDelete flags a literal member, not a computed one.
  const SID = "UNERR_SESSION_ID";
  let dir: string;
  let priorEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unerr-nudge-key-"));
    mkdirSync(join(dir, ".unerr", "state"), { recursive: true });
    priorEnv = process.env.UNERR_SESSION_ID;
    delete process.env[SID];
  });

  afterEach(() => {
    if (priorEnv === undefined) delete process.env[SID];
    else process.env.UNERR_SESSION_ID = priorEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  const flagsFiles = () =>
    readdirSync(join(dir, ".unerr", "state")).filter(
      (f) => f.startsWith("nudge-") && f.endsWith(".flags")
    );

  it("resolves .unerr/state/session.id into UNERR_SESSION_ID and keys the flags file on it (not pid)", () => {
    writeFileSync(join(dir, ".unerr", "state", "session.id"), "sess-abc123\n");

    pinSessionIdEnv(dir);
    expect(process.env.UNERR_SESSION_ID).toBe("sess-abc123");

    updateNudgeState(dir, (s) => {
      s.exec_nudge_emitted = true;
    });
    // Exactly one flags file, keyed on the session id — never a pid- file.
    expect(flagsFiles()).toEqual(["nudge-sess-abc123.flags"]);
    expect(flagsFiles().some((f) => f.includes("pid-"))).toBe(false);
  });

  it("two separate pin+write cycles for the same session share ONE flags file (one-shots gate across processes)", () => {
    writeFileSync(join(dir, ".unerr", "state", "session.id"), "sess-shared\n");

    // Simulate process A (e.g. the prompt hook) …
    pinSessionIdEnv(dir);
    updateNudgeState(dir, (s) => {
      s.static_boilerplate_emitted = true;
    });
    // … then process B (e.g. an `unerr exec` Bash call) with env cleared, as a
    // fresh process would start.
    delete process.env[SID];
    pinSessionIdEnv(dir);
    updateNudgeState(dir, (s) => {
      s.exec_nudge_emitted = true;
    });

    expect(flagsFiles()).toEqual(["nudge-sess-shared.flags"]);
  });

  it("never overrides an already-inherited UNERR_SESSION_ID", () => {
    writeFileSync(join(dir, ".unerr", "state", "session.id"), "from-file\n");
    process.env.UNERR_SESSION_ID = "inherited";

    pinSessionIdEnv(dir);
    expect(process.env.UNERR_SESSION_ID).toBe("inherited");
  });

  it("leaves env unset when no session.id file exists (degrades to pid fallback, never throws)", () => {
    expect(existsSync(join(dir, ".unerr", "state", "session.id"))).toBe(false);

    pinSessionIdEnv(dir);
    expect(process.env.UNERR_SESSION_ID).toBeUndefined();

    // Falls back to a pid-keyed file rather than crashing.
    updateNudgeState(dir, (s) => {
      s.exec_nudge_emitted = true;
    });
    expect(flagsFiles()).toEqual([`nudge-pid-${process.pid}.flags`]);
  });
});
