/**
 * C1.3 — per-repo runtime. Focus: HTTP port/URL read from server.json, the
 * always-derivable socket path, and graceful nulls when state is absent or
 * corrupt.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readRepoRuntime,
  readRepoServerJson,
  repoSockPath,
} from "../daemon/repo-runtime.js";

let repo: string;

function writeServerJson(body: unknown): void {
  const stateDir = join(repo, ".unerr", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "server.json"), JSON.stringify(body));
}

describe("repo-runtime", () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "unerr-rt-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("derives the socket path without any state on disk", () => {
    expect(repoSockPath(repo)).toBe(
      join(repo, ".unerr", "state", "proxy.sock")
    );
  });

  it("reads http port + url from server.json", () => {
    writeServerJson({
      port: 51890,
      pid: 123,
      startedAt: "2026-06-13T00:00:00Z",
      url: "http://localhost:51890",
    });
    const rt = readRepoRuntime(repo);
    expect(rt.http_port).toBe(51890);
    expect(rt.http_url).toBe("http://localhost:51890");
    expect(rt.sock_path).toBe(join(repo, ".unerr", "state", "proxy.sock"));
  });

  it("returns null endpoints when server.json is absent", () => {
    const rt = readRepoRuntime(repo);
    expect(rt.http_port).toBeNull();
    expect(rt.http_url).toBeNull();
    expect(rt.sock_path.length).toBeGreaterThan(0);
  });

  it("returns null on corrupt server.json", () => {
    const stateDir = join(repo, ".unerr", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "server.json"), "{ not json");
    expect(readRepoServerJson(repo)).toBeNull();
    expect(readRepoRuntime(repo).http_port).toBeNull();
  });
});
