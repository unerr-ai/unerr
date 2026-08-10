/**
 * Work mode must stay graph-free.
 *
 * `src/work/` serves hosts that have no codebase and no room for one: Claude
 * Cowork runs each session in an isolated VM, and an Agent Plugins package ships
 * as a single bundled binary. The moment work mode imports the graph it pulls in
 * CozoDB, the file watchers, and the process manager, and it stops fitting
 * anywhere it was built to run.
 *
 * Same shape as `bridge-isolation.test.ts`: a static scan of the source is the
 * cheapest guard against accidental re-entanglement, and the hardest to cheat.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORK_DIR = resolve(__dirname, "../work");

/** Every module under src/work/, recursively. */
function collectSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out.sort();
}

const sources = collectSources(WORK_DIR);

/** Matches both static and dynamic imports at any relative depth. */
function importPattern(folder: string): RegExp {
  return new RegExp(`(?:from|import\\()\\s*["'][^"']*\\/${folder}\\/`);
}

describe("work mode isolation", () => {
  it("has source files to check", () => {
    // A silent zero-file pass would make every assertion below meaningless.
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const forbidden of ["intelligence", "behaviors", "tracking"]) {
    it(`imports nothing from src/${forbidden}/`, () => {
      const pattern = importPattern(forbidden);
      const offenders = sources
        .filter((file) => pattern.test(readFileSync(file, "utf-8")))
        .map((file) => relative(WORK_DIR, file));

      expect(
        offenders,
        `src/work/ must not import src/${forbidden}/ — found in: ${offenders.join(", ")}`
      ).toEqual([]);
    });
  }

  it("never touches CozoDB", () => {
    const offenders = sources
      .filter((file) => /cozo/i.test(readFileSync(file, "utf-8")))
      .map((file) => relative(WORK_DIR, file));

    expect(
      offenders,
      `work mode runs where there is no graph — found cozo reference in: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("never starts a file watcher or the process manager", () => {
    const banned = [
      { pattern: /@parcel\/watcher/, why: "file watcher" },
      {
        pattern: /(?:from|import\()\s*["'][^"']*\/daemon\//,
        why: "process manager",
      },
    ];

    for (const { pattern, why } of banned) {
      const offenders = sources
        .filter((file) => pattern.test(readFileSync(file, "utf-8")))
        .map((file) => relative(WORK_DIR, file));
      expect(offenders, `work mode must not use the ${why}`).toEqual([]);
    }
  });

  it("writes no output to stdout", () => {
    // stdout is the MCP JSON-RPC transport. One console.log breaks every host.
    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf-8");
      if (
        /console\.log\(/.test(source) ||
        /process\.stdout\.write\(/.test(source)
      ) {
        // The server's own JSON-RPC writer is the single legitimate exception
        // and must say so on the line above.
        const lines = source.split("\n");
        const bad = lines.some((line, i) => {
          const isWrite =
            /console\.log\(/.test(line) ||
            /process\.stdout\.write\(/.test(line);
          if (!isWrite) return false;
          const prior = lines.slice(Math.max(0, i - 3), i).join(" ");
          return !/JSON-RPC|jsonrpc|transport/i.test(prior);
        });
        if (bad) offenders.push(relative(WORK_DIR, file));
      }
    }
    expect(
      offenders,
      `stdout is the MCP transport — log to stderr instead. Offenders: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("stays small enough to reason about", () => {
    const total = sources.reduce((sum, file) => sum + statSync(file).size, 0);
    // A graph-free tool surface has no business being large. If this trips,
    // something graph-shaped has probably moved in.
    expect(total).toBeLessThan(120_000);
  });
});
