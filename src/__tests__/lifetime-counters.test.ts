/**
 * Unit tests for src/tracking/lifetime-counters.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bumpLifetimeCounters,
  lifetimeCountersPath,
  readLifetimeCounters,
  seedLifetimeCountersIfAbsent,
  writeLifetimeCounters,
} from "../tracking/lifetime-counters.js";

describe("lifetime-counters", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "unerr-lifetime-counters-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("read on a fresh repo (no file) returns all zeros and empty updated_at", () => {
    const result = readLifetimeCounters(tmpDir);
    expect(result.tokens_saved_total).toBe(0);
    expect(result.hard_prevention_total).toBe(0);
    expect(result.reversible_saved_total).toBe(0);
    expect(result.modeled_saved_total).toBe(0);
    expect(result.updated_at).toBe("");
  });

  it("bump accumulates across multiple calls", () => {
    bumpLifetimeCounters(tmpDir, { tokens_saved_total: 100 });
    bumpLifetimeCounters(tmpDir, { tokens_saved_total: 50 });
    const result = readLifetimeCounters(tmpDir);
    expect(result.tokens_saved_total).toBe(150);
  });

  it("bump only touches the fields provided; untouched fields stay at zero", () => {
    bumpLifetimeCounters(tmpDir, { hard_prevention_total: 3 });
    const result = readLifetimeCounters(tmpDir);
    expect(result.tokens_saved_total).toBe(0);
    expect(result.hard_prevention_total).toBe(3);
    expect(result.reversible_saved_total).toBe(0);
    expect(result.modeled_saved_total).toBe(0);
  });

  it("bump routes a modeled delta into modeled_saved_total only", () => {
    bumpLifetimeCounters(tmpDir, { modeled_saved_total: 250 });
    bumpLifetimeCounters(tmpDir, { modeled_saved_total: 150 });
    const result = readLifetimeCounters(tmpDir);
    expect(result.modeled_saved_total).toBe(400);
    expect(result.tokens_saved_total).toBe(0);
  });

  it("seedLifetimeCountersIfAbsent writes when absent; second call with different values does NOT overwrite", () => {
    seedLifetimeCountersIfAbsent(tmpDir, () => ({
      tokens_saved_total: 500,
      hard_prevention_total: 10,
      reversible_saved_total: 20,
      modeled_saved_total: 30,
    }));
    const first = readLifetimeCounters(tmpDir);
    expect(first.tokens_saved_total).toBe(500);

    // second seed with different values — must not overwrite
    seedLifetimeCountersIfAbsent(tmpDir, () => ({
      tokens_saved_total: 9999,
      hard_prevention_total: 9999,
      reversible_saved_total: 9999,
      modeled_saved_total: 9999,
    }));
    const second = readLifetimeCounters(tmpDir);
    expect(second.tokens_saved_total).toBe(500);
    expect(second.hard_prevention_total).toBe(10);
    expect(second.reversible_saved_total).toBe(20);
    expect(second.modeled_saved_total).toBe(30);
  });

  it("seed then bump: bump adds on top of the seeded baseline", () => {
    seedLifetimeCountersIfAbsent(tmpDir, () => ({
      tokens_saved_total: 1000,
      hard_prevention_total: 5,
      reversible_saved_total: 0,
      modeled_saved_total: 0,
    }));
    bumpLifetimeCounters(tmpDir, {
      tokens_saved_total: 200,
      reversible_saved_total: 7,
    });
    const result = readLifetimeCounters(tmpDir);
    expect(result.tokens_saved_total).toBe(1200);
    expect(result.hard_prevention_total).toBe(5);
    expect(result.reversible_saved_total).toBe(7);
  });

  it("corrupt file content returns zeros without throwing", () => {
    const path = lifetimeCountersPath(tmpDir);
    mkdirSync(join(tmpDir, ".unerr", "state"), { recursive: true });
    writeFileSync(path, "not json {{{{", "utf8");
    const result = readLifetimeCounters(tmpDir);
    expect(result.tokens_saved_total).toBe(0);
    expect(result.hard_prevention_total).toBe(0);
    expect(result.reversible_saved_total).toBe(0);
    expect(result.updated_at).toBe("");
  });

  it("updated_at is a non-empty ISO string after a bump", () => {
    const before = new Date().toISOString();
    bumpLifetimeCounters(tmpDir, { tokens_saved_total: 1 });
    const result = readLifetimeCounters(tmpDir);
    expect(result.updated_at).toBeTruthy();
    expect(new Date(result.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime()
    );
  });

  it("writeLifetimeCounters round-trips through readLifetimeCounters", () => {
    const counters = {
      tokens_saved_total: 42,
      hard_prevention_total: 7,
      reversible_saved_total: 3,
      modeled_saved_total: 9,
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    writeLifetimeCounters(tmpDir, counters);
    const result = readLifetimeCounters(tmpDir);
    expect(result).toEqual(counters);
  });
});
