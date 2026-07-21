/**
 * Stop-persist detached worker.
 *
 * Three contracts under test:
 *   1. The Stop hook DELEGATES persistence — `spawnStopPersistWorker` spawns a
 *      detached `unerr hook stop-persist --transcript <path>` child (no stdin;
 *      the path rides argv) and the economy-line path never awaits UDS writes.
 *   2. The worker body re-reads the transcript, scrapes MARKER sentinels
 *      (intent/decision/blocker/resolution), and persists each over UDS by
 *      tool name. `unerr-save: note` lines are NOT scraped — the anchored-note
 *      system was removed (2026-07 active-memory strip); a leftover note line
 *      in a closing message is silently ignored.
 *   3. Both sides degrade silently: no transcript / no sentinels / no proxy
 *      socket → no spawn, zero persisted, never a throw.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import {
  runStopPersistWorkerAsync,
  spawnStopPersistWorker,
} from "../hooks/stop-hooks.js";

function shortSockPath(): string {
  // Keep the path short — macOS sun_path is capped at ~104 bytes.
  return join(
    tmpdir(),
    `ur-sp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  );
}

/** Write a Claude Code transcript JSONL whose last assistant turn is `text`. */
function writeTranscript(dir: string, text: string): string {
  const path = join(dir, "transcript.jsonl");
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
    }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const CLOSING_WITH_SAVES = [
  "Done — callers updated.",
  "unerr-save: note rul|f:src/x.ts|-|no intelligence imports",
  "unerr-save: intent migrate the y module",
].join("\n");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unerr-stop-persist-"));
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ unref: vi.fn() });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── spawnStopPersistWorker — the Stop-hook side ──────────────────────

describe("spawnStopPersistWorker", () => {
  it("spawns a detached, unref'd worker when the closing message carries sentinels", () => {
    const transcript = writeTranscript(dir, CLOSING_WITH_SAVES);
    const unref = vi.fn();
    spawnMock.mockReturnValue({ unref });

    const spawned = spawnStopPersistWorker(
      JSON.stringify({ transcript_path: transcript })
    );

    expect(spawned).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [execPath, args, opts] = spawnMock.mock.calls[0]!;
    expect(execPath).toBe(process.execPath);
    expect(args).toEqual([
      process.argv[1],
      "hook",
      "stop-persist",
      "--transcript",
      transcript,
    ]);
    // Detached + ignored stdio is what lets the child outlive the hook
    // subprocess; unref() releases the parent's event loop.
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("does not spawn when the closing message has no sentinels", () => {
    const transcript = writeTranscript(dir, "Done — nothing to persist.");
    expect(
      spawnStopPersistWorker(JSON.stringify({ transcript_path: transcript }))
    ).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not spawn when transcript_path is missing or the payload is malformed", () => {
    expect(spawnStopPersistWorker(JSON.stringify({}))).toBe(false);
    expect(spawnStopPersistWorker("not-json")).toBe(false);
    expect(
      spawnStopPersistWorker(
        JSON.stringify({ transcript_path: join(dir, "no-such.jsonl") })
      )
    ).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ── runStopPersistWorkerAsync — the detached-child side ──────────────

describe("runStopPersistWorkerAsync", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("persists marker sentinels over UDS and ignores leftover note lines", async () => {
    const transcript = writeTranscript(dir, CLOSING_WITH_SAVES);
    const sockPath = shortSockPath();
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];

    server = createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as {
          id?: number;
          params?: { name: string; arguments: Record<string, unknown> };
        };
        if (req.params) calls.push(req.params);
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} })}\n`
        );
      });
    });
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));

    const persisted = await runStopPersistWorkerAsync(transcript, {
      sockPath,
      timeoutMs: 500,
    });

    // The fixture carries a note line AND an intent line — only the marker
    // persists; the note sentinel is dead vocabulary and must not dispatch.
    expect(persisted).toBe(1);
    expect(calls.map((c) => c.name)).toEqual(["mark_intent"]);
    expect(calls[0]!.arguments).toEqual({ text: "migrate the y module" });
  });

  it("returns 0 when the proxy socket is absent (saves dropped, never thrown)", async () => {
    const transcript = writeTranscript(dir, CLOSING_WITH_SAVES);
    await expect(
      runStopPersistWorkerAsync(transcript, {
        sockPath: shortSockPath(),
        timeoutMs: 50,
      })
    ).resolves.toBe(0);
  });

  it("returns 0 for a missing transcript or a sentinel-free closing message", async () => {
    await expect(
      runStopPersistWorkerAsync(join(dir, "no-such.jsonl"))
    ).resolves.toBe(0);
    const clean = writeTranscript(dir, "All done.");
    await expect(runStopPersistWorkerAsync(clean)).resolves.toBe(0);
  });
});
