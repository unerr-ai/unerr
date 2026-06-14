# syntax=docker/dockerfile:1.7
#
# Production image for the unerr docs site (Next.js 16 + Fumadocs, standalone
# output). Built for AWS ECS / Fargate: multi-stage, non-root, lean, with proper
# signal handling so SIGTERM from ECS drains cleanly.
#
# Build:
#   docker build -t unerr-docs:local .
#
# NOTE: this site has NO NEXT_PUBLIC_* build-time config. Per-environment values
# (SITE_URL, OPENAI_API_KEY) are NOT baked — they are injected at RUNTIME by
# the ECS task definition + Secrets Manager and read by the server. So there are
# no --build-arg / build ENV for them here.

ARG NODE_VERSION=22-alpine

# ---------------------------------------------------------------------------
# base — pnpm via corepack, pinned to the version in package.json
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
# libc6-compat: some prebuilt native deps expect glibc symbols on Alpine/musl.
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — install the full dependency tree (cached on lockfile changes only)
# ---------------------------------------------------------------------------
FROM base AS deps
# Fumadocs gotcha: package.json `postinstall` runs `fumadocs-mdx`, which reads
# `source.config.ts` to generate the `.source/` directory. Without that file the
# postinstall fails/warns, so we copy it in BEFORE install. The .source produced
# here may be empty/partial — that's fine: the builder regenerates the real one
# during `next build` (the fumadocs-mdx Next plugin runs it against full content).
# Copying source.config.ts (not all of content/) keeps this layer cache-stable:
# it only busts when deps or the config change, not on every docs edit. Running
# install WITH scripts (no --ignore-scripts) is required so the native build
# scripts for sharp, esbuild, and unrs-resolver (package.json
# pnpm.onlyBuiltDependencies) actually run — without them next/og images and
# fumadocs-mdx break at build/runtime.
#
# next.config.mjs MUST be copied too: fumadocs-mdx's postinstall (bin.js) picks
# its codepath by probing for next.config.* — if absent it falls back to the Vite
# adapter and fails with "Cannot find package 'vite'". Copying it keeps the Next
# path selected, matching a local install.
COPY package.json pnpm-lock.yaml source.config.ts next.config.mjs ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder — build the standalone server (regenerates .source from full content)
# ---------------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# No secrets exist at build time; env validation is skipped. Telemetry off keeps
# builds hermetic. `next build` runs the fumadocs-mdx plugin, which regenerates
# the full `.source/` from source.config.ts + content/docs before compiling.
ENV NEXT_TELEMETRY_DISABLED=1 \
    SKIP_ENV_VALIDATION=1
RUN pnpm build

# ---------------------------------------------------------------------------
# runner — minimal runtime: standalone server + static assets, non-root
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

# tini reaps zombies and forwards SIGTERM to node so ECS task stops drain
# cleanly (a bare `node` as PID 1 mishandles signals). curl is here ONLY so the
# ECS task-definition health check (`curl -f http://localhost:3000/api/health`,
# owned by aws-infra) has a binary to run — the image's own HEALTHCHECK uses node.
RUN apk add --no-cache tini curl

# HOSTNAME here is only a DEFAULT. Next.js standalone (server.js) binds to
# whatever $HOSTNAME is at runtime — and ECS/Fargate injects its own HOSTNAME
# (the task's hostname, e.g. ip-10-1-1-23.ec2.internal) into the container, which
# overrides this ENV. The server would then bind to that single interface, so the
# loopback container health check AND the ALB target-group check can't reach it
# and ECS kills the task. The entrypoint below re-asserts 0.0.0.0 at runtime so it
# wins over the injected value. See https://github.com/vercel/next.js/issues/58657
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Force the all-interfaces bind regardless of the HOSTNAME the orchestrator
# injects, then exec the real command (kept as PID-1 child of tini for signals).
COPY <<'SH' /usr/local/bin/docker-entrypoint.sh
#!/bin/sh
set -e
export HOSTNAME=0.0.0.0
export PORT="${PORT:-3000}"
exec "$@"
SH
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Run as the unprivileged "node" user that the base image already provides.
# The standalone server bundles .source compiled output — no .source/ files
# need to be copied into the runtime.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000

# Image-level health check for plain `docker run` / local use. On ECS this is
# IGNORED — the task definition defines its own (curl-based) health check, which
# overrides the image's. Node's built-in fetch needs no extra binary here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini stays PID 1 (signals); it runs the entrypoint, which forces the 0.0.0.0
# bind and then execs `node server.js` (the CMD).
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
