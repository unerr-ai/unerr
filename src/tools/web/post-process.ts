/**
 * Markdown post-processing — runs after turndown, before passage splitting.
 *
 * Two layers:
 *   1. Universal cleanup (cheap, deterministic): collapse repeated blank lines,
 *      drop anchor-only stragglers, normalize trailing whitespace.
 *   2. Per-host declarative rule pass: drop / replace lines matching JSON
 *      rules keyed by hostname. Architecture port of vincentkoc/tokenjuice
 *      (MIT) — the rule shape, not the shell-tuned rule set.
 *
 * Rules live in src/tools/web/rules/*.json. One file per host (e.g.
 * github.com.json). Files are read once and cached for the process.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Per-host rule schema. Loaded from src/tools/web/rules/<host>.json.
 *
 * Three concern areas, applied at different points in the pipeline:
 *  - `drop` / `replace`: post-extraction markdown rewriting (this file)
 *  - `extractor`: extraction strategy + DOM-shaping (extract.ts)
 *  - `behavior`: transport-level overrides (fetch-url-protocol.ts)
 *
 * Hostname matching falls through suffixes: "docs.github.com" matches a
 * `github.com.json` rule when no exact "docs.github.com.json" exists.
 */
export interface HostRule {
  host: string;
  description?: string;
  /** Regex patterns of markdown lines to drop after extraction. */
  drop?: string[];
  /** Pattern → replacement applied after extraction. */
  replace?: Array<{ pattern: string; with: string }>;
  /** Extraction-strategy overrides. */
  extractor?: HostExtractorRule;
  /** Transport-level behavior overrides. */
  behavior?: HostBehaviorRule;
}

export interface HostExtractorRule {
  /**
   * Force a specific extractor instead of the default Defuddle → Readability
   * → raw-body chain. Useful for hosts where Defuddle reliably misses content
   * (forums, doc sites with non-standard semantic markup).
   */
  prefer?: "defuddle" | "readability" | "raw-body";
  /**
   * CSS selectors whose contents should be removed BEFORE extraction.
   * Use for cookie banners, "edit on GitHub" widgets, sidebars that the
   * generic extractor would otherwise keep. Applied in addition to the
   * library's own chrome-detection.
   */
  removeSelectors?: string[];
  /**
   * CSS selectors that, when matched, replace the document body for
   * extraction. Use only for hosts where the article body lives in a known
   * container — overzealous use breaks pages whose layout drifts.
   */
  contentSelectors?: string[];
  /**
   * Opt out of the universal chrome pre-strip (header/footer/nav/aside/
   * sidebar/menu/etc.). Set true for sites whose article content lives
   * inside a `<nav>` or `<aside>` that the universal pass would drop —
   * e.g. API reference docs where navigation is the content.
   */
  skipUniversalStrip?: boolean;
}

export interface HostBehaviorRule {
  /**
   * Force the Playwright SPA renderer for this host. Default selection is
   * signal-based (SPA_SHELL_PATTERN etc.); this is the override for hosts
   * known to never SSR (Twitter/X, Notion, some Vercel deployments).
   */
  forcePlaywright?: boolean;
  /**
   * Override the Accept-Language header for this host. Use when a site
   * geo-redirects to a less-extractable localised page on en-US.
   */
  acceptLanguage?: string;
}

const RULES_DIR = (() => {
  try {
    return join(fileURLToPath(new URL(".", import.meta.url)), "rules");
  } catch {
    return "";
  }
})();

let rulesCache: Map<string, HostRule> | null = null;

function loadRules(): Map<string, HostRule> {
  if (rulesCache) return rulesCache;
  const map = new Map<string, HostRule>();
  if (!RULES_DIR) {
    rulesCache = map;
    return map;
  }
  let entries: string[];
  try {
    entries = readdirSync(RULES_DIR);
  } catch {
    rulesCache = map;
    return map;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(RULES_DIR, name), "utf-8");
      const parsed = JSON.parse(raw) as HostRule;
      if (parsed.host) map.set(parsed.host.toLowerCase(), parsed);
    } catch {
      // best effort
    }
  }
  rulesCache = map;
  return map;
}

export function resetRulesCache(): void {
  rulesCache = null;
}

export interface PostProcessOptions {
  url?: string;
  rules?: HostRule[];
}

export function postProcessMarkdown(
  markdown: string,
  opts: PostProcessOptions = {}
): string {
  let out = universalCleanup(markdown);
  const hostRule = pickHostRule(opts);
  if (hostRule) out = applyHostRule(out, hostRule);
  out = universalCleanup(out);
  return out;
}

function universalCleanup(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(BASE64_INLINE_IMAGE_RE, (_match, alt: string) => {
      const label = (alt ?? "").trim();
      return label ? `\`[image: ${label}]\`` : "`[image]`";
    })
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\[\s*\]\([^)]*\)\s*$/gm, "")
    .trim();
}

/**
 * Match `![alt](data:image/...;base64,XXXX)` (and the same shape wrapped in
 * a link). Inline base64 images inflate compressed_bytes 5-10× on Substack,
 * Notion exports, and SVG-heavy posts — the agent never reads the payload, so
 * we collapse to a short placeholder while preserving the alt text. Matches
 * across the entire data-URI even if it contains URL-unsafe characters that a
 * lazy `[^)]+` would terminate on.
 */
const BASE64_INLINE_IMAGE_RE =
  /!\[([^\]]*)\]\(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+\)/g;

/**
 * Look up the host rule that applies to a URL, with suffix fallthrough.
 * Used by extract.ts and fetch-url-protocol.ts to read `extractor` and
 * `behavior` overrides — same matching rules as post-processing.
 */
export function lookupHostRule(url: string): HostRule | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const rules = loadRules();
    const exact = rules.get(host);
    if (exact) return exact;
    const parts = host.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const suffix = parts.slice(i).join(".");
      const match = rules.get(suffix);
      if (match) return match;
    }
    return null;
  } catch {
    return null;
  }
}

function pickHostRule(opts: PostProcessOptions): HostRule | null {
  if (opts.rules?.length) {
    return mergeRules(opts.rules);
  }
  if (!opts.url) return null;
  return lookupHostRule(opts.url);
}

function mergeRules(rules: HostRule[]): HostRule {
  return {
    host: "merged",
    drop: rules.flatMap((r) => r.drop ?? []),
    replace: rules.flatMap((r) => r.replace ?? []),
  };
}

function applyHostRule(md: string, rule: HostRule): string {
  let out = md;
  if (rule.drop?.length) {
    for (const pat of rule.drop) {
      try {
        const re = new RegExp(pat, "gm");
        out = out.replace(re, "");
      } catch {
        // skip malformed rule
      }
    }
  }
  if (rule.replace?.length) {
    for (const { pattern, with: replacement } of rule.replace) {
      try {
        const re = new RegExp(pattern, "gm");
        out = out.replace(re, replacement);
      } catch {
        // skip malformed rule
      }
    }
  }
  return out;
}
