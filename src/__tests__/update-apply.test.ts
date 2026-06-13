/**
 * U5 apply + rollback — every gate and the health-check/rollback fork, with all
 * I/O injected (no real install, no real spawn, no real filesystem). The safety
 * contract: an apply happens ONLY through all six gates; a failed health check
 * always rolls back to the last-known-good and records it; nothing is ever
 * re-installed once applied or once known-bad.
 */

import { describe, expect, it, vi } from "vitest";
import { applyUpdate } from "../update/apply.js";
import { isPackageManagerBusy } from "../update/collision-guard.js";
import type { InstallClassification } from "../update/install-manager.js";
import type { UpdateState } from "../update/update-state.js";

const SELF: InstallClassification = {
  manager: "npm",
  mode: "self_upgradable",
  path: "/usr/local/lib/node_modules/@unerr-ai/unerr/dist/cli.js",
};
const NOTIFY: InstallClassification = {
  manager: "homebrew",
  mode: "notify_only",
  path: "/opt/homebrew/Cellar/unerr/0.2.11/libexec/dist/cli.js",
  reason: "homebrew owns this install",
};

/** Build apply deps with sensible passing defaults; override per test. */
function deps(over: Partial<Parameters<typeof applyUpdate>[0]> = {}) {
  const writes: Partial<UpdateState>[] = [];
  const base = {
    current: "0.2.11",
    latest: "0.2.12",
    policy: "auto" as const,
    classification: SELF,
    isQuiet: () => true,
    isBusy: () => ({ busy: false }),
    runInstall: vi.fn(async () => ({ ok: true, output: "" })),
    healthCheck: vi.fn(async () => true),
    readState: () => ({}) as UpdateState,
    writeState: (p: Partial<UpdateState>) => {
      writes.push(p);
    },
    now: 1000,
    ...over,
  };
  return { base, writes };
}

describe("collision guard", () => {
  it("flags a foreign npm/pnpm/brew install in flight", () => {
    expect(
      isPackageManagerBusy({
        listProcesses: () => "node\nnpm install left-pad\nbash",
      }).busy
    ).toBe(true);
    expect(
      isPackageManagerBusy({ listProcesses: () => "brew upgrade ripgrep" })
        .reason
    ).toContain("brew");
  });

  it("ignores our own @unerr-ai/unerr install (not a foreign collision)", () => {
    expect(
      isPackageManagerBusy({
        listProcesses: () => "npm install -g @unerr-ai/unerr@0.2.12",
      }).busy
    ).toBe(false);
  });

  it("reports not-busy when the process list is unreadable", () => {
    expect(isPackageManagerBusy({ listProcesses: () => "" }).busy).toBe(false);
  });

  it("reports not-busy for an idle process list", () => {
    expect(
      isPackageManagerBusy({ listProcesses: () => "node\nzsh\nvim" }).busy
    ).toBe(false);
  });
});

describe("applyUpdate — gates", () => {
  it("skips a major (notify-only boundary)", async () => {
    const { base } = deps({ latest: "1.0.0" });
    const r = await applyUpdate(base);
    expect(r.status).toBe("skipped");
    expect(r).toMatchObject({ reason: expect.stringContaining("major") });
    expect(base.runInstall).not.toHaveBeenCalled();
  });

  it("skips when policy is not auto", async () => {
    const { base } = deps({ policy: "notify" });
    expect((await applyUpdate(base)).status).toBe("skipped");
    expect(base.runInstall).not.toHaveBeenCalled();
  });

  it("skips a notify-only install manager", async () => {
    const { base } = deps({ classification: NOTIFY });
    const r = await applyUpdate(base);
    expect(r.status).toBe("skipped");
    expect(base.runInstall).not.toHaveBeenCalled();
  });

  it("skips when an IDE session is active", async () => {
    const { base } = deps({ isQuiet: () => false });
    expect((await applyUpdate(base)).status).toBe("skipped");
    expect(base.runInstall).not.toHaveBeenCalled();
  });

  it("skips (backs off) when a foreign package manager is busy", async () => {
    const { base } = deps({
      isBusy: () => ({ busy: true, reason: "npm install in progress" }),
    });
    const r = await applyUpdate(base);
    expect(r.status).toBe("skipped");
    expect(r).toMatchObject({ reason: expect.stringContaining("npm install") });
    expect(base.runInstall).not.toHaveBeenCalled();
  });

  it("skips a version already applied (awaiting restart) — no re-install", async () => {
    const { base } = deps({
      readState: () => ({
        last_applied: { from: "0.2.11", to: "0.2.12", at: 1 },
      }),
    });
    expect((await applyUpdate(base)).status).toBe("skipped");
    expect(base.runInstall).not.toHaveBeenCalled();
  });

  it("skips a version that previously failed its health check", async () => {
    const { base } = deps({
      readState: () => ({
        last_rollback: { from: "0.2.11", to: "0.2.12", at: 1 },
      }),
    });
    expect((await applyUpdate(base)).status).toBe("skipped");
    expect(base.runInstall).not.toHaveBeenCalled();
  });
});

describe("applyUpdate — apply / health-check / rollback", () => {
  it("applies a healthy minor and records the transition + last-known-good", async () => {
    const { base, writes } = deps({ latest: "0.3.0" });
    const r = await applyUpdate(base);
    expect(r).toEqual({ status: "applied", from: "0.2.11", to: "0.3.0" });
    expect(base.runInstall).toHaveBeenCalledWith(
      "npm install -g @unerr-ai/unerr@0.3.0"
    );
    // pending staged first, then the applied record with the good pin.
    expect(writes[0]).toEqual({ pending_version: "0.3.0" });
    expect(writes.at(-1)).toMatchObject({
      last_applied: { from: "0.2.11", to: "0.3.0", at: 1000 },
      last_good_version: "0.3.0",
      pending_version: undefined,
    });
  });

  it("rolls back to the last-known-good when the new binary fails its health check", async () => {
    const { base, writes } = deps({
      latest: "0.2.12",
      healthCheck: vi.fn(async () => false),
      readState: () => ({ last_good_version: "0.2.11" }),
    });
    const r = await applyUpdate(base);
    expect(r).toEqual({
      status: "rolled_back",
      from: "0.2.11",
      to: "0.2.12",
      restored: true,
    });
    // installs the candidate, then re-installs the good version.
    expect(base.runInstall).toHaveBeenNthCalledWith(
      1,
      "npm install -g @unerr-ai/unerr@0.2.12"
    );
    expect(base.runInstall).toHaveBeenNthCalledWith(
      2,
      "npm install -g @unerr-ai/unerr@0.2.11"
    );
    expect(writes.at(-1)).toMatchObject({
      last_rollback: { from: "0.2.11", to: "0.2.12", at: 1000 },
      pending_version: undefined,
    });
  });

  it("reports failure (and clears pending) when the install itself fails", async () => {
    const { base, writes } = deps({
      runInstall: vi.fn(async () => ({ ok: false, output: "EACCES: denied" })),
    });
    const r = await applyUpdate(base);
    expect(r.status).toBe("failed");
    expect(base.healthCheck).not.toHaveBeenCalled();
    expect(writes.at(-1)).toEqual({ pending_version: undefined });
  });
});
