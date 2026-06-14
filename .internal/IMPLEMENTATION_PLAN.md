# unerr-docs — repo setup plan

Goal: stand up the documentation site **repo and infrastructure** for unerr, so docs pages
can be added one at a time later. This plan covers setup only — no doc content, no page
copy. When every sprint here is done, writing a new page = drop one `.mdx` file in
`content/docs/` and it ships.

Status: scaffold built and verified (Sprints 0–6 done; Sprint 7 code done, AWS infra + first deploy pending in `aws-infra`; Sprint 8 done except GitHub repo description). `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` all pass. Date written: 2026-06-14.

---

## Locked decisions

| Topic | Decision | Why |
|---|---|---|
| Platform | **Fumadocs** (MIT, Next.js App Router) | Self-host on our AWS, matches our Next.js stack, AI search with our own key — avoids Mintlify's paid AI tier |
| Repo | **This repo** (`unerr-docs`), separate from marketing | Docs and marketing change at different rates and owners |
| Domain | `docs.unerr.dev` | Subdomain, independent deploy |
| Hosting | AWS ECS / Fargate, next to `unerr-web-service` | Reuse that service's Docker + CI/CD pattern |
| Framework stack | Next.js 16.2.7, React 19.2.4, TypeScript 5, Tailwind v4 | Match `unerr-web-service` exact pins |
| Package manager | pnpm via `packageManager` field (Corepack) | Org convention; pin one version (see open questions) |
| Docs engine | `fumadocs-ui` ^16.10, `fumadocs-core` ^16.9, `fumadocs-mdx` ^14.2 | Current as of 2026-06 |
| Content format | MDX via `fumadocs-mdx`; API reference via `fumadocs-openapi` later | |
| AI search | Vercel AI SDK + `@ai-sdk/openai` (ChatGPT), our own key | Own key; no Mintlify Pro |
| Styling | Import tokens from `unerr-web-landing/styles/tailwind.css` (Substrate Dark + Violet) | Visual parity with the product |
| Brand assets | Reuse logos/icons/fonts/favicon from `unerr-web-landing/public` | One brand |
| Output mode | `next.config` `output: "standalone"` | Required by the Docker runner (`node server.js`) |

Source repos to mirror:
- Infra/Docker/CI: `/Users/jaswanth/IdeaProjects/unerr-web-service`
- Design tokens + assets + narrative: `/Users/jaswanth/IdeaProjects/unerr-web-landing`
- Doc content source-of-truth (later): `/Users/jaswanth/IdeaProjects/unerr-cli`

Narrative framing for the site: "mission control for coding agents." Skip all
LLM-cost-optimization and operations material for now.

---

## Sprint 0 — Prerequisites and ownership

Goal: confirm the things outside this repo before writing code.

Tasks:
- [x] Confirm pnpm version to pin (web-service uses 10.26.2; web-landing 10.33.0; local 10.21.0). Pick one. — pinned 10.26.2.
- [x] Confirm AWS infra is added in the `aws-infra` Terraform repo (ECR repo, ECS service, ALB target group, `docs.unerr.dev` DNS) — that repo owns task defs, not this one.
- [x] Confirm the OpenAI API key source for AI search (Secrets Manager entry name + which account/env). — injected by ECS at runtime.
- [x] Decide the home route behavior: a real landing page at `/`, or redirect `/` → `/docs`. — simple branded page linking to `/docs`.
- [ ] Get the GitHub repo created/named and the short description text approved.

Deliverable: answers recorded in `.internal/` and the open-questions list below cleared.
Acceptance: no remaining blockers tagged "needs decision."

---

## Sprint 1 — Repo scaffold and tooling

Goal: a buildable empty Next.js app with our lint/format/TS conventions.

Tasks:
- [x] `package.json` — pin Next 16.2.7, React 19.2.4, TypeScript 5, `packageManager`, `engines.node >=20.9.0`, `preinstall: only-allow pnpm`. Scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `format`, `format:check`.
- [x] `tsconfig.json` — copy web-service settings (strict, `moduleResolution: bundler`, `jsx: react-jsx`, path alias `@/*`, `next` plugin). Add `@/.source` resolution for generated Fumadocs output.
- [x] `eslint.config.mjs` (flat) — `eslint-config-next` core-web-vitals + typescript.
- [x] `prettier.config.mjs` + `.prettierignore` — match web-service (`semi`, double quotes, `trailingComma: all`).
- [x] `postcss.config.mjs` — single plugin `@tailwindcss/postcss` (Tailwind v4).
- [x] `next.config.ts` — `output: "standalone"`; security headers like web-service; wrapped by Fumadocs MDX in Sprint 2.
- [x] `env.mjs` — `@t3-oss/env-nextjs` + zod; server var `OPENAI_API_KEY` (optional at build), model name; `skipValidation` on `SKIP_ENV_VALIDATION`.
- [x] Extend existing `.gitignore` — add `.source/` (Fumadocs generated) and `.contentlayer`-style outputs if any; the existing file already covers `.next`, env, `.unerr`.
- [x] Add `/api/health` route plan (used by the ECS health check) — implement in Sprint 6/7.

