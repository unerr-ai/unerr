import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_WORKER_MODEL,
  CODEX_WORKER_MODEL,
  FABLE_AGENT_MD,
  FABLE_MODEL,
  JUNIOR_AGENT_MD,
  JUNIOR_AGENT_RELPATH,
  JUNIOR_MODEL,
  OPUS_AGENT_MD,
  OPUS_MODEL,
  REVIEWER_AGENT_MD,
  REVIEWER_AGENT_RELPATH,
  WORKER_AGENT_MD,
  fableAgentPath,
  juniorAgentPath,
  juniorHandoff,
  opusAgentPath,
  removeJuniorSubagent,
  reviewerAgentPath,
  selectTier,
  tierModel,
  workerAgentPath,
  writeJuniorSubagent,
} from "../skills/junior-agent.js";

describe("unerr-junior sub-agent (Lever C)", () => {
  const fresh = () => mkdtempSync(join(tmpdir(), "unerr-junior-"));

  /**
   * Reconstruct the description a YAML folded scalar (`description: >-`) parses
   * to: strip the block's 2-space indent and join with a single space — that
   * mirrors YAML fold semantics (what Claude Code actually reads), not the
   * wrapped raw source where a phrase can straddle a line break.
   */
  const foldedDescription = (md: string): string => {
    const lines = md.split("\n");
    const start = lines.indexOf("description: >-") + 1;
    const body: string[] = [];
    for (
      let i = start;
      i < lines.length && !lines[i]!.startsWith("model:");
      i++
    ) {
      body.push(lines[i]!.replace(/^ {2}/, ""));
    }
    return body.join(" ");
  };

  /** The `tools:` frontmatter line, parsed into its comma-separated entries. */
  const toolsOf = (md: string): string[] => {
    const m = md.match(/^tools: (.+)$/m);
    return m ? m[1]!.split(", ") : [];
  };

  it("definition pins the cheaper model and a bounded tool set", () => {
    expect(JUNIOR_AGENT_MD).toContain(`model: ${JUNIOR_MODEL}`);
    expect(JUNIOR_AGENT_MD).toContain("name: unerr-junior");
    // Self-verify + bounded retry are part of the contract.
    expect(JUNIOR_AGENT_MD).toContain("pnpm run typecheck");
    expect(JUNIOR_AGENT_MD).toMatch(/at most\s+\*\*2\*\*\s+retries/);
  });

  it("writes the file for claude-code and is idempotent", () => {
    const cwd = fresh();
    expect(writeJuniorSubagent("claude-code", cwd)).toBe(true);
    const p = juniorAgentPath(cwd);
    expect(p.endsWith(JUNIOR_AGENT_RELPATH)).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe(JUNIOR_AGENT_MD);
    // Second write is a no-op (content already matches).
    expect(writeJuniorSubagent("claude-code", cwd)).toBe(false);
  });

  it("does not write for non-delegating or file-less hosts", () => {
    const cwd = fresh();
    // Codex delegates via `codex exec -m` — no on-disk file.
    expect(writeJuniorSubagent("codex", cwd)).toBe(false);
    expect(writeJuniorSubagent("cursor", cwd)).toBe(false);
    expect(existsSync(juniorAgentPath(cwd))).toBe(false);
  });

  it("removes the file", () => {
    const cwd = fresh();
    writeJuniorSubagent("claude-code", cwd);
    expect(removeJuniorSubagent(cwd)).toBe(true);
    expect(existsSync(juniorAgentPath(cwd))).toBe(false);
    // Removing again is a no-op.
    expect(removeJuniorSubagent(cwd)).toBe(false);
  });

  it("writes BOTH tiers — junior and worker — and removes both", () => {
    const cwd = fresh();
    expect(writeJuniorSubagent("claude-code", cwd)).toBe(true);
    expect(existsSync(juniorAgentPath(cwd))).toBe(true);
    expect(existsSync(workerAgentPath(cwd))).toBe(true);
    expect(readFileSync(workerAgentPath(cwd), "utf-8")).toBe(WORKER_AGENT_MD);
    expect(WORKER_AGENT_MD).toContain(`model: ${CLAUDE_WORKER_MODEL}`);
    expect(WORKER_AGENT_MD).toContain("name: unerr-worker");
    // Both sub-agents get the unerr graph tools (no more grep-only worker).
    for (const md of [JUNIOR_AGENT_MD, WORKER_AGENT_MD]) {
      expect(md).toContain("mcp__unerr__search_code");
      expect(md).toContain("mcp__unerr__get_references");
      expect(md).not.toContain("Grep, Glob");
    }
    // Junior owns the read-only research class, so it gets web tools; the worker
    // (edit-heavy, rarely researches) keeps the no-web set.
    expect(JUNIOR_AGENT_MD).toContain("WebSearch");
    expect(JUNIOR_AGENT_MD).toContain("WebFetch");
    expect(JUNIOR_AGENT_MD).toContain("mcp__unerr__fetch_url");
    expect(WORKER_AGENT_MD).not.toContain("WebSearch");
    expect(WORKER_AGENT_MD).not.toContain("mcp__unerr__fetch_url");
    expect(removeJuniorSubagent(cwd)).toBe(true);
    expect(existsSync(workerAgentPath(cwd))).toBe(false);
  });

  it("also writes the user-invoked opus + fable sub-agents (claude-code, removed together)", () => {
    const cwd = fresh();
    expect(writeJuniorSubagent("claude-code", cwd)).toBe(true);
    // Opus + Fable land on disk so the user can spawn them explicitly.
    expect(existsSync(opusAgentPath(cwd))).toBe(true);
    expect(existsSync(fableAgentPath(cwd))).toBe(true);
    expect(readFileSync(opusAgentPath(cwd), "utf-8")).toBe(OPUS_AGENT_MD);
    expect(readFileSync(fableAgentPath(cwd), "utf-8")).toBe(FABLE_AGENT_MD);
    // Each pins its model + name and carries the shared operating contract.
    expect(OPUS_AGENT_MD).toContain(`model: ${OPUS_MODEL}`);
    expect(OPUS_AGENT_MD).toContain("name: unerr-opus");
    expect(FABLE_AGENT_MD).toContain(`model: ${FABLE_MODEL}`);
    expect(FABLE_AGENT_MD).toContain("name: unerr-fable");
    for (const md of [OPUS_AGENT_MD, FABLE_AGENT_MD]) {
      expect(md).toContain("pnpm run typecheck");
      expect(md).toMatch(/at most\s+\*\*2\*\*\s+retries/);
      expect(md).toContain("mcp__unerr__search_code");
      // Not a cheaper tier — the out-of-scope clause uses the neutral phrasing.
      expect(md).not.toContain("on the cheaper tier");
    }
    // uninstall removes the installed set (junior/worker/opus/fable; the
    // reviewer is off by default so it is not installed to begin with).
    expect(removeJuniorSubagent(cwd)).toBe(true);
    expect(existsSync(opusAgentPath(cwd))).toBe(false);
    expect(existsSync(fableAgentPath(cwd))).toBe(false);
  });

  it("does NOT install the reviewer by default and sweeps a stale copy (claude-code)", () => {
    const cwd = fresh();
    // Reviewer is OFF by default (REVIEWER_AGENT_ENABLED=false) — never written.
    expect(writeJuniorSubagent("claude-code", cwd)).toBe(true);
    expect(existsSync(reviewerAgentPath(cwd))).toBe(false);

    // A copy left by a prior install is swept on the next install. The first
    // call created .claude/agents/, so the path's parent already exists.
    writeFileSync(reviewerAgentPath(cwd), REVIEWER_AGENT_MD);
    expect(existsSync(reviewerAgentPath(cwd))).toBe(true);
    expect(writeJuniorSubagent("claude-code", cwd)).toBe(true);
    expect(existsSync(reviewerAgentPath(cwd))).toBe(false);
  });

  it("keeps the reviewer template well-formed and read-only for re-enable", () => {
    // The constant + path helper survive so flipping REVIEWER_AGENT_ENABLED back
    // on needs no other change to the definition.
    expect(reviewerAgentPath("/x").endsWith(REVIEWER_AGENT_RELPATH)).toBe(true);
    expect(REVIEWER_AGENT_MD).toContain("name: unerr-reviewer");
    expect(REVIEWER_AGENT_MD).toContain(`model: ${CLAUDE_WORKER_MODEL}`);
    expect(foldedDescription(REVIEWER_AGENT_MD)).toContain("Use PROACTIVELY");
    // Read-only tool set — no edit tools at all.
    const reviewerTools = toolsOf(REVIEWER_AGENT_MD);
    expect(reviewerTools).toContain("mcp__unerr__search_code");
    expect(reviewerTools).toContain("mcp__unerr__get_references");
    expect(reviewerTools).not.toContain("mcp__unerr__file_edit");
    expect(reviewerTools).not.toContain("Edit");
    expect(reviewerTools).not.toContain("Write");
  });

  it("junior/worker/reviewer descriptions signal auto-delegation; opus/fable are manual-only", () => {
    for (const md of [JUNIOR_AGENT_MD, WORKER_AGENT_MD, REVIEWER_AGENT_MD]) {
      const desc = foldedDescription(md);
      expect(desc).toContain("Use PROACTIVELY");
      expect(desc).toContain("MUST BE USED");
    }
    // Claude Code has no `disable-model-invocation` field — opus/fable must
    // stay out of automatic routing via description wording alone.
    for (const md of [OPUS_AGENT_MD, FABLE_AGENT_MD]) {
      const desc = foldedDescription(md);
      expect(desc).toContain("Manual-only");
      expect(desc).toContain("NEVER select this agent automatically");
      expect(desc).not.toContain("Use PROACTIVELY");
    }
  });

  it("every generated frontmatter uses a parseable folded description scalar", () => {
    for (const md of [
      JUNIOR_AGENT_MD,
      WORKER_AGENT_MD,
      OPUS_AGENT_MD,
      FABLE_AGENT_MD,
      REVIEWER_AGENT_MD,
    ]) {
      expect(md).toContain("description: >-\n");
      const lines = md.split("\n");
      const descIdx = lines.indexOf("description: >-");
      expect(descIdx).toBeGreaterThanOrEqual(0);
      // Every line between `description: >-` and `model:` must be indented —
      // an unindented line there would end the block scalar and start a new
      // (accidental) top-level YAML key, breaking the frontmatter.
      let i = descIdx + 1;
      let sawIndentedLine = false;
      while (i < lines.length && !lines[i]!.startsWith("model:")) {
        expect(lines[i]!.startsWith(" ")).toBe(true);
        expect(lines[i]!.trim().length).toBeGreaterThan(0);
        sawIndentedLine = true;
        i += 1;
      }
      expect(sawIndentedLine).toBe(true);
      expect(lines[i]).toMatch(/^model: /);
    }
  });
});

