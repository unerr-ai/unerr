/**
 * Sprint 4 — login-blocked passthrough for the non-interactive surfaces.
 *
 * The IDE hooks (PreToolUse/PostToolUse) and git pre-commit/post-commit shell
 * out to `unerr hook …` / `exec` / `compress-output` / `check-commit`. When the
 * machine is signed out (`loginBlocked()`), every one of these MUST pass through
 * unchanged: no graph-aware work, no deny, no throw, no non-zero exit, no
 * browser — and at most ONE throttled `ur|act` login nudge per repo per window.
 *
 * The gate composes `authState()`, so we drive it by mocking auth-state and
 * exercise the real `loginBlocked()`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState, AuthStateName } from "../cloud/auth-state.js";

const authStateMock = vi.fn<(now?: number) => AuthState>();
vi.mock("../cloud/auth-state.js", () => ({
  authState: (now?: number) => authStateMock(now),
}));

// loginBlocked() also requires real login presence (credential metadata).
// blocked()/allowed() drive both inputs together.
const credentialMetaMock = vi.fn<() => unknown>();
vi.mock("../cloud/credentials.js", () => ({
  readCredentialMetadata: () => credentialMetaMock(),
}));

import { registerCheckCommitCommand } from "../commands/check-commit.js";
import { registerCompressOutputCommand } from "../commands/compress-output.js";
import { runExecMain } from "../commands/exec.js";
import { registerHookCommand } from "../commands/hook.js";
import {
  LOGIN_NUDGE_LINE,
  LOGIN_NUDGE_WINDOW_MS,
  nudgeIfLoggedOut,
  shouldEmitLoginNudge,
} from "../hooks/login-nudge.js";

function stateOf(name: AuthStateName): AuthState {
  return {
    state: name,
    plan: name === "active" ? "pro" : "free",
    features: {},
    was_authenticated: name !== "logged_out",
  };
}

function blocked() {
  authStateMock.mockReturnValue(stateOf("logged_out"));
  credentialMetaMock.mockReturnValue(null);
}
function allowed() {
  authStateMock.mockReturnValue(stateOf("active"));
  credentialMetaMock.mockReturnValue({ organization_id: "org_1" });
}

let dir: string;
let prevCwd: string;
let prevShell: string | undefined;
let stdoutChunks: string[];
let stderrChunks: string[];

function execArgv(cmd: string): string[] {
  return [
    "node",
    "unerr",
    "exec",
    "--b64",
    Buffer.from(cmd, "utf-8").toString("base64"),
  ];
}
function stdout(): string {
  return stdoutChunks.join("");
}
function stderr(): string {
  return stderrChunks.join("");
}

beforeEach(() => {
  authStateMock.mockReset();
  credentialMetaMock.mockReset();
  Reflect.deleteProperty(process.env, "UNERR_TOKEN");
  Reflect.deleteProperty(process.env, "UNERR_QUIET");
  Reflect.deleteProperty(process.env, "CI");
  dir = mkdtempSync(join(tmpdir(), "unerr-login-passthrough-"));
  prevCwd = process.cwd();
  process.chdir(dir);
  prevShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  stdoutChunks = [];
  stderrChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(prevCwd);
  if (prevShell === undefined) Reflect.deleteProperty(process.env, "SHELL");
  else process.env.SHELL = prevShell;
  rmSync(dir, { recursive: true, force: true });
});

// ── Throttle (the shared nudge helper) ──────────────────────────────────────

describe("shouldEmitLoginNudge — throttle", () => {
  it("emits the first time, suppresses inside the window", () => {
    const t0 = 1_000_000;
    expect(shouldEmitLoginNudge(dir, t0)).toBe(true);
    expect(shouldEmitLoginNudge(dir, t0 + 60_000)).toBe(false);
    expect(shouldEmitLoginNudge(dir, t0 + LOGIN_NUDGE_WINDOW_MS - 1)).toBe(
      false
    );
  });

  it("re-emits once the window has elapsed", () => {
    const t0 = 1_000_000;
    expect(shouldEmitLoginNudge(dir, t0)).toBe(true);
    expect(shouldEmitLoginNudge(dir, t0 + LOGIN_NUDGE_WINDOW_MS)).toBe(true);
  });

  it("never throws when the state dir cannot be written", () => {
    // A path whose parent is a file, so mkdir/write cannot succeed.
    const badCwd = join(dir, "not-a-dir-file");
    writeFileSync(badCwd, "x");
    expect(() => shouldEmitLoginNudge(badCwd)).not.toThrow();
    // Fail-open: with no persisted marker it emits.
    expect(shouldEmitLoginNudge(badCwd)).toBe(true);
  });
});

// ── exec ─────────────────────────────────────────────────────────────────────

describe("runExecMain — login blocked", () => {
  it("prints raw output unchanged and a single nudge, exit unchanged", async () => {
    blocked();
    const code = await runExecMain(execArgv("echo hello-from-shell"));
    expect(code).toBe(0);
    expect(stdout()).toContain("hello-from-shell");
    expect(stdout()).toContain(LOGIN_NUDGE_LINE);
  }, 20000);

  it("does not emit the nudge twice within the window", async () => {
    blocked();
    await runExecMain(execArgv("echo first"));
    await runExecMain(execArgv("echo second"));
    const count = (stdout().match(/ur\|act run `unerr login`/g) ?? []).length;
    expect(count).toBe(1);
  }, 20000);

  it("propagates a non-zero command exit (login is not the failure)", async () => {
    blocked();
    const code = await runExecMain(execArgv("echo boom; exit 7"));
    expect(code).toBe(7);
    expect(stdout()).toContain("boom");
  }, 20000);

  it("when allowed it does not emit the login nudge", async () => {
    allowed();
    await runExecMain(execArgv("echo normal-run"));
    expect(stdout()).not.toContain(LOGIN_NUDGE_LINE);
  }, 20000);
});

// ── compress-output ──────────────────────────────────────────────────────────

async function runCompressOutput(input: string): Promise<void> {
  const program = new Command();
  registerCompressOutputCommand(program);
  // The action reads `process.stdin` via `for await`; feed it a Readable.
  const fake = Readable.from([input]);
  const prevStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: fake,
    configurable: true,
  });
  try {
    await program.parseAsync(["node", "unerr", "compress-output"]);
  } finally {
    if (prevStdin) Object.defineProperty(process, "stdin", prevStdin);
  }
}

describe("compress-output — login blocked", () => {
  it("echoes the input unchanged and nudges on stderr", async () => {
    blocked();
    const text = "raw output line one\nraw output line two\n";
    await runCompressOutput(text);
    expect(stdout()).toBe(text);
    expect(stderr()).toContain(LOGIN_NUDGE_LINE);
  });

  it("does not throw when blocked", async () => {
    blocked();
    await expect(runCompressOutput("anything")).resolves.toBeUndefined();
  });
});

// ── check-commit ─────────────────────────────────────────────────────────────

async function runCheckCommit(args: string[] = []): Promise<void> {
  const program = new Command();
  registerCheckCommitCommand(program);
  await program.parseAsync(["node", "unerr", "check-commit", ...args]);
}

describe("check-commit — login blocked", () => {
  it("allows the commit (exit 0), runs no engine, nudges once", async () => {
    blocked();
    process.exitCode = undefined;
    await runCheckCommit();
    expect(process.exitCode).toBe(0);
    expect(stderr()).toContain(LOGIN_NUDGE_LINE);
    process.exitCode = undefined;
  });

  it("does not block even in --blocking mode when signed out", async () => {
    blocked();
    process.exitCode = undefined;
    await expect(runCheckCommit(["--blocking"])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });
});

// ── hook event handlers ──────────────────────────────────────────────────────

async function runHook(event: string): Promise<void> {
  const program = new Command();
  registerHookCommand(program);
  await program.parseAsync(["node", "unerr", "hook", event]);
}

describe("hook events — login blocked", () => {
  // When blocked, the wrapper writes the universal passthrough "{}" and returns
  // before reading stdin, so the graph-touching handlers never run.
  for (const event of ["pre-bash", "pre-edit", "post-edit", "prompt-submit"]) {
    it(`${event} writes passthrough "{}" and does not throw`, async () => {
      blocked();
      await expect(runHook(event)).resolves.toBeUndefined();
      expect(stdout()).toContain("{}");
      // No deny / rewrite shape leaks through.
      expect(stdout()).not.toContain('"deny"');
      expect(stdout()).not.toContain("permissionDecision");
    });
  }

  it("emits the login nudge at most once across many hook fires", async () => {
    blocked();
    for (const event of ["pre-bash", "pre-read", "pre-edit", "post-edit"]) {
      await runHook(event);
    }
    const count = (stderr().match(/ur\|act run `unerr login`/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ── nudgeIfLoggedOut — the agent-surface helper (recon/review/index/learn) ───
//
// These commands are never walled; they run unchanged and emit the throttled
// nudge on STDERR (never stdout, so a `recon --json` payload stays clean).

describe("nudgeIfLoggedOut", () => {
  it("emits the nudge once on stderr when logged out, nothing on stdout", () => {
    blocked();
    nudgeIfLoggedOut(dir);
    expect(stderr()).toContain(LOGIN_NUDGE_LINE);
    expect(stdout()).toBe("");
  });

  it("does not emit twice within the throttle window", () => {
    blocked();
    nudgeIfLoggedOut(dir);
    nudgeIfLoggedOut(dir);
    const count = (stderr().match(/ur\|act run `unerr login`/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("stays silent when logged in", () => {
    allowed();
    nudgeIfLoggedOut(dir);
    expect(stderr()).not.toContain(LOGIN_NUDGE_LINE);
  });

  it("never throws", () => {
    blocked();
    expect(() => nudgeIfLoggedOut(dir)).not.toThrow();
  });
});
