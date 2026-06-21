/**
 * L1 — state + drift producers. Verifies that the per-file content-hash
 * writer (setFileHash, reached via indexFilesIncremental) and the comment-drift
 * detector (upsertAnnotations) each mirror their observation into the unified
 * per-repo event store as one contract-shaped event. HR-2: the file path lands
 * as a HASH (`file_id`) and the drifted entity as a HASH (`anchor`) — never the
 * raw path/key. Every emitted row validates against the @unerr-ai/contracts
 * IngestEvent union.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IngestEvent } from "@unerr-ai/contracts/ingest";
import { _resetEmitContextForTest, configureEmit } from "../events/enqueue.js";
import { PROXY_SEGMENT, segmentPath } from "../events/event-store.js";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import { indexFilesIncremental } from "../intelligence/incremental-indexer.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import {
  collectAnnotationCandidates,
  gateCandidates,
  upsertAnnotations,
} from "../intelligence/semantic/annotation-indexer.js";

const REPO_ID = "testrepo";
const HEX16 = /^[0-9a-f]{16}$/;

async function createCozoDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const Ctor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (Ctor as any)("mem", "") as CozoDb;
}

function readEvents(repoRoot: string, type: string): Record<string, unknown>[] {
  const segment = segmentPath(repoRoot, PROXY_SEGMENT);
  if (!existsSync(segment)) return [];
  const lines = readFileSync(segment, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

describe("L1 state + drift producers", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "unerr-state-drift-emit-"));
    _resetEmitContextForTest();
    configureEmit({
      repoRoot,
      segment: PROXY_SEGMENT,
      source: "unerr-cli@test",
    });
  });

  afterEach(() => {
    _resetEmitContextForTest();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("setFileHash emits a state event with a hashed file_id (not the raw path)", async () => {
    const db = await createCozoDb();
    await initSchema(db);
    const store = await CozoGraphStore.create(db);

    writeFileSync(
      join(repoRoot, "foo.ts"),
      "export function foo() { return 1; }\nexport function bar() { return 2; }\n"
    );
    await indexFilesIncremental(repoRoot, ["foo.ts"], store, REPO_ID);

    const stateEvents = readEvents(repoRoot, "state");
    expect(stateEvents.length).toBeGreaterThanOrEqual(1);

    const detail = stateEvents[0]?.detail as Record<string, unknown>;
    // file_id is a 16-hex hash, NEVER the raw path.
    expect(detail.file_id).toMatch(HEX16);
    expect(detail.file_id).not.toBe("foo.ts");
    expect(JSON.stringify(detail)).not.toContain("foo.ts");
    // content_hash present (already a hash, passed through).
    expect(typeof detail.content_hash).toBe("string");
    expect((detail.content_hash as string).length).toBeGreaterThan(0);
    expect(typeof detail.observed_at).toBe("string");

    // Every emitted row is a valid contract IngestEvent.
    for (const ev of stateEvents) {
      expect(IngestEvent.safeParse(ev).success).toBe(true);
    }
  });

  it("comment-drift detection emits a drift event with a hashed anchor (not the raw entity key)", async () => {
    const db = await createCozoDb();
    await initSchema(db);

    const FIXTURE = `/**
 * Validates a session token against the active key set — the auth boundary
 * every inbound API call funnels through.
 * @sem domain=auth role=gateway stability=frozen
 */
export function validateToken(token: string) {}
`;
    const TARGETS = [
      {
        key: "e:validateToken",
        name: "validateToken",
        startLine: 6,
        endLine: 6,
      },
    ];
    const BODY = "export function validateToken(token: string) {}";
    const EDITED_BODY =
      "export function validateToken(token: string) { return token; }";

    // First pass: insert the annotation (active, no drift).
    await upsertAnnotations(
      db,
      gateCandidates(collectAnnotationCandidates(FIXTURE, TARGETS))
    );
    expect(readEvents(repoRoot, "drift")).toHaveLength(0);

    // Second pass: body moves (content_hash changes), comment is byte-identical
    // (comment_hash unchanged) → comment_drift fires.
    const edited = FIXTURE.replace(BODY, EDITED_BODY);
    const written = await upsertAnnotations(
      db,
      gateCandidates(collectAnnotationCandidates(edited, TARGETS))
    );
    expect(written).toBe(1);

    const driftEvents = readEvents(repoRoot, "drift");
    expect(driftEvents).toHaveLength(1);

    const detail = driftEvents[0]?.detail as Record<string, unknown>;
    // anchor is a 16-hex hash, NEVER the raw entity key.
    expect(detail.anchor).toMatch(HEX16);
    expect(detail.anchor).not.toContain("validateToken");
    expect(JSON.stringify(detail)).not.toContain("validateToken");
    expect(detail.drift_kind).toBe("comment_drift");
    expect(typeof detail.client_drift_id).toBe("string");
    expect(typeof detail.detected_at).toBe("string");

    // Every emitted row is a valid contract IngestEvent.
    for (const ev of driftEvents) {
      expect(IngestEvent.safeParse(ev).success).toBe(true);
    }
  });
});