describe("three-tier model map (Issue 5 / D2)", () => {
  it("maps each delegable class to the right tier", () => {
    expect(selectTier("lint_format")).toBe("junior");
    expect(selectTier("docs")).toBe("junior");
    expect(selectTier("recon")).toBe("junior");
    expect(selectTier("verify")).toBe("junior");
    expect(selectTier("command_run")).toBe("junior");
    // New read-only junior classes (coverage expansion).
    expect(selectTier("research")).toBe("junior");
    expect(selectTier("qa_lookup")).toBe("junior");
    expect(selectTier("inventory_audit")).toBe("junior");
    expect(selectTier("log_triage")).toBe("junior");
    expect(selectTier("repro")).toBe("junior");
    expect(selectTier("tests")).toBe("worker");
    expect(selectTier("mechanical_refactor")).toBe("worker");
    expect(selectTier("caller_propagation")).toBe("worker");
    expect(selectTier("typecheck_fix")).toBe("worker");
    expect(selectTier("scaffold")).toBe("worker");
    expect(selectTier("codemod")).toBe("worker");
    // Scoped feature implementation is the default worker class (Lever A).
    expect(selectTier("feature_impl")).toBe("worker");
    expect(selectTier("none")).toBe("senior");
  });

  it("difficulty gate: aggressive per-class escalation to senior", () => {
    // No size hint → base tier (unchanged behaviour).
    expect(selectTier("codemod")).toBe("worker");
    expect(selectTier("mechanical_refactor", { files: 2, loc: 10 })).toBe(
      "worker"
    );
    // Mechanical breadth stays on the worker far longer — escalates only past
    // files>12 / loc>300 (deterministic edits, low Opus→Sonnet gap).
    expect(selectTier("codemod", { files: 8 })).toBe("worker");
    expect(selectTier("codemod", { files: 13 })).toBe("senior");
    expect(selectTier("mechanical_refactor", { loc: 60 })).toBe("worker");
    expect(selectTier("mechanical_refactor", { loc: 301 })).toBe("senior");
    // feature_impl escalates sooner — files>8 / loc>200 (novel breadth = more risk).
    expect(selectTier("feature_impl", { files: 5, loc: 120 })).toBe("worker");
    expect(selectTier("feature_impl", { files: 9 })).toBe("senior");
    expect(selectTier("feature_impl", { loc: 201 })).toBe("senior");
    // Other worker classes (tests/typecheck_fix/scaffold) escalate at files>8 / loc>150.
    expect(selectTier("tests", { loc: 150 })).toBe("worker");
    expect(selectTier("tests", { loc: 151 })).toBe("senior");
    // A junior class never escalates, however big.
    expect(selectTier("recon", { files: 20, loc: 500 })).toBe("junior");
  });

  it("senior tier resolves to null (session model, no flag); worker/junior pin a model", () => {
    expect(tierModel("claude-code", "senior")).toBeNull();
    expect(tierModel("claude-code", "worker")).toBe(CLAUDE_WORKER_MODEL);
    expect(tierModel("claude-code", "junior")).toBe(JUNIOR_MODEL);
    // A non-delegation host has no tiers.
    expect(tierModel("windsurf", "junior")).toBeNull();
  });

  it("juniorHandoff picks the model by class — worker for tests, junior for lint", () => {
    expect(juniorHandoff("codex", "tests")).toContain(CODEX_WORKER_MODEL);
    expect(juniorHandoff("codex", "lint_format")).toContain("gpt-5.4-mini");
    // Claude Code routes to the right on-disk sub-agent by tier.
    expect(juniorHandoff("claude-code", "tests")).toContain("unerr-worker");
    expect(juniorHandoff("claude-code", "lint_format")).toContain(
      "unerr-junior"
    );
    // Legacy no-class call floors to the junior tier (back-compat).
    expect(juniorHandoff("codex")).toContain("gpt-5.4-mini");
  });
});
