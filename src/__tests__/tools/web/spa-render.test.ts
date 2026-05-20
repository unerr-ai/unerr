import { describe, expect, it } from "vitest";
import {
  SPA_EMPTY_WC,
  SPA_LOW_WC,
  shouldUsePlaywright,
} from "../../../tools/web/spa-render.js";

const enabledConfig = {
  playwright: {
    enabled: true,
    timeoutMs: 15_000,
    waitUntil: "networkidle" as const,
  },
  acceptLanguage: "en-US,en;q=0.9",
};

const disabledConfig = {
  playwright: {
    enabled: false,
    timeoutMs: 15_000,
    waitUntil: "networkidle" as const,
  },
  acceptLanguage: "en-US,en;q=0.9",
};

const blankSignals = {
  rawHtml: "",
  rawBytes: 0,
  extractedBytes: 0,
};

describe("shouldUsePlaywright", () => {
  it("returns false when config is undefined", () => {
    expect(
      shouldUsePlaywright({
        ...blankSignals,
        config: undefined,
        extractor: "raw-body",
        wordCount: 0,
      })
    ).toBe(false);
  });

  it("returns false when playwright is disabled", () => {
    expect(
      shouldUsePlaywright({
        ...blankSignals,
        config: disabledConfig,
        extractor: "raw-body",
        wordCount: 0,
      })
    ).toBe(false);
  });

  it("returns false when extraction succeeded (defuddle) with enough content", () => {
    expect(
      shouldUsePlaywright({
        ...blankSignals,
        config: enabledConfig,
        extractor: "defuddle",
        wordCount: 500,
        rawBytes: 10_000,
        extractedBytes: 4_000,
      })
    ).toBe(false);
  });

  it("returns false when extraction succeeded (readability) with enough content", () => {
    expect(
      shouldUsePlaywright({
        ...blankSignals,
        config: enabledConfig,
        extractor: "readability",
        wordCount: 500,
        rawBytes: 10_000,
        extractedBytes: 4_000,
      })
    ).toBe(false);
  });

  it("returns false when raw-body has enough words", () => {
    expect(
      shouldUsePlaywright({
        ...blankSignals,
        config: enabledConfig,
        extractor: "raw-body",
        wordCount: SPA_EMPTY_WC + 1,
      })
    ).toBe(false);
  });

  it("returns true when raw-body is below threshold and enabled", () => {
    expect(
      shouldUsePlaywright({
        ...blankSignals,
        config: enabledConfig,
        extractor: "raw-body",
        wordCount: SPA_EMPTY_WC - 1,
      })
    ).toBe(true);
  });

  it("returns true when defuddle returns little content from a Next.js shell", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "defuddle",
        wordCount: 50,
        rawHtml: '<html><body><div id="__next"></div></body></html>',
        rawBytes: 50_000,
        extractedBytes: 200,
      })
    ).toBe(true);
  });

  it("returns true when defuddle returns little content from a React root", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "defuddle",
        wordCount: 80,
        rawHtml: '<html><body><div id="root"></div></body></html>',
        rawBytes: 60_000,
        extractedBytes: 300,
      })
    ).toBe(true);
  });

  it("returns true when defuddle returns module scripts and low content", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "defuddle",
        wordCount: 100,
        rawHtml: '<html><script type="module" src="/main.js"></script></html>',
        rawBytes: 80_000,
        extractedBytes: 500,
      })
    ).toBe(true);
  });

  it("returns true when extraction ratio is near zero", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "defuddle",
        wordCount: 90,
        rawHtml: "<html><body>App shell loading...</body></html>",
        rawBytes: 7_000_000,
        extractedBytes: 1_500,
      })
    ).toBe(true);
  });

  it("does not promote pages with legitimate low word counts to playwright", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "defuddle",
        wordCount: SPA_LOW_WC + 50,
        rawHtml: "<html><body><p>Short but legitimate page.</p></body></html>",
        rawBytes: 1_000,
        extractedBytes: 600,
      })
    ).toBe(false);
  });

  it("ignores SPA shell markers when content is already substantial", () => {
    expect(
      shouldUsePlaywright({
        config: enabledConfig,
        extractor: "defuddle",
        wordCount: SPA_LOW_WC + 100,
        rawHtml:
          '<html><body><div id="__next"><article>Substantial pre-rendered content here.</article></div></body></html>',
        rawBytes: 50_000,
        extractedBytes: 20_000,
      })
    ).toBe(false);
  });
});
