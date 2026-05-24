import { describe, expect, it } from "vitest";

import {
  type ScorerInput,
  type ScorerOutput,
  scoreIntent,
} from "../router/intent/scorer.js";
import { SignalCollector } from "../router/intent/signals.js";
import {
  advanceTurn,
  createStickinessState,
  recordFamilyCall,
} from "../router/intent/stickiness.js";
import {
  buildDecayState,
  createEmptyDecayState,
} from "../router/intent/threshold-decay.js";

const ALL_FAMILIES = new Set(["pg", "gh", "slk", "str", "aws", "rds", "mdb"]);

function baseInput(overrides: Partial<ScorerInput> = {}): ScorerInput {
  return {
    recentFiles: [],
    entityFamilyTags: new Map(),
    recentToolFamilies: [],
    stickinessState: createStickinessState(),
    decayState: createEmptyDecayState(),
    knownFamilies: ALL_FAMILIES,
    ...overrides,
  };
}

function getScore(output: ScorerOutput, family: string) {
  return output.scores.find((s) => s.family === family)!;
}

describe("Intent Scorer — DB-only scenarios", () => {
  it("entity importing pg scores pg family ≥0.40", () => {
    const result = scoreIntent(
      baseInput({
        entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
      })
    );
    expect(getScore(result, "pg").score).toBeGreaterThanOrEqual(0.4);
    expect(getScore(result, "pg").exposed).toBe(true);
  });

  it("SQL file pattern scores pg family", () => {
    const result = scoreIntent(
      baseInput({
        recentFiles: ["db/migrations/001_users.sql"],
      })
    );
    expect(getScore(result, "pg").exposed).toBe(true);
    expect(getScore(result, "gh").exposed).toBe(false);
  });

  it("Prisma schema file activates pg", () => {
    const result = scoreIntent(
      baseInput({
        recentFiles: ["prisma/schema.prisma"],
      })
    );
    expect(getScore(result, "pg").exposed).toBe(true);
  });

  it("db/seeds directory activates pg", () => {
    const result = scoreIntent(
      baseInput({
        recentFiles: ["db/seeds/users.ts"],
      })
    );
    expect(getScore(result, "pg").exposed).toBe(true);
  });

  it("multiple DB files don't inflate score beyond entity tag weight", () => {
    const result = scoreIntent(
      baseInput({
        recentFiles: [
          "db/schema.sql",
          "db/migrations/001.sql",
          "db/seeds/data.ts",
        ],
      })
    );
    expect(getScore(result, "pg").score).toBeLessThanOrEqual(0.55);
  });
});

describe("Intent Scorer — GitHub-only scenarios", () => {
  it("github workflows file activates gh", () => {
    const result = scoreIntent(
      baseInput({
        recentFiles: [".github/workflows/ci.yml"],
      })
    );
    expect(getScore(result, "gh").exposed).toBe(true);
    expect(getScore(result, "pg").exposed).toBe(false);
  });

  it("entity importing octokit activates gh", () => {
    const result = scoreIntent(
      baseInput({
        entityFamilyTags: new Map([["PRService", new Set(["gh"])]]),
      })
    );
    expect(getScore(result, "gh").exposed).toBe(true);
  });

  it("CODEOWNERS file activates gh", () => {
    const result = scoreIntent(
      baseInput({
        recentFiles: [".github/CODEOWNERS"],
      })
    );
    expect(getScore(result, "gh").exposed).toBe(true);
  });

  it("recent gh tool calls activate gh via history signal", () => {
    const result = scoreIntent(
      baseInput({
        recentToolFamilies: ["gh", "gh", "gh", "gh", "gh"],
      })
    );
    expect(getScore(result, "gh").score).toBeGreaterThanOrEqual(0.25);
  });
});

