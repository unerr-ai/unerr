/**
 * Nudge clarity invariants — block any regression to the abstract-placeholder
 * or hedge-verb patterns documented in CLAUDE.md "Writing nudges and hints".
 *
 * Anything the agent reads as advisory (Consider/Verify/Review/Check) or
 * abstract (`:N`, `<name>`) creates retry loops or silent drops. These tests
 * fail loud if either pattern returns.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SIGNAL_PREFIX_LEGEND,
} from "../proxy/response-envelope.js";

const HEDGE_VERBS = [
  /\bConsider\b/,
  /\bVerify\b/,
  /\bReview\b/,
  /\bCheck\b/, // followed by space (avoid "Checked", "checkbox" in identifiers)
  /\bmay want to\b/i,
];

const ROOT = join(__dirname, "..");

function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf-8");
}

/**
 * Extract every `action: "..."` string literal from a source file. Skips
 * action: undefined and action: variable-reference forms.
 */
function extractActionLiterals(src: string): string[] {
  const out: string[] = [];
  // Match: action: "..."  or  action: `...`
  const re = /action:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const literal = m[1] ?? m[2];
    if (literal) out.push(literal);
  }
  return out;
}

describe("nudge invariants — SIGNAL_PREFIX_LEGEND", () => {
  it("contains no literal `:N` cursor placeholder", () => {
    // The page hint format example must use concrete-value language, not :N.
    // Concrete shape uses <nextValue>, <remaining>, etc. as descriptive
    // placeholders inside angle brackets — those are documentation form,
    // not emission form.
    expect(SIGNAL_PREFIX_LEGEND).not.toMatch(/:N\b/);
  });

  it("contains no bare `<name>` parameter placeholder", () => {
    // Angle-bracket descriptors are allowed in format documentation
    // (<tool>, <cursorArg>, <nextValue>) but the literal "<name>" was the
    // pre-rewrite stand-in for an entity that never got substituted.
    expect(SIGNAL_PREFIX_LEGEND).not.toContain("<name>");
  });

  it("uses imperative verbs, not hedge verbs", () => {
    for (const re of HEDGE_VERBS) {
      expect(SIGNAL_PREFIX_LEGEND).not.toMatch(re);
    }
  });
});

describe("nudge invariants — signal-scorer action strings", () => {
  const src = readSource("intelligence/signal-scorer.ts");
  const actions = extractActionLiterals(src);

  it("scorer file has multiple action: literals (sanity check)", () => {
    expect(actions.length).toBeGreaterThan(5);
  });

  it("no action string uses hedge verbs", () => {
    for (const action of actions) {
      for (const re of HEDGE_VERBS) {
        if (re.test(action)) {
          throw new Error(
            `signal-scorer action uses hedge verb (${re}): "${action}"`,
          );
        }
      }
    }
  });

  it("no action string uses the deictic phrase 'this entity / pattern / file'", () => {
    for (const action of actions) {
      // The audit explicitly identified 'this entity', 'this pattern',
      // 'this file' as the recurring deictic anti-pattern.
      expect(action).not.toMatch(/\bthis (entity|pattern|file)\b/);
    }
  });
});

describe("nudge invariants — isError reaches the agent's MCP context", () => {
  const src = readSource("proxy/proxy.ts");
  const lines = src.split("\n");

  /**
   * For every line that writes a `[unerr]` error to stderr, the surrounding
   * window (next 12 lines) must include `isError: true`. This couples the
   * human-debug channel (stderr → .unerr/logs/) with the agent-context
   * channel (MCP CallToolResult.isError). The user's original concern:
   * "make sure isError writes to err stream AND err stream gets into the
   *  coding agent context" — codified.
   */
  it("every stderr error log in proxy.ts pairs with an isError:true on the wire", () => {
    const orphans: { line: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw) continue;
      // Match the stderr error pattern we standardized on.
      if (!/process\.stderr\.write\([\s\S]*\[unerr\][^)]*(failed|threw|disabled|validation)/i.test(raw))
        continue;
      // Look ahead up to 12 lines for `isError: true`.
      const window = lines.slice(i, Math.min(lines.length, i + 13)).join("\n");
      if (!/isError:\s*true/.test(window)) {
        orphans.push({ line: i + 1, text: raw.trim().slice(0, 100) });
      }
    }
    if (orphans.length > 0) {
      const msg = orphans
        .map((o) => `  proxy.ts:${o.line} → ${o.text}`)
        .join("\n");
      throw new Error(
        `${orphans.length} stderr error log(s) in proxy.ts do not set isError:true within 12 lines. Pair every human-debug log with a wire isError so the agent sees the failure:\n${msg}`,
      );
    }
  });

  it("contains the expected error-routing sites (sanity check)", () => {
    // Documents the four MCP error paths that must surface isError to MCP
    // clients. If anyone removes a path, this fires.
    expect(src).toMatch(/record_fact failed/);
    expect(src).toMatch(/recall_facts failed/);
    expect(src).toMatch(/tools\/call validation failed for/);
    expect(src).toMatch(/router\.execute\(\$\{name\}\) threw/);
  });
});

describe("nudge invariants — wire-cap nudges", () => {
  const src = readSource("proxy/wire-cap.ts");

  it("the buildPageHint template uses a numeric cursor (no `:N` in code)", () => {
    // The page-hint template now interpolates `${nextCursor}`. If anyone
    // ever reverts to a literal `:N`, this catches it.
    expect(src).not.toMatch(/\$\{cursorArg\}:N/);
    expect(src).not.toMatch(/`ur\|pg \$\{toolName\}[^`]*:N[`\s—]/);
  });

  it("PER_TOOL_CAPS.filterHint values are concrete (no `<name>` / `:T` / `:V` placeholders)", () => {
    // Page-hint format: `ur|pg <tool> +N — <cursor>:<n>/<filterHint>`. The
    // filterHint is appended verbatim. Literal placeholders (`<name>`, `:T`,
    // `:V`) train the agent to paste the placeholder instead of substituting
    // a real value — the exact anti-pattern this audit eliminated. Concrete
    // values or pipe-separated enums only.
    const capMatches = src.matchAll(/filterHint:\s*"([^"]+)"/g);
    const offenders: string[] = [];
    for (const match of capMatches) {
      const hint = match[1] ?? "";
      // Forbid angle-bracket placeholders (`<name>`, `<entity>`, etc).
      if (/<[^>]+>/.test(hint)) {
        offenders.push(`${hint} (contains <…> placeholder)`);
        continue;
      }
      // Forbid single-letter trailing placeholders (`fact_type:T`, `:V`).
      // A single-uppercase-letter value never reads as concrete.
      if (/:[A-Z](\s|$|\/|\|)/.test(hint)) {
        offenders.push(`${hint} (single-letter placeholder)`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `PER_TOOL_CAPS filterHint values must be concrete:\n${offenders.map((o) => `  - ${o}`).join("\n")}`,
      );
    }
  });
});
