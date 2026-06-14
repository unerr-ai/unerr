/**
 * Tests for the login `preAction` wall wired in `src/entrypoints/cli.ts`.
 *
 * Policy (2026-06-14, revised): a login wall fires ONLY for user-typed commands
 * that ADD, MODIFY, or START something — bare `unerr` (register repo + serve),
 * `install`, `pm start`, and `conventions` (reads/writes the shared cloud doc).
 * This mirrors the npm/docker/wrangler/supabase split: local + read + teardown
 * work logged out; mutating shared/remote state needs auth. These tests pin that
 * decision matrix:
 *
 *  - WALL  (login when blocked): bare `unerr`, `install`, `pm start`,
 *    `conventions push`/`pull`.
 *  - EXEMPT (no login, ever): `login`/`logout`/`whoami`/`doctor`, `status`,
 *    `uninstall`, `pm stop`/`remove`/`status`/`logs`, `router …`.
 *  - NUDGE (agent surfaces, pass through — never walled here; the throttled
 *    nudge itself is covered by login-blocked-passthrough.test.ts): `recon`,
 *    `review`, `index`, `learn`, `exec`, `compress-output`, `check-commit`,
 *    `hook`.
 *
 * The wall body lives inline in cli.ts and reads module-level state, so the
 * test reconstructs the SAME Commander 12 program shape + `requiresInteractiveLogin`
 * rule and the SAME `loginThenContinue` behavior, driving it through `parseAsync`.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wall composes loginBlocked()/loginGateNotice() from the gate module.
const loginBlockedMock = vi.fn<() => boolean>();
const loginGateNoticeMock = vi.fn<() => string>(() => "Sign in to use unerr.");
const isInternalEntryShapeMock = vi.fn<() => boolean>(() => false);
vi.mock("../cloud/login-gate.js", () => ({
  loginBlocked: () => loginBlockedMock(),
  loginGateNotice: () => loginGateNoticeMock(),
  isInternalEntryShape: () => isInternalEntryShapeMock(),
}));

import {
  isInternalEntryShape,
  loginBlocked,
  loginGateNotice,
} from "../cloud/login-gate.js";

// ── Mirror of the cli.ts wall (kept lockstep with the real wiring) ──

/**
 * True for the commands that wall: bare `unerr` (no parent), `install`,
 * `pm start`, and `conventions` (+ its pull/push subs). Everything else returns
 * false and passes through. Mirrors `requiresInteractiveLogin` in cli.ts.
 */
function requiresInteractiveLogin(actionCmd: Command): boolean {
  if (!actionCmd.parent) return true;
  const name = actionCmd.name();
  const parent = actionCmd.parent.name();
  if (name === "install") return true;
  if (parent === "pm" && name === "start") return true;
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
  program.command("review").action(actionRan);

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

  it("subcommand-naming finding: pm start reports leaf 'start' under parent 'pm'", async () => {
    // Confirms the wall logic keys off (name + parent), not the group.
    let observedName = "";
    let observedParent = "";
    const program = new Command();
    program.name("unerr");
    const pm = program.command("pm");
    pm.command("start").action(() => {});
    program.hook("preAction", (_t, actionCmd) => {
      observedName = actionCmd.name();
      observedParent = actionCmd.parent?.name() ?? "<none>";
    });
    await program.parseAsync(["node", "unerr", "pm", "start"]);
    expect(observedName).toBe("start");
    expect(observedParent).toBe("pm");
  });

  describe("EXEMPT — view / teardown / recovery run while logged out", () => {
    const exempt: Array<[string, string[]]> = [
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
    for (const cmd of ["recon", "review"]) {
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

  describe("WALL — add / modify / start commands trigger the login", () => {
    const walled: Array<[string, string[]]> = [
      ["bare unerr", []],
      ["install", ["install"]],
      ["pm start", ["pm", "start"]],
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
      await program.parseAsync(["node", "unerr", "install"]);
      expect(action).toHaveBeenCalledTimes(1);
      expect(loginRan).not.toHaveBeenCalled();
    });

    it("--mcp / --daemon-child entry shapes bypass the wall entirely", async () => {
      loginBlockedMock.mockReturnValue(true);
      isInternalEntryShapeMock.mockReturnValue(true);
      setTTY(true);
      const action = vi.fn();
      const program = buildProgram(action);
      await program.parseAsync(["node", "unerr", "install"]);
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
        program.parseAsync(["node", "unerr", "install"])
      ).rejects.toThrow("__exit__");

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(loginRan).not.toHaveBeenCalled(); // never opened the device flow
    });
  });
});