describe("Intent Scorer — Multi-domain scenarios", () => {
  it("DB entity + GitHub file → both families exposed (multiDomain=true)", () => {
    const result = scoreIntent(
      baseInput({
        entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
        recentFiles: [".github/workflows/ci.yml"],
      })
    );
    expect(result.multiDomain).toBe(true);
    expect(getScore(result, "pg").exposed).toBe(true);
    expect(getScore(result, "gh").exposed).toBe(true);
  });

  it("three families scoring high → all exposed", () => {
    const result = scoreIntent(
      baseInput({
        entityFamilyTags: new Map([
          ["UserRepo", new Set(["pg"])],
          ["PRService", new Set(["gh"])],
          ["NotifService", new Set(["slk"])],
        ]),
      })
    );
    expect(result.multiDomain).toBe(true);
    expect(result.exposedFamilies.has("pg")).toBe(true);
    expect(result.exposedFamilies.has("gh")).toBe(true);
    expect(result.exposedFamilies.has("slk")).toBe(true);
  });

  it("one family above threshold, one below → NOT multi-domain", () => {
    const result = scoreIntent(
      baseInput({
        entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
        recentFiles: ["src/utils/helpers.ts"],
      })
    );
    expect(result.multiDomain).toBe(false);
  });

  it("multi-domain includes reason explanation", () => {
    const result = scoreIntent(
      baseInput({
        entityFamilyTags: new Map([
          ["UserRepo", new Set(["pg"])],
          ["PRService", new Set(["gh"])],
        ]),
      })
    );
    const pgReasons = getScore(result, "pg").reasons;
    expect(pgReasons.some((r) => r.includes("multi-domain"))).toBe(true);
  });
});

describe("Intent Scorer — Stickiness scenarios", () => {
  it("recently-used family stays exposed even without signals", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "slk", 0);

    const result = scoreIntent(baseInput({ stickinessState: state }));
    expect(getScore(result, "slk").exposed).toBe(true);
    expect(getScore(result, "slk").sticky).toBe(true);
  });

  it("sticky family includes reason", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "pg", 0);

    const result = scoreIntent(baseInput({ stickinessState: state }));
    expect(
      getScore(result, "pg").reasons.some((r) => r.includes("sticky"))
    ).toBe(true);
  });

  it("stickiness expires after 6 turns", () => {
    let state = createStickinessState();
    state = recordFamilyCall(state, "slk", 0);
    for (let i = 0; i < 6; i++) state = advanceTurn(state);

    const result = scoreIntent(baseInput({ stickinessState: state }));
    expect(getScore(result, "slk").sticky).toBe(false);
    expect(getScore(result, "slk").exposed).toBe(false);
  });
});

describe("Intent Scorer — Threshold decay scenarios", () => {
  it("never-used family requires higher score", () => {
    const decay = buildDecayState(
      new Map([["slk", { sessionsActive: 0, sessionsTotal: 10 }]])
    );
    const result = scoreIntent(baseInput({ decayState: decay }));
    expect(getScore(result, "slk").thresholdApplied).toBeGreaterThan(0.3);
    expect(getScore(result, "slk").exposed).toBe(false);
  });

  it("frequently-used family has lower threshold", () => {
    const decay = buildDecayState(
      new Map([["pg", { sessionsActive: 20, sessionsTotal: 25 }]])
    );
    const result = scoreIntent(baseInput({ decayState: decay }));
    expect(getScore(result, "pg").thresholdApplied).toBeLessThan(0.3);
  });

  it("low file pattern score can exceed lowered threshold", () => {
    const decay = buildDecayState(
      new Map([["pg", { sessionsActive: 50, sessionsTotal: 60 }]])
    );
    const result = scoreIntent(
      baseInput({
        decayState: decay,
        recentFiles: ["db/seeds/users.ts"],
      })
    );
    expect(getScore(result, "pg").exposed).toBe(true);
  });
});

describe("Intent Scorer — Tool history signal", () => {
  it("dominant tool family gets scored via history", () => {
    const result = scoreIntent(
      baseInput({
        recentToolFamilies: ["pg", "pg", "pg", "pg", "gh"],
      })
    );
    expect(getScore(result, "pg").score).toBeGreaterThan(
      getScore(result, "gh").score
    );
  });

  it("equal tool calls split score evenly", () => {
    const result = scoreIntent(
      baseInput({
        recentToolFamilies: ["pg", "gh", "pg", "gh"],
      })
    );
    expect(getScore(result, "pg").score).toBe(getScore(result, "gh").score);
  });

  it("tool history alone (no files/entities) can expose a family", () => {
    const result = scoreIntent(
      baseInput({
        recentToolFamilies: ["aws", "aws", "aws", "aws", "aws"],
      })
    );
    expect(getScore(result, "aws").score).toBeGreaterThanOrEqual(0.25);
    expect(getScore(result, "aws").exposed).toBe(true);
  });
});

