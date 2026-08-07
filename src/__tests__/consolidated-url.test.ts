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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_API_URL, resolveApiUrl } from "../cloud/config.js";
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

// ── resolveApiUrl: production build ignores runtime overrides ────────────────
//
// `__UNERR_DEV_BUILD__` is a build-time constant (baked by tsup/bun --define,
// undefined here). Simulating a production build in-process means setting the
// real global `vi.stubGlobal` writes to, which the bare `__UNERR_DEV_BUILD__`
// reference in resolveApiUrl() reads at runtime same as any other global.

describe("resolveApiUrl — production build", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the baked address even when UNERR_API_URL env is set to something else", () => {
    vi.stubGlobal("__UNERR_DEV_BUILD__", false);
    process.env.UNERR_API_URL = "https://attacker.example";
    expect(resolveApiUrl()).toBe(DEFAULT_API_URL);
  });

  it("ignores a stored credential api_url", () => {
    vi.stubGlobal("__UNERR_DEV_BUILD__", false);
    expect(resolveApiUrl("https://stored.example")).toBe(DEFAULT_API_URL);
  });
});

describe("resolveApiUrl — dev build", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("still honors UNERR_API_URL when __UNERR_DEV_BUILD__ is true", () => {
    vi.stubGlobal("__UNERR_DEV_BUILD__", true);
    process.env.UNERR_API_URL = "http://localhost:4000";
    expect(resolveApiUrl("https://stored.example")).toBe(
      "http://localhost:4000"
    );
  });
});

// ── __UNERR_API_URL__ define: tsup and the binary build can't drift ──────────

describe("__UNERR_API_URL__ define", () => {
  const DEFINE_RE =
    /__UNERR_API_URL__:\s*JSON\.stringify\(\s*process\.env\.UNERR_BUILD_API_URL\s*\|\|\s*"([^"]+)"\s*\)/;

  it("bakes the identical default literal in tsup.config.ts and scripts/build-binary.ts", () => {
    const tsup = readFileSync(join(process.cwd(), "tsup.config.ts"), "utf8");
    const buildBinary = readFileSync(
      join(process.cwd(), "scripts", "build-binary.ts"),
      "utf8"
    );
    const tsupMatch = tsup.match(DEFINE_RE);
    const binaryMatch = buildBinary.match(DEFINE_RE);
    expect(tsupMatch).not.toBeNull();
    expect(binaryMatch).not.toBeNull();
    expect(tsupMatch?.[1]).toBe(binaryMatch?.[1]);
    expect(tsupMatch?.[1]).toBe(DEFAULT_API_URL);
  });
});
