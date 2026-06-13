/**
 * U6 — the resolved update policy. `updatePolicy()` blends two inputs with a
 * fixed precedence (AUTO_UPDATE_STRATEGY.md §7 + §8):
 *   explicit local `off`  >  enterprise `pinned` channel  >  mode
 * An `off` is never weakened; a server pin caps an `auto` down to `notify`;
 * otherwise the local mode passes through. There is no env opt-out. Pure +
 * injectable — every input is overridable, so no real settings/entitlement I/O.
 */

import { describe, expect, it } from "vitest";
import { updatePolicy } from "../update/update-config.js";

describe("updatePolicy — precedence", () => {
  it("passes an explicit auto through when nothing overrides it", () => {
    expect(updatePolicy({ configMode: "auto" })).toBe("auto");
  });

  it("passes notify through unchanged", () => {
    expect(updatePolicy({ configMode: "notify" })).toBe("notify");
  });

  it("keeps an explicit off off — never weakened by a pin", () => {
    expect(updatePolicy({ configMode: "off" })).toBe("off");
    expect(
      updatePolicy({ configMode: "off", serverChannel: "pinned" })
    ).toBe("off");
  });

  it("an enterprise pinned channel caps auto down to notify", () => {
    expect(
      updatePolicy({ configMode: "auto", serverChannel: "pinned" })
    ).toBe("notify");
  });

  it("a stable channel does not cap auto", () => {
    expect(
      updatePolicy({ configMode: "auto", serverChannel: "stable" })
    ).toBe("auto");
  });
});