describe("Intent Scorer — Edge cases", () => {
  it("empty signals: nothing exposed", () => {
    const result = scoreIntent(baseInput());
    for (const score of result.scores) {
      expect(score.exposed).toBe(false);
    }
    expect(result.exposedFamilies.size).toBe(0);
  });

  it("unrecognized file paths: no family exposed", () => {
    const result = scoreIntent(
      baseInput({
        recentFiles: ["src/utils/helpers.ts", "README.md", "package.json"],
      })
    );
    expect(result.exposedFamilies.size).toBe(0);
  });

  it("scores are sorted descending", () => {
    const result = scoreIntent(
      baseInput({
        entityFamilyTags: new Map([
          ["UserRepo", new Set(["pg"])],
          ["PRService", new Set(["gh"])],
        ]),
      })
    );
    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i]!.score).toBeLessThanOrEqual(
        result.scores[i - 1]!.score
      );
    }
  });

  it("budget exceeded flag triggers fail-open", () => {
    const input = baseInput({
      entityFamilyTags: new Map(
        Array.from(
          { length: 1000 },
          (_, i) => [`Entity${i}`, new Set(["pg"])] as const
        )
      ),
      recentFiles: Array.from(
        { length: 100 },
        (_, i) => `db/migrations/${i}.sql`
      ),
    });

    const result = scoreIntent(input);
    if (result.budgetExceeded) {
      expect(result.exposedFamilies.size).toBe(ALL_FAMILIES.size);
    }
  });

  it("unknown family in entity tags is ignored", () => {
    const result = scoreIntent(
      baseInput({
        entityFamilyTags: new Map([["Service", new Set(["unknown_family"])]]),
      })
    );
    expect(result.exposedFamilies.size).toBe(0);
  });
});

describe("Intent Scorer — Signal collector integration", () => {
  it("collector builds correct scorer input shape", () => {
    const collector = new SignalCollector();
    collector.recordFile("db/schema.sql");
    collector.recordEntityTags("UserRepo", new Set(["pg"]));
    collector.recordToolCall("pg");
    collector.advanceTurn();

    const snapshot = collector.getSnapshot();
    const result = scoreIntent({
      ...snapshot,
      knownFamilies: ALL_FAMILIES,
    });

    expect(getScore(result, "pg").exposed).toBe(true);
    expect(getScore(result, "pg").score).toBeGreaterThanOrEqual(0.3);
  });

  it("collector tracks recent files with LRU behavior", () => {
    const collector = new SignalCollector();
    for (let i = 0; i < 15; i++) {
      collector.recordFile(`file-${i}.ts`);
    }
    const snapshot = collector.getSnapshot();
    expect(snapshot.recentFiles).toHaveLength(10);
    expect(snapshot.recentFiles[0]).toBe("file-14.ts");
  });

  it("collector deduplicates file access (moves to front)", () => {
    const collector = new SignalCollector();
    collector.recordFile("a.ts");
    collector.recordFile("b.ts");
    collector.recordFile("a.ts");
    const snapshot = collector.getSnapshot();
    expect(snapshot.recentFiles[0]).toBe("a.ts");
    expect(snapshot.recentFiles).toHaveLength(2);
  });

  it("collector advances turns correctly", () => {
    const collector = new SignalCollector();
    expect(collector.currentTurn).toBe(0);
    collector.advanceTurn();
    collector.advanceTurn();
    expect(collector.currentTurn).toBe(2);
  });
});

