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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface HostRule {
  host: string;
  description?: string;
  drop?: string[];
  replace?: Array<{ pattern: string; with: string }>;
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
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\[\s*\]\([^)]*\)\s*$/gm, "")
    .trim();
}

function pickHostRule(opts: PostProcessOptions): HostRule | null {
  if (opts.rules?.length) {
    return mergeRules(opts.rules);
  }
  if (!opts.url) return null;
  try {
    const host = new URL(opts.url).hostname.toLowerCase();
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
