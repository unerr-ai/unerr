import { describe, expect, it } from "vitest";
import {
  CONTRACT_TEACHING_BLOCK,
  TOOL_DESCRIPTION_NUDGES,
} from "../intelligence/contract-teaching.js";
import { TIER_ENTRIES } from "../proxy/tool-descriptions.js";

describe("CONTRACT_TEACHING_BLOCK (D10)", () => {
  it("names all four contract moments", () => {
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/Moment 1.*Prompt receipt/);
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/Moment 2.*Anchor query/);
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/Moment 3.*Cite in plan/);
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/Moment 4.*Save at task end/);
  });

  it("references recall by tool name and save by sentinel (no unerr_remember)", () => {
    // Recall is a task-shaped search_code query (the recon composite folded
    // into search_code 2026-06; notes auto-inject via the UserPromptSubmit
    // hook); save is the `unerr-save:` Stop-hook sentinel — unerr_remember left
    // the catalog (2026-06) and must not be taught.
    expect(CONTRACT_TEACHING_BLOCK).toContain("search_code");
    expect(CONTRACT_TEACHING_BLOCK).toContain("unerr-save: note");
    expect(CONTRACT_TEACHING_BLOCK).not.toContain("unerr_remember");
  });

  it("documents the DSL vocabulary (kinds + anchor types + polarities)", () => {
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/cnv.*rul.*wrn.*dec.*blk.*fct/s);
    // Sprint 7.5 doc-lockstep guard: the anchor table must list every type the
    // parser accepts, INCLUDING `w:` (workspace) — note-dsl.ts VALID_ANCHOR_TYPES
    // and this teaching block must not drift apart.
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/f:.*e:.*g:.*p:.*w:/s);
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/workspace-wide/);
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/\+.*-.*~/s);
  });

  it("calls out the three-condition quality bar and the save cap", () => {
    expect(CONTRACT_TEACHING_BLOCK).toContain("non-obvious");
    expect(CONTRACT_TEACHING_BLOCK).toContain("likely useful next session");
    expect(CONTRACT_TEACHING_BLOCK).toContain("anchorable");
    expect(CONTRACT_TEACHING_BLOCK).toContain("15");
  });

  it("explains conflict + supersession behavior", () => {
    // Sentinel saves return nothing this turn — conflicts and supersession
    // surface on next-turn recall, so the teaching describes that, not the
    // old tool-return fields (conflict_group_id / supersedes_note_id).
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/conflict/i);
    expect(CONTRACT_TEACHING_BLOCK).toMatch(/supersession|superseded/i);
    expect(CONTRACT_TEACHING_BLOCK).toContain("next-turn recall");
  });

  it("stays under the ~500-token budget (rough char-based proxy)", () => {
    // Tokenization is variable; use 4 chars/token as a conservative proxy.
    const tokenProxy = CONTRACT_TEACHING_BLOCK.length / 4;
    expect(tokenProxy).toBeLessThan(800);
  });
});

describe("TOOL_DESCRIPTION_NUDGES (D10)", () => {
  it("nudges every existing tool that bridges to the contract", () => {
    const tools = TOOL_DESCRIPTION_NUDGES.map((n) => n.tool);
    expect(tools).toContain("search_code");
    expect(tools).toContain("get_references");
    // get_entity merged into search_code({detail:true}) 2026-06 — its
    // contract-surprise nudge now rides search_code's entry.
    expect(tools).not.toContain("get_entity");
    // file_read carries no nudge: it is a plain read that does NOT inject
    // notes/conventions/drift (anchored notes arrive via prompt injection +
    // on-demand recall, never inline in a tool response).
    expect(tools).not.toContain("file_read");
  });

  it("each nudge routes to a surviving contract mechanism", () => {
    // Recall = a task-shaped search_code; save = the `unerr-save:` Stop-hook
    // sentinel.
    for (const n of TOOL_DESCRIPTION_NUDGES) {
      expect(n.nudge).toMatch(/search_code|unerr-save: note/);
      expect(n.nudge).not.toMatch(/unerr_remember/);
    }
  });

  it("each nudge stays short (≤ 200 chars)", () => {
    for (const n of TOOL_DESCRIPTION_NUDGES) {
      expect(n.nudge.length).toBeLessThanOrEqual(200);
    }
  });

  // Drift guard: TOOL_DESCRIPTION_NUDGES is the canonical reference for what
  // each existing tool's description should say about the active-cognition
  // contract. The active strings in TIER_ENTRIES (tool-descriptions.ts) ship
  // to the agent. If they drift, the contract advertised to the agent stops
  // matching the contract documented here — silent failure mode.
  it("each nudge appears verbatim in its tool's active description", () => {
    for (const n of TOOL_DESCRIPTION_NUDGES) {
      const entry = TIER_ENTRIES[n.tool];
      expect(entry).toBeDefined();
      expect(entry?.active).toContain(n.nudge);
    }
  });

  // NUDGE_V2 / CLAUDE.md "Writing nudges and hints" rules: no deictic
  // pronouns ("this"), no hedge verbs ("consider", "verify"), no `:N`
  // placeholder. Apply to every nudge string emitted into descriptions.
  it("nudges follow NUDGE_V2 anti-drift rules (no deictic, hedge, or :N)", () => {
    const HEDGE_RE = /\b(consider|verify|review|may want to|try checking)\b/i;
    const DEICTIC_RE = /\bthis (entity|file|prompt|path)\b/i;
    const PLACEHOLDER_RE = /:N\b/;
    for (const n of TOOL_DESCRIPTION_NUDGES) {
      expect(n.nudge).not.toMatch(HEDGE_RE);
      expect(n.nudge).not.toMatch(DEICTIC_RE);
      expect(n.nudge).not.toMatch(PLACEHOLDER_RE);
    }
  });
});
