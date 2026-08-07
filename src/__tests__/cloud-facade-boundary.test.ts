/**
 * OSS conversion, cloud reorg — the facade boundary.
 *
 * `src/cloud/` is split into three feature folders — `auth/` (identity,
 * sign-in, credentials), `plan/` (entitlements, tier, repo cap), `sync/`
 * (everything that talks to the server) — plus two standalone top-level
 * files, `config.ts` (API base URL) and `dev-mode.ts` (dev-build login
 * skip). Each folder has exactly one facade, `index.ts`, that re-exports
 * only the symbols external callers use. Production code outside
 * `src/cloud/` may import ONLY those five entry points:
 *   `cloud/auth/index.js`, `cloud/plan/index.js`, `cloud/sync/index.js`,
 *   `cloud/config.js`, `cloud/dev-mode.js`
 * — never a concrete module inside a folder (e.g.
 * `../cloud/auth/credentials.js`).
 *
 * Why this matters: drop the guard and the folders stop being a boundary.
 * A caller reaches straight past the facade into internals, one import at
 * a time, and there is nothing to catch it at review time — the same way
 * login logic ended up spread across 11 flat files before this reorg.
 * `src/__tests__/` is exempt: tests legitimately reach in to mock
 * internals directly (e.g. `vi.mock("../cloud/auth/credentials.js", …)`).
 *
 * Static-analysis test: re-grepping every source file on each CI run is
 * the cheapest, hardest-to-cheat guard against accidental re-entanglement.
 * Modeled on `bridge-isolation.test.ts` / `daemon-isolation.test.ts`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = resolve(__dirname, "..");
const CLOUD_DIR = resolve(SRC_DIR, "cloud");
const TESTS_DIR = resolve(SRC_DIR, "__tests__");

const ALLOWED_ENTRY_POINTS = [
  "cloud/auth/index.js",
  "cloud/plan/index.js",
  "cloud/sync/index.js",
  "cloud/config.js",
  "cloud/dev-mode.js",
];

/** Every production `.ts`/`.tsx` source file outside `src/cloud/` and `src/__tests__/`. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (full === CLOUD_DIR || full === TESTS_DIR) continue;
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = extname(full);
      if (ext !== ".ts" && ext !== ".tsx") continue;
      if (full.endsWith(".test.ts") || full.endsWith(".test.tsx")) continue;
      out.push(full);
    }
  };
  walk(SRC_DIR);
  return out;
}

// Match static `from "…/cloud/…"` and dynamic `import("…/cloud/…")` import
// specifiers, at any relative depth. Covers `import type` too (it carries
// the `from`).
const CLOUD_IMPORT = /(?:from|import\()\s*["']([^"']*\/cloud\/[^"']*)["']/g;

describe("cloud facade boundary", () => {
  const files = productionSources();

  it("finds production source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no production file outside src/cloud/ imports a cloud path other than the five allowed entry points", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      CLOUD_IMPORT.lastIndex = 0;
      let match: RegExpExecArray | null = CLOUD_IMPORT.exec(source);
      while (match) {
        const specifier = match[1] ?? "";
        const isAllowed = ALLOWED_ENTRY_POINTS.some((entry) =>
          specifier.endsWith(entry)
        );
        if (!isAllowed) {
          offenders.push(`${relative(SRC_DIR, file)} -> ${specifier}`);
        }
        match = CLOUD_IMPORT.exec(source);
      }
    }
    expect(offenders).toEqual([]);
  });
});