Deliverable: `pnpm install && pnpm build` succeeds on an empty app shell.
Acceptance: clean `lint`, `typecheck`, `format:check`.

---

## Sprint 2 — Fumadocs core wiring

Goal: a working docs route that renders MDX, with sidebar tree, TOC, and search.

Tasks:
- [x] `source.config.ts` — `defineDocs({ dir: 'content/docs' })` + `defineConfig`. Configure remark/rehype plugins (GFM, code highlighting) if needed.
- [x] Wrap `next.config.ts` with `createMDX()` from `fumadocs-mdx/next`.
- [x] Add `postinstall: fumadocs-mdx` script so `.source/` regenerates on install and in Docker.
- [x] `lib/source.ts` — `loader({ baseUrl: '/docs', source: docs.toFumadocsSource() })`.
- [x] `mdx-components.tsx` — export `getMDXComponents` merging `fumadocs-ui/mdx` defaults.
- [x] `app/layout.tsx` (root) — `RootProvider`, html lang, import global css, fonts.
- [x] `app/layout.config.tsx` — shared nav (title/logo, links to product, GitHub, blog).
- [x] `app/docs/layout.tsx` — `DocsLayout` with `source.pageTree`.
- [x] `app/docs/[[...slug]]/page.tsx` — `getPage`, `DocsPage`/`DocsBody`/`DocsTitle`, `generateStaticParams`, `generateMetadata`.
- [x] `app/api/search/route.ts` — `createFromSource(source)` (static/server search).
- [x] One throwaway placeholder page + `meta.json` in `content/docs/` only to prove the pipeline (deleted when real content starts).

Deliverable: `/docs` renders, sidebar + TOC + search all work locally.
Acceptance: build is static where possible; search returns the placeholder page.

---

## Sprint 3 — Design system parity

Goal: the docs site looks like unerr (Substrate Dark + Violet), same brand assets.

Tasks:
- [x] Create `app/global.css` — import Tailwind v4, `fumadocs-ui` preset + neutral css, and `@source` for fumadocs-ui dist.
- [x] Port the token layer from `unerr-web-landing/styles/tailwind.css`: Void Black `#0A0A0F`, Obsidian `#050507`, Slate `#1E1E28`, Cloud White `#FAFAFA`, Violet 500/600/700 `#8B5CF6`/`#7C3AED`/`#6D28D9`, Live cyan `#22D3EE`, health/status scales.
- [x] Map Fumadocs theme CSS variables (`--color-fd-*`: background, foreground, primary, border, card, muted, accent) onto the unerr palette for both dark (default) and light (`.light`).
- [x] Wire fonts: Space Grotesk (headings), Inter (body), JetBrains Mono (code) via `next/font` — reuse the families web-landing uses; copy `public/fonts` if self-hosted. — loaded via `next/font/google`.
- [x] Copy brand assets from `unerr-web-landing/public` into `public/`: `icon.svg`/`icon.png`, `unerr.svg`, `unerr-wordmark.svg/png`, `icon-wordmark.svg/png`, `web-app-manifest-*`, favicon. Add `app/icon` / manifest metadata.
- [x] Set the docs nav logo + wordmark to the copied assets.
- [x] Home route per Sprint 0 decision (landing shell or redirect to `/docs`). — simple branded page linking to `/docs`.

Deliverable: docs chrome matches the product theme; logo and favicon are unerr's.
Acceptance: dark/light toggle both render correctly; no default Fumadocs purple/teal left over.

---

## Sprint 4 — AI search ("Ask AI")

Goal: in-docs AI chat grounded in our MDX, using our own OpenAI key — no paid tier.

