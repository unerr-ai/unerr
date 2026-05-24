/**
 * Anti-bot challenge detection for fetch_url.
 *
 * Some hosts return HTTP 200 with a JavaScript-challenge interstitial instead
 * of the real page (Cloudflare "Just a moment...", hCaptcha, PerimeterX). The
 * raw HTML is short, looks like an SPA shell, and produces a tiny extraction —
 * indistinguishable from a real SPA without these markers. Detecting the
 * challenge lets the caller surface a typed `blocked` result with a paste-ready
 * remediation hint instead of a misleading empty extraction.
 *
 * Detection is body-marker based and runs after `fetchHtml` but before
 * extraction. Markers are intentionally narrow to avoid false positives on
 * pages that merely *mention* Cloudflare.
 */

export type ChallengeKind = "cloudflare" | "hcaptcha" | "perimeterx";

export interface ChallengeDetection {
  kind: ChallengeKind;
  suggestion: string;
}

const CLOUDFLARE_MARKERS: RegExp[] = [
  /cf[-_]chl[-_]opt/i,
  /__cf_chl_/,
  /cf-browser-verification/i,
  /Just a moment\.\.\./i,
  /Enable JavaScript and cookies to continue/i,
  /Checking your browser before accessing/i,
  /challenges\.cloudflare\.com/i,
];

const HCAPTCHA_MARKERS: RegExp[] = [
  /hcaptcha\.com\/captcha/i,
  /h-captcha-response/i,
  /class=["'][^"']*\bh-captcha\b/i,
];

const PERIMETERX_MARKERS: RegExp[] = [
  /_pxhd/i,
  /window\._pxAppId/i,
  /Please verify you are a human/i,
  /captcha\.px-cloud\.net/i,
];

function matchesAny(html: string, markers: RegExp[]): boolean {
  for (const m of markers) {
    if (m.test(html)) return true;
  }
  return false;
}

export function detectChallenge(html: string): ChallengeDetection | null {
  if (html.length === 0) return null;
  if (matchesAny(html, CLOUDFLARE_MARKERS)) {
    return {
      kind: "cloudflare",
      suggestion:
        "enable .unerr/settings.json fetchUrl.playwright.enabled=true and retry; if still blocked, fetch via an authenticated session or skip this host",
    };
  }
  if (matchesAny(html, HCAPTCHA_MARKERS)) {
    return {
      kind: "hcaptcha",
      suggestion:
        "host requires solving hCaptcha — fetch this URL manually or via an authenticated session",
    };
  }
  if (matchesAny(html, PERIMETERX_MARKERS)) {
    return {
      kind: "perimeterx",
      suggestion:
        "host is gated by PerimeterX bot mitigation — fetch via an authenticated session or skip this host",
    };
  }
  return null;
}