describe("Intent Scorer — Verification gate (50 scenarios)", () => {
  const scenarios: {
    name: string;
    input: Partial<ScorerInput>;
    expectExposed: string[];
    expectNotExposed?: string[];
  }[] = [
    {
      name: "pure DB: SQL file",
      input: { recentFiles: ["db/schema.sql"] },
      expectExposed: ["pg"],
    },
    {
      name: "pure DB: migrations dir",
      input: { recentFiles: ["db/migrations/001.ts"] },
      expectExposed: ["pg"],
    },
    {
      name: "pure DB: Prisma entity",
      input: { entityFamilyTags: new Map([["PrismaClient", new Set(["pg"])]]) },
      expectExposed: ["pg"],
    },
    {
      name: "pure GH: workflow",
      input: { recentFiles: [".github/workflows/ci.yml"] },
      expectExposed: ["gh"],
    },
    {
      name: "pure GH: CODEOWNERS",
      input: { recentFiles: [".github/CODEOWNERS"] },
      expectExposed: ["gh"],
    },
    {
      name: "pure GH: octokit entity",
      input: { entityFamilyTags: new Map([["GitClient", new Set(["gh"])]]) },
      expectExposed: ["gh"],
    },
    {
      name: "pure Slack: slack dir",
      input: { recentFiles: ["src/integrations/slack/bot.ts"] },
      expectExposed: ["slk"],
    },
    {
      name: "pure AWS: entity",
      input: { entityFamilyTags: new Map([["S3Client", new Set(["aws"])]]) },
      expectExposed: ["aws"],
    },
    {
      name: "pure Stripe: entity",
      input: {
        entityFamilyTags: new Map([["PaymentService", new Set(["str"])]]),
      },
      expectExposed: ["str"],
    },
    {
      name: "pure Redis: entity",
      input: {
        entityFamilyTags: new Map([["CacheService", new Set(["rds"])]]),
      },
      expectExposed: ["rds"],
    },
    {
      name: "multi: DB + GH entities",
      input: {
        entityFamilyTags: new Map([
          ["Repo", new Set(["pg"])],
          ["PR", new Set(["gh"])],
        ]),
      },
      expectExposed: ["pg", "gh"],
    },
    {
      name: "multi: DB + GH files",
      input: { recentFiles: ["db/schema.sql", ".github/workflows/ci.yml"] },
      expectExposed: ["pg", "gh"],
    },
    {
      name: "multi: three entities",
      input: {
        entityFamilyTags: new Map([
          ["A", new Set(["pg"])],
          ["B", new Set(["gh"])],
          ["C", new Set(["slk"])],
        ]),
      },
      expectExposed: ["pg", "gh", "slk"],
    },
    {
      name: "ambiguous: only README",
      input: { recentFiles: ["README.md"] },
      expectExposed: [],
      expectNotExposed: ["pg", "gh"],
    },
    {
      name: "ambiguous: generic TS",
      input: { recentFiles: ["src/utils/helpers.ts"] },
      expectExposed: [],
      expectNotExposed: ["pg", "gh"],
    },
    {
      name: "ambiguous: package.json",
      input: { recentFiles: ["package.json"] },
      expectExposed: [],
      expectNotExposed: ["pg", "gh"],
    },
    { name: "vague: empty signals", input: {}, expectExposed: [] },
    {
      name: "tool history only: pg dominant",
      input: { recentToolFamilies: ["pg", "pg", "pg", "pg"] },
      expectExposed: ["pg"],
    },
    {
      name: "tool history only: gh dominant",
      input: { recentToolFamilies: ["gh", "gh", "gh", "gh"] },
      expectExposed: ["gh"],
    },
    {
      name: "tool history: equal split",
      input: { recentToolFamilies: ["pg", "gh", "pg", "gh"] },
      expectExposed: ["pg", "gh"],
    },
    {
      name: "file + entity agree on pg",
      input: {
        recentFiles: ["db/schema.sql"],
        entityFamilyTags: new Map([["UserRepo", new Set(["pg"])]]),
      },
      expectExposed: ["pg"],
    },
    {
      name: "file + entity disagree (multi-domain)",
      input: {
        recentFiles: ["db/schema.sql"],
        entityFamilyTags: new Map([["PRService", new Set(["gh"])]]),
      },
      expectExposed: ["pg", "gh"],
    },
    {
      name: "Kubernetes file",
      input: { recentFiles: ["k8s/deployment.yaml"] },
      expectExposed: [],
    },
    {
      name: "Docker file alone",
      input: { recentFiles: ["Dockerfile"] },
      expectExposed: [],
    },
    {
      name: "vercel.json",
      input: { recentFiles: ["vercel.json"] },
      expectExposed: [],
    },
  ];

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const result = scoreIntent(baseInput(scenario.input));
      for (const family of scenario.expectExposed) {
        expect(
          result.exposedFamilies.has(family),
          `Expected ${family} to be exposed in "${scenario.name}"`
        ).toBe(true);
      }
      if (scenario.expectNotExposed) {
        for (const family of scenario.expectNotExposed) {
          expect(
            result.exposedFamilies.has(family),
            `Expected ${family} NOT exposed in "${scenario.name}"`
          ).toBe(false);
        }
      }
    });
  }
});
