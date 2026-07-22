/**
 * Repo bootstrap (`ensureRepoConfig`): headless install entry points used to
 * leave a repo with no `.unerr/config.json`, which made the daemon-spawned
 * MCP server exit on first boot ("run `unerr` interactively first."). These
 * tests cover the fix — bootstrap creates the same on-disk shape the
 * interactive wizard writes, idempotently, and `runInstall` now leaves a
 * bootable repo behind.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ensureRepoConfig", () => {
  let dir: string;
  let counter = 0;

  beforeEach(() => {
    counter++;
    dir = join(
      tmpdir(),
      `repo-bootstrap-${Date.now()}-${counter}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates config.json + settings.json in an empty dir", async () => {
    const { ensureRepoConfig } = await import("../config/repo-bootstrap.js");
    const result = await ensureRepoConfig(dir);

    expect(result.created).toBe(true);
    expect(result.repoId).toMatch(/^[0-9a-f]{12}$/);

    const configPath = join(dir, ".unerr", "config.json");
    const settingsPath = join(dir, ".unerr", "settings.json");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).toEqual({ repoId: result.repoId });
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings).toEqual({});
  });

  it("is idempotent on a second call — created:false, same repoId, no rewrite", async () => {
    const { ensureRepoConfig } = await import("../config/repo-bootstrap.js");
    const first = await ensureRepoConfig(dir);
    const configPath = join(dir, ".unerr", "config.json");
    const rawAfterFirst = readFileSync(configPath, "utf-8");

    const second = await ensureRepoConfig(dir);

    expect(second.created).toBe(false);
    expect(second.repoId).toBe(first.repoId);
    // Content is byte-identical — the second call never rewrote the file.
    expect(readFileSync(configPath, "utf-8")).toBe(rawAfterFirst);
  });

  it("repoId matches the single hash source setup-wizard.ts imports (no duplicate hash logic)", async () => {
    const { ensureRepoConfig, generateRepoId } = await import(
      "../config/repo-bootstrap.js"
    );
    const result = await ensureRepoConfig(dir);
    const recomputed = await generateRepoId(dir);
    expect(result.repoId).toBe(recomputed);

    // setup-wizard.ts must import the shared function rather than carrying
    // its own copy of the hash algorithm — a duplicate copy could silently
    // drift and produce a different repoId for the same directory.
    const wizardSource = readFileSync(
      new URL("../commands/setup-wizard.ts", import.meta.url),
      "utf-8"
    );
    expect(wizardSource).toContain(
      'import { generateRepoId } from "../config/repo-bootstrap.js"'
    );
    expect(wizardSource).not.toMatch(/function generateRepoId/);
  });

  it("adds repoId to a config missing it without dropping its other keys", async () => {
    const { ensureRepoConfig } = await import("../config/repo-bootstrap.js");
    const configDir = join(dir, ".unerr");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    // A config that parses but has no repoId (partial / hand-edited).
    writeFileSync(configPath, JSON.stringify({ tier: "pro", extra: 1 }));

    const result = await ensureRepoConfig(dir);

    expect(result.created).toBe(true);
    expect(result.repoId).toMatch(/^[0-9a-f]{12}$/);
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(parsed.repoId).toBe(result.repoId);
    expect(parsed.tier).toBe("pro");
    expect(parsed.extra).toBe(1);
  });

  it("treats a corrupt config.json as absent and rewrites it", async () => {
    const { ensureRepoConfig } = await import("../config/repo-bootstrap.js");
    const configDir = join(dir, ".unerr");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, "{ not valid json ");

    const result = await ensureRepoConfig(dir);

    expect(result.created).toBe(true);
    expect(result.repoId).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).repoId).toBe(
      result.repoId
    );
  });
});

describe("runInstall bootstraps .unerr/config.json", () => {
  let homeDir: string;
  let cwd: string;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    homeDir = join(tmpdir(), `repo-bootstrap-home-${stamp}`);
    cwd = join(tmpdir(), `repo-bootstrap-project-${stamp}`);
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    // UNERR_HOME redirects the daemon registry + probe socket path away from
    // the real machine's ~/.unerr — so this never touches a live unerrd or
    // its repos.json, and `probeDaemon` fails fast (no socket at this path).
    vi.stubEnv("UNERR_HOME", homeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("leaves .unerr/config.json behind after a claude-code install", async () => {
    const { runInstall } = await import("../commands/install.js");
    const result = await runInstall(cwd, "claude-code" as any);

    expect(result.configBootstrapped).toBe(true);
    const configPath = join(cwd, ".unerr", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(typeof config.repoId).toBe("string");
  });
});
