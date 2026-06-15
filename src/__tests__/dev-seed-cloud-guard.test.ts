/**
 * Guard test for the DEV-ONLY seeding script `scripts/dev-seed-cloud.ts`.
 *
 * The script must NEVER touch a backend unless a `.unerr/dev.json` names a dev
 * `apiUrl`. This test runs the real script as a subprocess in a sandbox where
 * neither a repo-level nor a global `~/.unerr/dev.json` exists (HOME is pointed
 * at an empty temp dir), and asserts it refuses with a non-zero exit and a clear
 * stderr message — proving the prod-guard fires before any client construction
 * or network call. No live backend is contacted.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
// src/__tests__ -> repo root -> scripts/dev-seed-cloud.ts
const SCRIPT = join(here, "..", "..", "scripts", "dev-seed-cloud.ts");

describe("dev-seed-cloud prod guard", () => {
  let sandbox: string;
  let fakeHome: string;
  let repo: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "seed-guard-"));
    fakeHome = join(sandbox, "home");
    repo = join(sandbox, "repo");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("refuses to run when no dev.json names a dev apiUrl", () => {
    let stderr = "";
    let exitCode = 0;
    try {
      execFileSync("npx", ["tsx", SCRIPT, repo], {
        cwd: sandbox,
        env: {
          ...process.env,
          // Empty home so the global ~/.unerr/dev.json is absent; no repo file
          // either — the guard input is null on both paths.
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          // Ensure no env token short-circuits anything before the guard.
          UNERR_TOKEN: "",
          UNERR_API_URL: "",
        },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      exitCode = err.status ?? 1;
      stderr = err.stderr ?? "";
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain("REFUSING");
    expect(stderr).toContain("dev.json");
    // It must refuse BEFORE attempting any push/network.
    expect(stderr).not.toContain("seeding");
    // npx tsx cold-start is slow; the guard itself returns immediately.
  }, 30_000);
});
