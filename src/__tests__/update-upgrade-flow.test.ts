/**
 * Upgrade-flow tests — every external seam (network, spawn, package manager,
 * registry, daemon I/O) is injected, so no real process, socket, or registry is
 * touched. Covers: acquireBinary manager dispatch, performUpgrade end-to-end,
 * reinstallAllRepos (empty + populated, including a per-agent failure), and
 * restartRuntime (step order + per-step isolation + never-throws). Uses vitest.
 */

import { describe, expect, it, vi } from "vitest";
import type { InstallClassification } from "../update/install-manager.js";
import {
  acquireBinary,
  performUpgrade,
  reinstallAllRepos,
  restartRuntime,
} from "../update/upgrade-flow.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A log sink that discards its argument (the default-log paths under test). */
const noop = (_msg: string): void => {};

const NPM_CLS: InstallClassification = {
  manager: "npm",
  mode: "self_upgradable",
  path: "/usr/local/lib/node_modules/@unerr-ai/unerr/dist/cli.js",
};

const PNPM_CLS: InstallClassification = {
  manager: "pnpm",
  mode: "self_upgradable",
  path: "/home/dev/.local/share/pnpm/global/5/node_modules/@unerr-ai/unerr/dist/cli.js",
};

const BINARY_CLS: InstallClassification = {
  manager: "binary",
  mode: "self_upgradable",
  path: "/home/dev/.unerr/bin/unerr",
};

// ── 1. acquireBinary branching ────────────────────────────────────────────────

describe("acquireBinary — manager dispatch", () => {
  it("binary → calls selfReplaceImpl(version), not runInstall", async () => {
    const selfReplaceImpl = vi.fn(async (_v: string) => ({
      ok: true,
      output: `self-replaced → ${_v}`,
    }));
    const runInstall = vi.fn(async (_cmd: string) => ({
      ok: true,
      output: "",
    }));

    const result = await acquireBinary(BINARY_CLS, "1.2.3", {
      selfReplaceImpl,
      runInstall,
    });

    expect(selfReplaceImpl).toHaveBeenCalledOnce();
    expect(selfReplaceImpl).toHaveBeenCalledWith("1.2.3");
    expect(runInstall).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, output: "self-replaced → 1.2.3" });
  });

  it("npm → calls runInstall with exact npm install -g command", async () => {
    const runInstall = vi.fn(async (_cmd: string) => ({
      ok: true,
      output: "added 1 package",
    }));

    await acquireBinary(NPM_CLS, "2.0.0", { runInstall });

    expect(runInstall).toHaveBeenCalledOnce();
    expect(runInstall).toHaveBeenCalledWith(
      "npm install -g @unerr-ai/unerr@2.0.0"
    );
  });

  it("pnpm → calls runInstall with exact pnpm add -g command", async () => {
    const runInstall = vi.fn(async (_cmd: string) => ({
      ok: true,
      output: "",
    }));

    await acquireBinary(PNPM_CLS, "2.1.0", { runInstall });

    expect(runInstall).toHaveBeenCalledOnce();
    expect(runInstall).toHaveBeenCalledWith(
      "pnpm add -g @unerr-ai/unerr@2.1.0"
    );
  });
});

// ── 2. performUpgrade — end-to-end paths ─────────────────────────────────────

