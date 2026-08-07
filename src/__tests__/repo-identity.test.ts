import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const detectGitOrigin = vi.fn();

vi.mock("../daemon/git-origin.js", () => ({
  detectGitOrigin: (cwd: string) => detectGitOrigin(cwd),
}));

const { deriveRepoId, normalizeGitOrigin } = await import(
  "../cloud/sync/repo-identity.js"
);

const SHA256_HEX = /^[0-9a-f]{64}$/;

afterEach(() => {
  detectGitOrigin.mockReset();
});

describe("normalizeGitOrigin", () => {
  it("normalizes https, scp-style, and ssh spellings to one string", () => {
    const want = "github.com/org/repo";
    expect(normalizeGitOrigin("https://github.com/Org/Repo.git")).toBe(want);
    expect(normalizeGitOrigin("git@github.com:org/repo.git")).toBe(want);
    expect(normalizeGitOrigin("ssh://git@github.com/org/repo")).toBe(want);
  });

  it("treats .git and no-.git the same", () => {
    expect(normalizeGitOrigin("https://github.com/org/repo")).toBe(
      normalizeGitOrigin("https://github.com/org/repo.git")
    );
  });

  it("strips user:pass@ credentials", () => {
    expect(normalizeGitOrigin("https://user:token@github.com/org/repo")).toBe(
      "github.com/org/repo"
    );
  });

  it("strips a trailing slash", () => {
    expect(normalizeGitOrigin("https://github.com/org/repo/")).toBe(
      "github.com/org/repo"
    );
  });

  it("lowercases the whole thing", () => {
    expect(normalizeGitOrigin("https://GitHub.com/ORG/REPO")).toBe(
      "github.com/org/repo"
    );
  });
});

describe("deriveRepoId", () => {
  it("returns the same id for the three origin spellings", async () => {
    // detectGitOrigin yields the same credential-free struct for each spelling.
    const origin = {
      provider: "github",
      host: "github.com",
      owner: "org",
      repo: "repo",
    };
    detectGitOrigin.mockResolvedValue(origin);

    const a = await deriveRepoId("/a");
    const b = await deriveRepoId("/b");
    const c = await deriveRepoId("/c");

    expect(a).toMatch(SHA256_HEX);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("matches .git and no-.git origins (same host/owner/repo)", async () => {
    detectGitOrigin.mockResolvedValue({
      provider: "github",
      host: "github.com",
      owner: "org",
      repo: "repo",
    });
    const first = await deriveRepoId("/x");
    const second = await deriveRepoId("/y");
    expect(first).toBe(second);
  });

  it("falls back to a stable, path-keyed id with no origin", async () => {
    detectGitOrigin.mockResolvedValue(null);
    const p = path.join(os.tmpdir(), "unerr-repo-a");
    const id1 = await deriveRepoId(p);
    const id2 = await deriveRepoId(p);
    expect(id1).toMatch(SHA256_HEX);
    expect(id1).toBe(id2);
  });

  it("gives different path-keyed ids for different paths", async () => {
    detectGitOrigin.mockResolvedValue(null);
    const idA = await deriveRepoId(path.join(os.tmpdir(), "unerr-repo-a"));
    const idB = await deriveRepoId(path.join(os.tmpdir(), "unerr-repo-b"));
    expect(idA).not.toBe(idB);
  });

  it("resolves relative paths so the same dir is stable", async () => {
    detectGitOrigin.mockResolvedValue(null);
    const abs = path.resolve("some/rel/dir");
    const viaRel = await deriveRepoId("some/rel/dir");
    const viaAbs = await deriveRepoId(abs);
    expect(viaRel).toBe(viaAbs);
  });

  it("origin-keyed and path-keyed ids differ", async () => {
    detectGitOrigin.mockResolvedValue({
      provider: "github",
      host: "github.com",
      owner: "org",
      repo: "repo",
    });
    const originId = await deriveRepoId("/repo");
    detectGitOrigin.mockResolvedValue(null);
    const pathId = await deriveRepoId("/repo");
    expect(originId).not.toBe(pathId);
  });
});
