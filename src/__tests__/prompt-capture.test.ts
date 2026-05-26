/**
 * Fix J — verbatim user prompt capture + read projection.
 *
 * Covers the writer (`recordUserPromptReceived`), the config flag reader,
 * the read-side projection (`getPromptForTurn` / `getPromptsForSession`),
 * and the READ-time redactor.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCapturePromptsFlag,
  readProxySessionId,
  recordUserPromptReceived,
  redactPrompt,
} from "../hooks/prompt-capture.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";
import {
  getPromptForTurn,
  getPromptsForSession,
} from "../tracking/prompt-trace.js";

function makeFixture(): {
  unerrDir: string;
  cwd: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), "unerr-prompt-cap-"));
  const unerrDir = join(cwd, ".unerr");
  mkdirSync(unerrDir, { recursive: true });
  return {
    unerrDir,
    cwd,
    cleanup: () => {
      closeMetricsStore(unerrDir);
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

describe("readCapturePromptsFlag (Fix J)", () => {
  let fix: ReturnType<typeof makeFixture>;
  beforeEach(() => {
    fix = makeFixture();
  });
  afterEach(() => fix.cleanup());

  it("defaults to false when config.json is absent", () => {
    expect(readCapturePromptsFlag(fix.cwd)).toBe(false);
  });

  it("returns true when capture_prompts: true is set", () => {
    writeFileSync(
      join(fix.unerrDir, "config.json"),
      JSON.stringify({ capture_prompts: true })
    );
    expect(readCapturePromptsFlag(fix.cwd)).toBe(true);
  });

  it("returns false on any non-true value (string, 1, etc.)", () => {
    writeFileSync(
      join(fix.unerrDir, "config.json"),
      JSON.stringify({ capture_prompts: "true" })
    );
    expect(readCapturePromptsFlag(fix.cwd)).toBe(false);
  });

  it("returns false on malformed JSON", () => {
    writeFileSync(join(fix.unerrDir, "config.json"), "{not valid");
    expect(readCapturePromptsFlag(fix.cwd)).toBe(false);
  });
});

describe("recordUserPromptReceived (Fix J)", () => {
  let fix: ReturnType<typeof makeFixture>;
  beforeEach(() => {
    fix = makeFixture();
  });
  afterEach(() => fix.cleanup());

  it("stores operational metadata even when capture_prompts is false (default)", () => {
    const rowId = recordUserPromptReceived({
      unerrDir: fix.unerrDir,
      cwd: fix.cwd,
      sessionId: "s1",
      message: "fix the broken indexer",
      classifiedAs: "fix",
      hookPayloadChars: 200,
    });
    expect(rowId).toBeGreaterThan(0);
    const result = getPromptForTurn(fix.unerrDir, "s1", 0);
    expect(result).not.toBeNull();
    expect(result?.prompt).toBeNull(); // content suppressed by default
    expect(result?.length).toBe("fix the broken indexer".length);
    expect(result?.classified_as).toBe("fix");
  });

  it("stores verbatim prompt when capture_prompts: true", () => {
    writeFileSync(
      join(fix.unerrDir, "config.json"),
      JSON.stringify({ capture_prompts: true })
    );
    recordUserPromptReceived({
      unerrDir: fix.unerrDir,
      cwd: fix.cwd,
      sessionId: "s2",
      message: "refactor the auth module",
      classifiedAs: "refactor",
      hookPayloadChars: 150,
    });
    const result = getPromptForTurn(fix.unerrDir, "s2", 0);
    expect(result?.prompt).toBe("refactor the auth module");
    expect(result?.classified_as).toBe("refactor");
  });

  it("returns the latest capture when called with turn>0 (hook captures with turn=0)", () => {
    writeFileSync(
      join(fix.unerrDir, "config.json"),
      JSON.stringify({ capture_prompts: true })
    );
    recordUserPromptReceived({
      unerrDir: fix.unerrDir,
      cwd: fix.cwd,
      sessionId: "s3",
      message: "first prompt",
      classifiedAs: "build",
      hookPayloadChars: 100,
    });
    recordUserPromptReceived({
      unerrDir: fix.unerrDir,
      cwd: fix.cwd,
      sessionId: "s3",
      message: "second prompt",
      classifiedAs: "fix",
      hookPayloadChars: 100,
    });
    // Trace pages ask for a tool-call turn (1, 2, …); the hook wrote
    // turn=0. The projection falls back to the most-recent capture.
    const result = getPromptForTurn(fix.unerrDir, "s3", 1);
    expect(result?.prompt).toBe("second prompt");
  });
});

describe("recordUserPromptReceived — boundary dedupe", () => {
  let fix: ReturnType<typeof makeFixture>;
  beforeEach(() => {
    fix = makeFixture();
    writeFileSync(
      join(fix.unerrDir, "config.json"),
      JSON.stringify({ capture_prompts: true })
    );
  });
  afterEach(() => fix.cleanup());

  it("collapses an exact re-fire of the same prompt within the window", () => {
    const fire = () =>
      recordUserPromptReceived({
        unerrDir: fix.unerrDir,
        cwd: fix.cwd,
        sessionId: "dup-sess",
        message: "fix the broken indexer",
        classifiedAs: "fix",
        hookPayloadChars: 200,
      });
    // First fire persists; the 2nd and 3rd (the duplicate hook fires) are
    // skipped — they land within the 2s window with an identical digest.
    expect(fire()).toBeGreaterThan(0);
    expect(fire()).toBe(0);
    expect(fire()).toBe(0);

    // Exactly one boundary row survives for this session.
    expect(getPromptsForSession(fix.unerrDir, "dup-sess").length).toBe(1);
  });

  it("keeps two distinct prompts that share a length (digest differs)", () => {
    // "yes" and "yep" are both 3 chars — a length-only dedupe would have
    // wrongly collapsed the second. The content digest keeps them apart.
    recordUserPromptReceived({
      unerrDir: fix.unerrDir,
      cwd: fix.cwd,
      sessionId: "len-sess",
      message: "yes",
      classifiedAs: null,
      hookPayloadChars: 50,
    });
    const second = recordUserPromptReceived({
      unerrDir: fix.unerrDir,
      cwd: fix.cwd,
      sessionId: "len-sess",
      message: "yep",
      classifiedAs: null,
      hookPayloadChars: 50,
    });
    expect(second).toBeGreaterThan(0);
    expect(getPromptsForSession(fix.unerrDir, "len-sess").map((r) => r.prompt)).toEqual([
      "yes",
      "yep",
    ]);
  });

  it("does not dedupe across separate sessions", () => {
    const a = recordUserPromptReceived({
      unerrDir: fix.unerrDir,
      cwd: fix.cwd,
      sessionId: "sess-A",
      message: "same message",
      classifiedAs: null,
      hookPayloadChars: 50,
    });
    const b = recordUserPromptReceived({
      unerrDir: fix.unerrDir,
      cwd: fix.cwd,
      sessionId: "sess-B",
      message: "same message",
      classifiedAs: null,
      hookPayloadChars: 50,
    });
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });
});

describe("getPromptsForSession (Fix J)", () => {
  let fix: ReturnType<typeof makeFixture>;
  beforeEach(() => {
    fix = makeFixture();
  });
  afterEach(() => fix.cleanup());

  it("returns every captured prompt for one session", () => {
    writeFileSync(
      join(fix.unerrDir, "config.json"),
      JSON.stringify({ capture_prompts: true })
    );
    for (const msg of ["one", "two", "three"]) {
      recordUserPromptReceived({
        unerrDir: fix.unerrDir,
        cwd: fix.cwd,
        sessionId: "bulk-sess",
        message: msg,
        classifiedAs: null,
        hookPayloadChars: 50,
      });
    }
    const rows = getPromptsForSession(fix.unerrDir, "bulk-sess");
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.prompt)).toEqual(["one", "two", "three"]);
  });
});

describe("readProxySessionId — hook↔proxy session join", () => {
  let fix: ReturnType<typeof makeFixture>;
  const savedEnv = process.env.UNERR_SESSION_ID;
  beforeEach(() => {
    fix = makeFixture();
    delete process.env.UNERR_SESSION_ID;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.UNERR_SESSION_ID;
    else process.env.UNERR_SESSION_ID = savedEnv;
    fix.cleanup();
  });

  it("returns null when neither env nor state/session.id exists", () => {
    expect(readProxySessionId(fix.unerrDir)).toBeNull();
  });

  it("reads the proxy-written .unerr/state/session.id", () => {
    mkdirSync(join(fix.unerrDir, "state"), { recursive: true });
    writeFileSync(join(fix.unerrDir, "state", "session.id"), "6a0258c88259\n");
    expect(readProxySessionId(fix.unerrDir)).toBe("6a0258c88259");
  });

  it("prefers UNERR_SESSION_ID over the file", () => {
    mkdirSync(join(fix.unerrDir, "state"), { recursive: true });
    writeFileSync(join(fix.unerrDir, "state", "session.id"), "from-file");
    process.env.UNERR_SESSION_ID = "from-env";
    expect(readProxySessionId(fix.unerrDir)).toBe("from-env");
  });

  it("returns null on an empty session.id file (falls back to agent id)", () => {
    mkdirSync(join(fix.unerrDir, "state"), { recursive: true });
    writeFileSync(join(fix.unerrDir, "state", "session.id"), "   \n");
    expect(readProxySessionId(fix.unerrDir)).toBeNull();
  });
});

describe("redactPrompt (Fix J)", () => {
  it("redacts api_key tokens", () => {
    const input = "use api_key=sk_live_AbCdEfGhIjKl1234567890 to call";
    const out = redactPrompt(input);
    expect(out).not.toContain("sk_live_AbCdEfGhIjKl1234567890");
    expect(out).toContain("****");
  });

  it("redacts password tokens", () => {
    const input = "password: hunter2hunter2hunter2";
    const out = redactPrompt(input);
    expect(out).not.toContain("hunter2hunter2hunter2");
  });

  it("redacts bearer tokens", () => {
    const input = "Authorization: bearer xYz_aBcDeFgHiJkL_-12345";
    const out = redactPrompt(input);
    expect(out).not.toContain("xYz_aBcDeFgHiJkL_-12345");
  });

  it("leaves non-sensitive text unchanged", () => {
    const input = "refactor the auth module";
    expect(redactPrompt(input)).toBe(input);
  });
});