Tasks:
- [x] Add deps: `ai` (Vercel AI SDK), `@ai-sdk/openai`.
- [x] `app/api/chat/route.ts` — stream from ChatGPT; retrieve relevant passages from the docs/search index and pass as context (RAG-lite over the same `source`).
- [x] Add the Fumadocs `AISearch` / "Ask AI" trigger into the docs layout, pointed at `/api/chat`.
- [x] Pick the model (default `gpt-4o-mini`) and read the key from `OPENAI_API_KEY`. — model from `OPENAI_MODEL`, injected by ECS.
- [x] AI-discoverability: generate `llms.txt` (static route) and per-page `.md` export route so crawlers/agents ingest docs cleanly. — `llms.txt`, `llms-full.txt`, `llms.mdx`, per-page `.md`.
- [x] Graceful fallback: if no key is set, hide the Ask-AI trigger; keyword search still works.
- [x] Abuse/cost guards (`lib/ai/guards.ts`): same-origin check, per-IP rate limit (12/60s, in-memory, 429 + Retry-After), input caps (≤24 messages, ≤12k chars → 413), and `maxOutputTokens: 800`. Client shows a distinct notice on 429. Durable cluster-wide cap deferred to AWS WAF (see Sprint 7 / aws-infra).
- [x] Provider: ChatGPT via `@ai-sdk/openai`, key `OPENAI_API_KEY`, default model `gpt-4o-mini` (override via `OPENAI_MODEL`). No Anthropic in this repo.

Deliverable: "Ask AI" answers from the docs content locally with a key set.
Acceptance: no key → site still builds and search works; key present → chat streams answers.

---

## Sprint 5 — Content pipeline skeleton (structure only)

Goal: the empty information architecture so pages can be added one by one. No page copy.

Tasks:
- [x] Create the `content/docs/` folder tree with `meta.json` ordering files and empty/placeholder section roots (no body content).
- [x] Proposed top-level sections (from the CLI feature map — names only, fill later):
  - `getting-started/` (what it is, install, first run, supported agents)
  - `concepts/` (operational memory / code graph, anchored notes, session markers, signal prefixes, `@sem` comments, skills, conventions)
  - `cli/` (command reference: install, uninstall, doctor, status, recon, review, login/logout/whoami, conventions, pm, router)
  - `mcp-tools/` (the 7 always-on tools: search_code, unerr_context, fetch_url, file_outline, file_read, get_references, unerr_track)
  - `configuration/` (`.unerr/`, `.mcp.json`, env vars, hooks, dashboard port, credentials)
  - `integrations/` (per-agent install: Claude Code, Cursor, VS Code, Windsurf, and the rest)
  - `reference/` (versioning, supported languages, license) and OpenAPI reference if/when there's an API.
- [x] Add `fumadocs-openapi` wiring as a stub (commented config) for the API reference, to be enabled when there's a spec. — deferred; no public API yet.
- [x] Write a short `CONTRIBUTING` note: how to add a page (file + meta.json), the writing rule, and how to preview.
- [x] Decide the verified numbers to use in content later (flag discrepancies the CLI audit found: agent count 6 vs 16, command-types count, version drift `package.json` 0.2.12 vs `server.json`) — record, don't write pages yet.

Deliverable: empty IA that builds; adding a page is a one-file change.
Acceptance: sidebar shows the section skeleton; no placeholder marketing copy committed.

---

## Sprint 6 — Containerization

Goal: a production image matching the web-service pattern, minus Prisma/migrations.

Tasks:
- [x] `Dockerfile` — adapt web-service's: multi-stage Alpine, Corepack pnpm pinned, `deps`/`builder`/`runner`, `output: standalone`, tini as PID 1, non-root `node` user, `0.0.0.0` entrypoint, `NEXT_TELEMETRY_DISABLED`, `SKIP_ENV_VALIDATION` at build. Remove Prisma generate, ClickHouse, and `Dockerfile.migrate`.
- [x] Ensure `source.config.ts` + `next.config.ts` are in the build context and `.source/` is generated during build (via `postinstall` or an explicit `fumadocs-mdx` step).
- [x] `.dockerignore` — copy web-service's (node_modules, `.next`, env except `.env.example`, `.git`, tests, `.unerr`, `.source` if regenerated).
- [x] `/api/health` route returning 200 for the ECS health check.
- [x] Local verify: `docker build` + `docker run` confirmed — `/api/health` 200, `/docs` 200, `/` 200, `/api/chat` 503 with no key. Fix during verify: the deps stage must also copy `next.config.mjs`, else `fumadocs-mdx`'s postinstall takes the Vite path and fails on a missing `vite`.

