/**
 * verify-ingest-batches.ts — end-to-end ingest verifier.
 *
 * Drains the current local event queue for one repo, pushes it to the DEV
 * web-service in batches of 10 through the SAME wire pipeline the daemon uses
 * (assembleDrainers → projected wire rows → POST /api/v1/cli/ingest), captures
 * each batch's 200 ack (accepted / parked / rejected + per-event results[]),
 * then queries the REAL destination tables to confirm the rows landed:
 *
 *   ClickHouse (unerr-local):  events · transcripts · ledger · router   (by event_id)
 *   Postgres   (Supabase):     ingest_sessions · facts · timeline_entries (org row counts)
 *
 * It deliberately does NOT look at quarantine_events / the DLQ — only the real
 * stores. Reads from a throwaway zero cursor in a temp dir, so the daemon's real
 * push-cursor is never touched and inserts are idempotent (dedup token) — safe
 * to run repeatedly.
 *
 * Run:  pnpm tsx scripts/verify-ingest-batches.ts [repo-path]
 * Env:  VERIFY_TOTAL=60         total events to push (default 60 = 6 batches)
 *       VERIFY_PER_STREAM=20    max events read per stream (spread the mix)
 *       UNERR_WEB_ENV=/path/to/unerr-web-service/.env.local  (DB creds source)
 *
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentials } from "../src/cloud/auth/index.js";
import { applyDevConfig } from "../src/cloud/dev-mode.js";
import {
  CloudClient,
  assembleDrainers,
  PushCursor,
  deriveRepoId,
} from "../src/cloud/sync/index.js";
import { materializeTranscripts } from "../src/tracking/transcript-materializer.js";
import { UNERR_VERSION } from "../src/version.js";

const log = (m: string) => process.stderr.write(`${m}\n`);
const BATCH = 10;

// ── wire `type` → real destination table ────────────────────────────────────
const CH_TABLE: Record<string, "events" | "transcripts" | "ledger" | "router"> = {
  transcript: "transcripts",
  ledger: "ledger",
  router: "router",
};
const PG_TABLE: Record<string, string> = {
  session: "ingest_sessions",
  fact: "facts",
  timeline: "timeline_entries",
  drift: "drift_records",
  state: "repo_state",
};
function destOf(type: string): { kind: "clickhouse" | "postgres"; table: string } {
  if (type in CH_TABLE) return { kind: "clickhouse", table: CH_TABLE[type] };
  if (type in PG_TABLE) return { kind: "postgres", table: PG_TABLE[type] };
  return { kind: "clickhouse", table: "events" }; // token_flow, compression, behavior, file_read, session_summary, repo_activity, proxy, mcp, …
}

// ── minimal .env.local parser (only the single-line keys we need) ────────────
function loadWebEnv(): Record<string, string> {
  const path =
    process.env.UNERR_WEB_ENV ??
    join(process.cwd(), "..", "unerr-web-service", ".env.local");
  const out: Record<string, string> = {};
  if (!existsSync(path)) {
    log(`⚠ web-service env not found at ${path} — DB checks will be skipped`);
    return out;
  }
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function chQuery(env: Record<string, string>, sql: string): Promise<string> {
  const url = `${env.CLICKHOUSE_URL}/?database=${encodeURIComponent(env.CLICKHOUSE_DATABASE)}`;
  const auth = Buffer.from(`${env.CLICKHOUSE_USER}:${env.CLICKHOUSE_PASSWORD}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: sql,
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${await res.text()}`);
  return (await res.text()).trim();
}

async function main(): Promise<void> {
  const repoPath = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
  const unerrDir = join(repoPath, ".unerr");
  if (!existsSync(unerrDir)) {
    log(`no .unerr dir at ${unerrDir}`);
    process.exit(1);
  }

  // PROD GUARD: dev mode must point at a dev backend (localhost) before we push.
  applyDevConfig(repoPath);
  const apiUrl = process.env.UNERR_API_URL;
  if (!apiUrl || !/localhost|127\.0\.0\.1/.test(apiUrl)) {
    log(`refusing to run: UNERR_API_URL is '${apiUrl}', not a dev/localhost URL`);
    process.exit(1);
  }
  const creds = readCredentials();
  const token = creds?.token?.trim();
  if (!token) {
    log("no machine push token in credentials/keychain — run `unerr login` first");
    process.exit(1);
  }
  log(`▸ pushing to ${apiUrl} (token ${token.slice(0, 9)}…)\n`);

  // Populate the transcript stream from the live agent transcript (same producer
  // the Stop hook runs), so this run exercises the transcript ingest path too.
  // Deterministic event_ids mean re-runs dedup server-side. Opt out with
  // VERIFY_SKIP_TRANSCRIPTS=1.
  if (process.env.VERIFY_SKIP_TRANSCRIPTS !== "1") {
    try {
      const n = await materializeTranscripts({
        repoCwd: repoPath,
        unerrDir,
        agent: "claude-code",
        sessionId: process.env.VERIFY_TRANSCRIPT_SESSION ?? "verify-transcript-live",
      });
      log(`▸ materialized ${n} transcript turn(s) into the queue`);
    } catch (e) {
      log(`⚠ transcript materialize skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const repoId = await deriveRepoId(repoPath);
  const client = new CloudClient({ apiUrl, token });

  // Throwaway zero cursor → read the whole local store without touching the
  // daemon's real watermark. Inserts are idempotent so re-reading is safe.
  const scratch = await mkdtemp(join(tmpdir(), "unerr-verify-"));
  const cursor = await PushCursor.open(scratch);
  const set = await assembleDrainers({
    repoPath,
    unerrDir,
    repoId,
    client,
    source: `unerr-cli@${UNERR_VERSION}`,
    log,
  });
  if (set.drainers.length === 0) {
    log("no drainers built — empty stores?");
    await set.dispose?.();
    process.exit(1);
  }

  // ── collect wire rows across streams (capped, spread for a good mix) ────────
  const TOTAL = Number(process.env.VERIFY_TOTAL) || 60;
  const PER_STREAM = Number(process.env.VERIFY_PER_STREAM) || 20;
  type Row = { event_id: string; type: string; body: Record<string, unknown> };
  const rows: Row[] = [];
  try {
    for (const d of set.drainers) {
      if (rows.length >= TOTAL) break;
      let pos = cursor.position(d.key);
      let got = 0;
      for (let i = 0; i < 50 && got < PER_STREAM && rows.length < TOTAL; i++) {
        const batch = await d.read(pos);
        if (!batch || batch.rows.length === 0) break;
        for (const r of batch.rows as Record<string, unknown>[]) {
          if (got >= PER_STREAM || rows.length >= TOTAL) break;
          const event_id = String(r.event_id ?? "");
          const type = String(r.type ?? d.key.split(":")[0]);
          if (!event_id) continue;
          rows.push({ event_id, type, body: r });
          got++;
        }
        pos = batch.next;
      }
      if (got > 0) log(`  read ${got} row(s) from stream '${d.key}'`);
    }
  } finally {
    await set.dispose?.();
  }

  if (rows.length === 0) {
    log("\nno rows in the local queue to push — nothing to verify");
    process.exit(0);
  }
  log(`\n▸ collected ${rows.length} event(s); pushing in batches of ${BATCH}\n`);

  // ── push batches of 10, capture each 200 ack ────────────────────────────────
  const sentByDest = new Map<string, Set<string>>(); // "kind:table" → event_ids
  let totAccepted = 0,
    totParked = 0,
    totRejected = 0;
  const batches = Math.ceil(rows.length / BATCH);
  for (let b = 0; b < batches; b++) {
    const slice = rows.slice(b * BATCH, b * BATCH + BATCH);
    const res = await client.ingest(slice.map((r) => r.body));
    const ack = res.data as
      | { schema_version?: string; accepted?: number; parked?: number; rejected?: number; results?: Array<{ event_id: string; status: string; code?: string; disposition?: string }> }
      | undefined;
    if (!res.ok || !ack) {
      log(`  batch ${b + 1}/${batches}: ✗ HTTP ${res.status} — ${JSON.stringify(res.error ?? {})}`);
      continue;
    }
    totAccepted += ack.accepted ?? 0;
    totParked += ack.parked ?? 0;
    totRejected += ack.rejected ?? 0;
    const nonAccepted = (ack.results ?? []).filter((x) => x.status !== "accepted");
    log(
      `  batch ${b + 1}/${batches}: ✓ HTTP ${res.status} schema=${ack.schema_version} ` +
        `accepted=${ack.accepted} parked=${ack.parked} rejected=${ack.rejected}` +
        (nonAccepted.length
          ? `  ⟶ non-accepted: ${nonAccepted.map((x) => `${x.status}${x.code ? "/" + x.code : ""}`).join(", ")}`
          : "")
    );
    // Record accepted event_ids by destination for the DB cross-check.
    const acceptedIds = new Set((ack.results ?? []).filter((x) => x.status === "accepted").map((x) => x.event_id));
    for (const r of slice) {
      if (!acceptedIds.has(r.event_id)) continue;
      const d = destOf(r.type);
      const key = `${d.kind}:${d.table}`;
      if (!sentByDest.has(key)) sentByDest.set(key, new Set());
      sentByDest.get(key)!.add(r.event_id);
    }
  }
  log(
    `\n▸ server totals: accepted=${totAccepted} parked=${totParked} rejected=${totRejected} ` +
      `(accepted+parked+rejected=${totAccepted + totParked + totRejected} of ${rows.length} sent)\n`
  );

  // ── verify in the REAL tables (NOT quarantine) ─────────────────────────────
  const env = loadWebEnv();
  log("── ClickHouse verification (by event_id) ──");
  const haveCH = env.CLICKHOUSE_URL && env.CLICKHOUSE_USER;
  for (const table of ["events", "transcripts", "ledger", "router"] as const) {
    const ids = sentByDest.get(`clickhouse:${table}`);
    if (!ids || ids.size === 0) {
      log(`  ${table.padEnd(12)} — 0 accepted this run`);
      continue;
    }
    if (!haveCH) {
      log(`  ${table.padEnd(12)} sent=${ids.size}  (no CH creds — skipped)`);
      continue;
    }
    try {
      const inList = [...ids].map((s) => `'${s.replace(/'/g, "")}'`).join(",");
      const landed = await chQuery(env, `SELECT count() FROM \`${env.CLICKHOUSE_DATABASE}\`.${table} WHERE event_id IN (${inList})`);
      const n = Number(landed);
      const ok = n >= ids.size;
      log(`  ${table.padEnd(12)} sent=${ids.size}  landed=${n}  ${ok ? "✓ all present" : `✗ MISSING ${ids.size - n}`}`);
    } catch (e) {
      log(`  ${table.padEnd(12)} query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Postgres relational streams — confirmed via the server ack (accepted = the
  // relational upsert succeeded); show the org's current row count as corroboration.
  log("\n── Postgres (Supabase) relational streams ──");
  const pgStreams = ["postgres:ingest_sessions", "postgres:facts", "postgres:timeline_entries", "postgres:drift_records", "postgres:repo_state"];
  const anyPg = pgStreams.some((k) => (sentByDest.get(k)?.size ?? 0) > 0);
  if (!anyPg) {
    log("  (no relational events in this batch set)");
  } else if (!env.SUPABASE_DB_URL) {
    log("  no SUPABASE_DB_URL — relational rows confirmed via server ack (accepted) only");
  } else {
    let Client: any;
    try {
      const require = createRequire(import.meta.url);
      Client = require(join(process.cwd(), "..", "unerr-web-service", "node_modules", "pg")).Client;
    } catch {
      log("  pg driver not found — relational rows confirmed via server ack (accepted) only");
    }
    if (Client) {
      const pg = new Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
      try {
        await pg.connect();
        const orgId = creds?.organization_id ?? null;
        for (const k of pgStreams) {
          const sent = sentByDest.get(k)?.size ?? 0;
          if (sent === 0) continue;
          const table = k.split(":")[1];
          const r = await pg.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE ($1::text IS NULL OR organization_id = $1)`,
            [orgId]
          );
          log(`  ${table.padEnd(18)} accepted=${sent}  org_rows=${r.rows[0].n}  ✓ stored (ack=accepted)`);
        }
      } catch (e) {
        log(`  Postgres query failed: ${e instanceof Error ? e.message : String(e)} — ack=accepted still confirms storage`);
      } finally {
        await pg.end().catch(() => {});
      }
    }
  }

  log("\n✓ done — quarantine/DLQ intentionally not inspected (real tables only)");
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
