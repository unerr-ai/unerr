import { describe, expect, it } from "vitest";
import {
  SPA_EMPTY_WC,
  shouldUsePlaywright,
} from "../../../tools/web/spa-render.js";

const enabledConfig = {
  playwright: {
    enabled: true,
    timeoutMs: 15_000,
    waitUntil: "networkidle" as const,
  },
};

const disabledConfig = {
  playwright: {
    enabled: false,
    timeoutMs: 15_000,
    waitUntil: "networkidle" as const,
  },
};

describe("shouldUsePlaywright", () => {
  it("returns false when config is undefined", () => {
    expect(
      shouldUsePlaywright({
        config: undefined,
        extractor: "raw-body",
        wordCount: 0,
      })
    ).toBe(false);
  });

  it("returns false when playwright is disabled", () => {
    expect(
      shouldUsePlaywright({
        config: disabledConfig,
        extractor: "raw-body",
        wordCount: 0,
      })
    ).toBe(false);
  });

  it("returns false when extraction succeeded (defuddle)", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "defuddle",
        wordCount: 5,
      })
    ).toBe(false);
  });

  it("returns false when extraction succeeded (readability)", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "readability",
        wordCount: 5,
      })
    ).toBe(false);
  });

  it("returns false when raw-body has enough words", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "raw-body",
        wordCount: SPA_EMPTY_WC + 1,
      })
    ).toBe(false);
  });

  it("returns true when raw-body is below threshold and enabled", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "raw-body",
        wordCount: SPA_EMPTY_WC - 1,
      })
    ).toBe(true);
  });
});
