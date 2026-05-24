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
 * Detection fires when any of three signals indicates an SPA shell:
 *   1. Extractor fell through to raw-body AND word count is near-zero
 *   2. Word count is low AND raw HTML contains a known SPA mount marker
 *      (Next.js __next, React root, Vite/SvelteKit app shell, module scripts)
 *   3. Extraction ratio (extractedBytes / rawBytes) is near-zero — the page
 *      shipped megabytes of HTML but extraction returned almost nothing
 *
 * Signals 2 and 3 are gated by `wordCount < SPA_LOW_WC` to avoid promoting
 * genuinely short pages to a headless-browser fetch.
 */

import type { FetchUrlConfig } from "../../config/settings.js";

export interface SpaRenderResult {
  html: string;
  finalUrl: string;
  status: number;
}

export const SPA_EMPTY_WC = 40;
export const SPA_LOW_WC = 200;
export const SPA_LOW_EXTRACTION_RATIO = 0.01;

const SPA_SHELL_PATTERN =
  /<div[^>]+id=["'](?:__next|root|app|svelte|nuxt)["']|<script[^>]+type=["']module["']/i;

export interface ShouldUsePlaywrightArgs {
  config: FetchUrlConfig | undefined;
  extractor: "defuddle" | "readability" | "raw-body" | "cache";
  wordCount: number;
  rawHtml: string;
  rawBytes: number;
  extractedBytes: number;
}

export function shouldUsePlaywright(args: ShouldUsePlaywrightArgs): boolean {
  if (!args.config?.playwright?.enabled) return false;

  if (args.extractor === "raw-body" && args.wordCount < SPA_EMPTY_WC) {
    return true;
  }

  if (args.wordCount >= SPA_LOW_WC) return false;

  if (SPA_SHELL_PATTERN.test(args.rawHtml)) return true;

  if (args.rawBytes > 0) {
    const ratio = args.extractedBytes / args.rawBytes;
    if (ratio < SPA_LOW_EXTRACTION_RATIO) return true;
  }

  return false;
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
      locale: extractLocale(config.acceptLanguage),
      extraHTTPHeaders: {
        "accept-language": config.acceptLanguage,
      },
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
  newContext(opts: {
    userAgent?: string;
    locale?: string;
    extraHTTPHeaders?: Record<string, string>;
  }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

function extractLocale(acceptLanguage: string): string | undefined {
  const first = acceptLanguage.split(",")[0]?.trim();
  if (!first) return undefined;
  return first.split(";")[0]?.trim() || undefined;
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
    return (await import(
      "playwright" as string
    )) as unknown as PlaywrightModule;
  } catch {
    return null;
  }
}
