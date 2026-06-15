/**
 * CROSS_REPO_INTELLIGENCE Sprint 5.3: the process manager (`src/daemon/`) owns
 * the registry, dashboard, log file, and idle sweep — but NO per-repo
 * intelligence. Cross-repo federation lives in the home `unerr` proxy
 * (`src/intelligence/federation/`); the daemon only brokers peer discovery
 * (`peers.ts`) and the tier gate. This guard keeps that boundary by re-grepping
 * every daemon source file on each CI run — the cheapest, hardest-to-cheat
 * check against accidental re-entanglement.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DAEMON_DIR = resolve(__dirname, "../daemon");

/** Every daemon source file except tests. */
function daemonSources(): string[] {
  return readdirSync(DAEMON_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(DAEMON_DIR, f));
}

// Match static `from "…"` and dynamic `import("…")` against the forbidden dir
// at any relative depth. Covers `import type` too (it carries the `from`).
const forbidden = (dir: string) =>
  new RegExp(`(?:from|import\\()\\s*["'][^"']*/${dir}/`);

describe("daemon isolation (Sprint 5.3)", () => {
  const files = daemonSources();

  it("finds daemon source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const dir of ["intelligence", "behaviors", "tracking"]) {
    it(`no daemon file imports from src/${dir}/`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, "utf-8");
        if (forbidden(dir).test(source)) offenders.push(file);
      }
      expect(offenders).toEqual([]);
    });
  }
});
