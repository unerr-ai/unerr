/**
 * C1.1 — git origin detector. Focus: structured parse across URL shapes and the
 * credential-stripping guarantee (no token from a remote URL ever reaches the
 * parsed origin).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/git.js", () => ({ getRemoteUrl: vi.fn() }));

import {
  __clearGitOriginCache,
  detectGitOrigin,
  parseGitOrigin,
  providerFromHost,
} from "../daemon/git-origin.js";
import { getRemoteUrl } from "../utils/git.js";

const mockedGetRemoteUrl = vi.mocked(getRemoteUrl);

describe("parseGitOrigin", () => {
  it("parses an https remote", () => {
    expect(parseGitOrigin("https://github.com/unerr-ai/unerr-cli.git")).toEqual(
      {
        provider: "github",
        host: "github.com",
        owner: "unerr-ai",
        repo: "unerr-cli",
      }
    );
  });

  it("parses an scp-like ssh remote", () => {
    expect(parseGitOrigin("git@github.com:unerr-ai/unerr-cli.git")).toEqual({
      provider: "github",
      host: "github.com",
      owner: "unerr-ai",
      repo: "unerr-cli",
    });
  });

  it("parses an ssh:// URL with a port", () => {
    expect(
      parseGitOrigin("ssh://git@github.com:22/unerr-ai/unerr-cli.git")
    ).toEqual({
      provider: "github",
      host: "github.com",
      owner: "unerr-ai",
      repo: "unerr-cli",
    });
  });

  it("strips credentials embedded in an https remote", () => {
    const out = parseGitOrigin(
      "https://user:ghp_secrettoken@github.com/unerr-ai/unerr-cli.git"
    );
    expect(out).toEqual({
      provider: "github",
      host: "github.com",
      owner: "unerr-ai",
      repo: "unerr-cli",
    });
    // The token must not survive anywhere in the parsed result.
    expect(JSON.stringify(out)).not.toContain("ghp_secrettoken");
    expect(JSON.stringify(out)).not.toContain("user");
  });

  it("keeps GitLab nested groups in the owner", () => {
    expect(parseGitOrigin("git@gitlab.com:group/subgroup/app.git")).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      owner: "group/subgroup",
      repo: "app",
    });
  });

  it("classifies bitbucket and self-hosted hosts", () => {
    expect(parseGitOrigin("git@bitbucket.org:team/repo.git")?.provider).toBe(
      "bitbucket"
    );
    expect(
      parseGitOrigin("git@git.internal.acme.com:team/repo.git")?.provider
    ).toBe("other");
  });

  it("resolves enterprise GitHub/GitLab hosts to their provider", () => {
    expect(parseGitOrigin("https://github.acme.com/o/r.git")?.provider).toBe(
      "github"
    );
    expect(parseGitOrigin("https://gitlab.internal/o/r.git")?.provider).toBe(
      "gitlab"
    );
  });

  it("returns null for non-remote or single-segment input", () => {
    expect(parseGitOrigin("")).toBeNull();
    expect(parseGitOrigin("   ")).toBeNull();
    expect(parseGitOrigin("not a url")).toBeNull();
    expect(parseGitOrigin("https://github.com/just-owner")).toBeNull();
  });
});

describe("providerFromHost", () => {
  it("matches case-insensitively", () => {
    expect(providerFromHost("GitHub.com")).toBe("github");
    expect(providerFromHost("GITLAB.example")).toBe("gitlab");
  });
});

describe("detectGitOrigin", () => {
  beforeEach(() => {
    __clearGitOriginCache();
    mockedGetRemoteUrl.mockReset();
  });
  afterEach(() => __clearGitOriginCache());

  it("returns the parsed origin for a repo with a remote", async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      "git@github.com:unerr-ai/unerr-cli.git"
    );
    expect(await detectGitOrigin("/repo")).toEqual({
      provider: "github",
      host: "github.com",
      owner: "unerr-ai",
      repo: "unerr-cli",
    });
  });

  it("returns null for a directory with no remote", async () => {
    mockedGetRemoteUrl.mockResolvedValue(null);
    expect(await detectGitOrigin("/no-remote")).toBeNull();
  });

  it("memoizes per cwd (git is read once)", async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      "https://github.com/unerr-ai/unerr-cli.git"
    );
    await detectGitOrigin("/repo");
    await detectGitOrigin("/repo");
    expect(mockedGetRemoteUrl).toHaveBeenCalledTimes(1);
  });

  it("never throws when git access fails", async () => {
    mockedGetRemoteUrl.mockRejectedValue(new Error("not a git repo"));
    expect(await detectGitOrigin("/broken")).toBeNull();
  });
});
