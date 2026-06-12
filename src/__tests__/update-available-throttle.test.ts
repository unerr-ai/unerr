import { describe, expect, it } from "vitest";
import {
  DEFAULT_AVAILABLE_THROTTLE_MS,
  shouldSurfaceAvailable,
  updateSignal,
} from "../update/update-surface.js";
import type { UpdateState } from "../update/update-state.js";

describe("shouldSurfaceAvailable (daily throttle)", () => {
  const V = "9.9.9";

  it("surfaces when never notified", () => {
    expect(shouldSurfaceAvailable({}, V, 1_000)).toBe(true);
  });

  it("surfaces when the version differs from the last notified", () => {
    const state: UpdateState = {
      available_notified_version: "9.9.8",
      available_notified_at: 1_000,
    };
    expect(shouldSurfaceAvailable(state, V, 2_000)).toBe(true);
  });

  it("suppresses a repeat of the same version within the interval", () => {
    const state: UpdateState = {
      available_notified_version: V,
      available_notified_at: 10_000,
    };
    expect(
      shouldSurfaceAvailable(state, V, 10_000 + DEFAULT_AVAILABLE_THROTTLE_MS - 1)
    ).toBe(false);
  });

  it("surfaces again once the interval elapses", () => {
    const state: UpdateState = {
      available_notified_version: V,
      available_notified_at: 10_000,
    };
    expect(
      shouldSurfaceAvailable(state, V, 10_000 + DEFAULT_AVAILABLE_THROTTLE_MS)
    ).toBe(true);
  });
});

describe("updateSignal carries the version", () => {
  it("available line is tagged with the latest version", () => {
    const sig = updateSignal({
      state: { latest_version: "2.0.0" },
      current: "1.0.0",
      policy: "notify",
      classification: {
        manager: "homebrew",
        mode: "notify_only",
        path: "/opt/homebrew/bin/unerr",
      },
    });
    expect(sig?.dedupKey).toBe("available:2.0.0");
    expect(sig?.version).toBe("2.0.0");
  });
});
