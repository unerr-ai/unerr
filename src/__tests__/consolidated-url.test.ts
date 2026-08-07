/**
 * Tests for `consolidatedServiceBaseUrl` and `consolidatedDashboardUrl`
 * (src/utils/deep-link.ts).
 *
 * These helpers resolve the service base URL through the same chain as
 * `unerr login` (`resolveApiUrl` from credentials.ts):
 *   `UNERR_API_URL` env > `DEFAULT_API_URL`
 *
 * Dev mode (`dev.json apiUrl`) works by having `applyDevConfig` set
 * `process.env.UNERR_API_URL` at boot — so this test simulates dev mode by
 * setting that env var directly, which is exactly what the real code path does.
 *
 * Isolation: each test saves and restores `UNERR_API_URL` so no state leaks
 * between tests or into the developer's real environment.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_API_URL } from "../cloud/config.js";
import {
  consolidatedDashboardUrl,
  consolidatedServiceBaseUrl,
} from "../utils/deep-link.js";

const TOUCHED = ["UNERR_API_URL"] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TOUCHED) SAVED_ENV[k] = process.env[k];
  // Start clean — no env override — so each test controls this explicitly.
  Reflect.deleteProperty(process.env, "UNERR_API_URL");
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

// ── consolidatedServiceBaseUrl ────────────────────────────────────────────────

describe("consolidatedServiceBaseUrl", () => {
  it("returns DEFAULT_API_URL when no env override is set (prod default)", () => {
    expect(consolidatedServiceBaseUrl()).toBe(DEFAULT_API_URL);
    expect(consolidatedServiceBaseUrl()).toBe("https://app.unerr.dev");
  });

  it("returns UNERR_API_URL when set (env override wins, e.g. preview deploy)", () => {
    process.env.UNERR_API_URL = "https://preview.unerr.dev";
    expect(consolidatedServiceBaseUrl()).toBe("https://preview.unerr.dev");
  });

  it("returns localhost when UNERR_API_URL is set to localhost (dev.json injection)", () => {
    // applyDevConfig sets process.env.UNERR_API_URL from dev.json at boot;
    // setting it here is equivalent.
    process.env.UNERR_API_URL = "http://localhost:3000";
    expect(consolidatedServiceBaseUrl()).toBe("http://localhost:3000");
  });

  it("strips trailing slashes from the env override", () => {
    process.env.UNERR_API_URL = "http://localhost:3000///";
    expect(consolidatedServiceBaseUrl()).toBe("http://localhost:3000");
  });

  it("never throws when env value is an empty string — falls back to default", () => {
    process.env.UNERR_API_URL = "";
    expect(consolidatedServiceBaseUrl()).toBe(DEFAULT_API_URL);
  });
});

// ── consolidatedDashboardUrl ──────────────────────────────────────────────────

describe("consolidatedDashboardUrl", () => {
  it("returns base URL with utm_source=cli when no repoId (prod)", () => {
    expect(consolidatedDashboardUrl()).toBe(
      `${DEFAULT_API_URL}?utm_source=cli`
    );
  });

  it("appends /r/<repoId> when repoId is given (prod)", () => {
    expect(consolidatedDashboardUrl("repo_abc123")).toBe(
      `${DEFAULT_API_URL}/r/repo_abc123?utm_source=cli`
    );
  });

  it("uses localhost base when UNERR_API_URL is set to localhost (dev.json injection)", () => {
    process.env.UNERR_API_URL = "http://localhost:3000";
    expect(consolidatedDashboardUrl()).toBe(
      "http://localhost:3000?utm_source=cli"
    );
  });

  it("uses localhost base with repoId when UNERR_API_URL is set (dev.json injection)", () => {
    process.env.UNERR_API_URL = "http://localhost:3000";
    expect(consolidatedDashboardUrl("repo_xyz")).toBe(
      "http://localhost:3000/r/repo_xyz?utm_source=cli"
    );
  });

  it("returns base (no repoId path) when repoId is undefined", () => {
    const url = new URL(consolidatedDashboardUrl(undefined));
    expect(url.pathname).toBe("/");
  });
});
