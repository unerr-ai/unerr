import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordFullFileReadDenied } from "../tracking/read-deny-meter.js";

describe("recordFullFileReadDenied (full-file read-deny meter)", () => {
  let repoRoot: string;
  const savedSid = process.env.UNERR_SESSION_ID;
  const savedAgent = process.env.UNERR_AGENT;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-readdeny-"));
    mkdirSync(join(repoRoot, ".unerr", "state"), { recursive: true });
    // resolveExecSessionContext reads the live session id from this file (or
    // the env). Give it one so the row has something to attribute to.
    writeFileSync(join(repoRoot, ".unerr", "state", "session.id"), "sess-read");
    process.env.UNERR_SESSION_ID = "";
    process.env.UNERR_AGENT = "";
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedSid === undefined)
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    else process.env.UNERR_SESSION_ID = savedSid;
    if (savedAgent === undefined)
      Reflect.deleteProperty(process.env, "UNERR_AGENT");
    else process.env.UNERR_AGENT = savedAgent;
  });

  it("emits one full_file_read_denied row for a denied full-file read", () => {
    expect(
      recordFullFileReadDenied(repoRoot, "src/proxy/proxy.ts", "claude-code")
    ).toBe(true);
  });

  it("drops the row when no live session id can be resolved", () => {
    rmSync(join(repoRoot, ".unerr", "state", "session.id"), { force: true });
    expect(recordFullFileReadDenied(repoRoot, "src/x.ts")).toBe(false);
  });
});
