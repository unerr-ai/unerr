/**
 * C2 — fleet payload assembly + redaction. Focus: the join is correct, the repo
 * list is capped, the heartbeat is the lightweight subset, and NO secret/PII
 * (token, embedded credential) can ride in either payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../daemon/registry.js", () => ({ listRepos: vi.fn() }));
vi.mock("../utils/git.js", () => ({ getRemoteUrl: vi.fn() }));
vi.mock("../cloud/credentials.js", () => ({ readCredentialMetadata: vi.fn() }));
vi.mock("../daemon/repo-runtime.js", () => ({ readRepoRuntime: vi.fn() }));

import { readCredentialMetadata } from "../cloud/credentials.js";
import {
  MAX_REPOS_PER_REPORT,
  buildFleetReport,
  buildHeartbeatReport,
} from "../daemon/fleet-inventory.js";
import { __clearGitOriginCache } from "../daemon/git-origin.js";
import type { RepoStatusEntry } from "../daemon/protocol.js";
import { listRepos } from "../daemon/registry.js";
import { readRepoRuntime } from "../daemon/repo-runtime.js";
import { getRemoteUrl } from "../utils/git.js";

const mockedListRepos = vi.mocked(listRepos);
const mockedGetRemoteUrl = vi.mocked(getRemoteUrl);
const mockedMeta = vi.mocked(readCredentialMetadata);
const mockedRuntime = vi.mocked(readRepoRuntime);

const fakeProc = {
  pid: 1,
  uptime: () => 10,
  memoryUsage: () => ({ rss: 1 }) as NodeJS.MemoryUsage,
} as unknown as Pick<NodeJS.Process, "pid" | "uptime" | "memoryUsage">;

function statusEntry(over: Partial<RepoStatusEntry> = {}): RepoStatusEntry {
  return {
    path: "/repo/a",
    label: "a",
    status: "running",
    pid: 100,
    memory: 2048,
    idle: 0,
    connections: 1,
    lastActivity: "2026-06-13T00:00:00Z",
    entityCount: 10,
    edgeCount: 20,
    needsInput: [],
    ...over,
  };
}

describe("fleet inventory", () => {
  beforeEach(() => {
    __clearGitOriginCache();
    mockedMeta.mockReturnValue({
      organization_id: "org_1",
      machine_id: "m_1",
      machine_name: "host",
    });
    mockedListRepos.mockReturnValue([
      {
        path: "/repo/a",
        addedAt: "2026-06-01T00:00:00Z",
        lastStarted: "2026-06-12T00:00:00Z",
      } as any,
    ]);
    mockedRuntime.mockReturnValue({
      http_port: 51890,
      http_url: "http://localhost:51890",
      sock_path: "/repo/a/.unerr/state/proxy.sock",
    });
    mockedGetRemoteUrl.mockResolvedValue(
      "https://github.com/unerr-ai/unerr-cli.git"
    );
  });
  afterEach(() => {
    vi.clearAllMocks();
    __clearGitOriginCache();
  });

  it("returns null when not logged in", async () => {
    mockedMeta.mockReturnValue(null);
    expect(
      await buildFleetReport({ statusEntries: [], proc: fakeProc })
    ).toBeNull();
    expect(
      buildHeartbeatReport({ statusEntries: [], proc: fakeProc })
    ).toBeNull();
  });

  it("joins registry + status + origin + ports into the full report", async () => {
    const report = await buildFleetReport({
      statusEntries: [statusEntry()],
      proc: fakeProc,
    });
    expect(report?.schema_version).toBe(1);
    expect(report?.machine.machine_name).toBe("host");
    expect(report?.repos.length).toBe(1);
    expect(report?.repos[0]).toMatchObject({
      label: "a",
      path: "/repo/a",
      origin: { provider: "github", owner: "unerr-ai", repo: "unerr-cli" },
      status: "running",
      pid: 100,
      http_port: 51890,
      memory_bytes: 2048,
      entity_count: 10,
      edge_count: 20,
      added_at: "2026-06-01T00:00:00Z",
      // last_activity from the live status entry; last_used_at from the
      // registry's lastStarted (when the proxy was last used by an agent).
      last_activity: "2026-06-13T00:00:00Z",
      last_used_at: "2026-06-12T00:00:00Z",
    });
  });

  it("leaves origin null for a repo with no remote", async () => {
    mockedGetRemoteUrl.mockResolvedValue(null);
    const report = await buildFleetReport({
      statusEntries: [statusEntry()],
      proc: fakeProc,
    });
    expect(report?.repos[0]?.origin).toBeNull();
  });

  it("caps the repo list at the server's array limit", async () => {
    const many = Array.from({ length: MAX_REPOS_PER_REPORT + 25 }, (_, i) =>
      statusEntry({ path: `/repo/${i}`, label: `r${i}` })
    );
    const report = await buildFleetReport({
      statusEntries: many,
      proc: fakeProc,
    });
    expect(report?.repos.length).toBe(MAX_REPOS_PER_REPORT);
  });

  it("heartbeat is the lightweight subset (no origin/ports)", () => {
    const beat = buildHeartbeatReport({
      statusEntries: [statusEntry()],
      proc: fakeProc,
    });
    expect(beat?.schema_version).toBe(1);
    expect(beat?.daemon.pid).toBe(1);
    expect(beat?.repos[0]).toEqual({
      path: "/repo/a",
      status: "running",
      pid: 100,
      connections: 1,
      entity_count: 10,
      edge_count: 20,
      // Usage timestamps are now refreshed on the heartbeat too.
      added_at: "2026-06-01T00:00:00Z",
      last_activity: "2026-06-13T00:00:00Z",
      last_used_at: "2026-06-12T00:00:00Z",
    });
    // The lightweight beat carries the path/status but no origin or ports.
    expect(JSON.stringify(beat)).not.toContain("github");
    expect(JSON.stringify(beat)).not.toContain("http_port");
  });

  it("never leaks a token or an embedded git credential", async () => {
    mockedGetRemoteUrl.mockResolvedValue(
      "https://bot:ghp_supersecret@github.com/unerr-ai/unerr-cli.git"
    );
    const report = await buildFleetReport({
      statusEntries: [statusEntry()],
      proc: fakeProc,
    });
    const wire = JSON.stringify(report);
    expect(wire).not.toContain("ghp_supersecret");
    expect(wire).not.toMatch(/token|bearer|unerr_sk_/i);
    // The host still resolves, just credential-free.
    expect(report?.repos[0]?.origin?.host).toBe("github.com");
  });
});
