/**
 * Tests for deep-link.ts (Task 1.6) — URL generation for CLI → web dashboard bridge.
 *
 * Tests validate:
 *   - buildDeepLink(): correct URL structure with repo path and query params
 *   - utm_source: always present (default "cli", overridable)
 *   - View targeting: health, drift, timeline, graph views
 *   - Entity/intent list serialization (comma-joined)
 *   - Fallback: returns generic landing when repoId is missing
 */

import { describe, expect, it } from "vitest";
import { buildDeepLink } from "../utils/deep-link.js";

describe("Deep-Link URL Generation (1.6)", () => {
  // ── Basic URL structure ────────────────────────────────────────

  describe("basic URL structure", () => {
    it("generates URL with repo path and default utm_source", () => {
      const url = buildDeepLink("repo_abc123");
      expect(url).toBe("https://app.unerr.dev/r/repo_abc123?utm_source=cli");
    });

    it("includes view parameter when specified", () => {
      const url = buildDeepLink("repo_abc123", { view: "health" });
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/r/repo_abc123");
      expect(parsed.searchParams.get("view")).toBe("health");
      expect(parsed.searchParams.get("utm_source")).toBe("cli");
    });

    it("includes branch parameter", () => {
      const url = buildDeepLink("repo_abc123", { branch: "feature/auth" });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("branch")).toBe("feature/auth");
    });

    it("serializes entities as comma-joined list", () => {
      const url = buildDeepLink("repo_abc123", {
        entities: ["fn_pay", "cls_user", "fn_validate"],
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("entities")).toBe(
        "fn_pay,cls_user,fn_validate"
      );
    });

    it("serializes intents as comma-joined list", () => {
      const url = buildDeepLink("repo_abc123", {
        intents: ["intent_001", "intent_002"],
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("intents")).toBe("intent_001,intent_002");
    });
  });

  // ── utm_source tracking ────────────────────────────────────────

  describe("utm_source tracking", () => {
    it("defaults to 'cli' when no utm_source provided", () => {
      const url = buildDeepLink("repo_abc123");
      const parsed = new URL(url);
      expect(parsed.searchParams.get("utm_source")).toBe("cli");
    });

    it("uses custom utm_source for startup context", () => {
      const url = buildDeepLink("repo_abc123", {
        utm_source: "cli_startup",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("utm_source")).toBe("cli_startup");
    });

    it("uses custom utm_source for first boot health shock", () => {
      const url = buildDeepLink("repo_abc123", {
        view: "health",
        utm_source: "cli_first_boot",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("utm_source")).toBe("cli_first_boot");
    });

    it("uses custom utm_source for session summary", () => {
      const url = buildDeepLink("repo_abc123", {
        view: "timeline",
        intents: ["i1"],
        utm_source: "cli_session",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("utm_source")).toBe("cli_session");
    });
  });

  // ── View types ─────────────────────────────────────────────────

  describe("view types", () => {
    for (const view of ["health", "drift", "timeline", "graph"] as const) {
      it(`generates correct URL for '${view}' view`, () => {
        const url = buildDeepLink("repo_123", { view });
        const parsed = new URL(url);
        expect(parsed.searchParams.get("view")).toBe(view);
      });
    }
  });

  // ── Combined parameters ────────────────────────────────────────

  describe("combined parameters", () => {
    it("generates URL with all parameters", () => {
      const url = buildDeepLink("repo_abc123", {
        view: "drift",
        branch: "main",
        entities: ["fn_a", "fn_b"],
        intents: ["intent_1"],
        utm_source: "cli_status",
      });
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/r/repo_abc123");
      expect(parsed.searchParams.get("view")).toBe("drift");
      expect(parsed.searchParams.get("branch")).toBe("main");
      expect(parsed.searchParams.get("entities")).toBe("fn_a,fn_b");
      expect(parsed.searchParams.get("intents")).toBe("intent_1");
      expect(parsed.searchParams.get("utm_source")).toBe("cli_status");
    });

    it("omits empty optional parameters", () => {
      const url = buildDeepLink("repo_abc123", { utm_source: "cli" });
      const parsed = new URL(url);
      expect(parsed.searchParams.has("view")).toBe(false);
      expect(parsed.searchParams.has("branch")).toBe(false);
      expect(parsed.searchParams.has("entities")).toBe(false);
      expect(parsed.searchParams.has("intents")).toBe(false);
    });

    it("omits entities when array is empty", () => {
      const url = buildDeepLink("repo_abc123", { entities: [] });
      const parsed = new URL(url);
      expect(parsed.searchParams.has("entities")).toBe(false);
    });

    it("omits intents when array is empty", () => {
      const url = buildDeepLink("repo_abc123", { intents: [] });
      const parsed = new URL(url);
      expect(parsed.searchParams.has("intents")).toBe(false);
    });
  });

  // ── Fallback behavior ──────────────────────────────────────────

  describe("fallback when repoId unavailable", () => {
    it("returns generic landing URL when repoId is undefined", () => {
      const url = buildDeepLink(undefined);
      expect(url).toBe("https://app.unerr.dev?utm_source=cli");
    });

    it("returns generic landing URL when repoId is empty string", () => {
      const url = buildDeepLink("");
      expect(url).toBe("https://app.unerr.dev?utm_source=cli");
    });

    it("preserves utm_source on fallback URL", () => {
      const url = buildDeepLink(undefined, {
        utm_source: "cli_startup",
      });
      expect(url).toBe("https://app.unerr.dev?utm_source=cli_startup");
    });
  });
});
