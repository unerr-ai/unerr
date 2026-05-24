# Skill consolidation audit — 27 → 7

**Status:** SHIPPED 2026-05-23. The 27→7 consolidation has landed in
`src/skills/local-pack.ts`. Three open questions in §6 were resolved by the
user; see §8 for the as-shipped record and §9 for the next-track open
items (ur|<tag> legend 12→4, MCP tool surface 24→smaller).

**Why this audit:** The user flagged that 27 unerr skills are causing context
overload and conflicting instructions. Anthropic's own Skills docs confirm
description-budget truncation kicks in around the 1% context mark — at 27
skills, the lowest-priority descriptions are silently dropped, which means
some skills the agent thinks exist are invisible to it.

## 1. Current inventory (27 skills)

| # | id | Concern |
|---|----|---------|
| 1 | token-efficient | Output verbosity constraint |
| 2 | file-read-protocol | Use outlines + targeted reads |
| 3 | graph-first-navigation | Graph tools before file reads |
| 4 | understand-before-modify | Read context before edit |
| 5 | blast-radius-first | Caller fan-in before edit |
| 6 | convention-aware-generation | Match project style |
| 7 | dependency-aware-refactor | Trace deps before move/rename |
| 8 | safe-modification-workflow | 4-phase change pipeline |
| 9 | architecture-exploration | Use graph for unfamiliar areas |
| 10 | session-context-preservation | Resume context |
| 11 | timeline-markers | mark_intent/decision/blocker/resolution |
| 12 | turn-discipline | Don't yield mid-tasklist |
| 13 | user-fed-memory | Capture "remember X" |
| 14 | prompt-receipt (active-cognition) | Recall on every prompt |
| 15 | anchor-query | Anchored notes before edit |
| 16 | save-at-end | Persist learned notes at task end |
| 17 | safe-modification | Recon before edit (DUP of #8) |
| 18 | intent-tracking | Inline markers (DUP of #11) |
| 19 | pre-edit-recon | Recon before edit (DUP of #4, #17) |
| 20 | drift-aware-edit | Re-read drifted files |
| 21 | blast-radius-check | Caller fan-in (DUP of #5) |
| 22 | convention-discovery | Load conventions (DUP of #6) |
| 23 | systematic-debugging | Reproduce → isolate → fix (NEW) |
| 24 | brainstorming-before-build | Shape before code (NEW) |
| 25 | receiving-code-review | Classify each comment (NEW) |
| 26 | test-driven-development | Red → green → refactor (NEW) |
| 27 | using-unerr | Master orchestrator |

**Confirmed duplicates (4 pairs):**
- `blast-radius-first` ≡ `blast-radius-check`
- `safe-modification` ≡ `safe-modification-workflow`
- `convention-aware-generation` ≡ `convention-discovery`
- `understand-before-modify` ≡ `pre-edit-recon`

## 2. External research findings

| System | Count | Consolidation principle | Anti-pattern they avoid |
|---|---|---|---|
| Superpowers (obra/superpowers) | **14** | One skill per workflow *phase*, not micro-action. Lifecycle: `writing-plans` → `executing-plans` → `verification-before-completion`. No `pre-edit-recon` or `blast-radius-check` granularity — folded into the phase. | Redundant entries with overlapping triggers. |
| Anthropic Skills docs | No fixed count | Phase-oriented bundle (`/run`, `/verify`, `/debug`, `/code-review`). Description budget = 1% of context — lowest-priority descriptions auto-truncate. | `description` collisions; >500-line bodies. |
| Cursor rules | <300-400 lines combined | Path-scope (`globs:`) disambiguates rather than name-splitting. | Two rules with contradictory instructions both matching the same path. |
| LangChain / CrewAI | 3-7 tools per agent | Agents-as-namespaces — small tool subset per agent, router picks the agent. | 250-tool flat namespace; tool selection noise. |
| Academic (arxiv "Agent Skills" 2602.12430, "SkillReducer" 2603.29919) | Multi-level hierarchy | Planning → functional → atomic. Two-phase loading: registry-of-short-descriptions always loaded; bodies loaded on match. | Flat skill registries. |

**Convergent principle across all 5 sources:** **one skill per workflow phase
+ a dispatcher that owns routing**. Atomic actions live INSIDE phase skills,
not as separate skills.

## 3. Anthropic's specific failure modes (we are hitting both)

From the Skills troubleshooting section:

> "Skill triggers too often" — fix: narrow `description`, set
> `disable-model-invocation`, or merge.

> "Descriptions cut short" — fix: drop low-priority skills to name-only,
> reduce the skill count, narrow `paths`.

With 27 unerr skills, we hit "descriptions cut short" — `blast-radius-check`
and `blast-radius-first` both fight for the same trigger phrase and one will
be silently truncated. With the new 4 dispatch-target skills, `using-unerr`
points at `systematic-debugging` but the model may have lost the description
by then.

## 4. Proposed consolidation (27 → 7)

| Keep | Absorbs | Phase it owns |
|---|---|---|
| **`unerr-using-unerr`** | — | Master dispatcher — like `using-superpowers` |
| **`unerr-safe-modification`** | `safe-modification`, `safe-modification-workflow`, `pre-edit-recon`, `understand-before-modify`, `blast-radius-first`, `blast-radius-check`, `convention-aware-generation`, `convention-discovery`, `drift-aware-edit`, `dependency-aware-refactor` | "Edit existing code" lifecycle (recon → blast → convention → drift → edit → verify) |
| **`unerr-exploration`** | `graph-first-navigation`, `architecture-exploration`, `file-read-protocol` | "Find / understand unfamiliar code" (graph first, outline-then-read) |
| **`unerr-memory`** | `prompt-receipt`, `anchor-query`, `save-at-end`, `user-fed-memory`, `session-context-preservation` | Four-moment contract + capture + resume |
| **`unerr-markers`** | `timeline-markers`, `intent-tracking`, `turn-discipline` | mark_intent / decision / blocker / resolution discipline |
| **`unerr-build-and-debug`** | `systematic-debugging`, `brainstorming-before-build` | New-code lifecycle (Track A) + bug lifecycle (Track B) |
| **`unerr-test-and-review`** | `test-driven-development`, `receiving-code-review` | TDD (Track A) + review-response (Track B) |
| ~~`unerr-token-efficient`~~ | (FOLDED into `unerr-using-unerr` body) | Output shape — baked into the master skill's instructions |

**Net:** 27 → 7 skills. Description budget stays under Anthropic's 1% threshold.
Every skill has a non-overlapping trigger phrase.

## 5. Migration approach

1. **Phase 1 — write the 7 consolidated skill bodies** as new SkillDefinitions
   in `src/skills/local-pack.ts`. Keep the old 27 in place — additive only.
2. **Phase 2 — update `USING_UNERR_SKILL` dispatch table** to point at the
   new 7. The verb clusters in `src/hooks/prompt-hooks.ts` need to update too.
3. **Phase 3 — run `unerr install`** against this repo. Diff the
   `.claude/skills/` output. Each consolidated skill should be present;
   the 20 absorbed skills should still be there (additive — old paths
   keep working for any cached prompts).
4. **Phase 4 — deprecate the old 20** by setting their `trigger.type` to
   `"agent-requested"` (off the always-on list) and adding a `description`
   prefix `"DEPRECATED — merged into <new-skill>".`. Two release cycles
   later, delete.
5. **Phase 5 — measure** with the new turn-summary `highlights` field:
   does `skill_invoked` count rise after the consolidation lands? If yes,
   the description-budget freed by removing 20 entries restored
   auto-invocation for the remaining 7.

## 6. Open questions for the user

- Token-efficient as a standalone (#7) — or fold into `unerr-using-unerr`'s
  body since the master skill is always-on anyway?
- `unerr-build-and-test` bundles 4 distinct lifecycles (build, debug, test,
  review). Worth splitting into 2 (`unerr-build-and-debug` + `unerr-test-and-review`)?
- Keep both `.claude/` and `local-pack.ts` paths during Phase 4, or delete
  the disk artifacts on the same release that flips `trigger.type`?

## 8. As-shipped record (2026-05-23)

The three open questions in §6 were resolved as follows:

1. **Token-efficient as #7** → **FOLDED** into `unerr-using-unerr`. The
   master skill is always-on; embedding the 9 output-shape rules in its
   body eliminates a separate skill entry, freeing one of the 7 slots.
   Token-efficient guidance now lives in `USING_UNERR_SKILL.instructions`
   in `src/skills/local-pack.ts` (version 2.0.0).
2. **Split `unerr-build-and-test`?** → **SPLIT** into `unerr-build-and-debug`
   and `unerr-test-and-review`. Reasoning: build+debug share a *forensic*
   mental model (shape it / reproduce it), while test+review share a
   *verification* mental model (assert what should hold / classify what
   was flagged). Bundling all four in one body would exceed Anthropic's
   500-line recommendation and split-trigger phrasing would still need
   per-track sections — better to make the boundary explicit at the
   skill level. The slot freed by folding token-efficient absorbs the
   split, so the net count stays at 7.
3. **Disk cleanup timing** → **EAGER**. Legacy `unerr-*` SKILL.md dirs not
   in `LOCAL_SKILLS` are wiped from `.claude/skills/` and `.cursor/rules/`
   before the 7 are written. Implemented in two places:
   - `src/commands/install.ts` — `removeInstalledSkills(ide, cwd)` runs
     before `resolveAndInstallSkills` on every `unerr install <agent>`.
   - `src/skills/resolver.ts` — `ensureSkillsPresent` is migration-aware:
     on proxy boot it detects legacy `unerr-*` files outside the
     consolidated set and triggers the same cleanup, so users who never
     re-run install still get the cleanup at the next session.

**Final 7 (as shipped):**

| Slot | id | Always-on? | Body source |
|------|----|-----------|-------------|
| 1 | `unerr-using-unerr` | yes | `USING_UNERR_SKILL` (token-efficient folded in) |
| 2 | `unerr-safe-modification` | yes | `SAFE_MODIFICATION_SKILL` |
| 3 | `unerr-exploration` | on demand | `EXPLORATION_SKILL` |
| 4 | `unerr-memory` | yes | `MEMORY_SKILL` |
| 5 | `unerr-markers` | yes | `MARKERS_SKILL` |
| 6 | `unerr-build-and-debug` | on demand | `BUILD_AND_DEBUG_SKILL` (Track A/B) |
| 7 | `unerr-test-and-review` | on demand | `TEST_AND_REVIEW_SKILL` (Track A/B) |

**Verification:** `unerr install claude-code --force` + `unerr install cursor
--force` against this repo wiped all 22 legacy entries and installed exactly
the 7 above (see `.claude/skills/` and `.cursor/rules/` post-install). The
115 targeted tests covering the consolidation pass cleanly.

## 9. Follow-on consolidation tracks

The 27→7 ship surfaced two adjacent over-surface problems that earn their
own consolidation pass:

### 9.1. `ur|<tag>` legend — 12 → 4 (next track)

Today's legend (`SIGNAL_PREFIX_LEGEND` in `src/proxy/response-envelope.ts`
and the table in `CLAUDE.md`) lists 12 tags: `hlt`, `dft`, `rsk`, `wrn`,
`hnt`, `unl`, `fct`, `ctx`, `hth`, `hst`, `skl`, `act`. The agent has to
memorise 12 distinct response semantics, and emission sites use the tag
purely as a routing key — the *content* of the line is what the agent
acts on, not the tag.

**Proposed 12 → 4 taxonomy:**

| New tag | Subsumes | Semantics |
|---------|----------|-----------|
| `ur\|act` | `act`, `skl`, `unl`, `hlt` | "Do this now." A named tool/skill must run this turn (Moment 1 recall, mark_intent, turn_summary, Skill('<name>'), unlocked tool, halt-and-switch). |
| `ur\|ctx` | `dft`, `ctx`, `hth` | "State the agent is in." Drift detected → re-read; context already delivered → don't re-query; session health degraded → consider restart. |
| `ur\|rsk` | `rsk`, `wrn`, `hst` | "Risk surface around the change." Blast radius high; anti-pattern on this path; prior failures on this entity. |
| `ur\|fct` | `fct`, `hnt` | "Information the agent can use." Surfaced project fact (subtype in brackets); co-change suggestion. |

**Net:** 12 → 4 tags. Each tag carries a subtype suffix when the merged
tags had distinct semantics — e.g. `ur|act[skl:exploration]`,
`ur|ctx[dft]`, `ur|rsk[hst]`. Subtype is optional; bare `ur|<tag>` is
valid for the most common emission per category.

**Migration plan:**
1. Add a `TAG_ALIAS` map in `src/proxy/response-envelope.ts` so legacy
   `ur|<old>` strings emit as `ur|<new>[<subtype>]`.
2. Update every emission site (grep for `'ur|' +` and `\`ur|`).
3. Update `SIGNAL_PREFIX_LEGEND` and the `CLAUDE.md` `ur|<tag>` table to
   show the 4 new tags + their subtypes.
4. Update `.cursor/rules/unerr-instructions.mdc` instruction body via
   `src/config/instruction-writer.ts`.

Tracked as tasks #76, #77, #78, #79.

### 9.2. MCP tool surface — 24 → 16 (deferred to a dedicated sprint)

Today's per-repo proxy exposes 23 MCP tools (down from 24 after counting
non-tool legend entries). Five fold candidates collapse the surface to
16. The folds are listed below in **risk-ascending order** so the next
sprint can land them one at a time.

| # | Fold | Today | Proposed | Risk | Blast radius |
|---|------|-------|----------|------|--------------|
| 1 | Markers | `mark_intent`, `mark_decision`, `mark_blocker`, `mark_resolution` (4) | 1 `mark({kind: "intent"\|"decision"\|"blocker"\|"resolution", ...})` | Low — all tier-3, identical handler shape | 28 src files, 14 tests, 2 instruction writers, 1 skill body |
| 2 | Memory writes | `record_fact`, `unerr_remember` (2) | 1 `remember({source: "observed"\|"user-fed", ...})` | Low — already share dispatch | 18 src files, 9 tests |
| 3 | Memory reads | `recall_facts`, `unerr_recall_notes` (2) | 1 `recall({scope: "facts"\|"notes", ...})` | Low — distinct anchors, identical retrieval path | 20 src files, 11 tests |
| 4 | File ops | `file_read`, `file_outline` (2) | 1 `file({mode: "read"\|"outline", ...})` | Medium — `file_read` is tier-1 workhorse with auto-injection of conventions/drift/facts | 40+ src files, 30+ tests |
| 5 | Discovery | `search_code`, `get_entity` (2) | 1 `find({by: "text"\|"entity", ...})` | Medium — both tier-1, distinct return shapes | 35+ src files, 25+ tests |

**Net:** 24 → 16. Each fold is independently shippable. Aliases keep
backwards-compat for one deprecation window (one minor release).

#### 9.2.1. Implementation spec (per fold)

For every fold, the work is:

1. **Add the unified tool entry** in `src/proxy/tool-descriptions.ts`
   (`TIER_ENTRIES`) with active/locked/unlocked descriptions under the
   tier-1/2/3 budgets (80/30/60 tokens). Use the same tier as the
   most-restrictive folded tool.
2. **Add the unified schema** in `src/proxy/tool-definitions.ts` with
   the discriminator field (`kind`/`scope`/`mode`/`by`/`source`) and
   per-discriminator required fields.
3. **Add the dispatch** in `src/intelligence/query-router.ts` —
   discriminator value routes to the existing private handler. Zero
   new logic; the underlying implementation is preserved verbatim.
4. **Add backwards-compat aliases** — keep the old `mark_intent` etc.
   entries in `TIER_ENTRIES` for one minor release. Their handlers
   simply construct the equivalent unified payload and dispatch.
   Annotate as `(deprecated — call mark({kind:"intent", ...}))` in
   the active description.
5. **Update the agent-facing instructions**: `CLAUDE.md` table,
   `src/config/instruction-writer.ts` injected section, every skill
   body in `src/skills/local-pack.ts` that names the old tool.
6. **Update tests** to use the unified name. Keep one alias test per
   fold to verify the deprecation alias still works.
7. **Update web-landing docs**:
   - `docs/open-cli/architecture/TOOL_SKILL_REGISTRATION_GUIDE.md`
   - `docs/open-cli/architecture/MCP_GATEWAY_ROUTER_PROXY.md`
   - `docs/open-cli/architecture/AGENT_INTEGRATION_GUIDE.md`

#### 9.2.2. Status

Tracked as task #80. **Deferred** in the 2026-05-24 session because:
- Each fold needs careful migration + deprecation window.
- The audit's "Design + user confirmation required" gate has not been
  passed for any fold below row 3.
- The ur|<tag> 14→4 fold (§9.1) already shipped this sprint; landing
  five MCP folds in the same release would be a hostile change for
  any consumer who installed an earlier version.

**Next sprint plan:** ship folds 1, 2, 3 (low-risk, tier-3 or
memory-only). Re-evaluate folds 4 and 5 after one minor release with
the deprecation aliases in place to gather adoption telemetry.

## 10. Sources

- [Superpowers skills tree](https://github.com/obra/superpowers/tree/main/skills)
- [Anthropic Skills docs](https://code.claude.com/docs/en/skills)
- [Cursor Rules docs](https://cursor.com/docs/rules)
- [Empirical study of Cursor Rules (arxiv 2512.18925)](https://arxiv.org/html/2512.18925v3)
- [Unified tool calling: LangChain / CrewAI / MCP](https://www.scalekit.com/blog/unified-tool-calling-architecture-langchain-crewai-mcp)
- [Agent Skills survey (arxiv 2602.12430)](https://arxiv.org/html/2602.12430v3)
- [SkillReducer (arxiv 2603.29919)](https://arxiv.org/pdf/2603.29919)
