# Memory pages: merge Sidekick Memory → Project Memory (plan, no code)

Status: plan drafted, awaiting approval. No code shipped.
Last updated: 2026-05-25.
Scope: the two dashboard pages `facts` ("Project Memory") and `sidekick-memory` ("Sidekick Memory").

Goal: we don't need both — collapse to **one** uplifted page that's a better experience and a genuine "wow." This plan grounds the merge in the current tree and in 2026 knowledge-management / consolidation UX standards.

---

## 1 — The core finding: they're two views of one dataset

Both pages read the **same `TemporalFactStore`** (`facts.db`, `src/intelligence/temporal-facts.ts`). They differ only in *presentation and capability*, not in data:

| | **Project Memory** (`facts`) | **Sidekick Memory** (`sidekick-memory`) |
|---|---|---|
| Component | `FactsPage.tsx` | `SidekickMemoryPage.tsx` |
| API | `/api/facts` + `/api/facts/health` | `/api/facts-v2/list?source=…` (richer) |
| Store | `TemporalFactStore` | **same** `TemporalFactStore` |
| Mental model | curated **explorer** — "what does unerr know about my project?" | raw **inventory + editor** — "what's recorded, fix it" |
| Presentation | humanized, categorized hero (Coding Patterns / Hot Files / Lessons / Explicit Rules / Change History), confidence ring, detail modal | flat list split by source (user-fed vs auto), raw `fact_type`/source codes |
| Extra data shown | — | `source_quote` (provenance), `applies_to`, `drift` ("may be stale"), `disabled` |
| Actions | Reinforce, Dismiss | Edit (inline), Disable/Re-enable, Delete |

So "Project Memory" is the **glance/trust** layer and "Sidekick Memory" is the **control/transparency** layer over the *same facts*. That's the textbook case for one page with progressive disclosure, not two.

(Grounding: `FactsPage.tsx:9–21,39–86,150–229,440–1054`; `SidekickMemoryPage.tsx:21–47,55–218,315–368`; `src/server/routes/facts.ts:32–234`; `temporal-facts.ts:7–17,72–85,538–573,924–978`; routes `router.ts:30,33`.)

---

## 2 — Why merge (grounded in 2026 standards)

