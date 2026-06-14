# Documentation standards

The rules we follow when writing the unerr docs, and the ones to keep following.
This is for people (and agents) editing `content/docs/`. It is not a published page.

The short version: every page is **one job**, written in **plain language**, with
**structure over prose**, and **grounded in the shipped binary** — not in memory or
marketing.

---

## 1. Information architecture — Diátaxis

We organize content by what the reader needs, using the four Diátaxis modes. Mixing
modes on one page is the most common cause of confusing docs, so don't.

| Mode | Reader's need | Our sections |
|---|---|---|
| Tutorial / orientation | "Get me running" | `getting-started/` |
| Explanation | "Help me understand what this is and why" | `concepts/` |
| Reference | "Give me the exact facts" | `cli/`, `mcp-tools/`, `reference/` |
| How-to | "Walk me through a task" | `integrations/`, parts of `configuration/` |

When you add a page, decide its mode first. A reference page lists facts in tables; it
does not teach. A concept page explains; it does not give step-by-step commands. If a
page wants to do both, split it.

Source: [Diátaxis](https://diataxis.fr/), [Diátaxis — start here](https://diataxis.fr/start-here/).

---

## 2. Writing rules (hard)

These match the product's own writing rule. They are not style preferences.

1. **Less text, more information.** Plain language anyone can follow on the first read.
   Define a term the first time you use it.
2. **No marketing or hype words.** Banned: powerful, seamless, leverage, unlock, robust,
   supercharge, best-in-class, cutting-edge, effortless, revolutionary, game-changing,
   blazing-fast. State what it does and how.
3. **Structure over prose.** Prefer short sections, tables, and short lists. Lead with the
   answer, then the detail. Short sentences.
4. **Only what the reader needs.** Cut padding. Do not document internal implementation,
   internal/dev-only environment variables, or agent-internal subcommands a user can't run.
5. **Be concrete.** Real command, path, flag, number — never "the relevant part".
6. **Say it straight.** If something is optional, cloud-only, or has a caveat, say so.
7. **Never name a competitor product.** Keep comparisons generic ("grep/glob",
   "built-in file tools", "output-compression tools").

Quick test: read a sentence out loud. If it could appear in an ad, rewrite it.

Sources: [Technical documentation best practices, 2025](https://deepdocs.dev/technical-documentation-best-practices/),
[Software documentation best practices, 2025](https://www.tutorial.ai/b/software-documentation-best-practices).

---

## 3. Accuracy — ground every claim in the shipped product

Docs drift from code unless tied to it. Rules:

- **The binary is the source of truth for the CLI.** Command pages must match
  `unerr <command> --help`. When a flag changes, update the page in the same change.
- **Cite real numbers.** Current version (0.3.0), npm package (`@unerr-ai/unerr`),
  license (Apache-2.0), supported-language list, default token budget (4000). If you can't
  confirm a number from the code or the binary, leave it out.
- **Don't document what users can't act on.** Internal env vars, dev flags, and
  agent/hook-only subcommands stay out. The documented CLI surface is exactly: `install`,
  `uninstall`, `doctor`, `status`, `recon`, `review`, `login`/`logout`/`whoami`,
  `conventions`, `pm`, `router`.
- **Mark cloud/optional features as such.** Login, fleet/dashboard-across-machines, and
  the team conventions document are logged-in features. unerr works fully offline without
  an account — say this wherever it matters.
- **Keep docs in step with releases.** Treat a behavior change in the CLI as also a docs
  change. Run the build before merging (section 7).

Sources: [Keep docs aligned with releases](https://www.wondermentapps.com/blog/technical-documentation-best-practices/).

---

## 4. Page structure conventions

Use the same skeleton for same-typed pages so readers can scan.

**CLI command page** (`cli/*.mdx`):
1. One-line summary.
2. `## Synopsis` — a `bash` block with the usage line.
3. Short description.
4. `## Options` — a table (`flag | description`) when the command has options.
5. Subcommands as a table where relevant.
6. `## Examples` — 1–3 realistic `bash` examples.
7. A "Related" line linking to connected pages.

**MCP tool page** (`mcp-tools/*.mdx`): state up front that the agent calls these
automatically (users don't type them). Then what it does and when the agent uses it, an
`## Arguments` table, what built-in tool it replaces, and a short, accurate example. Do
not invent response fields.

**Concept page** (`concepts/*.mdx`): explain what it is and why it exists. Tables for any
fixed vocabulary (tags, kinds, polarities). No step-by-step command sequences.

**Integration page** (`integrations/*.mdx`): ordered setup steps, the files `unerr
install` writes, what the agent gets (only Claude Code gets skills + hooks), and a verify
step.

---

## 5. MDX and Fumadocs conventions

- **Frontmatter.** Every page has `title` and `description`. Keep `title` stable (it's the
  sidebar label and the page H1). `description` is one plain sentence.
- **Ordering.** A section's order lives in its `meta.json` `pages` array. To add a page,
  create the `.mdx` file and add its slug to `pages`. Don't reorder casually.
- **Headings.** Start page bodies at `##` (the `title` is the H1).
- **Code blocks** always carry a language: ` ```bash `, ` ```json `, ` ```ts `, ` ```mdx `.
- **Callouts** are global: `<Callout type="info|warn|error">…</Callout>`. Use sparingly,
  for genuine caveats (offline/privacy, "cloud feature", destructive flags).
- **Internal links** use absolute doc paths: `[anchored notes](/docs/concepts/anchored-notes)`.
- **One idea per table.** Don't overload a table with unrelated columns.

### GFM table gotcha — escape literal `|` inside table cells

A literal pipe inside an inline-code span **inside a table cell** breaks the table: GFM
still reads `|` as a column separator there, which exposes any following `{…}` to the MDX
expression parser and fails the build. Escape it as `\|`.

```mdx
<!-- breaks the build -->
| `act` | `ur|act run get_references({...})` |

<!-- correct -->
| `act` | `ur\|act run get_references({...})` |
```

This only applies inside tables. In normal prose, `|` inside backticks is fine.

---

## 6. Diagrams (Mermaid)

A `<Mermaid />` component is registered globally (`components/mermaid.tsx`). It loads
Mermaid lazily on the client and re-renders when the dark/light theme toggles.

```mdx
<Mermaid chart={`flowchart LR
  A[IDE] -->|stdio| B(unerr --mcp bridge)
  B -->|UDS| C(unerr per-repo server)
`} />
```

Rules:
- Use a diagram only where it explains a flow or architecture faster than text would —
  not for decoration.
- Keep Mermaid syntax valid. Quote node labels that contain spaces or punctuation.
- Prefer `flowchart` and `sequenceDiagram`.

---

## 7. Before you merge

Run all three from the repo root; all must pass.

```bash
pnpm typecheck    # MDX types + the Mermaid component
pnpm build        # compiles every page — catches malformed MDX and Mermaid
pnpm lint         # eslint
pnpm format:check # prettier
```

The build is the real test: it compiles all 50+ pages to static HTML and fails on a single
broken page. A page that typechecks can still fail the build (see the table-pipe gotcha).

---

## 8. Authoring with multiple agents

When generating or updating many pages at once, keep one shared brief (writing rules +
the same product facts) and give every agent that brief, so voice and facts stay
consistent. Have each agent preserve frontmatter `title`, never touch `meta.json`, and
ground content only in the brief. Then run section 7 centrally and fix any build errors in
one pass (the per-page agents should not run builds).

---

## Sources

- [Diátaxis documentation framework](https://diataxis.fr/) and [start here](https://diataxis.fr/start-here/)
- [10 Technical Documentation Best Practices for 2025 — DeepDocs](https://deepdocs.dev/technical-documentation-best-practices/)
- [Software Documentation Best Practices for 2025](https://www.tutorial.ai/b/software-documentation-best-practices)
- [Technical Documentation Best Practices — Wonderment](https://www.wondermentapps.com/blog/technical-documentation-best-practices/)
- [Model Context Protocol docs](https://modelcontextprotocol.io/) — for MCP-tool framing
