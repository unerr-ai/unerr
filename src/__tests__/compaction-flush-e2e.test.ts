/**
 * Compaction flush end-to-end (cost lever 3).
 *
 * Real hook subcommand → real UDS socket → real `handleCompactionRequest` →
 * real `BodyDedupStore`. Nothing here is mocked except the proxy's socket
 * server, which is wired exactly as proxy.ts wires it (one line-delimited
 * JSON-RPC frame in, one out).
 *
 * Covers: the PostCompact path, the SessionStart(compact) fallback path,
 * idempotent double-fire, session scoping, and every fail-open mode (no socket,
 * dead socket, malformed reply).
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergePreToolUseBashHook,
  removePreToolUseBashHook,
} from "../config/claude-settings-hooks.js";
import {
  runPostCompactHookAsync,
  signalCompaction,
} from "../hooks/compaction-hooks.js";
import { runSessionStartHookAsync } from "../hooks/session-hooks.js";
import {
  COMPACTION_METHOD,
  handleCompactionRequest,
} from "../proxy/compaction-protocol.js";
import {
  type BodyDedupStore,
  createBodyDedup,
} from "../proxy/session-dedup.js";

const MTIME = 1_700_000_000_000;
const TOKENS = 120;
const A = { sessionId: "bridge-A", nativeSessionId: "nat-A" };
const B = { sessionId: "bridge-B", nativeSessionId: "nat-B" };

/** Claude Code PostCompact payload (matcher values are manual|auto). */
function postCompactPayload(sessionId: string, trigger = "auto"): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: "PostCompact",
    trigger,
    compact_summary: "…",
    cwd: process.cwd(),
  });
}

/** Claude Code SessionStart payload. */
function sessionStartPayload(sessionId: string, source: string): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: "SessionStart",
    source,
    cwd: process.cwd(),
  });
}