- **Two-tier memory is the 2026 pattern.** Leading second-brain / agent-memory systems separate *synthesized fact nodes* from a *human-readable narrative layer* — "retrieval vs presentation" ([Medium — KM has outgrown note-taking](https://medium.com/the-smart-founder/knowledge-management-ai-trends-2026-d5b64d7dd1e0), [Karpathy LLM wiki](https://codersera.com/blog/karpathy-llm-knowledge-base-second-brain/), [arXiv second-brain study](https://arxiv.org/pdf/2509.20187)). unerr **already has both tiers**: `TemporalFact` nodes + `humanizeContent()` narrative. Today they're split across two pages; merging unifies the tier model on one surface.
- **Graphs are replacing taxonomies.** 2026 KM is moving from folders/lists to *self-maintaining organizational memory* anchored to a knowledge graph, where facts surface automatically ([buildin 2026](https://buildin.ai/blog/best-second-brain-apps-2026)). unerr's facts are already anchored to files/entities (`scope` + `applies_to`) — the merged page can present memory *on the graph*, not as a flat table.
- **Consolidation UX = progressive disclosure + minimalism.** Standard guidance for collapsing overlapping pages: prioritize essential elements first, keep it minimal, surface segmentation above the listing, and reveal depth on demand ([NN/G](https://www.nngroup.com/articles/ecommerce-homepages-listing-pages/), [Baymard](https://baymard.com/blog/current-state-ecommerce-product-page-ux)). Maps cleanly to "curated overview by default → full inventory + edit on expand."

---

## 3 — Decision: one page, `facts` route kept, `sidekick-memory` retired

- **Keep** route id `facts`; **retire** `sidekick-memory` (redirect it to `facts` for any bookmarks). Single nav entry.
- **Server:** standardize the merged page on `/api/facts-v2` (it already carries `source_quote`, `applies_to`, `drift`, and the full edit/disable/reinforce/delete mutations) + keep `/api/facts/health` for the ring. The legacy `/api/facts` list becomes redundant for the UI (leave the endpoint; just stop the page depending on it).
- **No data migration** — same store, same schema (consistent with the no-migrations-pre-release rule).
- **Page name — DECIDED: "Project Memory"** (keep name + route id `facts`). Matches sibling voice (Code Intelligence / Codebase Map / Project Memory). "Sidekick Memory" retired.

---

## 4 — The uplifted page: overview → manage, one surface

Two depths via progressive disclosure. Everything from both pages survives; nothing is lost.

### 4.0 Hero — "your codebase's living memory" (keep + uplift `FactsPage` hero)
- Knowledge ring (avg recall confidence) + mini-stats: Total · Explicit Rules · Coding Patterns · Hot Files · Lessons · **User-fed** (new, from facts-v2 source split).
- One-line framing: *"What unerr has learned about this project — injected into the agent as it works. Correct anything; it learns."*
- (Additive, optional) impact stat: "N memories surfaced to the agent this week" from `behavior_events.fact_recalled` — ties memory to outcomes.

### 4.1 Curated categories (keep `FactsPage`'s strength — the glance layer)
- Sections: **Explicit Rules** (▸ emerald), **Coding Patterns** (◆ violet), **Hot Files** (⚡ cyan), **Lessons Learned** (✗ red), **Change History** (◎ amber). Humanized cards + confidence bars (Strong/Moderate/Fading).
- This stays the default view — trust-first, plain-English.

### 4.2 Unified card → expand = full detail + inline control (folds ALL of Sidekick in)
Clicking a card opens one detail surface that merges the `FactsPage` modal **and** the `SidekickMemoryPage` card:
- Humanized **Summary** + raw **Original content**.
- **Provenance:** `source` label + `source_quote` blockquote (the verbatim "you said…").
- **Scope / Applies-to:** the files/entities it governs.
- **Drift badge** "may be stale" when `drift=true`; **disabled** state.
- **Injection preview** (uplift of "How it's used"): *"When the agent touches `{scope}`, it sees: …"* — show the actual line unerr would inject.
- **Memory strength:** base → effective (after decay), decay delta, reinforcements.
- **Inline actions:** Edit · Reinforce · Disable/Re-enable · Delete (Sidekick's direct manipulation — trust through editability).

### 4.3 Segmentation + "All memories" manage view (fold Sidekick's inventory)
- A filter/segment bar above the listing (consolidation-UX standard): by **source** (user-fed / auto-detected), **type**, **status** (active / fading / disabled / drifting), **scope**, + search.
- A toggle: **Curated** (4.1, default) ⇄ **All memories** (flat, dense inventory incl. disabled — Sidekick's list, now with the same rich cards).

### 4.4 The "wow" layer (the differentiator)
**DECIDED — ships first: Injection preview by file.** Choose a file → see exactly the memory context unerr would wrap around the agent. Turns "a list of facts" into "see what your agent actually gets." Strongest trust/wow, lowest cost (data already exists in `scope`/`applies_to`). No proxy/MCP path change — read-only render of the same facts the injector already selects.

Deferred (additive, later — not blocking):
- **Memory-on-graph** — overlay facts onto the existing Codebase Map: which files/entities carry memory, color by confidence/drift. Most visually striking; reuses the graph page.
- **Living-decay visualization** — show memory as reinforcing/fading over time (the decay model is already unique vs claude-mem). Makes "self-maintaining memory" tangible.

---

## 5 — Phased implementation plan (no code)

**Phase 0 — Consolidate routing.** Retire `sidekick-memory` nav entry; redirect its hash to `facts`; single "Project Memory" nav item (`router.ts`, `app.tsx`, AppShell nav). Acceptance: one nav entry; old `#…/sidekick-memory` lands on `facts`; tests updated.

**Phase 1 — Server standardize.** Point the page at `/api/facts-v2/list` + `/api/facts/health`. Confirm facts-v2 returns everything FactsPage needs (it does, plus more). Acceptance: page renders entirely from facts-v2 + health; legacy `/api/facts` no longer fetched by the UI.

**Phase 2 — Merge the card + detail.** Build the unified card/detail (4.2) combining `FactsPage` modal sections with `SidekickMemoryPage` provenance/drift/inline-edit. Acceptance: every field + action from both old pages is reachable on the one card; reinforce/edit/disable/delete all work and invalidate the shared query.

**Phase 3 — Curated + manage views.** Wire the Curated⇄All toggle (4.1/4.3) and the segment/filter/search bar. Acceptance: curated categories by default; "All memories" shows the full inventory incl. disabled; filters work.

**Phase 4 — Wow layer.** Implement the chosen 4.4 feature (decision below). Acceptance: the headline feature renders from existing data; no proxy/MCP path change.

**Phase 5 — Retire dead code + full suite.** Remove `SidekickMemoryPage.tsx` once parity is confirmed; `pnpm run test:run`.

---

## 6 — Open questions / risks
1. ✅ **Page name** — DECIDED: "Project Memory" (route `facts`).
2. ✅ **Wow-layer scope** — DECIDED: Injection-preview-by-file ships first; memory-on-graph + decay-viz deferred.
3. **Default depth** — Curated-first (recommended) vs inventory-first. Recommend curated-first; confirmable.
4. **Legacy `/api/facts`** — leave for back-compat or remove after UI cutover. Lean: leave, stop using.
5. **`episodic` ("Change History")** — surfaced in `FactsPage` but minor; confirm it stays a category in the merged page.
6. **Injection-preview fidelity** — the preview must read from the *same* selection logic the injector uses (scope/applies-to match), not a parallel reimplementation, so it never lies about what the agent gets. Confirm the shared selection path before Phase 4.

---

## 7 — Non-goals
- No change to the MCP/proxy execution path, tool dispatch, or latency budget — UI + route-shape only.
- No schema/data migration — same `facts.db` / `TemporalFactStore`.
- No new top-level nav entry — net **−1** page.
- No change to how facts are *created* (unerr_remember / record_fact / auto-detectors) — only how they're displayed and managed.
