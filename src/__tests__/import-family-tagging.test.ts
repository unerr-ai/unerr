import { describe, expect, it } from "vitest";

import {
  getLibraryFamilyMap,
  resolveFamiliesFromImports,
  resolveLibraryFamily,
} from "../router/intent/library-families.js";
import { type ScorerInput, scoreIntent } from "../router/intent/scorer.js";
import { createStickinessState } from "../router/intent/stickiness.js";
import { createEmptyDecayState } from "../router/intent/threshold-decay.js";

describe("Library Family Map", () => {
  it("has ≥30 library mappings", () => {
    const map = getLibraryFamilyMap();
    expect(map.size).toBeGreaterThanOrEqual(30);
  });

  // ── Direct package resolution ──────────────────────────────────

  it("resolves pg → pg family", () => {
    expect(resolveLibraryFamily("pg")).toBe("pg");
  });

  it("resolves @prisma/client → pg family", () => {
    expect(resolveLibraryFamily("@prisma/client")).toBe("pg");
  });

  it("resolves drizzle-orm → pg family", () => {
    expect(resolveLibraryFamily("drizzle-orm")).toBe("pg");
  });

  it("resolves octokit → gh family", () => {
    expect(resolveLibraryFamily("octokit")).toBe("gh");
  });

  it("resolves @slack/bolt → slk family", () => {
    expect(resolveLibraryFamily("@slack/bolt")).toBe("slk");
  });

  it("resolves stripe → str family", () => {
    expect(resolveLibraryFamily("stripe")).toBe("str");
  });

  it("resolves posthog-js → posthog family", () => {
    expect(resolveLibraryFamily("posthog-js")).toBe("posthog");
  });

  it("resolves livekit-client → livekit family", () => {
    expect(resolveLibraryFamily("livekit-client")).toBe("livekit");
  });

  it("resolves @deepgram/sdk → deepgram family", () => {
    expect(resolveLibraryFamily("@deepgram/sdk")).toBe("deepgram");
  });

  it("resolves @circle-fin/usdc → circle family", () => {
    expect(resolveLibraryFamily("@circle-fin/usdc")).toBe("circle");
  });

  it("resolves @linear/sdk → lin family", () => {
    expect(resolveLibraryFamily("@linear/sdk")).toBe("lin");
  });

  it("resolves ioredis → rds family", () => {
    expect(resolveLibraryFamily("ioredis")).toBe("rds");
  });

  it("resolves mongoose → mdb family", () => {
    expect(resolveLibraryFamily("mongoose")).toBe("mdb");
  });

  it("resolves firebase-admin → fb family", () => {
    expect(resolveLibraryFamily("firebase-admin")).toBe("fb");
  });

  it("resolves @supabase/supabase-js → sup family", () => {
    expect(resolveLibraryFamily("@supabase/supabase-js")).toBe("sup");
  });

  it("resolves aws-sdk → aws family", () => {
    expect(resolveLibraryFamily("aws-sdk")).toBe("aws");
  });

  it("resolves dd-trace → dd family", () => {
    expect(resolveLibraryFamily("dd-trace")).toBe("dd");
  });

  // ── Scope-prefix fallback resolution ───────────────────────────

  it("resolves unknown @aws-sdk/ package via prefix", () => {
    expect(resolveLibraryFamily("@aws-sdk/client-ec2")).toBe("aws");
  });

  it("resolves unknown @google-cloud/ package via prefix", () => {
    expect(resolveLibraryFamily("@google-cloud/pubsub")).toBe("fb");
  });

  it("resolves unknown @sentry/ package via prefix", () => {
    expect(resolveLibraryFamily("@sentry/profiling-node")).toBe("snt");
  });

  it("resolves unknown @octokit/ package via prefix", () => {
    expect(resolveLibraryFamily("@octokit/plugin-paginate-rest")).toBe("gh");
  });

  // ── Unknown packages ───────────────────────────────────────────

  it("returns null for unknown package", () => {
    expect(resolveLibraryFamily("lodash")).toBeNull();
  });

  it("returns null for react", () => {
    expect(resolveLibraryFamily("react")).toBeNull();
  });

  it("returns null for unknown scoped package", () => {
    expect(resolveLibraryFamily("@my-company/utils")).toBeNull();
  });

  // ── Batch resolution ───────────────────────────────────────────

  it("resolves multiple imports to deduplicated families", () => {
    const families = resolveFamiliesFromImports([
      "pg",
      "pg-pool",
      "@prisma/client",
      "octokit",
    ]);
    expect(families.size).toBe(2);
    expect(families.has("pg")).toBe(true);
    expect(families.has("gh")).toBe(true);
  });

  it("filters out unknown packages in batch", () => {
    const families = resolveFamiliesFromImports([
      "react",
      "lodash",
      "pg",
      "express",
    ]);
    expect(families.size).toBe(1);
    expect(families.has("pg")).toBe(true);
  });

  it("handles empty import list", () => {
    const families = resolveFamiliesFromImports([]);
    expect(families.size).toBe(0);
  });
});

