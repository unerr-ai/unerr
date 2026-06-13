/**
 * Tests for sweepNudgeFlags — boot reclamation of per-session
 * `.unerr/state/nudge-<session>.flags` files.
 *
 * Contract: one flag file is minted per session and nothing else deletes
 * them (we found 890 accreted). A dead session's file is read by nothing
 * (`readNudgeState` + the dashboard ribbon only ever read the LIVE session's
 * path), so the boot sweep deletes EVERY non-active flag file outright. It
 * must (a) delete all non-active nudge files regardless of age, (b) NEVER
 * delete the current session's file, and (c) ignore non-nudge files.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepNudgeFlags } from "../proxy/nudge-state.js";

const DAY_MS = 86_400_000;

describe("sweepNudgeFlags", () => {
  let cwd: string;
  let stateDir: string;
  const prevSession = process.env.UNERR_SESSION_ID;

  beforeEach(() => {
    cwd = join(
      os.tmpdir(),
      `unerr-nudge-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    stateDir = join(cwd, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    if (prevSession === undefined)
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    else process.env.UNERR_SESSION_ID = prevSession;
  });

  function flag(session: string, ageDays = 0): string {
    const p = join(stateDir, `nudge-${session}.flags`);
    writeFileSync(p, "{}");
    if (ageDays > 0) {
      const t = (Date.now() - ageDays * DAY_MS) / 1000;
      utimesSync(p, t, t);
    }
    return p;
  }

  it("returns 0 when the state dir is missing", () => {
    rmSync(stateDir, { recursive: true, force: true });
    expect(sweepNudgeFlags(cwd)).toBe(0);
  });

  it("deletes every non-active flag file regardless of age", () => {
    // Active session pinned so its own file is the only survivor.
    process.env.UNERR_SESSION_ID = "activesession";
    flag("activesession", 0);
    const fresh = flag("bbbbbbbbbbbb", 0); // today
    const old = flag("aaaaaaaaaaaa", 100); // ancient
    const removed = sweepNudgeFlags(cwd);
    expect(removed).toBe(2);
    expect(existsSync(fresh)).toBe(false); // age is irrelevant — deleted
    expect(existsSync(old)).toBe(false);
  });

  it("never deletes the current session's file", () => {
    process.env.UNERR_SESSION_ID = "activesession";
    const active = flag("activesession", 100); // ancient, but active
    const stale = flag("deadsession0", 0); // brand new, but dead
    const removed = sweepNudgeFlags(cwd);
    expect(existsSync(active)).toBe(true); // spared despite age
    expect(existsSync(stale)).toBe(false); // deleted despite being fresh
    expect(removed).toBe(1);
  });

  it("ignores non-nudge files in the state dir", () => {
    const other = join(stateDir, "file_hashes.json");
    writeFileSync(other, "{}");
    utimesSync(other, 1, 1); // ancient
    sweepNudgeFlags(cwd);
    expect(existsSync(other)).toBe(true);
  });

  it("leaves only the active file when many dead sessions exist", () => {
    process.env.UNERR_SESSION_ID = "activesession";
    flag("activesession", 0);
    for (let i = 0; i < 10; i++) flag(`s${i}0000000000`.slice(0, 12), i);
    sweepNudgeFlags(cwd);
    const left = readdirSync(stateDir).filter((n) => n.startsWith("nudge-"));
    expect(left).toEqual(["nudge-activesession.flags"]);
  });
});
