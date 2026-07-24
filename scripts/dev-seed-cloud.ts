#!/usr/bin/env tsx
/**
 * DEV/TEST ONLY — one-shot cloud seeding script (C4-dev). NOT a `bin` entry and
 * NOT wired into the CLI.
 *
 * Reads whatever already lives in the developer's OWN laptop `.unerr/*` stores
 * (metrics.db's 8 tables, agent_transcripts, ledger/shadow.jsonl,
 * router/metrics.jsonl(.gz), facts.db, timeline.db) and pushes it through the
 * REAL live `/ingest/*` + `/sync/*` routes, so the cloud dashboards / insights
 * can be exercised end-to-end with real data before any second client exists.
 *
 * It REUSES the exact same push pipeline the live daemon drain loop uses — the
 * stream-source mappers and the client-side HR-2 code/path stripper — instead of
 * a parallel copy, so what it seeds matches byte-for-byte what live push sends:
 *
 *   - `assembleDrainers` (src/cloud/drainers/index.ts) — builds all 8 stream
 *     drainers for a repo (events, transcripts, ledger, router, sessions, facts,
 *     timeline, state). Each drainer maps source rows, strips code/paths, mints a
 *     deterministic per-row `event_id`, and caps each batch to its endpoint.
 *   - `drainRepo` (src/cloud/push-drainer.ts) — runs every drainer until empty,
 *     advancing the cursor only after a `2xx`.
 *   - `PushCursor` (src/cloud/push-cursor.ts) — the per-stream watermark. To seed
 *     ALL history this script points the cursor at a THROWAWAY temp dir, so every
 *     position starts empty and every row is read from position zero — and the
 *     repo's real daemon watermark is never touched.
 *   - `CloudClient` (src/cloud/client.ts) — the authenticated push transport.
 *   - `deriveRepoId` (src/cloud/repo-identity.ts) — the salted wire repo id.
 *
 * PROD GUARD: the script refuses to run unless a `.unerr/dev.json` (or the
 * global `~/.unerr/dev.json`) names a dev `apiUrl`. `applyDevConfig` then points
 * the cloud client at that dev URL and mints a local dev entitlement token, so
 * the script can ONLY ever target a dev backend, never production. No dev.json →
 * hard refuse.
 *
 * IDEMPOTENCY: re-running adds NO duplicate rollup counts. The drainers mint a
 * deterministic per-row `event_id` (content-hash, see src/cloud/event-id.ts), so
 * the server's `ReplacingMergeTree` + S1 dedup token collapse a second run to a
 * no-op. The throwaway cursor guarantees a full re-read each run; dedup is what
 * makes the re-read free of double-counting.
 *
 * Usage:  pnpm tsx scripts/dev-seed-cloud.ts [repoPath]
 *         (repoPath defaults to process.cwd())
 *
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudClient } from "../src/cloud/client.js";
import { readCredentials } from "../src/cloud/credentials.js";
import { applyDevConfig } from "../src/cloud/dev-mode.js";
import { assembleDrainers } from "../src/cloud/drainers/index.js";
import { PushCursor } from "../src/cloud/push-cursor.js";
import { drainRepo } from "../src/cloud/push-drainer.js";
import { deriveRepoId } from "../src/cloud/repo-identity.js";
import { UNERR_VERSION } from "../src/version.js";

/** stderr-only diagnostic line (stdout stays clean per the repo logging rule). */
function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** The two dev.json locations, repo-level taking precedence (mirrors dev-mode). */
function devProfilePaths(repoPath: string): { repo: string; global: string } {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return {
    repo: join(repoPath, ".unerr", "dev.json"),
    global: join(home, ".unerr", "dev.json"),
  };
}

/**
 * Read a dev.json `apiUrl` from the repo file, then the global file. Returns the
 * first `apiUrl` found, or null when neither file names one. This is the PROD
 * GUARD input: no dev apiUrl → the script refuses to run.
 */
function resolveDevApiUrl(repoPath: string): string | null {
  const { repo, global } = devProfilePaths(repoPath);
  for (const path of [repo, global]) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        apiUrl?: unknown;
      };
      if (
        typeof parsed.apiUrl === "string" &&
        parsed.apiUrl.trim().length > 0
      ) {
        return parsed.apiUrl.trim();
      }
    } catch {
      err(`[dev-seed] ignoring malformed ${path}`);
    }
  }
  return null;
}

/**
 * Resolve the machine push token. `applyDevConfig` already set
 * `process.env.UNERR_API_URL` to the dev URL and minted a dev entitlement token;
 * the machine *push* token itself still comes from the logged-in credentials
 * (file/keychain) or `UNERR_TOKEN`. Returns null when there is no usable token.
 */
function resolveToken(): string | null {
  const creds = readCredentials();
  if (creds && creds.token.trim().length > 0) return creds.token.trim();
  return null;
}

