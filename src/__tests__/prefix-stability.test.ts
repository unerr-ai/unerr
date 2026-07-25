/**
 * W1 — cache-prefix stability (all agents).
 *
 * The cached prefix that every agent carries every turn is `tools/list` +
 * the standing instruction block. If either changes byte-for-byte between
 * turns, prompt-caching busts the whole suffix (exact-prefix KV reuse) and the
 * cache-hit rate `H` collapses — the −46% lever in
 * `.internal/roadmap/AGENT_TOOLING_OVERHEAD_ANALYSIS.md` §4. These guards fail
 * loud if a future change injects a per-session value (timestamp, random,
 * Set/Map-iteration order, a salted hash) into the prefix for ANY agent.
 *
 * Plan: `.internal/roadmap/OVERHEAD_REDUCTION_IMPLEMENTATION_PLAN.md` W1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getConfigurableAgents } from "../config/agent-registry.js";
import { generateCustomInstructions } from "../config/instruction-writer.js";
import { ADVERTISED_TOOL_DEFINITIONS } from "../proxy/tool-definitions.js";

// A full ISO timestamp (date + T + clock) is the canonical cache-bust value —
// a plain "2026-06" in prose is fine, an injected `new Date().toISOString()` is
// not. Keep this strict so legitimate year-month strings don't false-positive.
const VOLATILE_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe("W1 cache-prefix stability — tools/list (all agents)", () => {
  it("advertised tools are emitted in a deterministic (name-sorted) order", () => {
    const names = ADVERTISED_TOOL_DEFINITIONS.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });

  it("serializes byte-identically across calls and carries no volatile value", () => {
    const a = JSON.stringify(ADVERTISED_TOOL_DEFINITIONS);
    const b = JSON.stringify(ADVERTISED_TOOL_DEFINITIONS);
    expect(a).toBe(b);
    expect(VOLATILE_ISO.test(a)).toBe(false);
  });
});

describe("W1 cache-prefix stability — instruction block (every instruction-file agent)", () => {
  const instructionAgents = getConfigurableAgents().filter(
    (a) => a.instructionFilePath
  );

  it("the instruction-file agent set is non-empty (guards a silent list collapse)", () => {
    // 9 agents carry an instruction file today (claude-code, cursor, codex,
    // gemini-cli, vscode, github-copilot-cli, cline, windsurf, antigravity);
    // floor at 8 so adding/removing one doesn't break the guard, an emptied
    // list does.
    expect(instructionAgents.length).toBeGreaterThanOrEqual(8);
  });

  for (const agent of instructionAgents) {
    it(`${agent.id}: instruction block is deterministic + non-volatile`, () => {
      const first = generateCustomInstructions(agent.id);
      const second = generateCustomInstructions(agent.id);
      expect(first).toBe(second); // pure function of the agent id
      expect(first.length).toBeGreaterThan(0);
      expect(VOLATILE_ISO.test(first)).toBe(false);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// W1 (build-time companion) — instruction-write path call-site lock.
//
// WHY THIS EXISTS
// The injected `<!-- unerr:start -->` instruction section (written by
// `writeInstructionFile`, src/config/instruction-writer.ts) is part of every
// agent's cached context prefix — the same exact-prefix prompt cache the tool
// schema sits in. Rewriting it mid-session busts KV reuse and re-bills the whole
// suffix as a cache WRITE. One measured mutation of that prefix class cost $1.24
// (.internal/docs/04-telemetry-insights/04-WHERE-TOKENS-CAN-BE-REDUCED.md §5).
// The runtime sibling for the tool half is src/proxy/catalog-lock.ts, which
// pins tools/list to a byte-identical constant; this section's byte-stability
// instead rests on it having exactly ONE production writer reached through only
// TWO legitimate lifecycle triggers:
//   1. explicit `unerr install <agent>`  — registerInstallCommand → runInstall
//      (src/commands/install.ts).
//   2. version-gated auto-refresh         — refreshAgentInstallsIfUpgraded →
//      runInstall (src/config/agent-reinstall.ts); a no-op unless UNERR_VERSION
//      changed, so it only rewrites on a real upgrade.
// Content is a pure function of (ide, terse flag) — the W1 tests above prove it
// carries no volatile value — so there is no spontaneous same-version rewrite,
// and no runtime refusal is added (a refusal could not tell in-session drift
// from a legitimate upgrade and would risk bricking installs).
//
// This is a pure source-structure lock, no runtime behavior. If a future
// refactor wires a NON-version in-session event (branch switch, re-index,
// per-turn hook, config-flag flip) into the instruction-write path, it MUST add
// a new caller of `writeInstructionFile` or of `runInstall` — which trips one of
// the assertions below and forces a review instead of silently shipping a
// prefix-busting mid-session rewrite.
describe("W1 instruction-write path — call-site lock (mid-session rewrite busts the prompt cache)", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  // Every production .ts/.tsx under src/, repo-root-relative with POSIX
  // separators, minus tests and ambient declarations. A source scan, not a raw
  // line grep: a new file importing or calling the locked symbol lands in this
  // set and trips the assertion regardless of where in the file it appears.
  function listProductionSources(): { rel: string; src: string }[] {
    const out: { rel: string; src: string }[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "__tests__" || ent.name === "node_modules") continue;
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(abs);
        } else if (
          (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx")) &&
          !ent.name.endsWith(".d.ts")
        ) {
          const rel = relative(REPO_ROOT, abs).split(/[\\/]/).join("/");
          out.push({ rel, src: readFileSync(abs, "utf8") });
        }
      }
    };
    walk(join(REPO_ROOT, "src"));
    return out;
  }

  const sources = listProductionSources();

  it("sees a non-trivial production tree (guards against an empty scan silently passing)", () => {
    expect(sources.length).toBeGreaterThan(200);
    expect(
      sources.some((s) => s.rel === "src/config/instruction-writer.ts")
    ).toBe(true);
  });

  it("writeInstructionFile is referenced by exactly one production file: src/commands/install.ts", () => {
    // instruction-writer.ts is the definer; every OTHER production reference
    // (import or call) of this unique identifier must be the single install site.
    const DEFINER = "src/config/instruction-writer.ts";
    const refs = sources
      .filter(
        (s) => s.rel !== DEFINER && /\bwriteInstructionFile\b/.test(s.src)
      )
      .map((s) => s.rel)
      .sort();
    expect(refs).toEqual(["src/commands/install.ts"]);
  });

  it("runInstall (install.ts export) is invoked in-process from exactly two production files", () => {
    // A real call `runInstall(...)`, narrowed to files that are install.ts (the
    // definer / self-caller via registerInstallCommand) OR import runInstall from
    // commands/install. The narrowing excludes the unrelated `runInstall`
    // dependency-injection FIELD in src/update/*.ts, which invokes a child
    // `unerr install` process through runInstallCommand and never calls
    // install.ts's runInstall in-process.
    const CALL = /\brunInstall\s*\(/;
    const importsFromInstall = (src: string): boolean =>
      /import\s*(?:type\s*)?\{[^}]*\brunInstall\b[^}]*\}\s*from\s*["'][^"']*commands\/install(?:\.js)?["']/.test(
        src
      ) ||
      /\{[^}]*\brunInstall\b[^}]*\}\s*=\s*await\s+import\(\s*["'][^"']*commands\/install(?:\.js)?["']\s*\)/.test(
        src
      );
    const invokers = sources
      .filter(
        (s) =>
          CALL.test(s.src) &&
          (s.rel === "src/commands/install.ts" || importsFromInstall(s.src))
      )
      .map((s) => s.rel)
      .sort();
    expect(invokers).toEqual([
      "src/commands/install.ts",
      "src/config/agent-reinstall.ts",
    ]);
  });
});
