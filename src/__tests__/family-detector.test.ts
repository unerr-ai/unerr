import { describe, expect, it } from "vitest";

import {
  type DetectionResult,
  detectFamilies,
  detectFamilyForFile,
} from "../router/family-detector.js";

describe("Family Detector", () => {
  // ── SQL / Database family ──────────────────────────────────────

  it("detects pg family from .sql file", () => {
    const result = detectFamilies(["db/schema.sql"]);
    expect(result.primary).toBe("pg");
    expect(result.signals[0]!.score).toBeGreaterThanOrEqual(0.7);
  });

  it("detects pg family from migrations directory", () => {
    const result = detectFamilies(["db/migrations/001_create_users.ts"]);
    expect(result.primary).toBe("pg");
  });

  it("detects pg family from Prisma schema", () => {
    const result = detectFamilies(["prisma/schema.prisma"]);
    expect(result.primary).toBe("pg");
  });

  it("detects pg family from Drizzle config", () => {
    const result = detectFamilies(["drizzle/schema.ts"]);
    expect(result.primary).toBe("pg");
  });

  it("detects pg family from seed files", () => {
    const result = detectFamilies(["db/seeds/users.ts"]);
    expect(result.primary).toBe("pg");
  });

  // ── GitHub / CI family ─────────────────────────────────────────

  it("detects gh family from .github directory", () => {
    const result = detectFamilies([".github/workflows/ci.yml"]);
    expect(result.primary).toBe("gh");
  });

  it("detects gh family from CI config", () => {
    const result = detectFamilies([".github/workflows/deploy.yml"]);
    expect(result.primary).toBe("gh");
  });

  it("detects gh family from CODEOWNERS", () => {
    const result = detectFamilies([".github/CODEOWNERS"]);
    expect(result.primary).toBe("gh");
  });

  it("detects gh family from PR template", () => {
    const result = detectFamilies([".github/PULL_REQUEST_TEMPLATE.md"]);
    expect(result.primary).toBe("gh");
  });

  // ── Slack family ───────────────────────────────────────────────

  it("detects slk family from slack-related file", () => {
    const result = detectFamilies(["src/integrations/slack/webhook.ts"]);
    expect(result.primary).toBe("slk");
  });

  // ── Kubernetes family ──────────────────────────────────────────

  it("detects k8s family from k8s directory", () => {
    const result = detectFamilies(["k8s/deployment.yaml"]);
    expect(result.primary).toBe("k8s");
  });

  it("detects k8s family from Helm chart", () => {
    const result = detectFamilies(["helm/values.yaml"]);
    expect(result.primary).toBe("k8s");
  });

  // ── Docker family ──────────────────────────────────────────────

  it("detects dkr family from Dockerfile", () => {
    const result = detectFamilies(["Dockerfile"]);
    expect(result.primary).toBe("dkr");
  });

  it("detects dkr family from docker-compose", () => {
    const result = detectFamilies(["docker-compose.yml"]);
    expect(result.primary).toBe("dkr");
  });

  // ── Multi-domain detection ─────────────────────────────────────

  it("detects multiple families from mixed files", () => {
    const result = detectFamilies([
      "db/schema.sql",
      ".github/workflows/ci.yml",
    ]);
    expect(result.primary).toBeDefined();
    expect(result.signals.length).toBeGreaterThanOrEqual(2);

    const families = result.signals.map((s) => s.family);
    expect(families).toContain("pg");
    expect(families).toContain("gh");
  });

  it("secondary families have score >= 0.3", () => {
    const result = detectFamilies([
      "db/schema.sql",
      ".github/workflows/ci.yml",
      "src/integrations/slack/bot.ts",
    ]);
    for (const family of result.secondary) {
      const signal = result.signals.find((s) => s.family === family);
      expect(signal!.score).toBeGreaterThanOrEqual(0.3);
    }
  });

  // ── Filtering by known aliases ─────────────────────────────────

  it("only returns families matching known aliases when provided", () => {
    const known = new Set(["gh", "pg"]);
    const result = detectFamilies(
      ["db/schema.sql", "src/integrations/slack/bot.ts"],
      known
    );
    const families = result.signals.map((s) => s.family);
    expect(families).toContain("pg");
    expect(families).not.toContain("slk");
  });

  // ── Empty / no match ───────────────────────────────────────────

  it("returns null primary for unrecognized files", () => {
    const result = detectFamilies(["src/utils/helpers.ts", "README.md"]);
    expect(result.primary).toBeNull();
    expect(result.signals).toHaveLength(0);
  });

  it("handles empty file list", () => {
    const result = detectFamilies([]);
    expect(result.primary).toBeNull();
  });

  // ── Single-file convenience ────────────────────────────────────

  it("detectFamilyForFile works for single file", () => {
    const result = detectFamilyForFile("db/migrations/002_add_orders.sql");
    expect(result.primary).toBe("pg");
  });

  // ── Cloud / specialty families ─────────────────────────────────

  it("detects aws family from CloudFormation template", () => {
    const result = detectFamilies(["cloudformation/stack.yaml"]);
    expect(result.primary).toBe("aws");
  });

  it("detects vrc family from vercel.json", () => {
    const result = detectFamilies(["vercel.json"]);
    expect(result.primary).toBe("vrc");
  });

  it("detects str family from stripe integration", () => {
    const result = detectFamilies(["src/payments/stripe/webhook.ts"]);
    expect(result.primary).toBe("str");
  });

  it("detects sup family from supabase config", () => {
    const result = detectFamilies(["supabase/config.toml"]);
    expect(result.primary).toBe("sup");
  });

  it("detects fb family from firebase config", () => {
    const result = detectFamilies(["firebase.json"]);
    expect(result.primary).toBe("fb");
  });

  it("detects mdb family from mongodb config", () => {
    const result = detectFamilies(["src/db/mongodb/client.ts"]);
    expect(result.primary).toBe("mdb");
  });

  it("detects rds family from redis config", () => {
    const result = detectFamilies(["src/cache/redis/client.ts"]);
    expect(result.primary).toBe("rds");
  });

  // ── Score aggregation ──────────────────────────────────────────

  it("uses max score (not sum) for multiple matching rules", () => {
    const result = detectFamilies([
      "db/schema.sql",
      "db/migrations/001.sql",
      "db/seeds/users.ts",
    ]);
    expect(result.primary).toBe("pg");
    const pgSignal = result.signals.find((s) => s.family === "pg")!;
    expect(pgSignal.score).toBeLessThanOrEqual(1.0);
    expect(pgSignal.reason).toContain("SQL file");
  });

  it("includes multiple reasons in signal", () => {
    const result = detectFamilies(["db/migrations/001.sql"]);
    const pgSignal = result.signals.find((s) => s.family === "pg")!;
    expect(pgSignal.reason.split(", ").length).toBeGreaterThanOrEqual(2);
  });
});