/**
 * Seed one repo: build the real drainers against a throwaway zero cursor and
 * push every row through the live dev backend. Returns the total rows pushed and
 * dead-lettered. Reuses the live push pipeline wholesale — no parallel mapper.
 */
async function seedRepo(
  repoPath: string,
  apiUrl: string,
  token: string
): Promise<void> {
  const unerrDir = join(repoPath, ".unerr");
  if (!existsSync(unerrDir)) {
    err(`[dev-seed] no .unerr dir at ${unerrDir} — nothing to seed`);
    return;
  }

  const repoId = await deriveRepoId(repoPath);
  const client = new CloudClient({ apiUrl, token });

  // Drain from position ZERO: a fresh cursor in a throwaway temp dir means every
  // stream starts empty (reads the whole store) AND the repo's real daemon
  // watermark at .unerr/state/push-cursor.json is never clobbered.
  const scratchDir = await mkdtemp(join(tmpdir(), "unerr-seed-"));
  const cursor = await PushCursor.open(scratchDir);

  const set = await assembleDrainers({
    repoPath,
    unerrDir,
    repoId,
    client,
    source: `unerr-cli@${UNERR_VERSION}`,
    log: err,
  });

  if (set.drainers.length === 0) {
    err(`[dev-seed] no drainers built for ${repoPath} — empty stores?`);
    await set.dispose?.();
    return;
  }

  // Optional stream filter: UNERR_SEED_STREAMS="facts,timeline" pushes ONLY the
  // streams whose key starts with one of the comma-listed prefixes (so "timeline"
  // matches both "timeline:turns" and "timeline:markers"). Unset → push every
  // stream. Lets a re-validation target one fixed stream without re-pushing the
  // already-synced bulk event streams that hammer a single dev server.
  const streamFilter = (process.env.UNERR_SEED_STREAMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const drainers =
    streamFilter.length > 0
      ? set.drainers.filter((d) =>
          streamFilter.some((p) => d.key === p || d.key.startsWith(`${p}:`))
        )
      : set.drainers;
  if (streamFilter.length > 0) {
    err(
      `[dev-seed] stream filter ${JSON.stringify(streamFilter)} → ${drainers.length}/${set.drainers.length} stream(s): ${drainers.map((d) => d.key).join(", ")}`
    );
  }
  if (drainers.length === 0) {
    err(
      `[dev-seed] stream filter matched no drainers — check UNERR_SEED_STREAMS`
    );
    await set.dispose?.();
    return;
  }

  try {
    // isEntitled:() => true bypasses the paid-tier telemetry gate — the dev
    // entitlement token need not carry cloud_ingest for a dev seed to run.
    // maxBatchesPerStream lifts the daemon's per-tick safety bound (20) so a
    // single seed run drains EVERY row from the zero cursor to empty — a full
    // backfill, not the first 20 batches. Override with UNERR_SEED_MAX_BATCHES.
    const maxBatchesPerStream =
      Number(process.env.UNERR_SEED_MAX_BATCHES) || 1_000_000;
    const outcomes = await drainRepo(cursor, drainers, {
      isEntitled: () => true,
      log: err,
      maxBatchesPerStream,
    });

    let pushed = 0;
    let dead = 0;
    for (const o of outcomes) {
      pushed += o.pushed;
      dead += o.deadLettered;
      err(
        `[dev-seed] ${o.stream}: ${o.pushed} pushed, ${o.deadLettered} dead-lettered (${o.status})`
      );
    }
    err(
      `[dev-seed] done — ${pushed} row(s) pushed, ${dead} dead-lettered across ${outcomes.length} stream(s)`
    );
  } finally {
    await set.dispose?.();
  }
}

async function main(): Promise<void> {
  const repoPath = process.argv[2]
    ? join(process.cwd(), process.argv[2])
    : process.cwd();

  // PROD GUARD — refuse unless a dev.json names a dev apiUrl.
  const devApiUrl = resolveDevApiUrl(repoPath);
  if (!devApiUrl) {
    err(
      "[dev-seed] REFUSING: no dev apiUrl in .unerr/dev.json (repo or ~/.unerr/dev.json)."
    );
    err(
      "[dev-seed] This script can ONLY target a dev backend. Run `pnpm dev:config --host <dev-url> --tier pro` first."
    );
    process.exitCode = 1;
    return;
  }

  // Point the cloud client at the dev URL + mint the local dev entitlement token.
  await applyDevConfig(repoPath);

  // applyDevConfig only sets UNERR_API_URL when it is unset; force the dev URL so
  // an unrelated env var can never redirect the seed at prod.
  const apiUrl = devApiUrl;

  const token = resolveToken();
  if (!token) {
    err(
      "[dev-seed] REFUSING: no machine token — log in (or set UNERR_TOKEN) so the dev backend accepts the push."
    );
    process.exitCode = 1;
    return;
  }

  err(`[dev-seed] seeding ${repoPath} → ${apiUrl}`);
  await seedRepo(repoPath, apiUrl, token);
}

main().catch((e) => {
  err(`[dev-seed] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
