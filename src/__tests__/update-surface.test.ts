/**
 * U3 auto-update surfacing — the in-band signal + status panel/line.
 *
 * Every branch is exercised with fully-injected deps (state / current / policy
 * / classification) — no filesystem, no real install. The contract under test:
 * an applied / available-not-auto-applying / rolled-back update is NEVER
 * silent, an update that WILL auto-apply emits nothing (its result surfaces
 * next session), and policy `off` mutes the in-band line entirely.
 */

import { describe, expect, it } from "vitest";
import type { InstallClassification } from "../update/install-manager.js";
import {
  releaseNotesUrl,
  updateSignal,
  updateStatusLine,
  updateStatusPanel,
} from "../update/update-surface.js";
import type { UpdateState } from "../update/update-state.js";

const SELF_UPGRADABLE: InstallClassification = {
  manager: "npm",
  mode: "self_upgradable",
  path: "/usr/local/lib/node_modules/@unerr-ai/unerr/dist/cli.js",
};
const NOTIFY_ONLY: InstallClassification = {
  manager: "homebrew",
  mode: "notify_only",
  path: "/opt/homebrew/Cellar/unerr/0.2.11/libexec/dist/cli.js",
  reason: "homebrew owns this install",
};

const EMPTY: UpdateState = {};

describe("releaseNotesUrl", () => {
  it("points at the v-tagged GitHub release", () => {
    expect(releaseNotesUrl("0.2.13")).toBe(
      "https://github.com/unerr-ai/unerr-cli/releases/tag/v0.2.13"
    );
  });
});

describe("updateSignal — in-band line", () => {
  it("policy off → no line at all", () => {
    expect(
      updateSignal({
        policy: "off",
        current: "0.2.11",
        state: { latest_version: "0.3.0" },
        classification: SELF_UPGRADABLE,
      })
    ).toBeNull();
  });

  it("up to date → no line", () => {
    expect(
      updateSignal({
        policy: "auto",
        current: "0.2.13",
        state: { latest_version: "0.2.13" },
        classification: SELF_UPGRADABLE,
      })
    ).toBeNull();
  });

  it("minor available + self_upgradable + auto → silent (will auto-apply)", () => {
    expect(
      updateSignal({
        policy: "auto",
        current: "0.2.11",
        state: { latest_version: "0.3.0" },
        classification: SELF_UPGRADABLE,
      })
    ).toBeNull();
  });

  it("major available + self_upgradable + auto → loud (majors never auto-apply)", () => {
    const sig = updateSignal({
      policy: "auto",
      current: "0.2.11",
      state: { latest_version: "1.0.0" },
      classification: SELF_UPGRADABLE,
    });
    expect(sig?.tag).toBe("act");
    expect(sig?.dedupKey).toBe("available:1.0.0");
    expect(sig?.content).toContain("npm install -g @unerr-ai/unerr@1.0.0");
    expect(sig?.content).toContain("(major;");
  });

  it("minor available + notify_only install → loud with the native command", () => {
    const sig = updateSignal({
      policy: "auto",
      current: "0.2.11",
      state: { latest_version: "0.3.0" },
      classification: NOTIFY_ONLY,
    });
    expect(sig?.tag).toBe("act");
    expect(sig?.content).toContain("brew upgrade unerr");
    expect(sig?.content).toContain("0.3.0 available");
  });

  it("minor available + policy notify → loud even when self_upgradable", () => {
    const sig = updateSignal({
      policy: "notify",
      current: "0.2.11",
      state: { latest_version: "0.3.0" },
      classification: SELF_UPGRADABLE,
    });
    expect(sig?.tag).toBe("act");
    expect(sig?.content).toContain("npm install -g @unerr-ai/unerr@0.3.0");
  });

  it("applied event on the version we now run → quiet fct, reported once", () => {
    const sig = updateSignal({
      policy: "auto",
      current: "0.2.13",
      state: {
        latest_version: "0.2.13",
        last_applied: { from: "0.2.11", to: "0.2.13", at: 1 },
      },
      classification: SELF_UPGRADABLE,
    });
    expect(sig?.tag).toBe("fct");
    expect(sig?.dedupKey).toBe("applied:0.2.13");
    expect(sig?.content).toContain("auto-updated 0.2.11 → 0.2.13 (patch)");
  });

  it("rollback wins over an applied record and is loud", () => {
    const sig = updateSignal({
      policy: "auto",
      current: "0.2.11",
      state: {
        last_rollback: { from: "0.2.11", to: "0.3.0", at: 1 },
        last_applied: { from: "0.2.10", to: "0.2.11", at: 1 },
      },
      classification: SELF_UPGRADABLE,
    });
    expect(sig?.tag).toBe("act");
    expect(sig?.dedupKey).toBe("rollback:0.3.0");
    expect(sig?.content).toContain("rolled back to 0.2.11");
  });

  it("a newer version beats a stale applied record (no missed available)", () => {
    // We applied 0.2.12 earlier, but 0.2.13 is out now — surface the available.
    const sig = updateSignal({
      policy: "notify",
      current: "0.2.12",
      state: {
        latest_version: "0.2.13",
        last_applied: { from: "0.2.11", to: "0.2.12", at: 1 },
      },
      classification: SELF_UPGRADABLE,
    });
    expect(sig?.dedupKey).toBe("available:0.2.13");
  });
});

describe("updateStatusPanel / updateStatusLine", () => {
  it("up to date", () => {
    const p = updateStatusPanel({
      policy: "auto",
      current: "0.2.13",
      state: { latest_version: "0.2.13", last_checked_at: 1000 },
      classification: SELF_UPGRADABLE,
    });
    expect(p.status).toBe("up-to-date");
    expect(p.upgradeCommand).toBeNull();
    expect(p.lastCheckedAt).toBe(1000);
    expect(updateStatusLine({ policy: "auto", current: "0.2.13", state: { latest_version: "0.2.13" }, classification: SELF_UPGRADABLE })).toContain(
      "up to date"
    );
  });

  it("available surfaces the exact command + kind", () => {
    const p = updateStatusPanel({
      policy: "notify",
      current: "0.2.11",
      state: { latest_version: "0.3.0" },
      classification: SELF_UPGRADABLE,
    });
    expect(p.status).toBe("available");
    expect(p.kind).toBe("minor");
    expect(p.upgradeCommand).toBe("npm install -g @unerr-ai/unerr@0.3.0");
  });

  it("disabled when policy off", () => {
    const p = updateStatusPanel({
      policy: "off",
      current: "0.2.11",
      state: { latest_version: "0.3.0" },
      classification: SELF_UPGRADABLE,
    });
    expect(p.status).toBe("disabled");
    expect(updateStatusLine({ policy: "off", current: "0.2.11", state: EMPTY, classification: SELF_UPGRADABLE })).toContain(
      "disabled"
    );
  });

  it("pending when a staged version differs from current", () => {
    const p = updateStatusPanel({
      policy: "auto",
      current: "0.2.11",
      state: { pending_version: "0.2.13" },
      classification: SELF_UPGRADABLE,
    });
    expect(p.status).toBe("pending");
    expect(p.pendingVersion).toBe("0.2.13");
  });

  it("rolled-back state", () => {
    const p = updateStatusPanel({
      policy: "auto",
      current: "0.2.11",
      state: { last_rollback: { from: "0.2.11", to: "0.3.0", at: 1 } },
      classification: SELF_UPGRADABLE,
    });
    expect(p.status).toBe("rolled-back");
  });
});
