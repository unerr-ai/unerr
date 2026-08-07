/**
 * Tests for the login `preAction` wall wired in `src/entrypoints/cli-main.ts`.
 *
 * Policy (2026-08, OSS conversion): unerr's local features — indexing, serving,
 * install, the process manager — need no account at all. `conventions` is the
 * one exception: it reads and writes a document shared between people on our
 * servers, so it alone still needs a login. These tests pin that decision:
 *
 *  - WALL  (login when blocked): `conventions push`/`pull`.
 *  - EXEMPT (no login, ever): bare `unerr`, `install`, `pm start`,
 *    `login`/`logout`/`whoami`/`doctor`, `status`, `uninstall`,
 *    `pm stop`/`remove`/`status`/`logs`, `router …`.
 *  - NUDGE (agent surfaces, pass through — never walled here; the throttled
 *    nudge itself is covered by login-blocked-passthrough.test.ts): `recon`,
 *    `index`, `learn`, `exec`, `compress-output`, `hook`.
 *
 * The wall body lives inline in cli-main.ts and reads module-level state, so
 * the test reconstructs the SAME Commander 12 program shape +
 * `requiresInteractiveLogin` rule and the SAME `loginThenContinue` behavior,
 * driving it through `parseAsync`.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wall composes loginBlocked()/loginGateNotice() from the gate module.
const loginBlockedMock = vi.fn<() => boolean>();
const loginGateNoticeMock = vi.fn<() => string>(() => "Sign in to use unerr.");
const isInternalEntryShapeMock = vi.fn<() => boolean>(() => false);
vi.mock("../cloud/auth/login-gate.js", () => ({
  loginBlocked: () => loginBlockedMock(),
  loginGateNotice: () => loginGateNoticeMock(),
  isInternalEntryShape: () => isInternalEntryShapeMock(),
}));

import {
  isInternalEntryShape,
  loginBlocked,
  loginGateNotice,
} from "../cloud/auth/login-gate.js";

// ── Mirror of the cli-main.ts wall (kept lockstep with the real wiring) ──

/**
 * True only for `conventions` (+ its pull/push subs). Everything else,
 * including bare `unerr` (no parent), `install`, and `pm start`, returns
 * false and passes through. Mirrors `requiresInteractiveLogin` in cli-main.ts.
 */
function requiresInteractiveLogin(actionCmd: Command): boolean {
  if (!actionCmd.parent) return false;
  const name = actionCmd.name();
  const parent = actionCmd.parent.name();
  if (name === "conventions" || parent === "conventions") return true;
  return false;
}

// Records each call so a test can assert whether the interactive login ran.
const loginRan = vi.fn();

async function loginThenContinue(): Promise<void> {
  const notice = loginGateNotice();
  if (!process.stderr.isTTY) {
    process.stderr.write(`\n  ${notice}\n`);
    process.exit(1);
  }
  loginRan(); // stand-in for the real `runLogin()` device flow
}

/** A fresh program with the exact wall + the actions we assert on. */
function buildProgram(actionRan: () => void): Command {
  const program = new Command();
  program.name("unerr").exitOverride(); // throw instead of process.exit on parse errors

  program.action(actionRan); // bare `unerr`
  program.command("login").action(actionRan);
  program.command("logout").action(actionRan);
  program.command("whoami").action(actionRan);
  program.command("doctor").action(actionRan);
  program.command("status").action(actionRan);
  program.command("install").action(actionRan);
  program.command("uninstall").action(actionRan);
  program.command("recon").action(actionRan);

  const conventions = program.command("conventions");
  conventions.command("pull").action(actionRan);
  conventions.command("push").action(actionRan);

  const pm = program.command("pm");
  pm.command("start").action(actionRan);
  pm.command("stop [path]").action(actionRan);
  pm.command("remove [path]").action(actionRan);
  pm.command("status").action(actionRan);
  pm.command("logs").action(actionRan);

  const router = program.command("router");
  router.command("status").action(actionRan);

  program.hook("preAction", async (_thisCmd, actionCmd) => {
    if (isInternalEntryShape()) return;
    if (!requiresInteractiveLogin(actionCmd)) return;
    if (!loginBlocked()) return;
    await loginThenContinue();
  });

  return program;
}

