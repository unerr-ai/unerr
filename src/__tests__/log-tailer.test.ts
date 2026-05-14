import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"; // appendFileSync + writeFileSync still used for unerr.jsonl JSONL tests
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";
import { startupLog } from "../utils/startup-log.js";

// Mock startupLog to capture output
vi.mock("../utils/startup-log.js", () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    startupLog: {
      step: (...args: unknown[]) => calls.push({ method: "step", args }),
      done: (...args: unknown[]) => calls.push({ method: "done", args }),
      warn: (...args: unknown[]) => calls.push({ method: "warn", args }),
      error: (...args: unknown[]) => calls.push({ method: "error", args }),
      tokenFlow: (...args: unknown[]) =>
        calls.push({ method: "tokenFlow", args }),
      fmt: {
        muted: (s: string) => s,
        dim: (s: string) => s,
        cyan: (s: string) => s,
        bold: (s: string) => s,
      },
      _calls: calls,
      _reset: () => {
        calls.length = 0;
      },
    },
  };
});

function getCalls() {
  return (
    startupLog as unknown as {
      _calls: Array<{ method: string; args: unknown[] }>;
    }
  )._calls;
}
function resetCalls() {
  (startupLog as unknown as { _reset: () => void })._reset();
}

describe("log-tailer", () => {
  let tmpDir: string;
  let unerrDir: string;
  let logsDir: string;

  beforeEach(() => {
    tmpDir = join(
      os.tmpdir(),
      `unerr-tailer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    unerrDir = join(tmpDir, ".unerr");
    logsDir = join(unerrDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    resetCalls();
  });

  afterEach(() => {
    closeMetricsStore(unerrDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("startLogTailer returns a handle with close()", async () => {
    const { startLogTailer } = await import("../proxy/log-tailer.js");
    const handle = startLogTailer(tmpDir);
    expect(handle).toBeDefined();
    expect(typeof handle.close).toBe("function");
    handle.close();
  });

  it("polls compression rows from metrics.db", async () => {
    const { startLogTailer } = await import("../proxy/log-tailer.js");
    const handle = startLogTailer(tmpDir, { pollIntervalMs: 50 });

    // Insert after the tailer has captured its initial lastIds.
    openMetricsStore(unerrDir).insertCompression({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      command: "ps aux",
      category: "tabular",
      confidence: 0.85,
      raw_bytes: 1000,
      compressed_bytes: 300,
      saved_pct: 70,
      omni_fallback: 0,
      tee_file: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const calls = getCalls();
    const compressionCall = calls.find(
      (c) => c.method === "step" && String(c.args[0]).includes("ps aux"),
    );
    expect(compressionCall).toBeDefined();

    handle.close();
  });

  it("polls token-flow rows and filters own-PID", async () => {
    const { startLogTailer } = await import("../proxy/log-tailer.js");
    const handle = startLogTailer(tmpDir, { pollIntervalMs: 50 });

    const store = openMetricsStore(unerrDir);
    const ts = Date.now();
    // Own PID — should be filtered out by printTokenFlowEntry
    store.insertTokenFlow({
      ts,
      ts_iso: new Date(ts).toISOString(),
      session_id: "s1",
      pid: process.pid,
      turn: 1,
      mechanism: "graph_query",
      tool: "get_callers",
      tokens_without: 150,
      tokens_with: 50,
      tokens_saved: 100,
      detail: null,
    });
    // Other PID — should be relayed
    store.insertTokenFlow({
      ts: ts + 1,
      ts_iso: new Date(ts + 1).toISOString(),
      session_id: "s1",
      pid: process.pid + 999,
      turn: 3,
      mechanism: "shell_compression",
      tool: "bash",
      tokens_without: 500,
      tokens_with: 150,
      tokens_saved: 350,
      detail: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const calls = getCalls();
    const tfCalls = calls.filter((c) => c.method === "tokenFlow");
    expect(tfCalls.length).toBe(1);
    const tfCall = tfCalls[0]!.args[0] as Record<string, unknown>;
    expect(tfCall.mechanism).toBe("shell_compression");
    expect(tfCall.tokensSaved).toBe(350);

    handle.close();
  });

  it("filters own-PID entries from unerr.jsonl", async () => {
    const generalPath = join(logsDir, "unerr.jsonl");
    writeFileSync(generalPath, "");

    const { startLogTailer } = await import("../proxy/log-tailer.js");
    const handle = startLogTailer(tmpDir);

    const ownEntry = JSON.stringify({
      pid: process.pid,
      level: "warn",
      msg: "own-warning",
    });
    const otherEntry = JSON.stringify({
      pid: process.pid + 1,
      level: "warn",
      msg: "other-warning",
    });
    appendFileSync(generalPath, ownEntry + "\n" + otherEntry + "\n");

    await new Promise((resolve) => setTimeout(resolve, 3500));

    const calls = getCalls();
    const warnCalls = calls.filter((c) => c.method === "warn");
    expect(
      warnCalls.find((c) => String(c.args[0]).includes("own-warning")),
    ).toBeUndefined();
    expect(
      warnCalls.find((c) => String(c.args[0]).includes("other-warning")),
    ).toBeDefined();

    handle.close();
  });

  it("polls file-read rows for events with savings", async () => {
    const { startLogTailer } = await import("../proxy/log-tailer.js");
    const handle = startLogTailer(tmpDir, { pollIntervalMs: 50 });

    openMetricsStore(unerrDir).insertFileRead({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      file: "src/proxy/proxy.ts",
      mode: "entity",
      total_lines: 2000,
      returned_lines: 45,
      saved_pct: 98,
      entity: null,
      token_estimate: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const calls = getCalls();
    const fileReadCall = calls.find(
      (c) =>
        c.method === "step" &&
        String(c.args[0]).includes("proxy.ts") &&
        String(c.args[0]).includes("entity"),
    );
    expect(fileReadCall).toBeDefined();

    handle.close();
  });

  it("skips file-read entries with 0% savings", async () => {
    const { startLogTailer } = await import("../proxy/log-tailer.js");
    const handle = startLogTailer(tmpDir, { pollIntervalMs: 50 });

    openMetricsStore(unerrDir).insertFileRead({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      file: "readme.md",
      mode: "full",
      total_lines: 20,
      returned_lines: 20,
      saved_pct: 0,
      entity: null,
      token_estimate: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const calls = getCalls();
    const fileReadCall = calls.find(
      (c) => c.method === "step" && String(c.args[0]).includes("readme.md"),
    );
    expect(fileReadCall).toBeUndefined();

    handle.close();
  });

  it("skips compression entries with 0% savings", async () => {
    const { startLogTailer } = await import("../proxy/log-tailer.js");
    const handle = startLogTailer(tmpDir, { pollIntervalMs: 50 });

    openMetricsStore(unerrDir).insertCompression({
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      command: "echo hello",
      category: "omni",
      confidence: 1,
      raw_bytes: 12,
      compressed_bytes: 12,
      saved_pct: 0,
      omni_fallback: 0,
      tee_file: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const calls = getCalls();
    const echoCall = calls.find(
      (c) => c.method === "step" && String(c.args[0]).includes("echo hello"),
    );
    expect(echoCall).toBeUndefined();

    handle.close();
  });
});