describe("Scorer — Entity family tags", () => {
  const baseScorerInput = (): ScorerInput => ({
    recentFiles: [],
    entityFamilyTags: new Map(),
    recentToolFamilies: [],
    stickinessState: createStickinessState(),
    decayState: createEmptyDecayState(),
    knownFamilies: new Set(["pg", "gh", "slk", "str"]),
  });

  it("scores entity with pg-family tag ≥0.40", () => {
    const input: ScorerInput = {
      ...baseScorerInput(),
      entityFamilyTags: new Map([["UserService", new Set(["pg"])]]),
    };
    const result = scoreIntent(input);

    const pgScore = result.scores.find((s) => s.family === "pg")!;
    expect(pgScore.score).toBeGreaterThanOrEqual(0.4);
    expect(pgScore.exposed).toBe(true);
    expect(pgScore.reasons.some((r) => r.includes("import-graph"))).toBe(true);
  });

  it("multiple entities with same family don't double-count", () => {
    const input: ScorerInput = {
      ...baseScorerInput(),
      entityFamilyTags: new Map([
        ["UserService", new Set(["pg"])],
        ["OrderRepo", new Set(["pg"])],
      ]),
    };
    const result = scoreIntent(input);

    const pgScore = result.scores.find((s) => s.family === "pg")!;
    expect(pgScore.score).toBeLessThanOrEqual(0.5);
  });

  it("entities with multiple family tags score both", () => {
    const input: ScorerInput = {
      ...baseScorerInput(),
      entityFamilyTags: new Map([["SyncService", new Set(["pg", "gh"])]]),
    };
    const result = scoreIntent(input);

    const pgScore = result.scores.find((s) => s.family === "pg")!;
    const ghScore = result.scores.find((s) => s.family === "gh")!;
    expect(pgScore.score).toBeGreaterThanOrEqual(0.4);
    expect(ghScore.score).toBeGreaterThanOrEqual(0.4);
    expect(pgScore.exposed).toBe(true);
    expect(ghScore.exposed).toBe(true);
  });

  it("untagged families stay at 0 score", () => {
    const input: ScorerInput = {
      ...baseScorerInput(),
      entityFamilyTags: new Map([["UserService", new Set(["pg"])]]),
    };
    const result = scoreIntent(input);

    const slkScore = result.scores.find((s) => s.family === "slk")!;
    expect(slkScore.score).toBe(0);
    expect(slkScore.exposed).toBe(false);
  });

  it("file patterns combine with entity tags", () => {
    const input: ScorerInput = {
      ...baseScorerInput(),
      recentFiles: [".github/workflows/ci.yml"],
      entityFamilyTags: new Map([["UserService", new Set(["pg"])]]),
    };
    const result = scoreIntent(input);

    expect(result.exposedFamilies.has("pg")).toBe(true);
    expect(result.exposedFamilies.has("gh")).toBe(true);
  });

  it("completes within 5ms budget", () => {
    const input: ScorerInput = {
      ...baseScorerInput(),
      entityFamilyTags: new Map(
        Array.from(
          { length: 50 },
          (_, i) => [`Entity${i}`, new Set(["pg"])] as const
        )
      ),
      recentFiles: Array.from(
        { length: 20 },
        (_, i) => `db/migrations/${i}.sql`
      ),
    };
    const result = scoreIntent(input);
    expect(result.latencyMs).toBeLessThan(5);
  });

  it("returns sorted scores (highest first)", () => {
    const input: ScorerInput = {
      ...baseScorerInput(),
      entityFamilyTags: new Map([["UserService", new Set(["pg"])]]),
    };
    const result = scoreIntent(input);
    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i]!.score).toBeLessThanOrEqual(
        result.scores[i - 1]!.score
      );
    }
  });
});

describe("Scorer — Verification gate scenario", () => {
  it("synthetic codebase: 5 files with known imports → correct family exposure", () => {
    const knownFamilies = new Set(["pg", "posthog", "gh", "livekit", "slk"]);

    const entityFamilyTags = new Map<string, ReadonlySet<string>>([
      ["DbClient", new Set(resolveFamiliesFromImports(["pg"]))],
      ["AnalyticsTracker", new Set(resolveFamiliesFromImports(["posthog-js"]))],
      ["GitHubSync", new Set(resolveFamiliesFromImports(["octokit"]))],
      ["VideoRoom", new Set(resolveFamiliesFromImports(["livekit-client"]))],
      ["UtilHelpers", new Set(resolveFamiliesFromImports(["lodash"]))],
    ]);

    const input: ScorerInput = {
      recentFiles: [],
      entityFamilyTags,
      recentToolFamilies: [],
      stickinessState: createStickinessState(),
      decayState: createEmptyDecayState(),
      knownFamilies,
    };

    const result = scoreIntent(input);

    expect(result.exposedFamilies.has("pg")).toBe(true);
    expect(result.exposedFamilies.has("posthog")).toBe(true);
    expect(result.exposedFamilies.has("gh")).toBe(true);
    expect(result.exposedFamilies.has("livekit")).toBe(true);
    expect(result.exposedFamilies.has("slk")).toBe(false);
  });
});
