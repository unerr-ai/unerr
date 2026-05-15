/**
 * Tests for Git-Native Attribution — Phase 5.5 §1.5
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AttributionContext,
  buildCommitMessageWithTrailers,
  buildGitNotePayload,
  readAttributionFromManifest,
} from "../tracking/git-attribution.js";

function makeAttribution(
  overrides?: Partial<AttributionContext>
): AttributionContext {
  return {
    sessionId: "sess-abc-123",
    ledgerEntryIds: ["entry-1", "entry-2"],
    prompt: "Add user authentication",
    planSummary: "Implement OAuth2 flow with Google provider",
    changeType: "feat",
    featureArea: "auth/oauth",
    agentModel: "claude-sonnet-4",
    agentTool: "cursor",
    filesChanged: ["src/auth/oauth.ts", "src/auth/types.ts"],
    ...overrides,
  };
}

describe("git-attribution", () => {
  // ── buildCommitMessageWithTrailers ──────────────────────────

  describe("buildCommitMessageWithTrailers", () => {
    it("appends session trailer to commit message", () => {
      const result = buildCommitMessageWithTrailers(
        "feat: add login",
        makeAttribution()
      );
      expect(result).toContain("Unerr-Session: sess-abc-123");
    });

    it("includes ledger ID trailer (first entry only)", () => {
      const result = buildCommitMessageWithTrailers(
        "feat: add login",
        makeAttribution()
      );
      expect(result).toContain("Unerr-Ledger-Id: entry-1");
      expect(result).not.toContain("entry-2");
    });

    it("includes change type trailer", () => {
      const result = buildCommitMessageWithTrailers(
        "feat: add login",
        makeAttribution()
      );
      expect(result).toContain("Unerr-Change-Type: feat");
    });

    it("includes feature area trailer", () => {
      const result = buildCommitMessageWithTrailers(
        "feat: add login",
        makeAttribution()
      );
      expect(result).toContain("Unerr-Feature: auth/oauth");
    });

    it("includes plan summary trailer", () => {
      const result = buildCommitMessageWithTrailers(
        "feat: add login",
        makeAttribution()
      );
      expect(result).toContain(
        "Unerr-Plan: Implement OAuth2 flow with Google provider"
      );
    });

    it("truncates plan summary to 72 chars", () => {
      const longPlan = "A".repeat(100);
      const result = buildCommitMessageWithTrailers(
        "feat: add login",
        makeAttribution({ planSummary: longPlan })
      );
      expect(result).toContain(`Unerr-Plan: ${"A".repeat(69)}...`);
    });

    it("does not truncate plan exactly 72 chars", () => {
      const exactPlan = "B".repeat(72);
      const result = buildCommitMessageWithTrailers(
        "feat: add login",
        makeAttribution({ planSummary: exactPlan })
      );
      expect(result).toContain(`Unerr-Plan: ${"B".repeat(72)}`);
      expect(result).not.toContain("...");
    });

    it("includes agent model and tool trailers", () => {
      const result = buildCommitMessageWithTrailers(
        "feat: add login",
        makeAttribution()
      );
      expect(result).toContain("Unerr-Agent-Model: claude-sonnet-4");
      expect(result).toContain("Unerr-Agent-Tool: cursor");
    });

    it("separates trailers from message body with blank line", () => {
      const result = buildCommitMessageWithTrailers(
        "feat: add login",
        makeAttribution()
      );
      expect(result).toMatch(/feat: add login\n\nUnerr-Session:/);
    });

    it("omits optional trailers when values are undefined", () => {
      const result = buildCommitMessageWithTrailers(
        "chore: cleanup",
        makeAttribution({
          changeType: undefined,
          featureArea: undefined,
          planSummary: undefined,
          agentModel: undefined,
          agentTool: undefined,
        })
      );
      expect(result).toContain("Unerr-Session:");
      expect(result).toContain("Unerr-Ledger-Id:");
      expect(result).not.toContain("Unerr-Change-Type:");
      expect(result).not.toContain("Unerr-Feature:");
      expect(result).not.toContain("Unerr-Plan:");
      expect(result).not.toContain("Unerr-Agent-Model:");
      expect(result).not.toContain("Unerr-Agent-Tool:");
    });

    it("omits ledger ID trailer when no entry IDs", () => {
      const result = buildCommitMessageWithTrailers(
        "chore: cleanup",
        makeAttribution({ ledgerEntryIds: [] })
      );
      expect(result).not.toContain("Unerr-Ledger-Id:");
    });
  });

  // ── buildGitNotePayload ────────────────────────────────────

  describe("buildGitNotePayload", () => {
    it("returns version 1.0", () => {
      const payload = buildGitNotePayload(makeAttribution());
      expect(payload.version).toBe("1.0");
    });

    it("maps attribution fields to snake_case payload", () => {
      const payload = buildGitNotePayload(makeAttribution());
      expect(payload.session_id).toBe("sess-abc-123");
      expect(payload.ledger_entry_ids).toEqual(["entry-1", "entry-2"]);
      expect(payload.prompt).toBe("Add user authentication");
      expect(payload.plan_summary).toBe(
        "Implement OAuth2 flow with Google provider"
      );
      expect(payload.change_type).toBe("feat");
      expect(payload.feature_area).toBe("auth/oauth");
      expect(payload.agent_model).toBe("claude-sonnet-4");
      expect(payload.agent_tool).toBe("cursor");
      expect(payload.files_changed).toEqual([
        "src/auth/oauth.ts",
        "src/auth/types.ts",
      ]);
    });

    it("sets entities_affected to empty array (resolved server-side)", () => {
      const payload = buildGitNotePayload(makeAttribution());
      expect(payload.entities_affected).toEqual([]);
    });

    it("includes ISO 8601 created_at timestamp", () => {
      const before = new Date().toISOString();
      const payload = buildGitNotePayload(makeAttribution());
      const after = new Date().toISOString();
      expect(payload.created_at >= before).toBe(true);
      expect(payload.created_at <= after).toBe(true);
    });

    it("handles missing optional fields", () => {
      const payload = buildGitNotePayload(
        makeAttribution({
          planSummary: undefined,
          changeType: undefined,
          featureArea: undefined,
          agentModel: undefined,
          agentTool: undefined,
        })
      );
      expect(payload.plan_summary).toBeUndefined();
      expect(payload.change_type).toBeUndefined();
      expect(payload.feature_area).toBeUndefined();
      expect(payload.agent_model).toBeUndefined();
      expect(payload.agent_tool).toBeUndefined();
    });

    it("produces valid JSON when serialized", () => {
      const payload = buildGitNotePayload(makeAttribution());
      const json = JSON.stringify(payload, null, 2);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(parsed).toHaveProperty("version", "1.0");
      expect(parsed).toHaveProperty("session_id", "sess-abc-123");
    });
  });

  // ── readAttributionFromManifest ────────────────────────────

  describe("readAttributionFromManifest", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(
        tmpdir(),
        `unerr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(join(tempDir, ".unerr"), { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    });

    it("returns null when manifest does not exist", () => {
      const result = readAttributionFromManifest(join(tmpdir(), "nonexistent"));
      expect(result).toBeNull();
    });

    it("returns null when manifest has no sessionId", () => {
      writeFileSync(
        join(tempDir, ".unerr", "manifest.json"),
        JSON.stringify({ attributions: [{ prompt: "test" }] })
      );
      expect(readAttributionFromManifest(tempDir)).toBeNull();
    });

    it("returns null when manifest has no attributions", () => {
      writeFileSync(
        join(tempDir, ".unerr", "manifest.json"),
        JSON.stringify({ sessionId: "sess-1", attributions: [] })
      );
      expect(readAttributionFromManifest(tempDir)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      writeFileSync(join(tempDir, ".unerr", "manifest.json"), "not json {{{");
      expect(readAttributionFromManifest(tempDir)).toBeNull();
    });

    it("reads a single attribution", () => {
      writeFileSync(
        join(tempDir, ".unerr", "manifest.json"),
        JSON.stringify({
          sessionId: "sess-xyz",
          attributions: [
            {
              prompt: "Add login",
              planSummary: "OAuth flow",
              changeType: "feat",
              featureArea: "auth",
              agentModel: "claude-sonnet-4",
              agentTool: "cursor",
              filesChanged: ["src/auth.ts"],
              ledgerEntryIds: ["le-1"],
            },
          ],
        })
      );

      const result = readAttributionFromManifest(tempDir);
      expect(result).not.toBeNull();
      expect(result?.sessionId).toBe("sess-xyz");
      expect(result?.prompt).toBe("Add login");
      expect(result?.planSummary).toBe("OAuth flow");
      expect(result?.changeType).toBe("feat");
      expect(result?.featureArea).toBe("auth");
      expect(result?.agentModel).toBe("claude-sonnet-4");
      expect(result?.agentTool).toBe("cursor");
      expect(result?.filesChanged).toEqual(["src/auth.ts"]);
      expect(result?.ledgerEntryIds).toEqual(["le-1"]);
    });

    it("merges multiple attributions into a single context", () => {
      writeFileSync(
        join(tempDir, ".unerr", "manifest.json"),
        JSON.stringify({
          sessionId: "sess-multi",
          attributions: [
            {
              prompt: "Add login",
              filesChanged: ["src/auth/login.ts"],
              ledgerEntryIds: ["le-1"],
              changeType: "feat",
            },
            {
              prompt: "Add signup",
              filesChanged: ["src/auth/signup.ts", "src/auth/login.ts"],
              ledgerEntryIds: ["le-2"],
              changeType: "fix",
              planSummary: "Fix the signup flow",
            },
          ],
        })
      );

      const result = readAttributionFromManifest(tempDir);
      expect(result).not.toBeNull();
      expect(result?.sessionId).toBe("sess-multi");
      // Prompts joined with arrow
      expect(result?.prompt).toBe("Add login → Add signup");
      // Files are deduped
      expect(result?.filesChanged).toHaveLength(2);
      expect(result?.filesChanged).toContain("src/auth/login.ts");
      expect(result?.filesChanged).toContain("src/auth/signup.ts");
      // Entry IDs are deduped
      expect(result?.ledgerEntryIds).toEqual(["le-1", "le-2"]);
      // Uses latest attribution's metadata
      expect(result?.changeType).toBe("fix");
      expect(result?.planSummary).toBe("Fix the signup flow");
    });

    it("deduplicates ledger entry IDs", () => {
      writeFileSync(
        join(tempDir, ".unerr", "manifest.json"),
        JSON.stringify({
          sessionId: "sess-dedup",
          attributions: [
            { prompt: "First", ledgerEntryIds: ["le-1", "le-2"] },
            { prompt: "Second", ledgerEntryIds: ["le-2", "le-3"] },
          ],
        })
      );

      const result = readAttributionFromManifest(tempDir);
      expect(result?.ledgerEntryIds).toEqual(["le-1", "le-2", "le-3"]);
    });

    it("handles attributions with missing optional fields", () => {
      writeFileSync(
        join(tempDir, ".unerr", "manifest.json"),
        JSON.stringify({
          sessionId: "sess-minimal",
          attributions: [{ prompt: "Just a prompt" }],
        })
      );

      const result = readAttributionFromManifest(tempDir);
      expect(result).not.toBeNull();
      expect(result?.sessionId).toBe("sess-minimal");
      expect(result?.prompt).toBe("Just a prompt");
      expect(result?.ledgerEntryIds).toEqual([]);
      expect(result?.filesChanged).toEqual([]);
    });
  });
});
