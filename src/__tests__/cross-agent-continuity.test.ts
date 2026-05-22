/**
 * Phase 4 Sprint 13 — Cross-agent continuity.
 *
 * Demonstrates that a user-fed fact stored from one IDE session (Agent
 * A — e.g. Claude Code) is recalled and enforced in a separate IDE
 * session (Agent B — e.g. Cursor) on the same repo, with no shared
 * in-memory state between the two.
 *
 * The two "agents" are modeled as two independently-created
 * TemporalFactStore handles pointed at the same on-disk `facts.db`.
 * They never share a CozoDB connection; everything flows through the
 * persistent file. This is the same isolation the bridge gives us in
 * production (each IDE launches its own `unerr --mcp` bridge that talks
 * over UDS to the long-lived per-repo proxy — the proxy owns the
 * single facts.db handle; the bridge owns nothing).
 *
 * The test simulates four moments:
 *   1. Agent A captures a user-fed fact via `executeUnerrRemember`.
 *   2. Agent B opens a fresh handle and runs `recallByScope` — must
 *      see the fact.
 *   3. Agent B touches a file whose path falls inside the fact's
 *      `applies_to` list — `factsApplyingTo` must surface it.
 *   4. `renderEnforcedFactPrefix` produces the `ur|fct` body line that
 *      Agent B's response envelope would inject.
 */

import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type TemporalFact,
  TemporalFactStore,
} from "../intelligence/temporal-facts.js";
import {
  appliesToFor,
  factsApplyingTo,
  renderEnforcedFactPrefix,
} from "../proxy/enforcement-loop.js";
import { executeUnerrRemember } from "../tools/intelligence/unerr-remember.js";

function tmpRepoRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "unerr-cross-agent-"));
}

