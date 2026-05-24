# unerr — identity, router, hook, skills, and impact-surfacing redesign (v3 — triage tracker)

**Status:** decisions resolved (see §"Resolved decisions"); implementation in progress.

> **2026-05-23 update — skill count consolidated 27 → 7.** The 17→27 skill
> sprawl described below has been absorbed into a 7-skill set; see
> `docs/skill-consolidation-audit.md` (now marked SHIPPED). The "Top 6
> skills to (re)write — first wave" subsection in §4 is superseded by the
> consolidated set in `src/skills/local-pack.ts`. Treat the older skill
> counts in §4 as historical context for *why* the consolidation happened.
**This doc is the triage tracker** for the whole redesign — every code change is enumerated under §"Implementation tracker" with a file path, status, and a manual-verification check. Doc stays here until every row is `done + verified`, then we move it under `docs/proposals/` (decision #5).

**Changes in v2 (research-backed; preserved):**
- Identity prose: dropped user-framed Drafts A/B/C; new Draft D mirrors Anthropic's own Claude Code system-prompt house style (researched against leaked Claude Code system prompt at `system_prompts_leaks/Anthropic/claude-code.md`).
- Prompt hook: kept keyword regex as the fast tier; added a research section comparing pure-keyword vs. semantic-embedding (semantic-router) vs. LLM-self-classification, with a hybrid recommendation grounded in production patterns.
- Skills: added a **master skill** (`using-unerr`) — mirrors Superpowers' `using-superpowers` orchestrator pattern, composes with user-defined skills.
- Impact surfacing: re-grounded in the four-surface model from `unerr-web-landing/docs/open-cli/PERCEPTION_TO_PRESENCE.md`. We adopt **Surfaces 2, 3, and 4** (the three execution-trace surfaces; Surface 1 is the UI dashboard, out of scope here). All user-facing copy rewritten to be jargon-free natural language.

**Changes in v3:**
- Open decisions → resolved (Draft D adopted; hybrid classifier kept; omni-skill fallback chosen; assistant-body surface chosen; doc stays here as triage tracker until verified).
- Added §"Implementation tracker" — 27 discrete tasks across 5 sections with status, file paths, and verification checks.

Each section reads as a before/after.

**Goal (unchanged):** make the LLM treat unerr's outputs as **first-class context, equal in weight to the source files themselves** — and make the user **feel** that value on every turn through natural-language lines they can scan without knowing anything about `ur|<tag>`, anchors, or wire formats.

---

## 0. The frame we're shifting toward

A senior engineer never hands a junior a codebase and says "build a feature." They first explain:
- **History** — what already happened to this code, who changed it, why it drifted.
- **Importance & blast radius** — what depends on this, what breaks if it changes.
- **Need & necessity** — why a change is justified (or not).
- **How to act** — the team's process: TDD, design-first, root-cause-first.
- **What to consider** — conventions, prior failures, team agreements.
- **Sequence** — the order of operations the team has agreed on.

This is the user's mental model and we encode it without stating it theatrically. Anthropic's own Claude Code system prompt does **not** say "you are a senior engineer." It says, in one line, *"You are an interactive agent that helps users with software engineering tasks."* — then immediately moves to operational rules. That terse, imperative house style is what the model treats as ground truth. Theatrical role-play prose loses to mechanical declarations of fact in compliance testing ([Anthropic prompt engineering](https://aiflowchat.com/blog/articles/anthropic-prompt-engineering-guide), [leaked Claude Code system prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-code.md)).

So the five changes below all serve the senior-engineer-brief mental model — but they are **written in Anthropic's mechanical house voice**, not in a role-play voice.

---

## 1. Identity reframe

### Current — `src/config/instruction-writer.ts:63` (first 3 lines of every CLAUDE.md / AGENTS.md / .cursor/rules/unerr-instructions.mdc the install writes)

```
## REQUIRED: Use unerr Graph Intelligence Tools (21 MCP tools)

This project has unerr MCP tools installed. You MUST use these instead
of built-in Read/Grep/Glob for code navigation, and `fetch_url` instead
of built-in WebFetch. unerr tools are graph-backed, return results in
<5ms, and include project context that built-in tools miss.
```

Then 200+ lines of per-tool routing tables.

**Problems:**
- Leads with **"21 MCP tools"** — research on MCP tool overload ([Lunar](https://www.lunar.dev/post/why-is-there-mcp-tool-overload-and-how-to-solve-it-for-your-ai-agents), [Junia](https://www.junia.ai/blog/mcp-context-window-problem)) shows large tool counts trigger context-rot.
- Frames unerr as **"instead of built-in Read/Grep/Glob"** — positions us as a substitute, not as a different category of information.
- Says nothing about *what only unerr knows* — the history, drift, anchored notes, blast radius, conventions, rules the user has fed it.
- Theatrical "REQUIRED" / "MUST" headers without an operational identity line first — research shows the model anchors to the *first* identity statement, not to scattered capitalisation ([Anthropic Bedrock prompt-eng best practices](https://aws.amazon.com/blogs/machine-learning/prompt-engineering-techniques-and-best-practices-learn-by-doing-with-anthropics-claude-3-on-amazon-bedrock/)).

### Research informing the rewrite

We compared identity prose patterns from:
- **Anthropic's own Claude Code system prompt** (leaked, v2.1.143) — opens with a single-line role statement, then `# Harness` and `# Text output` sections of mechanical operational rules. Zero role-play prose. `IMPORTANT:` used sparingly (once for security policy). The model's compliance is tied to terseness, not theatrics.
- **Anthropic's prompt-engineering guide** — recommends a one-line role to "shape perspective and tone," then concrete operational rules.
- **Superpowers' `using-superpowers` SKILL.md** — uses `<EXTREMELY-IMPORTANT>` XML wrapper for the *one* non-negotiable rule; the rest is operational prose.
- **Anti-pattern observed** in lower-compliance system prompts (the leak set): heavy persona prose ("you are a senior X with N years experience") consistently underperforms mechanical role declarations in adversarial testing.

The conclusion is unambiguous: **the highest-compliance identity prose is short, mechanical, second-person, names the role in one line, and follows with operational rules — not analogies or role-play.**

### Proposed — Draft D (Anthropic-style; the research pick)

```
## unerr — operational memory for this codebase

unerr remembers what this codebase has been through. The source files
tell you what the system DOES today. unerr tells you what it has
LEARNED — who changed each file last, why it drifted, what failed here
before, the conventions the team accreted, and the rules the user has
fed it across sessions.

Treat unerr's outputs as ground-truth context, equal in weight to
source files. Two sources feed every non-trivial change you ship:

  - the codebase  — the system as it IS
  - unerr         — the system as it has been UNDERSTOOD

unerr's outputs reach you through four channels:

  - body-line signals prefixed `ur|<tag>` on tool responses
    (risk, drift, halt, hint, fact, history)
  - anchored notes via `unerr_recall_notes` — rules and decisions
    tied to specific files or entities, written in prior sessions
  - persistent facts via `recall_facts` — what the user said about
    this pattern before
  - workflow skills via `Skill()` — the team's agreed sequence
    for debug / refactor / brainstorm / TDD work

IMPORTANT: Before any non-trivial code action (implement, fix, refactor,
build, debug), call `unerr_recall_notes` with the verbatim user prompt.
Source files alone are half the brief.
```

**Why this is the research-backed pick (and Drafts A/B/C are dropped):**

| Property | Anthropic house style | Draft A | Draft B | Draft C | **Draft D (chosen)** |
|---|---|---|---|---|---|
| One-line role declaration | ✓ | ✗ (3-line metaphor) | ✓ | ✗ (paragraph) | ✓ |
| Mechanical, non-theatrical tone | ✓ | partial | ✓ | ✗ (senior-engineer role-play) | ✓ |
| Names the operational channels explicitly | n/a | partial | partial | ✓ | ✓ |
| Single `IMPORTANT:` directive | ✓ | ✗ | ✗ | ✗ | ✓ |
| Second-person imperative | ✓ | ✓ | ✓ | ✓ | ✓ |
| No "you are a senior X" role-play | ✓ | ✓ | ✓ | ✗ | ✓ |

Draft D preserves the user's *mental model* (the senior-engineer brief) but encodes it in Anthropic's own *compliance-winning style* — never says "senior engineer," but the structure *is* the senior-engineer brief.

### Why this matters

- Removes the "21 tools" anti-pattern lead.
- Stops positioning unerr as a Read/Grep replacement.
- Drops theatrical role-play; gives the model one operational line and one `IMPORTANT:` directive — proven highest-compliance shape.
- Tells the model *what only unerr knows* (the user's stated point) — the four channels are named and weighted equal to source files.

---

## 2. Router surfacing

(Unchanged from v1 — research validated the direction.)

### Current

- `src/intelligence/query-router.ts` — internal Datalog dispatch from all 21 MCP tools. Plumbing.
- `src/proxy/router-gateway.ts:65-209` — **progressive disclosure gateway**:
  - **Tier-1 (9 tools)** seeded at session start, always exposed.
  - **Tier-2 (7 tools)** unlock on signals.
  - **Tier-3 (6 tools)** unlock on session maturity.
  - Each unlock emits a `ur|hnt <tool> unlocked — <reason>` line in the next response.

The injected instruction file currently enumerates all 21 tools in 6+ tables (defeats the progressive disclosure we already built). The "too many tools" problem is industry-known ([Lunar Tool Groups](https://www.lunar.dev/post/why-is-there-mcp-tool-overload-and-how-to-solve-it-for-your-ai-agents), [WRITER RAG-MCP](https://writer.com/engineering/rag-mcp/)). We built the fix and hid it.

### Proposed

1. **Strip the per-tool inventory tables** from the injected instruction file. Replace with a 5-line tier paragraph (Anthropic-style mechanical):

   ```
   ## Tool exposure — earned, not advertised

   You start each session with 9 unerr tools (search_code, file_read,
   file_outline, get_entity, get_imports, recall_facts, mark_intent,
   mark_decision, unerr_remember). The other 12 unlock automatically as
   your call pattern justifies them.

   When a tool unlocks you see: `ur|unl <tool> — <reason>`.
   Use the unlocked tool now, while the signal is fresh.

   Call the tools you need. The gateway will hand you the rest.
   ```

2. **Disambiguate the tag**: today `ur|hnt` covers both co-change hints and unlock notifications. Split into `ur|unl` for unlocks; keep `ur|hnt` for co-change hints. (One-line legend change.)

### Why this matters
- Cuts injected instructions by ~200 lines → smaller system prompt = less context rot.
- Turns each unlock into a discrete moment ("you earned a new tool").
- Aligns the LLM's mental model with how the gateway actually works.

---

## 3. Prompt hook — from generic nudge to keyword + LLM-self skill router

### Current — `src/hooks/prompt-hooks.ts:78-140`

The handler runs a keyword regex on coding verbs (`fix|bug|add|implement|refactor|debug|update|change|modify|create|delete|remove|test|find|search|where|who calls|callers|dependencies|import`). If matched → long tool-roster nudge. If not → short tool-roster nudge.

**Problem:** keyword regex *exists*, but only branches between two nudge volumes. There is no branching by intent into a skill or workflow.

### Research — which intent-classification approach should we use?

We surveyed three families against the production literature:

| Approach | Latency | Accuracy on coding-task intents | Library / pattern | Failure modes |
|---|---|---|---|---|
| **Pure keyword regex** | <1ms | Decent on common verbs; poor on paraphrases ("the auth is breaking" misses "bug") | None needed | Brittle to phrasing; false negatives on indirect language |
| **Embedding-based semantic similarity (kNN)** | ~5–100ms | Best on paraphrases and indirect language | [semantic-router](https://github.com/aurelio-labs/semantic-router) (MIT, Python; no canonical JS port) | Requires an embedding model at runtime; latency budget tight inside a UserPromptSubmit hook |
| **LLM self-classification (skill catalog injected; LLM picks)** | one extra inference (~hundreds of ms) | Best overall — the LLM already understands intent | Superpowers/Anthropic Skills pattern (`SKILL.md` frontmatter `description` is the matcher) | Adds latency to every turn; trusts the LLM |
| **Hybrid (keyword fast path + LLM-self fallback)** | ~1ms fast path; LLM fallback only on cold prompts | Production-standard ([Maxim AI](https://www.getmaxim.ai/articles/top-5-llm-routing-techniques/), [OpenReview lightweight intent classification](https://openreview.net/forum?id=UMuVvvIEvA)) | Custom thin layer | Most complex to maintain |

**What Claude Code itself does:** I read `claude-code-source-code/prompts/10-context-and-prompts.md` and the leaked v2.1.143 system prompt. Claude Code does **not** do explicit intent classification in code. Instead it:
1. Injects a **skill catalog** into the system prompt (`SKILL.md` `description` lines for each available skill — exactly what we see in our own session-reminders today).
2. Lets the **LLM self-classify** which skill applies by reading the descriptions.
3. The skill's `<EXTREMELY-IMPORTANT>` directive enforces invocation: *"if there is even a 1% chance a skill might apply, you MUST invoke it."*

That is the **Anthropic-blessed pattern**: skills are matched by **the LLM, against `description` frontmatter, against the prompt** — no regex, no embeddings, no extra latency beyond the catalog tokens.

### Proposed — hybrid: keyword fast path + LLM-self via skill catalog

We do **both**, because they fail on different cases and reinforce each other:

#### Path A — keyword fast path (no latency)

The existing keyword regex stays, but its *destination* changes. Same regex set; routes to a named sub-skill instead of two nudge volumes:

| Verb cluster                                              | Sub-skill invoked                  |
| --------------------------------------------------------- | ---------------------------------- |
| `bug, broken, failing, crash, error, regression`          | `unerr-systematic-debugging`       |
| `build, create, add (new), implement (new), design`       | `unerr-brainstorming-before-build` |
| `refactor, rename, move, restructure, extract`            | `unerr-dependency-aware-refactor`  |
| `fix (existing), modify, change, update, tweak`           | `unerr-understand-before-modify`   |
| `review, audit, check this PR`                            | `unerr-receiving-code-review`      |
| `test, write tests, TDD`                                  | `unerr-test-driven-development`    |
| `find, search, where, who calls, callers, dependencies`   | `unerr-graph-first-navigation`     |
| `remember, always, from now on, never`                    | `unerr-user-fed-memory`            |
| _(no cluster matched)_                                    | (fall through to Path B)           |

Fast path emits one line:

```
ur|skl unerr-systematic-debugging — this prompt has debug verbs.
       Skill('unerr-systematic-debugging') for the workflow.
```

#### Path B — LLM-self via skill catalog (always-on)

The injected instruction file gets a one-line catalog block — exactly the Anthropic Skills pattern:

```
## Skills available — invoke if even 1% relevant

  - unerr-systematic-debugging       — use for any bug, test failure,
                                       unexpected behavior, before fixes
  - unerr-brainstorming-before-build — use before any new feature,
                                       component, or behavior change
  - unerr-understand-before-modify   — use before editing any existing
                                       function, class, or exported type
  - unerr-dependency-aware-refactor  — use before moving, renaming, or
                                       restructuring code across files
  - unerr-graph-first-navigation     — use when finding callers, callees,
                                       hotspots, or unfamiliar code
  - unerr-test-driven-development    — use when implementing a feature
                                       or bugfix, before writing code
  - unerr-user-fed-memory            — use when the user says remember,
                                       always, from now on, never
  - using-unerr                      — master skill; invoked first
                                       (see §4.5)
```

The LLM matches against descriptions, picks a skill, calls `Skill('unerr-<name>')`. This is exactly how `using-superpowers` routes ([Superpowers](https://github.com/obra/superpowers)).

#### Why both paths

- Path A is the **deterministic fast track** — when the prompt is unambiguous ("fix the bug in X"), no extra inference. Saves a turn of skill-discovery overhead.
- Path B catches **paraphrases** Path A misses ("the build is acting weird" never matches `bug|failing|crash` but reads to the LLM as systematic-debugging territory) — and gives the user's **own skills** a place to live (Path A only knows about ours).
- They compose: when Path A fires, Path B sees the skill is already named and skips re-classification.

#### Constraint to preserve
`feedback_hooks_error_handling.md` — runtime hooks return `passthrough()` on any failure. Path A must fail-open; if classification throws, fall through to Path B's catalog.

### Why this matters

- Keyword classifier is upgraded from "louder/quieter nudge" to "named workflow."
- Adopts the **Anthropic Skills compliance pattern** that already proves itself in `using-superpowers` and every plugin in the Claude Code marketplace.
- User-defined skills compose naturally — they land in the same catalog, the LLM picks among ours + theirs by description.

---

## 4. Skills — from behavior reminders to workflows (Superpowers shape)

### Current — `src/skills/local-pack.ts:33-485`, 17 skills

Each skill is a 5–10-bullet list (e.g., `TOKEN_EFFICIENT_SKILL`, `GRAPH_FIRST_NAVIGATION_SKILL`). The closest to a workflow is `SAFE_MODIFICATION_WORKFLOW_SKILL` with 4 named phases — but no gate enforcement.

### Compare — Superpowers' `systematic-debugging/SKILL.md` (full text fetched)

- **Iron Law** at the top — one sentence the LLM cannot violate ("NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST").
- **Phases** — numbered, each with substeps and concrete tool calls.
- **Red Flags** — anti-rationalization table ("'I know what's wrong' → Skipping Phase 0 = skipping the brief").
- **Process flow** as a DOT graph.
- **Exit state** — names the terminal skill ("invoke writing-plans").

### Proposed shape (every workflow skill)

```
---
name: unerr-<name>
description: <one phrase that the master skill matches on; mirrors
             Anthropic skill catalog conventions>
trigger: keyword | always | agent-requested
---

# <Title>

## Iron Law
<one sentence the LLM cannot violate>

## Phases (each phase names the unerr tool that powers it)
Phase 0 — History
  • unerr_recall_notes({anchors:[...]}) — has anyone hit this before?
  • get_entity → look for ur|hst (prior failure) and ur|wrn (warn)
Phase 1 — Understand
  • get_references — blast radius
  • get_conventions — local style
  • file_read with purpose:'explore' — auto-injected facts
Phase 2 — Plan
  • Describe change plan to user if blast radius > 5
Phase 3 — Execute
Phase 4 — Verify

## Red Flags (anti-rationalizations)
| Thought                         | Reality                              |
| "I know what's wrong"           | Skipping Phase 0 = skipping the brief|
| "Quick patch — I'll come back"  | Symptom fixes are failure            |

## Exit
<invoke next skill / verify-after-completion / return control>
```

### Top 6 skills to (re)write — first wave

| Existing (`local-pack.ts`)                          | Action                | New name                              |
| --------------------------------------------------- | --------------------- | ------------------------------------- |
| `SAFE_MODIFICATION_WORKFLOW_SKILL`                  | Rewrite as workflow   | `unerr-understand-before-modify`      |
| `DEPENDENCY_AWARE_REFACTOR_SKILL`                   | Rewrite as workflow   | `unerr-dependency-aware-refactor`     |
| `ARCHITECTURE_EXPLORATION_SKILL`                    | Rewrite as workflow   | `unerr-architecture-exploration`      |
| _(new)_                                             | New workflow          | `unerr-systematic-debugging`          |
| _(new)_                                             | New workflow          | `unerr-brainstorming-before-build`    |
| _(new)_                                             | New workflow          | `unerr-test-driven-development`       |
| `TOKEN_EFFICIENT_SKILL`                             | Keep as behavior      | unchanged                             |
| `TIMELINE_MARKERS_SKILL`, `TURN_DISCIPLINE_SKILL`   | Keep as behavior      | unchanged                             |
| `USER_FED_MEMORY_SKILL`                             | Keep as behavior      | unchanged                             |

### Our differentiator vs. Superpowers

Each workflow phase names the **unerr graph tool** that powers it (Phase 0 — unerr_recall_notes; Phase 1 — get_references + get_conventions; etc.). Superpowers has no graph layer ([their skills don't reference any code-intel tools](https://github.com/obra/superpowers/tree/main/skills)) — they only orchestrate process. We orchestrate process **and** evidence-gathering through the graph. That's the moat.

### 4.5 — The master skill `using-unerr`

**Why:** Superpowers won the Claude Code skills space by adding **one** thing — a master skill (`using-superpowers`) that runs at session start, reads the user's request, and dispatches to the right sub-skill. As of May 2026 the project has 177k+ GitHub stars largely because of this one dispatcher pattern ([popularaitools.ai](https://popularaitools.ai/blog/superpowers-plugin-10x-claude-code-2026), [mejba.me review](https://www.mejba.me/blog/superpowers-plugin-claude-code-review)). It eliminates the "just start coding" failure mode by forcing a process-skill dispatch on every prompt.

We need this. Proposal: a new SKILL.md `using-unerr` that:

```
---
name: using-unerr
description: Use FIRST on every prompt. Reads the prompt and dispatches
             to the right unerr sub-skill. Composes with user-defined
             skills. Required before any code action.
trigger: always
---

<EXTREMELY-IMPORTANT>
If there is even a 1% chance a sub-skill applies to this prompt, you
MUST invoke it via Skill() before acting. Coding tasks (implement /
fix / refactor / build / debug) ALWAYS have a matching skill.
</EXTREMELY-IMPORTANT>

# Using unerr

## Dispatch (read in order, invoke the FIRST matching skill)

1. If the prompt asks to **debug, diagnose, or root-cause** something
   → Skill('unerr-systematic-debugging').
2. If it asks to **design or build something new** (feature, page,
   component, schema, behavior change) → Skill('unerr-brainstorming-before-build').
3. If it asks to **refactor, rename, move, restructure** existing code
   → Skill('unerr-dependency-aware-refactor').
4. If it asks to **modify, fix, change, update** existing code
   → Skill('unerr-understand-before-modify').
5. If it asks to **write tests** or follow TDD
   → Skill('unerr-test-driven-development').
6. If it asks to **find, search, navigate, trace callers**
   → Skill('unerr-graph-first-navigation').
7. If the user said **"remember", "always", "from now on", "never"**
   → Skill('unerr-user-fed-memory').
8. If no unerr sub-skill matches BUT a **user-defined skill** in the
   catalog matches → invoke that one. Our sub-skills never block the
   user's own.
9. If nothing matches → proceed with default behavior.

## Composition with user-defined skills

The user may install their own skills alongside unerr's. Treat them as
peers:
  - User skills override unerr sub-skills when both match — the user
    is in control. (Same priority rule Superpowers documents:
    user instructions > skills > default system prompt.)
  - When two unerr sub-skills could apply, invoke the one named EARLIEST
    in the dispatch list above (process skills first, navigation last).

## Before you draft

Every non-trivial turn begins with:
  1. unerr_recall_notes({prompt: '<verbatim user prompt>'})
  2. The matched skill's Phase 0 (History).
  3. Then everything else.
```

This is the **dispatcher** — and it's what the user explicitly asked for ("a main skill that will help us use the sub skills when needed; users can use their own skills along with our skill set").

---

## 5. Impact-surfacing — the three execution-trace surfaces (Surfaces 2, 3, 4)

This is the change that delivers the user-visible wow factor every turn.

### Grounding — the four-surface model already exists

`unerr-web-landing/docs/open-cli/PERCEPTION_TO_PRESENCE.md` defines four surfaces:

| # | Surface | Where | In scope for this doc? |
|---|---------|-------|------------------------|
| 1 | Dashboard archive (Logbook / Session Economy / Sidekick Memory) | browser at `localhost:9847/` | **Out of scope** — user excluded UI |
| 2 | Start-of-turn context preface | first line of first response of each turn, inside `content[].text` | **In scope** |
| 3 | End-of-turn session-economy footer | last line of final response of each turn, inside `content[].text` | **In scope** |
| 4 | Named-sidekick persistence (4 sub-surfaces — attribution, capture, ambiguity, enforcement) | inside `content[].text`, on plan/decision turns | **In scope** |

We adopt Surfaces 2, 3, 4. Surface 1 (UI) is governed by `PERCEPTION_TO_PRESENCE.md` itself.

### Cross-cutting rule — jargon-free, transformed, not raw

The user's directive: *"every information LLM receives from unerr doesn't need surfacing in its exact form; it could be transformed or trimmed down into easy-to-understand info."*

Translation rules applied to **every line surfaced to the user**:

| Raw (LLM-facing)                                       | Transformed (user-facing) |
| ------------------------------------------------------ | ------------------------- |
| `ur|fct [user_fed] mcp-config-project-only loaded from anchor p:` | `unerr · I remembered: you've said "MCP config is project-level only" — I'm not touching ~/.cursor.` |
| `ur|rsk fan_in=24 fan_out=3 (high blast radius)`       | `unerr · this function is called from 24 places — I'll list them before changing it.` |
| `ur|dft modified on main by intent-abc since last seen` | `unerr · this file changed since your last session — I'm re-reading it before editing.` |
| `ur|unl get_critical_nodes unlocked — fan-in spike detected` | `unerr · I unlocked a hotspot finder for this session — using it now to spot what depends on this code.` |
| `unerr_recall_notes returned 2 notes anchored to f:src/proxy/proxy.ts` | `unerr · I found 2 rules you wrote about this file in earlier sessions — applying them.` |

The user reads any of these and goes "ohh!! unerr helped here." Zero technical jargon. Zero `ur|<tag>` exposure. Zero anchor wire format.

The `ur|<tag>` lines stay in the response body for the **LLM** to act on. The `unerr · …` lines are the **user-channel** equivalent — same information, natural language.

### Surface 2 — Start-of-turn context preface (the "brief")

**Where:** prepended to the first response of every turn.

**Today:** nothing. The UserPromptSubmit hook injects the generic tool-roster nudge into the LLM's context, which the user never sees.

**Proposed (jargon-free, max 5 lines):**

```
unerr · brief for this prompt
        2 rules from earlier sessions apply here
        1 file in scope changed since you last looked at it
        I'm using the "fix existing code" workflow — graph context
          before any edits
```

The same information, in raw form, is **also** injected into the LLM context (so it actually acts on it). The user only sees the transformed prose; the LLM sees both.

**Honest-zero (per PERCEPTION_TO_PRESENCE §8):** when there's nothing to load, the line reads `unerr · brief: no prior context applies — fresh start.` Never blank.

### Surface 3 — End-of-turn session-economy footer (the "debrief")

**Where:** appended to the final response of every turn.

**Today:** an `unerr · this turn: helped N times (...) · saved ~X tokens · ~Y extra turns of room added` line is emitted on **tool responses** inside the bridge — but it's at the bottom of a tool result block, often invisible to the user.

**Proposed (jargon-free, max 4 lines):**

```
unerr · this turn
        caught 1 stale file before you edited it; re-read it for you
        used 6 graph lookups instead of full file reads (~14k tokens
          saved → about 5 extra turns of headroom this session)
        learned 1 new rule: don't import intelligence in bridge.ts
          (I'll remind you next time you touch that file)
```

This is the **proof-of-value the user feels**. Three lines, each a distinct kind of value:
1. **Catches** — what disasters did unerr prevent?
2. **Savings** — what work did it skip (translated into "extra turns of headroom," never raw tokens — per `PERCEPTION_TO_PRESENCE.md`: *"+5 turns of headroom this session" beats "4.2k tokens saved" in the feeling contest*).
3. **Learning** — what did it just store for next time?

**Ambient-marker collapse (per `src/proxy/ambient-marker.ts`):** after 3 consecutive zero-value turns, footer collapses to `unerr · ⋯` until the next turn produces a real catch. No banner blindness.

### Surface 4 — Named-sidekick persistence (the four sub-surfaces)

**Where:** inside `content[].text` on plan/decision/capture-shaped turns.

| Sub-surface | When it fires | What the user sees |
|---|---|---|
| **4a Attribution panel** | LLM produces a plan or decision | `unerr · this plan drew on: your rule "MCP config is project-level only", your decision from last week to gate router-tier-3, and 6 conventions auto-detected from the codebase.` |
| **4b User-fed capture** | User says "remember X", "from now on Y", "always Z" | `unerr · stored: "MCP config is project-level only" — I'll enforce this silently. Edit / disable on the Sidekick Memory page.` |
| **4c Ambiguity confirmation** | A capture lands at 0.5 ≤ confidence < 0.7 | `unerr · please confirm: "MCP config is project-level only" — should I remember this? Yes / clarify / no.` |
| **4d Enforcement loop** | LLM touches a file with a stored rule | `unerr · reminder while we're in src/proxy/proxy.ts: you've said "don't import intelligence here" — keeping that.` |

All four exist as concepts in `PERCEPTION_TO_PRESENCE.md`; we adopt them verbatim. Our job is to make sure they're rendered as `unerr · …` user-prose on every applicable turn, not buried in MCP response telemetry.

### How the three surfaces feel together (one-turn walkthrough)

User types: *"refactor `dispatchToolCall` to use the new gateway"*

**Surface 2 (start of turn) — what unerr loads for the user before the LLM drafts:**
```
unerr · brief for this prompt
        I found 3 rules you wrote about the router gateway in earlier
          sessions — applying them
        `dispatchToolCall` is called from 17 places — high blast radius;
          I'll list them before changing
        Using the "refactor across files" workflow — dependency chain
          before any rename
```

**Surface 4a (mid-turn, when the LLM produces the plan):**
```
unerr · this plan drew on: your rule "gate before dispatch, record
        after" (May 12), the cross-boundary check I ran on the gateway,
        and 17 call sites I tracked through the graph
```

**Surface 3 (end of turn) — what unerr did, in dollars and cents:**
```
unerr · this turn
        prevented 1 broken edit by surfacing 17 callers before the
          refactor went out
        used the graph instead of grepping 240 files (~18k tokens
          saved → about 6 extra turns of headroom this session)
        nothing new to learn this turn
```

The user scrolls and sees, in plain English, three discrete moments where unerr earned its place. No technical jargon. No `ur|<tag>`. No anchor wire format. Exactly the "ohh!! unerr helped here" reaction the user described.

### Where these surfaces live in the code (sketch, not implementation)

| Surface | Assembly point | Source data |
|---------|---------------|-------------|
| 2 (brief) | `src/hooks/prompt-hooks.ts` UserPromptSubmit, into context **and** as a `unerr · …` line in the LLM's first response | `unerr_recall_notes`, `recall_facts`, `topic-shift`, skill router from §3, current tier-exposure state |
| 3 (debrief) | `src/proxy/turn-footer.ts` + `src/proxy/ambient-marker.ts` (already exist for tool-response footers) | `EfficiencyTracker.getSnapshot()` (`src/proxy/efficiency-tracker.ts:16`), 7 mechanism rows in `metrics.db`, the per-turn `behavior_events` rows |
| 4a (attribution) | `attribution-panel.ts` renderer (per PERCEPTION_TO_PRESENCE §11 Phase 3) | `recall_facts`, `unerr_recall_notes` results from the turn |
| 4b (capture) | `unerr_remember` tool response | tool input |
| 4c (ambiguity) | next-turn Surface 2 preface | `confidence` field from `unerr_remember` |
| 4d (enforcement) | inline `ur|fct …` line + user-channel `unerr · reminder …` line on file-touching responses | `temporal_facts` table |

### Constraints to preserve
- `_meta/_context fields removed` (project memory) — brief + footer go inline in the response body as `ur|<tag>` (LLM) and `unerr · …` (user) lines. No `_meta` regrowth.
- `feedback_additive_metrics.md` — these are additive on top of the existing telemetry/dashboard.
- The `unerr · …` lines must remain "user-prose, LLM ignores" (the CLAUDE.md rule about middle-dot prefix vs vertical-bar). LLM acts on `ur|<tag>`; user reads `unerr · …`. Same data, two channels.

### Why this matters

- **First-turn aha:** the brief on turn 1 says "I found 3 rules you wrote in earlier sessions; applying them." That's the moment. Cline Memory Bank, Aider RepoMap, and mem0 all win on exactly this ([Cline Memory Bank docs](https://docs.cline.bot/prompting/cline-memory-bank), [mem0 State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)).
- **Every-turn aha:** the footer shows catches + savings (in "turns of headroom," not raw tokens) + learnings. Felt value, every turn.
- **Symmetric to the senior-engineer mental model:** the senior briefs you before, debriefs you after.
- **Jargon-free, exactly as the user asked:** transformed copy, not raw signals.

---

## Sequencing & dependencies

| Step | Change                                                            | Depends on                 | Lines (approx) |
| ---- | ----------------------------------------------------------------- | -------------------------- | -------------- |
| 1    | Identity reframe — Draft D into `instruction-writer.ts` (§1)      | —                          | ~25            |
| 2    | Router surfacing — tier paragraph + `ur|unl` split (§2)           | §1 (same file)             | ~40 net-negative |
| 3    | Master skill `using-unerr` SKILL.md (§4.5)                        | §4 (sub-skills must exist) | ~80            |
| 4    | Top-6 skills rewrite — workflow shape (§4)                        | §1 (identity vocabulary)   | ~700           |
| 5    | Prompt-hook → keyword-fast-path + catalog (§3 Path A + Path B)    | §3 (skills), §4.5 (master) | ~120           |
| 6    | Impact sandwich — Surfaces 2, 3, 4 with jargon-free transforms (§5) | §3 (hook), §4 (skills)   | ~250 + 150     |

Ship 1+2 together (same file). 3+4 together (master needs sub-skills). 5 after them. 6 last (assembles all of the above into one user-visible surface).

---

## Resolved decisions

| # | Decision | Choice | Implication |
| --- | --- | --- | --- |
| 1 | Identity prose | **Draft D** (Anthropic house style) | Drafts A/B/C dropped. Draft D becomes the new opening of every agent's instruction file (CLAUDE.md, AGENTS.md, .cursor/rules/unerr-instructions.mdc, etc.) — see T1.1. |
| 2 | Intent-classification path | **Keep both** Path A (keyword fast) and Path B (catalog + LLM-self) | Path A handles unambiguous coding verbs in <1 ms. Path B fires on every prompt as a parallel signal — the LLM self-classifies against the skill catalog. See T3.1, T3.2. |
| 3 | Skill-router fallback | **Default omni skill** (`using-unerr` master skill) — the user said "either (b) silent OR a default omni skill that explains the default best-to-use workflow". The omni skill is the stronger option because it teaches the workflow on every unmatched prompt instead of going quiet. | When neither Path A keywords nor Path B catalog match, the master `using-unerr` skill body runs as the default — it carries the "default best workflow" the user described. See T4.2, T3.3. |
| 4 | `unerr · …` rendering channel | **(b) Inject into the assistant's response body** | Cannot literally splice into LLM tokens, so this is implemented as an **instruction in the master skill**: the LLM is told to emit a one-line `unerr · context: …` preface at the start of its first response and a one-line `unerr · this turn: …` footer at the end. Tool-block lines stay for IDEs that show them, but the assistant-body line is the load-bearing surface. See T5.1, T5.2. |
| 5 | Doc location | **Stay here for now**, use this doc as the triage tracker until every row in §"Implementation tracker" is `done + verified`. Then move under `docs/proposals/`. | All status updates land in this file; no separate tracker. See §"Implementation tracker" below. |

---

## Implementation tracker

This is the single source of truth for the redesign. Every code change is one row. Status legend:

- `pending` — not started.
- `in_progress` — actively being worked on.
- `done` — code change landed.
- `verified` — code change landed **and** manually verified per the "Verify" column.

A task is closed only when status = `verified`. Hold this bar — `done` is not the finish line.

**Recommended order:** §1 → §2 (same file, ship together) → §4 (master + sub-skills, ship together) → §3 (hook needs skills to dispatch to) → §5 (surfaces assemble §3 + §4 output). Verification block (V1–V6) runs last after every section is `done`.

### §1 Identity reframe (Draft D into instruction-writer)

| ID | Subject | File(s) | Status | Verify |
| --- | --- | --- | --- | --- |
| T1.1 | Replace heading + intro (first ~6 lines of injected section) with Draft D prose ("## unerr — operational memory for this codebase" + memory/codebase framing). | `src/config/instruction-writer.ts` (~L63) | pending | After `unerr install claude-code`, CLAUDE.md's `<!-- unerr:start -->` block opens with the Draft D heading verbatim. |
| T1.2 | Strip the 200+ lines of per-tool routing tables and replace with the "five-channel" paragraph from Draft D (signals · hints · anchored notes · recall hits · skills). | `src/config/instruction-writer.ts` | pending | Injected CLAUDE.md section drops from ~270 lines to ~80 lines (rough target — measure with `wc -l`). |
| T1.3 | Mirror Draft D into the Cursor `.mdc` generation path (same content, mdc frontmatter wrapper). | `src/config/instruction-writer.ts` (Cursor variant) | pending | `unerr install cursor` writes `.cursor/rules/unerr-instructions.mdc` whose body matches the CLAUDE.md injected block. |
| T1.4 | Mirror Draft D into AGENTS.md / GEMINI.md / `.github/copilot-instructions.md` / `.clinerules`. | `src/config/instruction-writer.ts` (per-agent map) | pending | Each of the supported agents (`unerr install <agent>`) writes a Draft-D-aligned section. |
| T1.5 | Update repo `CLAUDE.md` (this project's own) to use Draft D framing for consistency. | `CLAUDE.md` (repo root) | pending | Repo CLAUDE.md opens with the operational-memory frame, not "graph-backed code-intelligence proxy". |
| T1.6 | Update README tagline + first paragraph from "graph-backed code-intelligence proxy" to operational-memory framing. (Was originally out-of-scope; promoted because Draft D and README must agree, otherwise install messaging contradicts marketing.) | `README.md` | pending | README opening paragraph aligns with Draft D wording. |

### §2 Router surfacing (`RouterGateway` + tier disclosure)

| ID | Subject | File(s) | Status | Verify |
| --- | --- | --- | --- | --- |
| T2.1 | Add a "Progressive tier disclosure" paragraph to the Draft D injected section explaining Tier-1 (9 tools, always available), Tier-2 (7 unlock on signals), Tier-3 (6 unlock on session maturity). | `src/config/instruction-writer.ts` | pending | Injected CLAUDE.md mentions the three tiers by name and tool counts. |
| T2.2 | Add `unl` (unlock) row to `SIGNAL_PREFIX_LEGEND`. Legend agrees with emission. | `src/proxy/response-envelope.ts` | pending | `SIGNAL_PREFIX_LEGEND.unl` defined; matches the table row in CLAUDE.md (T2.4). |
| T2.3 | `RouterGateway.recordAndUnlock()` emits `ur\|unl <tool> unlocked by <signal>` lines when a tier-locked tool unlocks. | `src/proxy/router-gateway.ts` (~L161) | pending | Synthetic signal in a unit test produces a tool response containing `ur\|unl …`. |
| T2.4 | Add `unl` row to the `ur\|<tag>` table inside the Draft D injected section. | `src/config/instruction-writer.ts` | pending | Injected CLAUDE.md contains an `unl` row in the prefix table. |
| T2.5 | Audit existing `ur\|hnt` emissions for ones that semantically mean "unlock" and migrate them to `ur\|unl`. | `src/proxy/router-gateway.ts`, `src/intelligence/query-router.ts` | pending | `grep -r "ur\|hnt"` shows only co-change / hint usages, not unlock usages. |

### §3 Prompt hook (hybrid classifier)

| ID | Subject | File(s) | Status | Verify |
| --- | --- | --- | --- | --- |
| T3.1 | Refine Path A keyword regex — add Claude Code's `replace`, `rename`, `revert`, `optimize`, `cleanup`, `extract`, `inline`, etc. (cross-referenced from leaked Claude Code system prompt). | `src/hooks/prompt-hooks.ts` (~L88) | pending | Prompts `replace X with Y`, `extract function Z`, `optimize the loop` all hit Path A. |
| T3.2 | Path B — inject the skill catalog (frontmatter `description` lines from every installed SKILL.md) into prompt-hook output as `available skills:` bullets. | `src/hooks/prompt-hooks.ts` | pending | Hook output contains `available skills:` block listing all skill descriptions one per line. |
| T3.3 | Skill-router fallback — when neither Path A regex nor Path B catalog matches, emit a one-line "using `using-unerr` (default workflow)" pointer so the master skill becomes the omni fallback. | `src/hooks/prompt-hooks.ts` | pending | Prompt `tell me about this repo` (read-only, no coding verb, no skill catalog match) → hook output contains `using using-unerr (default workflow)`. |
| T3.4 | Cross-session intent stitching — surface the prior session's last `mark_intent` + any unresolved `mark_blocker` in the next session's first hook output. | `src/hooks/prompt-hooks.ts` + `src/tracking/intent-ledger.ts` | pending | After a session with `mark_intent("foo")` and `mark_blocker("bar")`, restarting the agent → first hook output contains both. |

### §4 Skills (workflows + master orchestrator)

| ID | Subject | File(s) | Status | Verify |
| --- | --- | --- | --- | --- |
| T4.1 | Rewrite the top-6 skills (`safe-modification`, `intent-tracking`, `pre-edit-recon`, `drift-aware-edit`, `blast-radius-check`, `convention-discovery`) into Iron Law / Phases / Red Flags shape (Superpowers structure). | `src/skills/local-pack.ts` | pending | Each of the 6 SKILL.md files written by install has the 3 named sections in that order. |
| T4.2 | Create the master `using-unerr` SKILL.md with `<EXTREMELY-IMPORTANT>` directive, dispatch list (which sub-skill for which intent), and the **default workflow** body (used as the omni fallback per decision #3). | `src/skills/local-pack.ts` (new entry) or `src/skills/using-unerr.ts` | pending | `.claude/skills/using-unerr/SKILL.md` written by `unerr install`; contains `<EXTREMELY-IMPORTANT>` block + dispatch table + default-workflow Iron Law. |
| T4.3 | Ensure install never overwrites user-defined skills. User skills compose alongside unerr's. Idempotency contract: re-run only updates files unerr itself wrote. | `src/config/instruction-writer.ts` or skill-install path | pending | Put `.claude/skills/my-team-skill/SKILL.md` in a test repo, run `unerr install` twice, verify `my-team-skill` untouched and `using-unerr` updated only if content changed. |
| T4.4 | Master skill body includes explicit instructions for Surface 2 (start preface) and Surface 3 (end footer) — this is how decision #4 (assistant-body rendering) is implemented. | master skill body (file from T4.2) | pending | `using-unerr` SKILL.md body contains "First response in a session: open with `unerr · context: …` summarizing what unerr loaded." and "Every assistant turn: end with `unerr · this turn: …` summarizing what unerr caught." in plain English. |
| T4.5 | Master skill body composes with user skills — explicit "if the user defines their own SKILL.md, dispatch to it before falling back to `using-unerr`'s default workflow". | master skill body | pending | `using-unerr` SKILL.md body has a "user-defined skills run first" clause. |

### §5 Impact surfacing (Surfaces 2, 3, 4 — execution-trace channels)

Surfaces 2 and 3 land via the master skill's instructions (T4.4). Surface 4 is the existing capture / ambiguity / enforcement plumbing — these rows audit and reinforce it.

| ID | Subject | File(s) | Status | Verify |
| --- | --- | --- | --- | --- |
| T5.1 | Surface 2 — start-of-turn preface emitted by LLM per T4.4. Jargon-free wording: `unerr · context: 3 stored facts loaded, 1 file cached`. | master skill body (T4.4) | pending | First response in a fresh session with stored facts opens with `unerr · context: …`. |
| T5.2 | Surface 3 — end-of-turn footer emitted by LLM per T4.4. Jargon-free wording: `unerr · this turn: 2 catches (1 stale edit, 1 cascade) · ≈ 4.2k tokens saved`. | master skill body (T4.4) | pending | Last line of every assistant turn (after a coding action) is `unerr · this turn: …`. |
| T5.3 | Surface 4a (attribution) — when unerr fed a fact that shaped the answer, the LLM says it in plain English ("unerr reminded me you'd asked to X"). | master skill body | pending | Turn where `recall_facts` returned a load-bearing fact contains an attribution phrase like the one above. |
| T5.4 | Surface 4b (capture confirmation) — after `unerr_remember`, LLM emits "added that to unerr for next time". This is already half-wired in the agent instructions; verify it survives the rewrite. | master skill body + capture path | pending | User says "remember X always", LLM calls `unerr_remember`, next assistant line includes "added that to unerr for next time". |
| T5.5 | Surface 4c (ambiguity) — when `unerr_remember` returns `please confirm`, LLM asks the user verbatim: "should I remember: '<quote>'? (yes/no)". Already in current CLAUDE.md; verify it's preserved in Draft D rewrite. | `src/config/instruction-writer.ts` (Draft D body) | pending | Low-confidence capture (0.5 ≤ conf < 0.7) → next assistant turn contains the verbatim yes/no question. |
| T5.6 | Surface 4d (enforcement) — explicit rule in master skill: "if the user says 'always', 'from now on', 'remember', call `unerr_remember` with verbatim `source_quote` and your `confidence`". | master skill body | pending | Rule present; manual test prompt `from now on always X` triggers `unerr_remember` call in tool transcript. |
| T5.7 | Codify the jargon-free transformation rules (raw `ur\|<tag>` → user-prose) in a single translator module so future signals follow the same discipline. | new `src/proxy/user-prose-translator.ts` (or extend `src/proxy/ambient-marker.ts`) | pending | Unit test asserts every `ur\|<tag>` from `SIGNAL_PREFIX_LEGEND` has a plain-English mapping that contains no internal jargon (`ur\|`, `<tag>`, `_meta`, `fan_in`, etc.). |
| T5.8 | Ambient marker integration — keep current "collapse to `unerr · ⋯` after 3 zero-content turns" behavior; ensure it does NOT swallow Surface 2/3 lines. | `src/proxy/ambient-marker.ts` | pending | 3 zero-content tool calls → 4th turn emits `unerr · ⋯`; a turn with a real Surface 3 footer is not collapsed. |

### Verification (cross-cutting — run last)

| ID | Subject | Command / action | Status |
| --- | --- | --- | --- |
| V1 | Full test suite clean. | `pnpm run test:run` (NOT `pnpm test` — that's watch mode; see `feedback_full_test_suite.md`). | pending |
| V2 | Lint clean. | `pnpm run lint` | pending |
| V3 | Typecheck clean. | `pnpm run typecheck` | pending |
| V4 | Build clean. | `pnpm run build` | pending |
| V5 | Fresh-repo install dry-run. | In a temp repo: `unerr install claude-code` → inspect `.claude/skills/using-unerr/SKILL.md` exists, `CLAUDE.md` opens with Draft D, no `21 MCP tools` heading anywhere. | pending |
| V6 | Live MCP turn. | In Claude Code attached to the temp repo, run a coding prompt → assistant response opens with `unerr · context: …`, ends with `unerr · this turn: …`. | pending |
| V7 | Ambient-marker regression. | Three zero-content turns in the temp repo → 4th turn carries `unerr · ⋯`. | pending |
| V8 | User-skill composition. | Add a custom `.claude/skills/my-team-skill/SKILL.md`, re-run install, verify file untouched and that `using-unerr` correctly defers to it on dispatch. | pending |

### §6 Cross-agent compatibility (research; runs last)

We support 7 agents today (Claude Code, Cursor, Codex, Gemini CLI, VS Code Copilot, Cline, GitHub Copilot CLI). Each has its own instruction-file format and its own skill semantics. We need to confirm — not assume — that the redesign holds across all of them, and document the per-agent caveats.

| ID | Subject | File(s) / Surface | Status | Verify |
| --- | --- | --- | --- | --- |
| T6.1 | Research cross-agent compatibility of identity / skill / surface changes. Confirm each agent supports the SKILL.md frontmatter pattern (or graceful degradation if not), the `unerr · …` assistant-body channel surfaces correctly, hook output is consumed (prompt-submit semantics vary), and Draft D heading renders consistently. Document per-agent caveats and any agent-specific adaptations needed. | research output: new section in this doc or `docs/cross-agent-compat.md` | pending | Produce a per-agent compatibility matrix (one row per agent: SKILL.md support? · assistant-body rendering? · hook input format? · Draft D heading rendering?). If any agent lacks SKILL.md support, propose a fallback (inline skill-equivalent content in that agent's CLAUDE.md-analogue). |

### How to update this tracker

- Flip a row's `status` from `pending` → `in_progress` when you start work, → `done` when the code lands, → `verified` after running the "Verify" column.
- Add new rows here when a sub-task surfaces during implementation (don't open a separate doc).
- When every row is `verified`, move this file under `docs/proposals/` per decision #5 and close out.

---

## Implementation update — 2026-05-23

Post-restart audit (session `0e248201-…`, 894 assistant turns) revealed that
**none of the v3 surfaces, four-moment contract, or end-of-turn receipt were
firing reliably** despite the implementation tracker showing rows as done.
Grounded RCA (cited in `.unerr/ledger/shadow.jsonl` markers, session JSONL
parse, Anthropic Skills docs, Superpowers comparison) identified three load-
bearing gaps and the levers below shipped against each.

### Lever A — Close the legend gap for `ur|skl` / `ur|act`

**Problem:** The hook emitted `ur|skl unerr-using-unerr — Invoke Skill(…)` 15
times in one session and `Skill()` was called zero times. Root cause: the
agent-facing `ur|<tag>` legend in `CLAUDE.md` (and the matching
`SIGNAL_PREFIX_LEGEND` constant in `src/proxy/response-envelope.ts`) did not
bind `skl` or `act` — both tags were silently dropped as "unrecognised
ambient text" because the contract *"act on them before consuming the rest
of the response"* only covers tags in the legend table.

**Files changed:**
- `CLAUDE.md` — added `skl` and `act` rows to the legend table.
- `.cursor/rules/unerr-instructions.mdc` — mirrored for Cursor.
- `src/proxy/response-envelope.ts` — added `skl` + `act` to
  `SIGNAL_PREFIX_LEGEND` so the agent instruction file is consistent with the
  emission constant.
- `src/proxy/user-prose-translator.ts` — added `skl` + `act` to the
  `SignalTag` union and the `KNOWN_SIGNAL_TAGS` array; both translate to
  `null` (agent-facing only — never surface to the user as `unerr · …`
  prose).

### Lever B — Strengthen the master-skill description + bundle pipeline

**Problem:** The `unerr-using-unerr` SKILL.md frontmatter was a noun phrase
(*"Master orchestrator skill…"*) — Anthropic's Skills docs are explicit that
auto-invocation is **description-driven**. Superpowers' equivalent
(`using-superpowers`) uses a verb clause: *"Use when starting any
conversation — establishes how to find and use skills, requiring Skill tool
invocation before ANY response including clarifying questions."* The
`<EXTREMELY-IMPORTANT>` 1%-rule directive lived inside the body and was
unreadable until after invocation.

**Files changed:**
- `.claude/skills/unerr-using-unerr/SKILL.md` — frontmatter rewritten to a
  Superpowers-shape *"Use when starting ANY non-trivial coding task… If you
  think there is even a 1% chance this skill applies, you MUST invoke it via
  `Skill('unerr-using-unerr')`…"* description. Added `name:`,
  `when_to_use:`, and `allowed-tools:` fields.
- `src/skills/local-pack.ts` — `USING_UNERR_SKILL` description updated to
  match; added optional `whenToUse` and `allowedTools` fields to
  `SkillDefinition` and threaded them through `BUNDLED_SKILLS`.
- `src/schemas/api/skills.ts` — added optional `whenToUse` and
  `allowedTools` to `SkillSchema` so the install pipeline carries the new
  fields through validation.
- `src/skills/resolver.ts` — `formatClaudeCodeSkill` now emits `name:` (the
  on-disk directory name), `when_to_use:`, and `allowed-tools:` frontmatter
  fields when set. Added `escapeFrontmatter` helper for quote-safe rendering.

The net effect: every fresh `unerr install claude-code` writes the
Superpowers-shape frontmatter, so the change propagates to all repos — not
just this one.

### Lever C — Force-inject Surface 2 + Moment 1 via hook `ur|act` lines

**Problem:** Even with Levers A and B, Surface 2 (the context preface) and
Moment 1 (the prompt-receipt `unerr_recall_notes` call) lived ONLY in the
master-skill body. With the master skill never invoked in earlier sessions,
both contracts had no surviving delivery channel. The hook injected only
`mark_intent` + `unerr_turn_summary` `ur|act` lines.

**Files changed:**
- `src/hooks/prompt-hooks.ts` — added `buildMoment1Line` (every coding-task
  prompt, `ur|act` directing `unerr_recall_notes({prompt:'<verbatim>'})`) and
  `buildSurface2Line` (one-shot per session, `ur|act` directing the agent to
  open its first user-facing response with a `unerr · context: …` line).
  Both wired into the prompt-assembler ahead of `mark_intent`.
- `src/proxy/nudge-state.ts` — extended `NudgeSessionState` with
  `surface2_emitted` (one-shot flag) and `moment1_emitted_count` (telemetry).

### Richer close-out receipt (Task #61)

Per user feedback that token savings are one slice and the bigger picture is
"where unerr helped" (skills used, data used, reasoning improvement):

**Files changed:**
- `src/proxy/turn-footer.ts` — `renderSessionEconomyLine` now optionally
  takes `events: NamedEvent[]` and appends a token-cheap "via N <plural>, M
  <plural>, K <plural>" segment (top 3 categories by count, drawn from the
  `getPhrasing` table — e.g., "12 code lookups, 8 compact reads, 4 remembered
  notes"). New `topHighlightsPhrase` helper exported.
- `src/proxy/turn-summary-handler.ts` — `TurnSummaryResult` carries a new
  `highlights: Array<{event_type, count, phrasing}>` field so UI clients and
  agents can render their own framing without re-parsing the prose line.

### New dispatch-target skills (Task #63)

The hook's `VERB_CLUSTERS` and `USING_UNERR_SKILL` dispatch table referenced
four skill ids that did not exist on disk — `Skill()` would fail. Added them
to `src/skills/local-pack.ts` following the Iron-Law / Phases / Red Flags
shape:

- `SYSTEMATIC_DEBUGGING_SKILL` — reproduce → isolate → root-cause → fix.
- `BRAINSTORMING_BEFORE_BUILD_SKILL` — recall → survey → conventions →
  shape → confirm → build.
- `RECEIVING_CODE_REVIEW_SKILL` — parse → ACCEPT / PUSHBACK / CLARIFY for
  every comment, never silently drop.
- `TEST_DRIVEN_DEVELOPMENT_SKILL` — RED → GREEN → REFACTOR with explicit
  failure-confirmation between phases.

Each emits `name:` + `when_to_use:` frontmatter via the resolver pipeline.

### Token-savings authenticity finding (Task #61, audit slice)

Audit of `metrics.db / token_flow_events` confirmed the calculation is
correct, but two mechanisms are **under-recording on this repo's active
session**:

- Global stats: 27.5M tokens saved across 11,640 events / 202 sessions.
  Mean ≈ 136K tokens saved/session.
- Active session: 27 events / 1,250 tokens. The lucrative mechanisms
  (`file_read` avg 9,070 tokens/event globally; `graph_query` avg 2,291)
  recorded **zero events** here despite the agent making ~9
  `mcp__unerr__file_read` and ~14 `search_code`/`get_references` calls.
- Likely root cause: `file_read` mechanism gate requires
  `result._layer6_meta.total_lines` to be set; `graph_query` is a
  behavior-event (`graph_query_served`), not a token-flow event with
  tokens_saved. Both should be revisited as a follow-up tracking-gap fix.

This is now a tracked follow-up — see the consolidation audit doc.

### Pending follow-ups

- **Skill consolidation** (27 → 7) — full audit at
  `docs/skill-consolidation-audit.md`. Three OSS systems converge on
  "one skill per workflow phase + dispatcher". Awaiting user review before
  the merge lands.
- **Token-flow tracking gap** — `file_read` mechanism is under-recording on
  small-file reads; `graph_query` mechanism is a behavior event not a
  token-flow event, so it never appears in `total_tokens_saved`. Fix path:
  either credit `graph_query_served` events with a measured savings number
  or split the receipt to count behavior + token-flow events distinctly.

---

## Out of scope for this doc (parked, not forgotten)

- Deeper temporal-query MCP tools (e.g., a literal "what happened to this file last week" query) — deferred per `project_persistent_context.md` (temporal branch view deferred).
- Renaming the project tagline — README still says *"graph-backed code-intelligence proxy"*. If Draft D is adopted, README needs the new framing. Tracked as a follow-up, not part of this redesign.
- Migrating from `ur|hnt` to `ur|unl` on the LLM side — this is a one-line legend edit; flagged here, scheduled with §2.
- Adding semantic-router (embedding-based) intent classification as a Tier-3 fallback — only revisit if Path A + Path B together miss > 10% of prompts in eval. No need to build it upfront.

---

## Research sources

- [Anthropic Prompt Engineering Guide — role assignment, XML tags, IMPORTANT directives](https://aiflowchat.com/blog/articles/anthropic-prompt-engineering-guide)
- [Anthropic prompt engineering on Bedrock (AWS)](https://aws.amazon.com/blogs/machine-learning/prompt-engineering-techniques-and-best-practices-learn-by-doing-with-anthropics-claude-3-on-amazon-bedrock/)
- [Leaked Claude Code v2.1.143 system prompt](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-code.md) — primary source for identity-prose house style
- [Anthropic Skills GitHub](https://github.com/anthropics/skills) — official skill catalogue + frontmatter pattern
- [Anthropic Claude Code plugin marketplace](https://github.com/anthropics/claude-plugins-official) — official skill ecosystem
- [Anthropic Skills docs](https://code.claude.com/docs/en/skills) — skill discovery and invocation
- [obra/superpowers GitHub (177k+ stars, May 2026)](https://github.com/obra/superpowers) — workflow-skills + master-skill orchestrator pattern
- [popularaitools.ai on Superpowers (2026)](https://popularaitools.ai/blog/superpowers-plugin-10x-claude-code-2026) — master-skill dispatcher mechanics
- [mejba.me Superpowers review](https://www.mejba.me/blog/superpowers-plugin-claude-code-review) — adoption and patterns
- [aurelio-labs/semantic-router (MIT)](https://github.com/aurelio-labs/semantic-router) — embedding-based intent classification reference
- [Lunar.dev on MCP tool overload](https://www.lunar.dev/post/why-is-there-mcp-tool-overload-and-how-to-solve-it-for-your-ai-agents) — Tool Groups pattern
- [WRITER.com on RAG-MCP](https://writer.com/engineering/rag-mcp/) — retrieval-as-selection for tools
- [Junia AI on MCP context-rot](https://www.junia.ai/blog/mcp-context-window-problem)
- [Maxim AI on LLM routing techniques](https://www.getmaxim.ai/articles/top-5-llm-routing-techniques/) — hybrid routing as production standard
- [OpenReview — fast intent classification for LLM routing](https://openreview.net/forum?id=UMuVvvIEvA)
- [Cline Memory Bank docs](https://docs.cline.bot/prompting/cline-memory-bank) — first-turn memory pattern
- [mem0 State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026) — shared memory as 2026 "wow"
- [unerr-web-landing PERCEPTION_TO_PRESENCE.md](file:///Users/jaswanth/IdeaProjects/unerr-web-landing/docs/open-cli/PERCEPTION_TO_PRESENCE.md) — the four-surface model we adopt for Surfaces 2/3/4