describe("performUpgrade", () => {
  it("happy npm path: ok true, to pinned version, not upToDate, not restarted", async () => {
    const runInstall = vi.fn(async (_cmd: string) => ({
      ok: true,
      output: "done",
    }));
    const healthCheck = vi.fn(async (_v: string) => true);

    const result = await performUpgrade({
      version: "9.9.9",
      classification: NPM_CLS,
      runInstall,
      healthCheck,
      reinstallRepos: false,
      restart: false,
      channel: "stable",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("9.9.9");
    expect(result.upToDate).toBe(false);
    expect(result.restarted).toBe(false);
    expect(runInstall).toHaveBeenCalledOnce();
  });

  it("acquire failure: ok false, error contains install output, restarted false", async () => {
    const runInstall = vi.fn(async (_cmd: string) => ({
      ok: false,
      output: "boom — EACCES",
    }));

    const result = await performUpgrade({
      version: "9.9.9",
      classification: NPM_CLS,
      runInstall,
      healthCheck: async () => true,
      reinstallRepos: false,
      restart: false,
      channel: "stable",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
    expect(result.restarted).toBe(false);
  });

  it("binary path: selfReplaceImpl ok → result ok true", async () => {
    const selfReplaceImpl = vi.fn(async (_v: string) => ({
      ok: true,
      output: `self-replaced → ${_v}`,
    }));
    const healthCheck = vi.fn(async (_v: string) => true);

    const result = await performUpgrade({
      version: "9.9.9",
      classification: BINARY_CLS,
      selfReplaceImpl,
      healthCheck,
      reinstallRepos: false,
      restart: false,
      channel: "stable",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("9.9.9");
  });

  it("health-check false is a warning, not a gate — result.ok still true", async () => {
    const logs: string[] = [];
    const runInstall = vi.fn(async (_cmd: string) => ({
      ok: true,
      output: "done",
    }));
    const healthCheck = vi.fn(async (_v: string) => false);

    const result = await performUpgrade({
      version: "9.9.9",
      classification: NPM_CLS,
      runInstall,
      healthCheck,
      reinstallRepos: false,
      restart: false,
      channel: "stable",
      log: (msg) => logs.push(msg),
    });

    expect(result.ok).toBe(true);
    // A warning line mentioning the target version must appear in the log.
    expect(logs.some((l) => l.includes("9.9.9"))).toBe(true);
  });
});

// ── 3. reinstallAllRepos — empty registry ────────────────────────────────────
// Mock the two internal modules so no real disk access or spawn occurs.

vi.mock("../daemon/registry.js", () => ({
  listRepos: () => [],
}));

vi.mock("../config/agent-reinstall.js", () => ({
  configuredAgents: (_path: string): string[] => [],
}));

describe("reinstallAllRepos — empty registry", () => {
  it("returns an empty array when no repos are registered", async () => {
    const result = await reinstallAllRepos();
    expect(result).toEqual([]);
  });

  it("returns an empty array with a no-op log function", async () => {
    const logs: string[] = [];
    const result = await reinstallAllRepos((msg) => logs.push(msg));
    expect(result).toEqual([]);
    expect(logs).toEqual([]);
  });
});

// ── 4. reinstallAllRepos — populated registry (deps injected) ─────────────────
// Inject the registry/agent-lookup/install seams directly, so no real spawn or
// disk access occurs and the per-repo aggregation can be asserted exactly.

describe("reinstallAllRepos — populated registry", () => {
  it("installs every configured agent in every repo; all ok → no failures", async () => {
    const installAgent = vi.fn(async (_args: string[], _cwd: string) => 0);
    const result = await reinstallAllRepos(noop, {
      listRepos: () =>
        [
          { path: "~/proj/a", label: "a" },
          { path: "~/proj/b", label: "b" },
        ] as ReturnType<typeof import("../daemon/registry.js").listRepos>,
      configuredAgents: () => ["claude-code", "cursor"],
      installAgent,
    });

    // 2 repos × 2 agents = 4 install runs.
    expect(installAgent).toHaveBeenCalledTimes(4);
    expect(installAgent).toHaveBeenCalledWith(
      ["install", "claude-code"],
      expect.stringContaining("proj/a")
    );
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.ok)).toBe(true);
    expect(result.every((r) => r.failures.length === 0)).toBe(true);
    expect(result[0]?.agents).toEqual(["claude-code", "cursor"]);
  });

  it("a non-zero install exit code is recorded as a per-agent failure", async () => {
    // "cursor" fails (exit 1); "claude-code" succeeds (exit 0).
    const installAgent = vi.fn(async (args: string[], _cwd: string) =>
      args[1] === "cursor" ? 1 : 0
    );
    const result = await reinstallAllRepos(noop, {
      listRepos: () =>
        [{ path: "~/proj/a", label: "a" }] as ReturnType<
          typeof import("../daemon/registry.js").listRepos
        >,
      configuredAgents: () => ["claude-code", "cursor"],
      installAgent,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.ok).toBe(false);
    expect(result[0]?.failures).toEqual(["cursor"]);
  });

  it("an unreadable repo config yields zero agents, not a throw", async () => {
    const installAgent = vi.fn(async (_args: string[], _cwd: string) => 0);
    const result = await reinstallAllRepos(noop, {
      listRepos: () =>
        [{ path: "~/proj/a", label: "a" }] as ReturnType<
          typeof import("../daemon/registry.js").listRepos
        >,
      configuredAgents: () => {
        throw new Error("config unreadable");
      },
      installAgent,
    });

    expect(installAgent).not.toHaveBeenCalled();
    expect(result[0]?.agents).toEqual([]);
    expect(result[0]?.ok).toBe(true);
  });
});

// ── 5. restartRuntime — step order + isolation (deps injected) ────────────────

describe("restartRuntime", () => {
  it("runs stopDaemon → killBridges → startDaemon in order", async () => {
    const calls: string[] = [];
    await restartRuntime(noop, {
      stopDaemon: async () => {
        calls.push("stop");
      },
      killBridges: async () => {
        calls.push("kill");
      },
      startDaemon: () => {
        calls.push("start");
      },
    });
    expect(calls).toEqual(["stop", "kill", "start"]);
  });

  it("a throw in one step never blocks the rest and never propagates", async () => {
    const calls: string[] = [];
    await expect(
      restartRuntime(noop, {
        stopDaemon: async () => {
          throw new Error("shutdown failed");
        },
        killBridges: async () => {
          calls.push("kill");
        },
        startDaemon: () => {
          calls.push("start");
        },
      })
    ).resolves.toBeUndefined();
    // stopDaemon threw, but the remaining steps still ran.
    expect(calls).toEqual(["kill", "start"]);
  });
});
