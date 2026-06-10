/**
 * U6 — the resolved update policy. `updatePolicy()` blends three inputs with a
 * fixed precedence (AUTO_UPDATE_STRATEGY.md §7 + §8):
 *   explicit local `off`  >  enterprise `pinned` channel  >  env opt-out  >  mode
 * An `off` is never weakened; a server pin and the env opt-out both cap an
 * `auto` down to `notify`; otherwise the local mode passes through. Pure +
 * injectable — every input is overridable, so no real settings/entitlement I/O.
 */

import { describe, expect, it } from "vitest";
import { updatePolicy } from "../update/update-config.js";

const noEnv: NodeJS.ProcessEnv = {};
const optOut: NodeJS.ProcessEnv = { UNERR_NO_AUTO_UPDATE: "1" };

describe("updatePolicy — precedence", () => {
  it("passes an explicit auto through when nothing overrides it", () => {
    expect(updatePolicy({ configMode: "auto", env: noEnv })).toBe("auto");
  });

  it("passes notify through unchanged", () => {
    expect(updatePolicy({ configMode: "notify", env: noEnv })).toBe("notify");
  });

  it("keeps an explicit off off — never weakened by env or pin", () => {
    expect(updatePolicy({ configMode: "off", env: optOut })).toBe("off");
    expect(
      updatePolicy({ configMode: "off", env: noEnv, serverChannel: "pinned" })
    ).toBe("off");
  });

  it("an enterprise pinned channel caps auto down to notify", () => {
    expect(
      updatePolicy({ configMode: "auto", env: noEnv, serverChannel: "pinned" })
    ).toBe("notify");
  });

  it("a stable channel does not cap auto", () => {
    expect(
      updatePolicy({ configMode: "auto", env: noEnv, serverChannel: "stable" })
    ).toBe("auto");
  });

  it("the env opt-out downgrades auto to notify", () => {
    expect(updatePolicy({ configMode: "auto", env: optOut })).toBe("notify");
  });

  it("the pin takes effect even with the env opt-out set (both → notify)", () => {
    expect(
      updatePolicy({ configMode: "auto", env: optOut, serverChannel: "pinned" })
    ).toBe("notify");
  });

  it.each(["1", "true", "yes", "TRUE", "Yes"])(
    "treats UNERR_NO_AUTO_UPDATE=%s as opt-out",
    (v) => {
      expect(
        updatePolicy({ configMode: "auto", env: { UNERR_NO_AUTO_UPDATE: v } })
      ).toBe("notify");
    }
  );

  it("ignores a non-truthy env value", () => {
    expect(
      updatePolicy({ configMode: "auto", env: { UNERR_NO_AUTO_UPDATE: "0" } })
    ).toBe("auto");
  });
});
