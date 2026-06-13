/**
 * Tests for planInstallLogin — the pure verdict behind A5 install-time login
 * chaining. Pins every escape path so the install command never strands a user
 * in a half-connected state: `--token` connects non-interactively, an existing
 * connection short-circuits, a non-TTY install (CI / piped) stays free, and a
 * plain interactive install prompts once. Login is on by default — there is no
 * opt-out flag. Pure logic → no TTY or network.
 */

import { describe, expect, it } from "vitest";
import {
  type InstallLoginPlan,
  planInstallLogin,
} from "../commands/install.js";

const tty = { loggedIn: false, hasTty: true };

describe("planInstallLogin — install-time login verdict", () => {
  it("--token wins over everything (CI / headless, no prompt)", () => {
    const plan = planInstallLogin(
      { token: "unerr_sk_abc" },
      { loggedIn: true, hasTty: true }
    );
    expect(plan).toEqual<InstallLoginPlan>({
      action: "token",
      token: "unerr_sk_abc",
    });
  });

  it("already connected → no prompt, no login", () => {
    expect(planInstallLogin({}, { loggedIn: true, hasTty: true })).toEqual({
      action: "already",
    });
  });

  it("no TTY (piped / CI without --token) → stays free, never blocks", () => {
    expect(planInstallLogin({}, { loggedIn: false, hasTty: false })).toEqual({
      action: "later",
    });
  });

  it("plain interactive install → prompts once (login on by default)", () => {
    expect(planInstallLogin({}, tty)).toEqual({ action: "prompt" });
  });
});
