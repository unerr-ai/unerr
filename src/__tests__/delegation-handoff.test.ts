import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDelegationHandoff } from "../skills/junior-agent.js";
import { recordDelegationHandoff } from "../tracking/delegation-handoff.js";

describe("detectDelegationHandoff (Issue 5 cross-agent meter)", () => {
  it("recognizes a Codex handoff and resolves the tier from the model", () => {
    expect(
      detectDelegationHandoff('codex exec -m gpt-5.4-mini "<digest> + task"')
    ).toEqual({ host: "codex", tier: "junior", model: "gpt-5.4-mini" });
    // The distinct worker model resolves to the worker tier.
    expect(
      detectDelegationHandoff('codex exec -m gpt-5.4 "<digest> + task"')
    ).toEqual({ host: "codex", tier: "worker", model: "gpt-5.4" });
  });

  it("recognizes a Cursor handoff — collapsed tier always resolves to junior", () => {
    expect(
      detectDelegationHandoff('cursor-agent -p -m composer-1 --force "task"')
    ).toEqual({ host: "cursor", tier: "junior", model: "composer-1" });
  });

  it("recognizes a Copilot handoff via --model", () => {
    expect(
      detectDelegationHandoff(
        'copilot -p "task" --model gpt-5-mini --allow-all-tools'
      )
    ).toEqual({
      host: "github-copilot-cli",
      tier: "junior",
      model: "gpt-5-mini",
    });
    expect(
      detectDelegationHandoff(
        'copilot -p "task" --model gpt-5 --allow-all-tools'
      )
    ).toEqual({ host: "github-copilot-cli", tier: "worker", model: "gpt-5" });
  });

  it("does NOT match a non-handoff command that merely carries a -m flag", () => {
    // `git commit -m` has a -m but no codex/cursor/copilot handoff token.
    expect(detectDelegationHandoff('git commit -m "fix: thing"')).toBeNull();
    expect(detectDelegationHandoff("ls -la")).toBeNull();
    expect(detectDelegationHandoff("pnpm run test:run")).toBeNull();
    expect(detectDelegationHandoff("")).toBeNull();
  });
});

describe("recordDelegationHandoff (in-process emit)", () => {
  let repoRoot: string;
  const savedSid = process.env.UNERR_SESSION_ID;
  const savedAgent = process.env.UNERR_AGENT;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-handoff-"));
    mkdirSync(join(repoRoot, ".unerr", "state"), { recursive: true });
    // resolveExecSessionContext reads the live session id from this file (or
    // the env). Give it one so the row has something to attribute to.
    writeFileSync(join(repoRoot, ".unerr", "state", "session.id"), "sess-xyz");
    process.env.UNERR_SESSION_ID = "";
    process.env.UNERR_AGENT = "";
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    // Restore env exactly — assigning `undefined` would coerce to the string
    // "undefined" in process.env, so truly-unset vars are removed via Reflect.
    if (savedSid === undefined)
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    else process.env.UNERR_SESSION_ID = savedSid;
    if (savedAgent === undefined)
      Reflect.deleteProperty(process.env, "UNERR_AGENT");
    else process.env.UNERR_AGENT = savedAgent;
  });

  it("emits the 2 tier-only savings rows for a real handoff", () => {
    const n = recordDelegationHandoff(
      repoRoot,
      'codex exec -m gpt-5.4-mini "<digest> + task"'
    );
    // harness_subagent_model + delegated_to_junior. The class-gated kinds
    // (recon / worker_batch_parallel) stay off — class is unknown cross-agent.
    expect(n).toBe(2);
  });

  it("is a no-op for a non-handoff command", () => {
    expect(recordDelegationHandoff(repoRoot, "ls -la")).toBe(0);
  });

  it("drops the row when no live session id can be resolved", () => {
    rmSync(join(repoRoot, ".unerr", "state", "session.id"), { force: true });
    expect(
      recordDelegationHandoff(repoRoot, 'codex exec -m gpt-5.4-mini "x"')
    ).toBe(0);
  });
});
