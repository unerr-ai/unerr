/**
 * Cap A-1: trajectory trace capture.
 *
 * Verifies that resolving a blocker synthesizes a trace with:
 *   - non-empty dead_ends derived from the ledger span
 *   - situation tokens indexed in trace_tokens
 *   - correct situation/unlock/anchor from the marker pair
 *
 * Also verifies the sentinel-scrape optional dead_ends refinement.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSentinelBody } from "../hooks/sentinel-scrape.js";
import { CozoTimelineStore } from "../timeline/timeline-store.js";
import { handleMarkerCall } from "../tools/intelligence/timeline-markers.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";

let tempDir: string;
let unerrDir: string;
let ledger: ShadowLedger;
let store: CozoTimelineStore;

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `unerr-trace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  unerrDir = join(tempDir, ".unerr");
  mkdirSync(unerrDir, { recursive: true });
  ledger = new ShadowLedger(unerrDir);
  store = await CozoTimelineStore.create(tempDir);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("trajectory trace capture (Cap A-1)", () => {
  it("blocker+resolution writes a trace with non-empty dead_ends and situation_tokens", async () => {
    const deps = { ledger, store, branch: "main", headSha: "abc123" };

    // 1. Record a blocker — returns marker_id the agent passes to mark_resolution.
    const blockerResult = await handleMarkerCall(
      "mark_blocker",
      {
        text: "Cannot resolve TypeScript error in auth module",
        file_path: "src/auth/token.ts",
      },
      deps
    );
    const blockerBody = JSON.parse(blockerResult.content[0]!.text) as {
      ok: boolean;
      marker_id: string;
    };
    expect(blockerBody.ok).toBe(true);
    const markerId = blockerBody.marker_id;

    // 2. Simulate intermediate tool calls that become dead_ends.
    ledger.record(
      "file_read",
      { file_path: "src/auth/session.ts" },
      { ok: true },
      "main",
      "abc123"
    );
    ledger.record(
      "search_code",
      { query: "token validation", entity: "TokenValidator" },
      { ok: true },
      "main",
      "abc123"
    );
    ledger.record(
      "file_read",
      { file_path: "src/auth/middleware.ts" },
      { ok: true },
      "main",
      "abc123"
    );

    // 3. Record the resolution.
    const resResult = await handleMarkerCall(
      "mark_resolution",
      {
        text: "Fixed by adding await to getToken() call",
        blocker_ref: markerId,
      },
      deps
    );
    expect(JSON.parse(resResult.content[0]!.text)).toMatchObject({ ok: true });

    // 4. synthesizeTrace is fire-and-forget — wait for it to complete.
    await new Promise<void>((r) => setTimeout(r, 150));

    // 5. Verify trace row.
    const db = store.getDb();
    const tracesResult = await db.run(
      `?[trace_id, situation, dead_ends, unlock, anchor] :=
        *traces{trace_id, situation, dead_ends, unlock, anchor}`
    );
    expect(tracesResult.rows.length).toBe(1);

    const [, situation, deadEndsJson, unlock, anchor] = tracesResult.rows[0]!;
    expect(situation as string).toContain("TypeScript error");
    expect(unlock as string).toContain("Fixed");
    expect(anchor as string).toBe("src/auth/token.ts");

    // 6. dead_ends must include the intermediate file paths (not the anchor).
    const deadEnds: string[] = JSON.parse(deadEndsJson as string);
    expect(deadEnds.length).toBeGreaterThan(0);
    expect(deadEnds).toContain("src/auth/session.ts");
    expect(deadEnds).not.toContain("src/auth/token.ts"); // anchor excluded

    // 7. situation tokens must be indexed.
    const tokensResult = await db.run(
      "?[token, trace_id] := *trace_tokens[token, trace_id]"
    );
    expect(tokensResult.rows.length).toBeGreaterThan(0);
  });

  it("recallTracesByTokens returns matching traces", async () => {
    const deps = { ledger, store, branch: "main", headSha: "abc123" };

    const blockerResult = await handleMarkerCall(
      "mark_blocker",
      {
        text: "cozo schema migration fails on startup",
        file_path: "src/intelligence/cozo-schema.ts",
      },
      deps
    );
    const { marker_id } = JSON.parse(blockerResult.content[0]!.text) as {
      ok: boolean;
      marker_id: string;
    };

    ledger.record(
      "file_read",
      { file_path: "src/intelligence/facts-schema.ts" },
      { ok: true },
      "main",
      "abc123"
    );

    await handleMarkerCall(
      "mark_resolution",
      { text: "added missing column default", blocker_ref: marker_id },
      deps
    );

    await new Promise<void>((r) => setTimeout(r, 150));

    // "schema" or "cozo" should match the tokenized situation.
    const results = await store.recallTracesByTokens(["cozo", "schema"], 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.situation).toContain("cozo schema");
  });
});

describe("sentinel-scrape: resolution dead_ends refinement", () => {
  it("parses `| dead_ends:` suffix into refinedDeadEnds", () => {
    const save = parseSentinelBody(
      "resolution The fix was X | dead_ends:src/a.ts,src/b.ts"
    );
    expect(save).not.toBeNull();
    expect(save?.kind).toBe("marker");
    if (save?.kind === "marker") {
      expect(save.op).toBe("resolution");
      expect(save.text).toBe("The fix was X");
      expect(save.refinedDeadEnds).toEqual(["src/a.ts", "src/b.ts"]);
    }
  });

  it("plain resolution without suffix parses normally (no refinedDeadEnds)", () => {
    const save = parseSentinelBody("resolution Fixed the null pointer");
    expect(save).not.toBeNull();
    if (save?.kind === "marker") {
      expect(save.op).toBe("resolution");
      expect(save.text).toBe("Fixed the null pointer");
      expect(save.refinedDeadEnds).toBeUndefined();
    }
  });
});