describe("login preAction wall", () => {
  const realIsTTY = process.stderr.isTTY;

  beforeEach(() => {
    loginBlockedMock.mockReset();
    loginGateNoticeMock.mockClear();
    isInternalEntryShapeMock.mockReset();
    isInternalEntryShapeMock.mockReturnValue(false);
    loginRan.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: realIsTTY,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stderr, "isTTY", {
      value,
      configurable: true,
    });
  }

  it("subcommand-naming finding: conventions push reports leaf 'push' under parent 'conventions'", async () => {
    // Confirms the wall logic keys off (name + parent) — the check the
    // current requiresInteractiveLogin relies on.
    let observedName = "";
    let observedParent = "";
    const program = new Command();
    program.name("unerr");
    const conventions = program.command("conventions");
    conventions.command("push").action(() => {});
    program.hook("preAction", (_t, actionCmd) => {
      observedName = actionCmd.name();
      observedParent = actionCmd.parent?.name() ?? "<none>";
    });
    await program.parseAsync(["node", "unerr", "conventions", "push"]);
    expect(observedName).toBe("push");
    expect(observedParent).toBe("conventions");
  });

  describe("EXEMPT — local features run while logged out", () => {
    const exempt: Array<[string, string[]]> = [
      ["bare unerr", []],
      ["install", ["install"]],
      ["pm start", ["pm", "start"]],
      ["login", ["login"]],
      ["logout", ["logout"]],
      ["whoami", ["whoami"]],
      ["doctor", ["doctor"]],
      ["status", ["status"]],
      ["uninstall", ["uninstall"]],
      ["pm stop", ["pm", "stop"]],
      ["pm remove", ["pm", "remove"]],
      ["pm status", ["pm", "status"]],
      ["pm logs", ["pm", "logs"]],
      ["router status", ["router", "status"]],
    ];
    for (const [label, argv] of exempt) {
      it(`${label} is allowed (wall never fires)`, async () => {
        loginBlockedMock.mockReturnValue(true);
        setTTY(true);
        const action = vi.fn();
        const program = buildProgram(action);
        await program.parseAsync(["node", "unerr", ...argv]);
        expect(action).toHaveBeenCalledTimes(1);
        expect(loginRan).not.toHaveBeenCalled();
      });
    }

    it("does not even consult loginBlocked for a non-wall command", async () => {
      loginBlockedMock.mockReturnValue(true);
      setTTY(true);
      const program = buildProgram(vi.fn());
      await program.parseAsync(["node", "unerr", "status"]);
      expect(loginBlockedMock).not.toHaveBeenCalled();
    });
  });

  describe("NUDGE — agent surfaces pass through (not walled here)", () => {
    for (const cmd of ["recon"]) {
      it(`${cmd} runs while logged out (no interactive wall)`, async () => {
        loginBlockedMock.mockReturnValue(true);
        setTTY(true);
        const action = vi.fn();
        const program = buildProgram(action);
        await program.parseAsync(["node", "unerr", cmd]);
        expect(action).toHaveBeenCalledTimes(1);
        expect(loginRan).not.toHaveBeenCalled();
      });
    }
  });

  describe("WALL — conventions (shared cloud doc) triggers the login", () => {
    const walled: Array<[string, string[]]> = [
      ["conventions pull", ["conventions", "pull"]],
      ["conventions push", ["conventions", "push"]],
    ];
    for (const [label, argv] of walled) {
      it(`${label} triggers login when blocked (TTY)`, async () => {
        loginBlockedMock.mockReturnValue(true);
        setTTY(true);
        const program = buildProgram(vi.fn());
        await program.parseAsync(["node", "unerr", ...argv]);
        expect(loginRan).toHaveBeenCalledTimes(1);
      });
    }

    it("a wall command runs normally when NOT blocked (logged in)", async () => {
      loginBlockedMock.mockReturnValue(false);
      setTTY(true);
      const action = vi.fn();
      const program = buildProgram(action);
      await program.parseAsync(["node", "unerr", "conventions", "push"]);
      expect(action).toHaveBeenCalledTimes(1);
      expect(loginRan).not.toHaveBeenCalled();
    });

    it("--mcp / --daemon-child entry shapes bypass the wall entirely", async () => {
      loginBlockedMock.mockReturnValue(true);
      isInternalEntryShapeMock.mockReturnValue(true);
      setTTY(true);
      const action = vi.fn();
      const program = buildProgram(action);
      await program.parseAsync(["node", "unerr", "conventions", "push"]);
      expect(loginBlockedMock).not.toHaveBeenCalled();
      expect(loginRan).not.toHaveBeenCalled();
      expect(action).toHaveBeenCalledTimes(1);
    });
  });

  describe("non-TTY blocked path (wall command)", () => {
    it("exits non-zero without running the interactive login (no browser)", async () => {
      loginBlockedMock.mockReturnValue(true);
      setTTY(false);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("__exit__");
      }) as never);
      const program = buildProgram(vi.fn());

      await expect(
        program.parseAsync(["node", "unerr", "conventions", "push"])
      ).rejects.toThrow("__exit__");

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(loginRan).not.toHaveBeenCalled(); // never opened the device flow
    });
  });
});
