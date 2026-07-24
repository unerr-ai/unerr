import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectSerializedByMasterLeak } from "../hooks/stop-hooks.js";
import { readNudgeState, updateNudgeState } from "../proxy/nudge-state.js";

// `detectSerializedByMasterLeak` no longer reads `transcript_path` (the
// journal-sentinel closing-message scraper was removed) — the pending flag
// alone is now the signal. `stdinJson` is still accepted for call-site
// compatibility, so these fixtures keep passing a transcript path; its
// content is no longer consulted.
function writeTranscript(dir: string, closing: string): string {
  const path = join(dir, "transcript.jsonl");
  const row = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: closing }] },
  };
  writeFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  return path;
}

describe("detectSerializedByMasterLeak (Issue 5 leak)", () => {
  let repoRoot: string;
  let unerrDir: string;
  const savedSid = process.env.UNERR_SESSION_ID;
  const savedCwd = process.cwd();

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-leak-"));
    unerrDir = join(repoRoot, ".unerr");
    mkdirSync(join(unerrDir, "state"), { recursive: true });
    writeFileSync(join(unerrDir, "state", "session.id"), "sess-leak");
    process.env.UNERR_SESSION_ID = "sess-leak";
    process.chdir(repoRoot);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedSid === undefined)
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    else process.env.UNERR_SESSION_ID = savedSid;
  });

  function arm(): void {
    updateNudgeState(repoRoot, (s) => {
      s.delegable_nudge_pending = true;
    });
  }

  it("is a no-op when no delegable nudge was pending", () => {
    const tp = writeTranscript(repoRoot, "did the work myself, no markers");
    expect(
      detectSerializedByMasterLeak(
        JSON.stringify({ transcript_path: tp }),
        unerrDir
      )
    ).toBe(false);
  });

  it("emits the leak whenever the nudge is left armed at turn end", () => {
    arm();
    const tp = writeTranscript(repoRoot, "renamed it myself");
    expect(
      detectSerializedByMasterLeak(
        JSON.stringify({ transcript_path: tp }),
        unerrDir
      )
    ).toBe(true);
    // flag disarmed after firing once
    expect(readNudgeState(repoRoot).delegable_nudge_pending).toBe(false);
  });

  it("fires at most once — second call after disarm is a no-op", () => {
    arm();
    const tp = writeTranscript(repoRoot, "no markers");
    expect(
      detectSerializedByMasterLeak(
        JSON.stringify({ transcript_path: tp }),
        unerrDir
      )
    ).toBe(true);
    expect(
      detectSerializedByMasterLeak(
        JSON.stringify({ transcript_path: tp }),
        unerrDir
      )
    ).toBe(false);
  });
});
