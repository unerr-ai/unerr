/**
 * Optional Playwright SPA renderer for fetch_url.
 *
 * Off by default. Enabled via `.unerr/settings.json`:
 *   { "fetchUrl": { "playwright": { "enabled": true } } }
 *
 * `playwright` is a peer-style dependency — NOT in package.json deps.
 * Users opt in by installing it themselves (`npm i playwright`) and enabling
 * the flag. If the import fails we return null so the caller keeps the
 * server-rendered HTML it already has.
 *
 * Detection: if the post-extraction word count drops below SPA_EMPTY_WC and
 * Playwright is enabled, we re-fetch with a headless browser and let the
 * normal extraction pipeline run on the rendered DOM.
 */

import type { FetchUrlConfig } from "../../config/settings.js";

export interface SpaRenderResult {
  html: string;
  finalUrl: string;
  status: number;
}

export const SPA_EMPTY_WC = 40;

export interface ShouldUsePlaywrightArgs {
  config: FetchUrlConfig | undefined;
  extractor: "defuddle" | "readability" | "raw-body" | "cache";
  wordCount: number;
}

export function shouldUsePlaywright(args: ShouldUsePlaywrightArgs): boolean {
  if (!args.config?.playwright?.enabled) return false;
  if (args.extractor !== "raw-body") return false;
  return args.wordCount < SPA_EMPTY_WC;
}

export async function renderWithPlaywright(
  url: string,
  config: FetchUrlConfig
): Promise<SpaRenderResult | null> {
  const pw = await loadPlaywright();
  if (!pw) return null;

  const browser = await pw.chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent:
        "unerr-fetch-url/1.0 (+https://unerr.dev) Mozilla/5.0 compatible",
    });
    const page = await ctx.newPage();
    const response = await page.goto(url, {
      waitUntil: config.playwright.waitUntil,
      timeout: config.playwright.timeoutMs,
    });
    const html = await page.content();
    return {
      html,
      finalUrl: page.url(),
      status: response?.status() ?? 200,
    };
  } finally {
    await browser.close();
  }
}

interface PlaywrightModule {
  chromium: {
    launch(opts: { headless: boolean }): Promise<PlaywrightBrowser>;
  };
}

interface PlaywrightBrowser {
  newContext(opts: { userAgent?: string }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
}

interface PlaywrightPage {
  goto(
    url: string,
    opts: { waitUntil: string; timeout: number }
  ): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  url(): string;
}

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return (await import("playwright" as string)) as unknown as PlaywrightModule;
  } catch {
    return null;
  }
}