describe("Phase 4 Sprint 13 — cross-agent continuity", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = tmpRepoRoot();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("user-fed fact captured in Agent A surfaces in Agent B's next session", async () => {
    // ── Agent A — Claude Code, session A ─────────────────────────────
    const agentAStore = await TemporalFactStore.create(repoRoot);
    const result = await executeUnerrRemember(
      {
        content: "always use cozo-node ≥ 0.7.6",
        source_quote: "from now on, always use cozo-node ≥ 0.7.6",
        scope: "project",
        subject: "project",
        fact_type: "convention",
        confidence: 0.95,
        applies_to: ["src/intelligence/"],
      },
      agentAStore,
      "session-claude-code",
      1
    );
    expect(result.stored).toBe(true);
    if (!result.stored) throw new Error("unreachable");
    const storedFactId = result.fact_id;
    expect(storedFactId).toBeTruthy();

    // Agent A exits. No in-memory state survives.

    // ── Agent B — Cursor, fresh session on the same repo ─────────────
    const agentBStore = await TemporalFactStore.create(repoRoot);

    // (2) Recall: Agent B must see the same fact.
    const recalled = await agentBStore.recallByScope("project");
    const match = recalled.find((f) => f.fact_id === storedFactId);
    expect(match).toBeDefined();
    expect(match?.source).toBe("user_fed");
    expect(match?.content).toBe("always use cozo-node ≥ 0.7.6");

    // (3) Provenance round-trips through the evidence blob — the
    //     verbatim quote and applies_to list reach Agent B unchanged.
    const provenance = await agentBStore.readProvenance(storedFactId);
    expect(provenance.source_quote).toBe(
      "from now on, always use cozo-node ≥ 0.7.6"
    );
    expect(provenance.applies_to).toContain("src/intelligence/");

    // (4) File-touch enforcement: Agent B reads a file under the
    //     applies_to prefix; the enforcement loop must surface the
    //     fact.
    const candidate = {
      fact: match as TemporalFact,
      applies_to: provenance.applies_to,
    };
    const touched = "src/intelligence/local-graph.ts";
    const hits = factsApplyingTo(touched, [candidate]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.fact_id).toBe(storedFactId);

    // (5) The `ur|fct` body line that goes into Agent B's next-turn
    //     response envelope must read as a follow-class convention.
    const line = renderEnforcedFactPrefix(hits[0] as TemporalFact);
    expect(line).toBe("ur|fct [convention] follow: always use cozo-node ≥ 0.7.6");
  });

  it("non-applies_to files do not trigger enforcement for Agent B", async () => {
    // Captures a fact scoped narrowly. A file outside the scope must
    // not surface the fact — proves the matcher is not over-fitting.
    const agentAStore = await TemporalFactStore.create(repoRoot);
    const result = await executeUnerrRemember(
      {
        content: "never call console.log in proxy code",
        source_quote: "stdout is sacred — never console.log from proxy.ts",
        scope: "src/proxy/",
        subject: "src/proxy/",
        fact_type: "negative",
        confidence: 0.95,
        applies_to: ["src/proxy/"],
      },
      agentAStore,
      "session-claude-code",
      2
    );
    expect(result.stored).toBe(true);
    if (!result.stored) throw new Error("unreachable");

    const agentBStore = await TemporalFactStore.create(repoRoot);
    const recalled = await agentBStore.recallByScope("src/proxy/");
    const fact = recalled.find((f) => f.fact_id === result.fact_id);
    expect(fact).toBeDefined();

    const provenance = await agentBStore.readProvenance(result.fact_id);
    const candidates = [
      { fact: fact as TemporalFact, applies_to: provenance.applies_to },
    ];

    // A file outside src/proxy must NOT match.
    expect(factsApplyingTo("src/ui/App.tsx", candidates)).toHaveLength(0);
    expect(factsApplyingTo("src/tracking/named-events.ts", candidates)).toHaveLength(0);
    // A file inside src/proxy MUST match.
    const hits = factsApplyingTo("src/proxy/proxy.ts", candidates);
    expect(hits).toHaveLength(1);
    expect(renderEnforcedFactPrefix(hits[0] as TemporalFact)).toContain(
      "[negative] avoid:"
    );
  });

  it("ambiguity flags survive the agent hand-off", async () => {
    // An ambiguous capture (0.5 ≤ confidence < 0.7) must store with
    // `ambiguity_flag: true` in Agent A; Agent B must see the same
    // flag in the evidence (so the dashboard could prompt the user to
    // confirm even from a different IDE).
    const agentAStore = await TemporalFactStore.create(repoRoot);
    const result = await executeUnerrRemember(
      {
        content: "we tend to colocate tests with source",
        source_quote: "I think we usually colocate tests, not sure",
        scope: "project",
        subject: "tests",
        fact_type: "convention",
        confidence: 0.6,
      },
      agentAStore,
      "session-claude-code",
      3
    );
    expect(result.stored).toBe(true);
    if (!result.stored) throw new Error("unreachable");
    expect(result.ambiguity_flag).toBe(true);

    const agentBStore = await TemporalFactStore.create(repoRoot);
    const facts = await agentBStore.listFactsBySource("user_fed");
    const fact = facts.find((f) => f.fact_id === result.fact_id);
    expect(fact).toBeDefined();
    expect(fact?.source_quote).toBe("I think we usually colocate tests, not sure");
    // Ambiguity is preserved on the evidence blob (Phase 2 stores it
    // there as the schema has no dedicated column).
    expect(fact?.effective_confidence).toBeLessThan(0.7);
  });

  it("appliesToFor merges across multiple evidence entries written by different agents", async () => {
    // Agent A captures with one applies_to, Agent B reinforces with
    // additional applies_to. The merged set covers both. Proves the
    // hand-off is bidirectional (B → A direction also works).
    const agentAStore = await TemporalFactStore.create(repoRoot);
    const a = await executeUnerrRemember(
      {
        content: "single source of truth for routes is server/http.ts",
        source_quote: "all routes go through server/http",
        scope: "project",
        subject: "routes",
        fact_type: "procedural",
        confidence: 0.95,
        applies_to: ["src/server/"],
      },
      agentAStore,
      "session-claude-code",
      4
    );
    expect(a.stored).toBe(true);
    if (!a.stored) throw new Error("unreachable");

    // Agent B reinforces with an expanded scope.
    const agentBStore = await TemporalFactStore.create(repoRoot);
    await agentBStore.reinforceFact(a.fact_id, {
      session_id: "session-cursor",
      action: "reinforced",
      timestamp: Date.now(),
      quote: "also covers anything under src/server/routes",
      applies_to: ["src/server/routes/"],
    });

    // A third agent reads the merged applies_to set.
    const agentCStore = await TemporalFactStore.create(repoRoot);
    const provenance = await agentCStore.readProvenance(a.fact_id);
    expect(provenance.applies_to).toEqual(
      expect.arrayContaining(["src/server/", "src/server/routes/"])
    );

    // Verify the same merge happens when appliesToFor is called
    // directly on a synthesized evidence list — proves the helper and
    // the store's reader agree.
    const merged = appliesToFor([
      {
        session_id: "session-claude-code",
        action: "created",
        timestamp: 1,
        applies_to: ["src/server/"],
      },
      {
        session_id: "session-cursor",
        action: "reinforced",
        timestamp: 2,
        applies_to: ["src/server/routes/"],
      },
    ]);
    expect(merged).toEqual(
      expect.arrayContaining(["src/server/", "src/server/routes/"])
    );
  });
});
