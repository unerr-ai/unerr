import { describe, it, expect } from "vitest";

import {
  scanServerUsage,
  resolveAutoMask,
  isAutoMasked,
  type ServerUsageProfile,
  type UsageScanResult,
} from "../router/usage-scanner.js";
import type { RouterTelemetryRecord } from "../proxy/router-telemetry.js";

function makeRecord(
  server: string,
  sessionId: string,
  opts?: { outcome?: "executed" | "soft_refused" | "child_error"; ts?: string },
): RouterTelemetryRecord {
  return {
    v: 1,
    ts: opts?.ts ?? "2025-06-01T00:00:00.000Z",
    sessionId,
    toolName: `${server}_tool`,
    originalToolName: "tool",
    server,
    outcome: opts?.outcome ?? "executed",
    wasMasked: false,
    tokensIn: 100,
    tokensSaved: 0,
    latencyMs: { total: 5 },
  };
}

function makeRecords(
  serverCalls: Record<string, number>,
  sessionCount: number,
): RouterTelemetryRecord[] {
  const records: RouterTelemetryRecord[] = [];
  for (let s = 0; s < sessionCount; s++) {
    const sessionId = `session-${s}`;
    for (const [server, calls] of Object.entries(serverCalls)) {
      for (let c = 0; c < calls; c++) {
        records.push(makeRecord(server, sessionId));
      }
    }
  }
  return records;
}

const SERVERS = [
  { name: "github", alias: "gh" },
  { name: "postgres", alias: "pg" },
  { name: "slack", alias: "slk" },
  { name: "sentry", alias: "snt" },
  { name: "stripe", alias: "str" },
];

describe("Usage Scanner — Server classification", () => {
  it("classifies server with 0 calls across ≥10 sessions as never-used", () => {
    const records = makeRecords({ github: 5, postgres: 10 }, 12);
    const result = scanServerUsage(records, SERVERS);

    const slk = result.profiles.find((p) => p.serverName === "slack")!;
    expect(slk.bucket).toBe("never-used");
    expect(slk.totalCalls).toBe(0);
  });

  it("classifies server with 1-20 total calls as occasional", () => {
    const records = [
      ...makeRecords({ github: 5, postgres: 10 }, 12),
      makeRecord("slack", "session-3"),
      makeRecord("slack", "session-5"),
    ];
    const result = scanServerUsage(records, SERVERS);

    const slk = result.profiles.find((p) => p.serverName === "slack")!;
    expect(slk.bucket).toBe("occasional");
    expect(slk.totalCalls).toBe(2);
  });

  it("classifies server with >20 total calls as frequent", () => {
    const records = makeRecords({ github: 5 }, 12);
    const result = scanServerUsage(records, SERVERS);

    const gh = result.profiles.find((p) => p.serverName === "github")!;
    expect(gh.bucket).toBe("frequent");
    expect(gh.totalCalls).toBe(60);
  });

  it("requires ≥10 sessions for never-used classification", () => {
    const records = makeRecords({ github: 5 }, 5);
    const result = scanServerUsage(records, SERVERS);

    const slk = result.profiles.find((p) => p.serverName === "slack")!;
    expect(slk.bucket).toBe("occasional");
    expect(slk.totalCalls).toBe(0);
  });

  it("counts unique sessions per server", () => {
    const records = [
      makeRecord("github", "s1"),
      makeRecord("github", "s1"),
      makeRecord("github", "s2"),
      makeRecord("github", "s3"),
      ...Array.from({ length: 10 }, (_, i) => makeRecord("postgres", `s${i}`)),
    ];
    const result = scanServerUsage(records, SERVERS);

    const gh = result.profiles.find((p) => p.serverName === "github")!;
    expect(gh.sessionsSeen).toBe(3);
    expect(gh.totalCalls).toBe(4);
  });

  it("tracks totalSessions across all records", () => {
    const records = makeRecords({ github: 1 }, 15);
    const result = scanServerUsage(records, SERVERS);
    expect(result.totalSessions).toBe(15);
  });

  it("only counts executed and soft_refused outcomes", () => {
    const records = [
      makeRecord("github", "s1", { outcome: "executed" }),
      makeRecord("github", "s2", { outcome: "child_error" }),
      ...Array.from({ length: 10 }, (_, i) => makeRecord("postgres", `s${i}`)),
    ];
    const result = scanServerUsage(records, SERVERS);

    const gh = result.profiles.find((p) => p.serverName === "github")!;
    expect(gh.totalCalls).toBe(1);
  });

  it("handles empty records gracefully", () => {
    const result = scanServerUsage([], SERVERS);
    expect(result.totalSessions).toBe(0);
    expect(result.autoMaskCandidates).toHaveLength(0);
    for (const profile of result.profiles) {
      expect(profile.bucket).toBe("occasional");
    }
  });
});

