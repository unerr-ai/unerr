/**
 * ST-2a: timeline marker tool handlers.
 * Verifies dual-write (ledger + timeline.db.markers), validation, and turn
 * stamping inheritance from the segmenter.
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleMarkerCall,
  isMarkerTool,
  MARKER_TOOLS,
} from "../tools/intelligence/timeline-markers.js";
import { ShadowLedger } from "../tracking/shadow-ledger.js";
import { CozoTimelineStore } from "../timeline/timeline-store.js";

let tempDir: string;
let unerrDir: string;
let ledger: ShadowLedger;
let store: CozoTimelineStore;

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `unerr-mk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("isMarkerTool / MARKER_TOOLS", () => {
  it("recognises all four marker names", () => {
    expect(MARKER_TOOLS).toEqual([
      "mark_intent",
      "mark_decision",
      "mark_blocker",
      "mark_resolution",
    ]);
    for (const t of MARKER_TOOLS) {
      expect(isMarkerTool(t)).toBe(true);
    }
    expect(isMarkerTool("file_read")).toBe(false);
    expect(isMarkerTool("mark_anything_else")).toBe(false);
  });
});

describe("handleMarkerCall — happy paths", () => {
  it("mark_intent writes a ledger row AND a markers row", async () => {
    const res = await handleMarkerCall(
      "mark_intent",
      { text: "refactor auth" },
      { ledger, store, branch: "main", headSha: "deadbeef" },
    );
    const body = JSON.parse(res.content[0]!.text);
    expect(body.ok).toBe(true);
    expect(body.type).toBe("mark_intent");
    expect(body.marker_id).toMatch(/^[a-f0-9]{12}$/);
    expect(body.turn_id).toMatch(/^[a-f0-9]{12}$/);

    // Ledger row
    const ledgerLines = readFileSync(
      join(unerrDir, "ledger", "shadow.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ledgerLines).toHaveLength(1);
    expect(ledgerLines[0].tool).toBe("mark_intent");
    expect(ledgerLines[0].args_summary.text).toBe("refactor auth");
    expect(ledgerLines[0].turn_id).toBe(body.turn_id);

    // Timeline.db row
    const markers = await store.listMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]!.marker_id).toBe(body.marker_id);
    expect(markers[0]!.type).toBe("mark_intent");
    expect(markers[0]!.text).toBe("refactor auth");
    expect(markers[0]!.turn_id).toBe(body.turn_id);
  });

  it("mark_decision persists alternatives (capped)", async () => {
    await handleMarkerCall(
      "mark_decision",
      {
        text: "JWT over session cookies",
        alternatives: ["session cookies", "OAuth proxy", "API tokens"],
      },
      { ledger, store, branch: "main", headSha: "x" },
    );
    const lines = readFileSync(
      join(unerrDir, "ledger", "shadow.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].args_summary.alternatives).toEqual([
      "session cookies",
      "OAuth proxy",
      "API tokens",
    ]);
  });

  it("mark_blocker carries file_path through to timeline.db", async () => {
    const res = await handleMarkerCall(
      "mark_blocker",
      { text: "type error in verify", file_path: "src/auth/token.ts" },
      { ledger, store, branch: "main", headSha: "x" },
    );
    const body = JSON.parse(res.content[0]!.text);
    const markers = await store.listMarkers({ type: "mark_blocker" });
    expect(markers).toHaveLength(1);
    expect(markers[0]!.marker_id).toBe(body.marker_id);
    expect(markers[0]!.file_path).toBe("src/auth/token.ts");
  });

  it("redacts secrets in BOTH the ledger row AND the timeline.db markers row", async () => {
    // Regression — live test on 2026-05-12 found the redactor only ran on
    // shadow.jsonl; raw tokens leaked into timeline.db.markers.text.
    const tokenish = "GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const res = await handleMarkerCall(
      "mark_blocker",
      { text: `auth fails when ${tokenish} is set`, file_path: "src/auth.ts" },
      { ledger, store, branch: "main", headSha: "x" },
    );
    const body = JSON.parse(res.content[0]!.text);
    expect(body.ok).toBe(true);

    // Ledger redacted
    const ledgerLines = readFileSync(
      join(unerrDir, "ledger", "shadow.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ledgerRow = ledgerLines.find((r) => r.id === body.marker_id);
    expect(ledgerRow.args_summary.text).not.toContain("ghp_");
    expect(ledgerRow.args_summary.text).toContain("<redacted>");

    // Timeline.db markers row also redacted (the bug)
    const markers = await store.listMarkers({ type: "mark_blocker" });
    const row = markers.find((m) => m.marker_id === body.marker_id);
    expect(row).toBeDefined();
    expect(row!.text).not.toContain("ghp_");
    expect(row!.text).toContain("<redacted>");
  });

  it("mark_resolution links to blocker via blocker_ref", async () => {
    const blocker = await handleMarkerCall(
      "mark_blocker",
      { text: "type error" },
      { ledger, store, branch: "main", headSha: "x" },
    );
    const blockerId = JSON.parse(blocker.content[0]!.text).marker_id;

    const res = await handleMarkerCall(
      "mark_resolution",
      { blocker_ref: blockerId, text: "fixed by import bump" },
      { ledger, store, branch: "main", headSha: "x" },
    );
    const body = JSON.parse(res.content[0]!.text);
    expect(body.ok).toBe(true);

    const resolutions = await store.listMarkers({ type: "mark_resolution" });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.blocker_ref).toBe(blockerId);
  });
});

describe("handleMarkerCall — validation", () => {
  it("rejects empty text", async () => {
    const res = await handleMarkerCall(
      "mark_intent",
      { text: "   " },
      { ledger, store, branch: "main", headSha: "x" },
    );
    const body = JSON.parse(res.content[0]!.text);
    expect(body.error).toMatch(/required/);
  });

  it("rejects over-cap text per tool", async () => {
    const long = "x".repeat(200);
    const res = await handleMarkerCall(
      "mark_intent",
      { text: long },
      { ledger, store, branch: "main", headSha: "x" },
    );
    const body = JSON.parse(res.content[0]!.text);
    expect(body.error).toMatch(/80/);
  });

  it("mark_resolution requires blocker_ref", async () => {
    const res = await handleMarkerCall(
      "mark_resolution",
      { text: "fixed" },
      { ledger, store, branch: "main", headSha: "x" },
    );
    const body = JSON.parse(res.content[0]!.text);
    expect(body.error).toMatch(/blocker_ref required/);
  });
});