Deliverable: image builds and runs locally.
Acceptance: container passes its own healthcheck; `/docs` reachable on 0.0.0.0:3000.

---

## Sprint 7 — CI/CD and deploy

Goal: build-push-to-ECR + manual ECS deploy, like web-service, minus migrations.

Tasks:
- [x] `.github/workflows/ci-cd.yml` — adapt web-service's: `test` (install, lint, typecheck, format:check, build), `verify-image` (PR build, no push), `build-push` (OIDC → ECR, tags `:latest` + `:<version>-<sha>`), `deploy-qa` / `deploy-prod` (manual, `update-service --force-new-deployment` + wait stable). Drop the migration one-off-task step.
- [x] Set repo vars/secrets: `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `ECR_REPOSITORY_DOCS`, `ECS_CLUSTER`, `ECS_SERVICE` (values come from `aws-infra`).
- [ ] In `aws-infra` (separate repo, coordinate): ECR repo, ECS service + task def (inject `OPENAI_API_KEY` from Secrets Manager at runtime), ALB target group + health check on `/api/health`, `docs.unerr.dev` DNS + cert.
- [ ] In `aws-infra`: AWS WAF rate-based rule on `/api/chat` — the durable cluster-wide Ask-AI limit. The in-app guards (`lib/ai/guards.ts`) are per-task only; WAF is the real cap.
- [ ] First deploy to qa, verify, then prod.

Deliverable: pushing `main` parks an image; manual deploy ships it to ECS.
Acceptance: `docs.unerr.dev` serves the site behind the ALB; healthcheck green.

Note: workflow mirrors `unerr-web-service`'s — Blacksmith runners (`blacksmith-4vcpu-ubuntu-2404`), Blacksmith builder + build-push actions, OIDC, decoupled build/deploy, env-scoped clusters, drops the DB-migration + Playwright jobs (docs has neither). Requires this repo to be installed in the Blacksmith GitHub app.

---

## Sprint 8 — Repo docs and handoff

Goal: the repo explains itself; external metadata is correct.

Tasks:
- [x] `README.md` — what this repo is, local dev commands, how to add a doc page, deploy notes, link to this plan.
- [x] Update `CLAUDE.md` "Repository state" section — replace "empty repo" text with the real stack, build/lint/test commands, and architecture once Sprints 1–2 land.
- [ ] Set the GitHub repo description (approved in Sprint 0).
- [x] Confirm the writing rule and research rule are reflected in CONTRIBUTING.

Deliverable: a newcomer can clone, run, and add a page from the README alone.
Acceptance: README commands work end to end.

---

## Open questions (need a decision)

1. pnpm version to pin — 10.26.2 (web-service) vs 10.33.0 (web-landing) vs local 10.21.0?
2. Home route — full landing page at `/`, or redirect to `/docs`?
3. OpenAI key — which Secrets Manager entry / account / env? Same key as web-service or separate?
4. Self-host fonts (copy `public/fonts`) or load via `next/font/google`?
5. Does unerr have a public HTTP API worth an OpenAPI reference now, or defer Sprint 5's OpenAPI stub?
6. GitHub repo description text.

**Resolved (2026-06-14):** pnpm pinned 10.26.2; home route = simple branded page linking to `/docs`; fonts via `next/font/google`; OpenAPI deferred (no public API yet); `NEXT_PUBLIC_*` banned — per-environment config read at runtime, base URL from `SITE_URL`. Still open: #6 GitHub repo description.

**Done (2026-06-14):** Ask-AI abuse/cost controls — in-app guards in `lib/ai/guards.ts` (same-origin, per-IP rate limit, input caps, output-token cap). Durable cluster-wide enforcement deferred to an AWS WAF rate-based rule on `/api/chat` (aws-infra, Sprint 7 list).

## Notes / risks

- Fumadocs versions move fast (releases within hours of this writing). Pin exact versions in `package.json` and bump deliberately.
- `.source/` must regenerate in the Docker build, or the standalone server has no content — verify in Sprint 6, not after deploy.
- Per-environment config is runtime (ECS task def), not baked into the image — same one-image-all-envs rule as web-service. The only build-time client config would be `NEXT_PUBLIC_*`, which docs likely don't need.
- Content accuracy: resolve the CLI doc-vs-code discrepancies (agent count, command-type count, version drift) before writing the matching pages.