describe("Usage Scanner — Auto-mask candidates", () => {
  it("identifies never-used servers as auto-mask candidates", () => {
    const records = makeRecords({ github: 5, postgres: 3 }, 12);
    const result = scanServerUsage(records, SERVERS);

    expect(result.autoMaskCandidates.length).toBe(3);
    const names = result.autoMaskCandidates.map((c) => c.serverName);
    expect(names).toContain("slack");
    expect(names).toContain("sentry");
    expect(names).toContain("stripe");
  });

  it("excludes pinned servers from candidates", () => {
    const records = makeRecords({ github: 5, postgres: 3 }, 12);
    const pinned = new Set(["slack"]);
    const result = scanServerUsage(records, SERVERS, pinned);

    const names = result.autoMaskCandidates.map((c) => c.serverName);
    expect(names).not.toContain("slack");
    expect(names).toContain("sentry");
    expect(names).toContain("stripe");
  });

  it("returns empty candidates when all servers are used", () => {
    const records = makeRecords(
      { github: 5, postgres: 3, slack: 1, sentry: 1, stripe: 1 },
      12,
    );
    const result = scanServerUsage(records, SERVERS);
    expect(result.autoMaskCandidates).toHaveLength(0);
  });

  it("returns empty candidates when insufficient sessions", () => {
    const records = makeRecords({ github: 5 }, 5);
    const result = scanServerUsage(records, SERVERS);
    expect(result.autoMaskCandidates).toHaveLength(0);
  });
});

describe("Usage Scanner — resolveAutoMask", () => {
  const candidates: ServerUsageProfile[] = [
    { serverName: "slack", alias: "slk", bucket: "never-used", totalCalls: 0, sessionsSeen: 0, totalSessions: 12, lastUsedAt: null },
    { serverName: "sentry", alias: "snt", bucket: "never-used", totalCalls: 0, sessionsSeen: 0, totalSessions: 12, lastUsedAt: null },
    { serverName: "stripe", alias: "str", bucket: "never-used", totalCalls: 0, sessionsSeen: 0, totalSessions: 12, lastUsedAt: null },
  ];

  it("masks only confirmed servers", () => {
    const masked = resolveAutoMask(candidates, ["slack", "sentry"]);
    expect(masked.has("slack")).toBe(true);
    expect(masked.has("sentry")).toBe(true);
    expect(masked.has("stripe")).toBe(false);
  });

  it("masks all when all confirmed", () => {
    const masked = resolveAutoMask(candidates, ["slack", "sentry", "stripe"]);
    expect(masked.size).toBe(3);
  });

  it("masks none when empty confirmation", () => {
    const masked = resolveAutoMask(candidates, []);
    expect(masked.size).toBe(0);
  });

  it("ignores non-candidate server names in confirmation", () => {
    const masked = resolveAutoMask(candidates, ["github", "postgres"]);
    expect(masked.size).toBe(0);
  });
});

describe("Usage Scanner — isAutoMasked", () => {
  const autoMasked = new Set(["slack", "sentry"]);
  const pinned = new Set(["sentry"]);

  it("returns true for auto-masked server", () => {
    expect(isAutoMasked("slack", autoMasked, new Set())).toBe(true);
  });

  it("returns false for non-masked server", () => {
    expect(isAutoMasked("github", autoMasked, new Set())).toBe(false);
  });

  it("pinned server overrides auto-mask", () => {
    expect(isAutoMasked("sentry", autoMasked, pinned)).toBe(false);
  });

  it("pinned server that is not auto-masked returns false", () => {
    expect(isAutoMasked("github", autoMasked, pinned)).toBe(false);
  });
});

describe("Usage Scanner — Verification gate scenario", () => {
  it("10 sessions, 3 heavily used, 5 never used → masks the 5", () => {
    const heavyServers = [
      { name: "github", alias: "gh" },
      { name: "postgres", alias: "pg" },
      { name: "linear", alias: "lin" },
    ];
    const neverUsed = [
      { name: "slack", alias: "slk" },
      { name: "sentry", alias: "snt" },
      { name: "stripe", alias: "str" },
      { name: "figma", alias: "fig" },
      { name: "jira", alias: "jra" },
    ];
    const allServers = [...heavyServers, ...neverUsed];

    const records = makeRecords({ github: 10, postgres: 8, linear: 5 }, 10);

    const result = scanServerUsage(records, allServers);

    expect(result.totalSessions).toBe(10);
    expect(result.autoMaskCandidates).toHaveLength(5);

    const candidateNames = result.autoMaskCandidates.map((c) => c.serverName).sort();
    expect(candidateNames).toEqual(["figma", "jira", "sentry", "slack", "stripe"]);

    const masked = resolveAutoMask(
      result.autoMaskCandidates,
      result.autoMaskCandidates.map((c) => c.serverName),
    );
    expect(masked.size).toBe(5);

    for (const server of heavyServers) {
      expect(isAutoMasked(server.name, masked, new Set())).toBe(false);
    }
    for (const server of neverUsed) {
      expect(isAutoMasked(server.name, masked, new Set())).toBe(true);
    }
  });
});
