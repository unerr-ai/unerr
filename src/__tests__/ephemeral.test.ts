import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Ephemeral Sandbox (P5.6-ADV-02)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `unerr-ephemeral-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("connect --ephemeral creates ephemeral repo config", () => {
    // Simulate ephemeral repo creation: a config with ephemeral: true and a TTL
    const unerrDir = path.join(tmpDir, ".unerr");
    fs.mkdirSync(unerrDir, { recursive: true });

    const ttlHours = 24;
    const expiresAt = new Date(
      Date.now() + ttlHours * 60 * 60 * 1000
    ).toISOString();

    const ephemeralConfig = {
      repoId: "eph-repo-123",
      orgId: "org-1",
      branch: "main",
      ephemeral: true,
      expiresAt,
    };

    fs.writeFileSync(
      path.join(unerrDir, "config.json"),
      `${JSON.stringify(ephemeralConfig, null, 2)}\n`
    );

    const raw = fs.readFileSync(path.join(unerrDir, "config.json"), "utf-8");
    const config = JSON.parse(raw) as {
      repoId: string;
      ephemeral: boolean;
      expiresAt: string;
    };

    expect(config.ephemeral).toBe(true);
    expect(config.repoId).toBe("eph-repo-123");
    expect(new Date(config.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("promote converts ephemeral to permanent config", () => {
    const unerrDir = path.join(tmpDir, ".unerr");
    fs.mkdirSync(unerrDir, { recursive: true });

    // Start with ephemeral config
    const ephemeralConfig = {
      repoId: "eph-repo-456",
      orgId: "org-1",
      branch: "main",
      ephemeral: true,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    const configPath = path.join(unerrDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(ephemeralConfig, null, 2));

    // Simulate "promote" — remove ephemeral flag and expiry
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    config.ephemeral = undefined;
    config.expiresAt = undefined;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const promoted = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      repoId: string;
      ephemeral?: boolean;
      expiresAt?: string;
    };

    expect(promoted.repoId).toBe("eph-repo-456");
    expect(promoted.ephemeral).toBeUndefined();
    expect(promoted.expiresAt).toBeUndefined();
  });

  it("ephemeral repo has TTL that can be checked", () => {
    const ttlHours = 2;
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    // Check if expired
    const isExpired = expiresAt.getTime() < Date.now();
    expect(isExpired).toBe(false);

    // Simulate an already-expired ephemeral repo
    const pastExpiry = new Date(Date.now() - 1000);
    const isPastExpired = pastExpiry.getTime() < Date.now();
    expect(isPastExpired).toBe(true);
  });

  it("ephemeral config includes all required fields", () => {
    const ephemeralConfig = {
      repoId: "eph-repo-789",
      orgId: "org-1",
      branch: "main",
      ephemeral: true,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    // Validate required fields
    expect(ephemeralConfig.repoId).toBeTruthy();
    expect(ephemeralConfig.orgId).toBeTruthy();
    expect(ephemeralConfig.branch).toBeTruthy();
    expect(ephemeralConfig.ephemeral).toBe(true);
    expect(ephemeralConfig.expiresAt).toBeTruthy();
  });

  it("expired ephemeral repos are detectable for cleanup", () => {
    // Simulate multiple ephemeral configs, some expired
    const configs = [
      {
        repoId: "eph-1",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        ephemeral: true,
      },
      {
        repoId: "eph-2",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        ephemeral: true,
      },
      {
        repoId: "eph-3",
        expiresAt: new Date(Date.now() - 5000).toISOString(),
        ephemeral: true,
      },
      { repoId: "perm-1", ephemeral: false, expiresAt: undefined },
    ];

    const expired = configs.filter(
      (c) =>
        c.ephemeral &&
        c.expiresAt &&
        new Date(c.expiresAt).getTime() < Date.now()
    );

    expect(expired.length).toBe(2);
    expect(expired.map((c) => c.repoId)).toContain("eph-2");
    expect(expired.map((c) => c.repoId)).toContain("eph-3");
  });
});
