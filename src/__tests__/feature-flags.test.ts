import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FEATURE_FLAGS,
  isEnabled,
  readFeaturesBlock,
  setFlag,
} from "../config/feature-flags.js";

describe("feature-flags", () => {
  let repo: string;
  const ENV_KEYS = [...FEATURE_FLAGS];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "unerr-flags-"));
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults every flag to OFF with no env and no config", () => {
    for (const flag of FEATURE_FLAGS) {
      expect(isEnabled(flag, repo)).toBe(false);
    }
  });

  it("reads an enabled flag from the config features block", () => {
    mkdirSync(join(repo, ".unerr"), { recursive: true });
    writeFileSync(
      join(repo, ".unerr", "config.json"),
      JSON.stringify({ features: { UNERR_PREFIX_RELOCATE: true } })
    );
    expect(isEnabled("UNERR_PREFIX_RELOCATE", repo)).toBe(true);
    expect(isEnabled("UNERR_DELEGATION", repo)).toBe(false);
  });

  it("env var wins over config — on", () => {
    setFlag("UNERR_LLMLINGUA", false, repo);
    process.env.UNERR_LLMLINGUA = "1";
    expect(isEnabled("UNERR_LLMLINGUA", repo)).toBe(true);
  });

  it("env var wins over config — off overrides an enabled config", () => {
    setFlag("UNERR_LLMLINGUA", true, repo);
    process.env.UNERR_LLMLINGUA = "0";
    expect(isEnabled("UNERR_LLMLINGUA", repo)).toBe(false);
  });

  it("setFlag preserves other config fields and toggles round-trip", () => {
    mkdirSync(join(repo, ".unerr"), { recursive: true });
    writeFileSync(
      join(repo, ".unerr", "config.json"),
      JSON.stringify({ repoId: "abc", capture_prompts: true })
    );
    setFlag("UNERR_XSESSION_CACHE", true, repo);

    const cfg = JSON.parse(
      readFileSync(join(repo, ".unerr", "config.json"), "utf-8")
    );
    expect(cfg.repoId).toBe("abc");
    expect(cfg.capture_prompts).toBe(true);
    expect(cfg.features.UNERR_XSESSION_CACHE).toBe(true);

    setFlag("UNERR_XSESSION_CACHE", false, repo);
    expect(isEnabled("UNERR_XSESSION_CACHE", repo)).toBe(false);
  });

  it("malformed config never throws — falls back to OFF", () => {
    mkdirSync(join(repo, ".unerr"), { recursive: true });
    writeFileSync(join(repo, ".unerr", "config.json"), "{ not json");
    expect(readFeaturesBlock(repo)).toEqual({});
    expect(isEnabled("UNERR_DELEGATION", repo)).toBe(false);
  });

  it("creates the config file when absent", () => {
    setFlag("UNERR_DELEGATION_CODEX", true, repo);
    expect(existsSync(join(repo, ".unerr", "config.json"))).toBe(true);
    expect(isEnabled("UNERR_DELEGATION_CODEX", repo)).toBe(true);
  });
});
