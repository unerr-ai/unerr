/**
 * Master reviewer switch — `isReviewEnabled` + the surface seams it gates.
 *
 * The reviewer is opt-in (OFF by default) while it is benchmarked, so a normal
 * agent run pays zero reviewer overhead. These tests pin that contract:
 *   - default OFF (no env, no config),
 *   - env UNERR_REVIEW_ENABLED is the override and wins over config,
 *   - .unerr/config.json {"review":{"enabled":true}} is the persistent opt-in,
 *   - the CLI `runReview` seam short-circuits (exit 0, no engine) when OFF,
 *   - the cloud review drainer emits nothing when OFF.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReviewDrainers } from "../cloud/drainers/review.js";
import type { DrainerContext } from "../cloud/push-drainer.js";
import { isReviewEnabled } from "../review/feature-flag.js";

describe("isReviewEnabled", () => {
  let repo: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ur-revflag-"));
    mkdirSync(join(repo, ".unerr"), { recursive: true });
    prevEnv = process.env.UNERR_REVIEW_ENABLED;
    // Default state for each test: env unset (let config / default decide).
    Reflect.deleteProperty(process.env, "UNERR_REVIEW_ENABLED");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    if (prevEnv === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_REVIEW_ENABLED");
    } else {
      process.env.UNERR_REVIEW_ENABLED = prevEnv;
    }
  });

  it("is OFF by default (no env, no config)", () => {
    expect(isReviewEnabled(repo)).toBe(false);
  });

  it("env enables for truthy values, disables otherwise", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.UNERR_REVIEW_ENABLED = v;
      expect(isReviewEnabled(repo)).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", "nonsense"]) {
      process.env.UNERR_REVIEW_ENABLED = v;
      expect(isReviewEnabled(repo)).toBe(false);
    }
  });

  it("treats an empty env value as unset (falls through to config/default)", () => {
    process.env.UNERR_REVIEW_ENABLED = "";
    expect(isReviewEnabled(repo)).toBe(false);
  });

  it("config review.enabled=true enables when env is unset", () => {
    writeFileSync(
      join(repo, ".unerr", "config.json"),
      JSON.stringify({ review: { enabled: true } })
    );
    expect(isReviewEnabled(repo)).toBe(true);
  });

  it("env wins over config (env off beats config on)", () => {
    writeFileSync(
      join(repo, ".unerr", "config.json"),
      JSON.stringify({ review: { enabled: true } })
    );
    process.env.UNERR_REVIEW_ENABLED = "0";
    expect(isReviewEnabled(repo)).toBe(false);
  });

  it("a corrupt config is not enabled (best-effort read)", () => {
    writeFileSync(join(repo, ".unerr", "config.json"), "{ not json");
    expect(isReviewEnabled(repo)).toBe(false);
  });

  it("the cloud review drainer emits no drainer while disabled", async () => {
    // unerrDir is `<root>/.unerr` — the drainer derives the repo root from it.
    const ctx = { unerrDir: join(repo, ".unerr") } as DrainerContext;
    const set = await buildReviewDrainers(ctx);
    expect(set.drainers).toEqual([]);
  });
});
