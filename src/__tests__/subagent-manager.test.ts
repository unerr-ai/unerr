import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEnv } from "../skills/subagent-manager.js";
import {
  ARCHITECT_AGENT_MD,
  ARCHITECT_MODEL,
  CLAUDE_WORKER_MODEL,
  CODEX_WORKER_MODEL,
  EXPERT_AGENT_MD,
  EXPERT_MODEL,
  JUNIOR_AGENT_MD,
  JUNIOR_AGENT_RELPATH,
  JUNIOR_MODEL,
  WORKER_AGENT_MD,
  architectAgentPath,
  buildArchitectAgentMd,
  buildExpertAgentMd,
  buildJuniorAgentMd,
  buildWorkerAgentMd,
  expertAgentPath,
  juniorAgentPath,
  removeSubagents,
  selectTier,
  subagentHandoff,
  tierModel,
  workerAgentPath,
  writeSubagents,
} from "../skills/subagent-manager.js";

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

  it("definition pins the cheaper model and a bounded tool set", () => {
    expect(JUNIOR_AGENT_MD).toContain(`model: ${JUNIOR_MODEL}`);
    expect(JUNIOR_AGENT_MD).toContain("name: unerr-junior");
    // Bounded retry is part of the contract regardless of env.
    expect(JUNIOR_AGENT_MD).toMatch(/at most\s+\*\*2\*\*\s+retries/);
    // DEFAULT_AGENT_ENV has no detected check commands, so the verify step
    // falls back to language-agnostic phrasing — never a hardcoded pnpm/TS
    // command for a repo the generator doesn't know is TypeScript.
    expect(JUNIOR_AGENT_MD).toContain(
      "Verify with the repo's own check tooling"
    );
    expect(JUNIOR_AGENT_MD).not.toContain("pnpm");
  });

  it("writes the file for claude-code and is idempotent", () => {
    const cwd = fresh();
    expect(writeSubagents("claude-code", cwd)).toBe(true);
    const p = juniorAgentPath(cwd);
    expect(p.endsWith(JUNIOR_AGENT_RELPATH)).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe(JUNIOR_AGENT_MD);
    // Second write is a no-op (content already matches).
    expect(writeSubagents("claude-code", cwd)).toBe(false);
  });

  it("does not write for non-delegating or file-less hosts", () => {
    const cwd = fresh();
    // Codex delegates via `codex exec -m` — no on-disk file.
    expect(writeSubagents("codex", cwd)).toBe(false);
    expect(writeSubagents("cursor", cwd)).toBe(false);
    expect(existsSync(juniorAgentPath(cwd))).toBe(false);
  });

  it("removes the file", () => {
    const cwd = fresh();
    writeSubagents("claude-code", cwd);
    expect(removeSubagents(cwd)).toBe(true);
    expect(existsSync(juniorAgentPath(cwd))).toBe(false);
    // Removing again is a no-op.
    expect(removeSubagents(cwd)).toBe(false);
  });

  it("writes BOTH tiers — junior and worker — and removes both", () => {
    const cwd = fresh();
    expect(writeSubagents("claude-code", cwd)).toBe(true);
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
    expect(removeSubagents(cwd)).toBe(true);
    expect(existsSync(workerAgentPath(cwd))).toBe(false);
  });

  it("also writes the architect + user-invoked expert sub-agents (claude-code, removed together)", () => {
    const cwd = fresh();
    expect(writeSubagents("claude-code", cwd)).toBe(true);
    // Architect + expert land on disk so the host/user can spawn them.
    expect(existsSync(architectAgentPath(cwd))).toBe(true);
    expect(existsSync(expertAgentPath(cwd))).toBe(true);
    expect(readFileSync(architectAgentPath(cwd), "utf-8")).toBe(
      ARCHITECT_AGENT_MD
    );
    expect(readFileSync(expertAgentPath(cwd), "utf-8")).toBe(EXPERT_AGENT_MD);
    // Each pins its model + name.
    expect(ARCHITECT_AGENT_MD).toContain(`model: ${ARCHITECT_MODEL}`);
    expect(ARCHITECT_AGENT_MD).toContain("name: unerr-architect");
    expect(EXPERT_AGENT_MD).toContain(`model: ${EXPERT_MODEL}`);
    expect(EXPERT_AGENT_MD).toContain("name: unerr-expert");
    // Expert carries the shared editing contract (bounded retry, hand-back);
    // not a cheaper tier — the out-of-scope clause uses the neutral phrasing.
    expect(EXPERT_AGENT_MD).toMatch(/at most\s+\*\*2\*\*\s+retries/);
    expect(EXPERT_AGENT_MD).toContain("mcp__unerr__search_code");
    expect(EXPERT_AGENT_MD).not.toContain("on the cheaper tier");
    // The architect is selected FOR design/root-cause work, so it gets its own
    // decision contract instead — no editing "Out of scope" refusal, no bounded
    // retry (it isn't an edit-and-verify loop).
    expect(ARCHITECT_AGENT_MD).toContain("mcp__unerr__search_code");
    expect(ARCHITECT_AGENT_MD).toContain("Deliverable is a decision");
    expect(ARCHITECT_AGENT_MD).not.toContain(
      "You are not equipped to make those calls"
    );
    expect(ARCHITECT_AGENT_MD).not.toMatch(/at most\s+\*\*2\*\*\s+retries/);
    // The architect's value is design judgement + context isolation, not being a
    // stronger model than the session that spawned it (the senior may already be
    // running a stronger model) — the description/intro must not claim otherwise.
    expect(ARCHITECT_AGENT_MD).toContain("design judgement");
    expect(ARCHITECT_AGENT_MD).not.toContain("stronger tier");
    expect(ARCHITECT_AGENT_MD).not.toContain(
      "exceeds the current session's model"
    );
    expect(ARCHITECT_AGENT_MD).not.toContain("strongest model on the team");
    // uninstall removes the installed set (junior/worker/architect/expert).
    expect(removeSubagents(cwd)).toBe(true);
    expect(existsSync(architectAgentPath(cwd))).toBe(false);
    expect(existsSync(expertAgentPath(cwd))).toBe(false);
  });

  it("junior/worker/architect descriptions signal auto-delegation; expert is manual-only", () => {
    for (const md of [JUNIOR_AGENT_MD, WORKER_AGENT_MD, ARCHITECT_AGENT_MD]) {
      const desc = foldedDescription(md);
      expect(desc).toContain("Use PROACTIVELY");
      expect(desc).toContain("MUST BE USED");
    }
    // The architect auto-selects for complex/large-context work — it must NOT
    // carry the manual-only wording.
    const architectDesc = foldedDescription(ARCHITECT_AGENT_MD);
    expect(architectDesc).not.toContain("Manual-only");
    expect(architectDesc).not.toContain(
      "NEVER select this agent automatically"
    );
    // Claude Code has no `disable-model-invocation` field — the expert tier must
    // stay out of automatic routing via description wording alone.
    const expertDesc = foldedDescription(EXPERT_AGENT_MD);
    expect(expertDesc).toContain("Manual-only");
    expect(expertDesc).toContain("NEVER select this agent automatically");
    expect(expertDesc).not.toContain("Use PROACTIVELY");
  });

  it("every generated frontmatter uses a parseable folded description scalar", () => {
    for (const md of [
      JUNIOR_AGENT_MD,
      WORKER_AGENT_MD,
      ARCHITECT_AGENT_MD,
      EXPERT_AGENT_MD,
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

  it("worker's example no longer self-references unerr's own status command", () => {
    expect(WORKER_AGENT_MD).not.toContain("unerr status");
    expect(WORKER_AGENT_MD).toContain("the project's status command");
  });
});

describe("per-repo AgentEnv interpolation (language-agnostic contract)", () => {
  const CONCRETE_ENV: AgentEnv = {
    checks: {
      typecheck: "pnpm run typecheck",
      test: "pnpm run test:run",
      testAcceptsPath: true,
    },
  };

  it("DEFAULT_AGENT_ENV produces agnostic text — no pnpm", () => {
    for (const md of [JUNIOR_AGENT_MD, WORKER_AGENT_MD, EXPERT_AGENT_MD]) {
      expect(md).not.toContain("pnpm");
    }
    expect(ARCHITECT_AGENT_MD).not.toContain("pnpm");
  });

  it("only the small junior tier interpolates the repo's exact check command; bigger tiers self-verify", () => {
    // Junior (Haiku) is the small model — it gets the repo's own detected
    // command spelled out verbatim.
    const junior = buildJuniorAgentMd(CONCRETE_ENV);
    expect(junior).toContain("`pnpm run typecheck`");
    expect(junior).toContain("pnpm run test:run <path>");

    // Worker/expert/architect run on bigger models that know to verify —
    // spelling out the command only spends tokens, so they get the one-line
    // self-verify reminder instead of the interpolated command.
    for (const md of [
      buildWorkerAgentMd(CONCRETE_ENV),
      buildExpertAgentMd(CONCRETE_ENV),
    ]) {
      expect(md).not.toContain("`pnpm run typecheck`");
      expect(md).not.toContain("pnpm run test:run");
      expect(md).toContain("Verify with the repo's own check tooling");
    }

    const architect = buildArchitectAgentMd(CONCRETE_ENV);
    expect(architect).not.toContain("`pnpm run typecheck`");
    expect(architect).toContain("Verify with the repo's own check tooling");
  });

  it("a repo with no test command falls back to tooling-agnostic phrasing, not an invented command", () => {
    const noTest = buildWorkerAgentMd({
      checks: { typecheck: "cargo check", test: null, testAcceptsPath: false },
    });
    expect(noTest).toContain("Verify with the repo's own check tooling");
    expect(noTest).not.toContain("cargo check");
  });

  it("junior stays read-only-aware: recon/verify tasks make no edits", () => {
    expect(JUNIOR_AGENT_MD).toContain("Read-only tasks stay read-only");
    expect(JUNIOR_AGENT_MD).toContain(
      "For recon, investigation, audits, and verify-runs, make NO edits"
    );
    // Worker/expert are edit-first — they don't carry the read-only step.
    expect(WORKER_AGENT_MD).not.toContain("Read-only tasks stay read-only");
    expect(EXPERT_AGENT_MD).not.toContain("Read-only tasks stay read-only");
  });

  it("architect gets a decision contract, not the other tiers' design-work refusal", () => {
    expect(ARCHITECT_AGENT_MD).toContain("Deliverable is a decision");
    expect(ARCHITECT_AGENT_MD).toContain("root cause");
    expect(ARCHITECT_AGENT_MD).not.toContain(
      "You are not equipped to make those calls"
    );
    // The other three tiers keep the hand-back-to-senior refusal.
    for (const md of [JUNIOR_AGENT_MD, WORKER_AGENT_MD, EXPERT_AGENT_MD]) {
      expect(md).toContain("You are not equipped to make those calls");
    }
  });

  it("the final-report example is language-neutral (no hardcoded file path)", () => {
    for (const md of [JUNIOR_AGENT_MD, WORKER_AGENT_MD, EXPERT_AGENT_MD]) {
      expect(md).not.toContain("src/x.ts:42");
      expect(md).toContain("a caller passes 2 args, the new signature takes 3");
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

  it("subagentHandoff picks the model by class — worker for tests, junior for lint", () => {
    expect(subagentHandoff("codex", "tests")).toContain(CODEX_WORKER_MODEL);
    expect(subagentHandoff("codex", "lint_format")).toContain("gpt-5.4-mini");
    // Claude Code routes to the right on-disk sub-agent by tier.
    expect(subagentHandoff("claude-code", "tests")).toContain("unerr-worker");
    expect(subagentHandoff("claude-code", "lint_format")).toContain(
      "unerr-junior"
    );
    // Legacy no-class call floors to the junior tier (back-compat).
    expect(subagentHandoff("codex")).toContain("gpt-5.4-mini");
  });
});
