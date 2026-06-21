/**
 * L1 — `enqueue` / `emit`. Verifies the identity envelope is stamped at emit
 * (event_id, ts, schema_version, source + ambient repo/agent/session), per-event
 * overrides win over ambient context, optional fields are omitted when unknown,
 * and the configured-context `emit` no-ops until `configureEmit` runs.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type EmitContext,
  _resetEmitContextForTest,
  configureEmit,
  emit,
  enqueue,
  stampEvent,
  updateEmitContext,
} from "../events/enqueue.js";
import {
  PROXY_SEGMENT,
  readSegmentFrom,
  segmentPath,
} from "../events/event-store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ctx(repoRoot: string): EmitContext {
  return {
    repoRoot,
    segment: PROXY_SEGMENT,
    source: "unerr-cli@test",
    repo: "repohash",
    agent: "claude-code",
    session_id: "sess-1",
    branch: "main",
    commit: "abc123",
  };
}

describe("L1 enqueue / emit", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "unerr-enqueue-"));
    _resetEmitContextForTest();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    _resetEmitContextForTest();
  });

  it("stamps the full identity envelope at emit", () => {
    const e = stampEvent(ctx(repo), {
      type: "behavior",
      detail: { behavior: "cascade_guard" },
      turn: 3,
    });
    expect(e.type).toBe("behavior");
    expect(e.schema_version).toMatch(/^1-0-\d+$/);
    expect(e.event_id).toMatch(UUID_RE);
    expect(typeof e.ts).toBe("string");
    expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
    expect(e.source).toBe("unerr-cli@test");
    expect(e.repo).toBe("repohash");
    expect(e.agent).toBe("claude-code");
    expect(e.session_id).toBe("sess-1");
    expect(e.branch).toBe("main");
    expect(e.commit).toBe("abc123");
    expect(e.turn).toBe(3);
    expect(e.detail).toEqual({ behavior: "cascade_guard" });
  });

  it("gives each event a distinct idempotency key", () => {
    const a = stampEvent(ctx(repo), { type: "token_flow", detail: {} });
    const b = stampEvent(ctx(repo), { type: "token_flow", detail: {} });
    expect(a.event_id).not.toBe(b.event_id);
  });

  it("lets a per-event field override ambient context", () => {
    const e = stampEvent(ctx(repo), {
      type: "timeline",
      detail: { kind: "intent", label: "x" },
      session_id: "override-sess",
      branch: "feature",
    });
    expect(e.session_id).toBe("override-sess");
    expect(e.branch).toBe("feature");
  });

  it("omits optional fields that are unknown (no null keys on the wire)", () => {
    const bare: EmitContext = {
      repoRoot: repo,
      segment: PROXY_SEGMENT,
      source: "unerr-cli@test",
    };
    const e = stampEvent(bare, { type: "token_flow", detail: {} });
    expect("repo" in e).toBe(false);
    expect("agent" in e).toBe(false);
    expect("session_id" in e).toBe(false);
    expect("branch" in e).toBe(false);
    expect("turn" in e).toBe(false);
  });

  it("enqueue appends a readable contract-shaped line to the segment", () => {
    enqueue(ctx(repo), { type: "behavior", detail: { behavior: "boundary" } });
    const slice = readSegmentFrom(segmentPath(repo, PROXY_SEGMENT), 0);
    expect(slice.events).toHaveLength(1);
    expect(slice.events[0]?.type).toBe("behavior");
  });

  it("emit no-ops until configureEmit runs, then writes", () => {
    emit({ type: "token_flow", detail: {} });
    expect(
      readSegmentFrom(segmentPath(repo, PROXY_SEGMENT), 0).events
    ).toHaveLength(0);

    configureEmit(ctx(repo));
    emit({ type: "token_flow", detail: { tokens_saved: 5 } });
    const slice = readSegmentFrom(segmentPath(repo, PROXY_SEGMENT), 0);
    expect(slice.events).toHaveLength(1);
    expect(slice.events[0]?.type).toBe("token_flow");
  });

  it("updateEmitContext merges new ambient identity into emit", () => {
    configureEmit(ctx(repo));
    updateEmitContext({ session_id: "sess-2", branch: "release" });
    emit({ type: "token_flow", detail: {} });
    const e = readSegmentFrom(segmentPath(repo, PROXY_SEGMENT), 0).events[0];
    expect(e?.session_id).toBe("sess-2");
    expect(e?.branch).toBe("release");
  });
});