describe("compaction flush e2e — hook → UDS → dedup store", () => {
  const origCwd = process.cwd();
  let tmpRepo: string;
  let server: Server | null = null;
  let store: BodyDedupStore;
  /** Every ack the fake proxy sent back, so a test can assert the count. */
  let acks: number[];

  beforeEach(async () => {
    // Short base keeps the nested sun_path under macOS's ~104B cap.
    tmpRepo = mkdtempSync(join(tmpdir(), "ur-cf-"));
    mkdirSync(join(tmpRepo, ".unerr", "state"), { recursive: true });
    store = createBodyDedup();
    acks = [];

    // Same wiring as the proxy's UDS handler: intercept the compaction method.
    server = createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as {
          id?: number;
          method?: string;
          params?: Parameters<typeof handleCompactionRequest>[1];
        };
        if (req.method === COMPACTION_METHOD) {
          const result = handleCompactionRequest(store, req.params);
          acks.push(result.dropped);
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`
          );
        } else {
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601 } })}\n`
          );
        }
      });
    });
    const sockPath = join(tmpRepo, ".unerr", "state", "proxy.sock");
    await new Promise<void>((resolve) => server?.listen(sockPath, resolve));
    process.chdir(tmpRepo);
  });

  afterEach(() => {
    process.chdir(origCwd);
    server?.close();
    server = null;
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("PostCompact hook drops the delivered-body entry for that conversation", async () => {
    store.record(
      "/repo/src/foo.ts",
      MTIME,
      1,
      TOKENS,
      undefined,
      undefined,
      undefined,
      A
    );

    const out = await runPostCompactHookAsync(postCompactPayload("nat-A"));

    // PostCompact has no decision control — the hook prints valid empty JSON.
    expect(out).toBe("{}");
    expect(acks).toEqual([1]);
    expect(
      store.check(
        "/repo/src/foo.ts",
        MTIME,
        2,
        undefined,
        undefined,
        undefined,
        A
      )
    ).toBeNull();
    // The signal also widened the recency window.
    expect(store.recencyWindowTurns()).toBe(50);
  });

  it("a second flush for the same compaction reports 0 (idempotent)", async () => {
    store.record(
      "/repo/src/foo.ts",
      MTIME,
      1,
      TOKENS,
      undefined,
      undefined,
      undefined,
      A
    );
    // Both hooks fire for one compaction: PostCompact first, then SessionStart.
    await runPostCompactHookAsync(postCompactPayload("nat-A"));
    await runSessionStartHookAsync(sessionStartPayload("nat-A", "compact"));
    expect(acks).toEqual([1, 0]);
  });

  it("SessionStart(source=compact) alone flushes — the no-PostCompact fallback", async () => {
    store.record(
      "/repo/src/foo.ts",
      MTIME,
      1,
      TOKENS,
      undefined,
      undefined,
      undefined,
      A
    );
    const out = await runSessionStartHookAsync(
      sessionStartPayload("nat-A", "compact")
    );
    // Still valid hook JSON (the resume strip path is unaffected).
    expect(() => JSON.parse(out)).not.toThrow();
    expect(acks).toEqual([1]);
  });

  it("SessionStart(source=clear) drops every conversation's entries", async () => {
    store.record("/a.ts", MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    store.record("/b.ts", MTIME, 1, TOKENS, undefined, undefined, undefined, B);
    await runSessionStartHookAsync(sessionStartPayload("nat-new", "clear"));
    expect(acks).toEqual([2]);
  });

  it("SessionStart(source=startup|resume) sends nothing — nothing was evicted", async () => {
    store.record("/a.ts", MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    await runSessionStartHookAsync(sessionStartPayload("nat-A", "startup"));
    await runSessionStartHookAsync(sessionStartPayload("nat-A", "resume"));
    expect(acks).toEqual([]);
    expect(store.isCompactionSignalled()).toBe(false);
    expect(
      store.check("/a.ts", MTIME, 2, undefined, undefined, undefined, A)
    ).toEqual({ deliveredTurn: 1, tokens: TOKENS });
  });

  it("the client returns the proxy's dropped count (ack parsed off the wire)", async () => {
    store.record("/a.ts", MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    store.record("/b.ts", MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    const dropped = await signalCompaction({
      trigger: "compact",
      sessionId: "nat-A",
    });
    expect(dropped).toBe(2);
  });

  it("a compaction in conversation A leaves conversation B's entries alone", async () => {
    store.record("/a.ts", MTIME, 1, TOKENS, undefined, undefined, undefined, A);
    store.record("/b.ts", MTIME, 1, TOKENS, undefined, undefined, undefined, B);
    await runPostCompactHookAsync(postCompactPayload("nat-A"));
    expect(acks).toEqual([1]);
    expect(
      store.check("/b.ts", MTIME, 2, undefined, undefined, undefined, B)
    ).toEqual({ deliveredTurn: 1, tokens: TOKENS });
  });
});

describe("compaction flush e2e — fail open", () => {
  const origCwd = process.cwd();
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), "ur-cf-"));
    mkdirSync(join(tmpRepo, ".unerr", "state"), { recursive: true });
    process.chdir(tmpRepo);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("no listener at all: hook still returns valid JSON", async () => {
    const out = await runPostCompactHookAsync(postCompactPayload("nat-A"));
    expect(out).toBe("{}");
  });

  it("stale socket path (nothing accepting): hook still returns valid JSON", async () => {
    // A leftover regular file where the socket used to be — connect() errors.
    writeFileSync(join(tmpRepo, ".unerr", "state", "proxy.sock"), "stale");
    const out = await runPostCompactHookAsync(postCompactPayload("nat-A"));
    expect(out).toBe("{}");
  });

  it("malformed reply: hook still returns valid JSON", async () => {
    const server = createServer((socket) => {
      socket.on("data", () => socket.write("not json\n"));
    });
    await new Promise<void>((resolve) =>
      server.listen(join(tmpRepo, ".unerr", "state", "proxy.sock"), resolve)
    );
    try {
      const out = await runPostCompactHookAsync(postCompactPayload("nat-A"));
      expect(out).toBe("{}");
    } finally {
      server.close();
    }
  });

  it("garbage stdin: hook still returns valid JSON", async () => {
    const out = await runPostCompactHookAsync("}{ not json");
    expect(out).toBe("{}");
  });
});

describe("PostCompact hook registration", () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), "ur-cr-"));
    mkdirSync(join(tmpRepo, ".claude"), { recursive: true });
  });

  afterEach(() => rmSync(tmpRepo, { recursive: true, force: true }));

  function readHooks(): Record<
    string,
    Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
  > {
    const raw = readFileSync(
      join(tmpRepo, ".claude", "settings.json"),
      "utf-8"
    );
    return (JSON.parse(raw).hooks ?? {}) as Record<
      string,
      Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
    >;
  }

  it("registers PostCompact with matcher manual|auto pointing at hook post-compact", () => {
    mergePreToolUseBashHook(tmpRepo);
    const entries = readHooks().PostCompact ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.matcher).toBe("manual|auto");
    const cmds = (entries[0]?.hooks ?? []).map((h) => h.command ?? "");
    expect(cmds.some((c) => /hook post-compact$/.test(c))).toBe(true);
  });

  it("keeps the SessionStart fallback matcher (older Claude Code has no PostCompact)", () => {
    mergePreToolUseBashHook(tmpRepo);
    const entries = readHooks().SessionStart ?? [];
    expect(entries[0]?.matcher).toBe("startup|resume|clear|compact");
  });

  it("uninstall strips the PostCompact entry", () => {
    mergePreToolUseBashHook(tmpRepo);
    expect(removePreToolUseBashHook(tmpRepo)).toBe(true);
    expect(readHooks().PostCompact).toBeUndefined();
  });
});
