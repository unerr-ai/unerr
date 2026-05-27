/**
 * P0.5 — Pre-edit hook UDS client + degradation.
 *
 * Two layers:
 *  1. `queryBlastRadius` against a fake UDS server: success, no-socket, timeout,
 *     and server-error all behave per the never-throw / never-stall contract.
 *  2. `runPreEditHookAsync` degradation: with no proxy socket in cwd it falls
 *     back to the static pre-edit nudge and emits valid JSON (exit 0) — the
 *     test that proves a down/absent proxy never makes editing worse.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { queryBlastRadius } from "../hooks/blast-radius-client.js";
import { runPreEditHookAsync } from "../hooks/navigation-hooks.js";
import { BLAST_RADIUS_METHOD } from "../proxy/blast-radius-protocol.js";

function shortSockPath(): string {
  // Keep the path short — macOS sun_path is capped at ~104 bytes.
  return join(tmpdir(), `ur-c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
}

/** Start a fake proxy that replies to `unerr/blast_radius` with `reply`,
 *  optionally after `delayMs`. Returns the bound socket path. */
function startFakeProxy(
  reply: unknown,
  opts: { delayMs?: number } = {}
): Promise<{ sockPath: string; server: Server }> {
  return new Promise((resolve) => {
    const sockPath = shortSockPath();
    const server = createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as {
          id?: number;
          method?: string;
        };
        const respond = () => {
          const frame =
            req.method === BLAST_RADIUS_METHOD
              ? { jsonrpc: "2.0", id: req.id, ...(reply as object) }
              : { jsonrpc: "2.0", id: req.id, error: { code: -32601 } };
          socket.write(`${JSON.stringify(frame)}\n`);
        };
        if (opts.delayMs) setTimeout(respond, opts.delayMs);
        else respond();
      });
    });
    server.listen(sockPath, () => resolve({ sockPath, server }));
  });
}

const sampleWarning = {
  changed_entity: "pay",
  changed_entity_key: "00aa11bb22cc33dd",
  change_type: "parameter_added",
  blast_radius: {
    direct_callers: [{ file: "src/checkout.ts", entity: "checkout", line: 4, isTest: false }],
    test_files: [{ file: "src/pay.test.ts", entity: "payTest", line: 9, isTest: true }],
    indirect_callers: 0,
    total_at_risk: 2,
  },
  suggestion: "Update all 2 caller(s) of pay.",
};

describe("queryBlastRadius (UDS client)", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("returns null immediately when no socket file exists", async () => {
    const res = await queryBlastRadius(
      { file_path: "src/pay.ts" },
      { sockPath: shortSockPath() } // never created
    );
    expect(res).toBeNull();
  });

  it("returns the proxy result on a successful round-trip", async () => {
    const { sockPath, server } = await startFakeProxy({
      result: { warnings: [sampleWarning] },
    });
    servers.push(server);
    const res = await queryBlastRadius(
      { file_path: "src/pay.ts", old_content: "a", new_content: "b" },
      { sockPath }
    );
    expect(res?.warnings).toHaveLength(1);
    expect(res?.warnings[0]!.blast_radius.total_at_risk).toBe(2);
  });

  it("returns null when the proxy is slower than the timeout", async () => {
    const { sockPath, server } = await startFakeProxy(
      { result: { warnings: [sampleWarning] } },
      { delayMs: 300 }
    );
    servers.push(server);
    const res = await queryBlastRadius(
      { file_path: "src/pay.ts" },
      { sockPath, timeoutMs: 50 }
    );
    expect(res).toBeNull();
  });

  it("returns null when the proxy replies with an error", async () => {
    const { sockPath, server } = await startFakeProxy({
      error: { code: -32603, message: "boom" },
    });
    servers.push(server);
    const res = await queryBlastRadius({ file_path: "src/pay.ts" }, { sockPath });
    expect(res).toBeNull();
  });
});

describe("runPreEditHookAsync degradation (no proxy in cwd)", () => {
  const origCwd = process.cwd();
  let tmp: string | null = null;

  afterEach(() => {
    process.chdir(origCwd);
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it("falls back to the static nudge and emits valid JSON when no proxy socket exists", async () => {
    // chdir to a clean temp dir so there is no .unerr/state/proxy.sock —
    // deterministic degradation regardless of any proxy running for this repo.
    tmp = mkdtempSync(join(tmpdir(), "ur-nodir-"));
    process.chdir(tmp);

    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "src/pay.ts",
        old_string: "export function pay(a) {",
        new_string: "export function pay(a, b) {",
      },
    });

    const out = await runPreEditHookAsync(stdin);
    // Valid JSON (exit 0 contract — never a crash).
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed).toBeTypeOf("object");
    // The static signature nudge — NOT the graph-backed cascade phrasing.
    expect(out).toContain("get_references");
    expect(out).not.toContain("caller(s) at risk");
  });

  it("falls back to the static nudge when the proxy is present but wedged (slower than the timeout)", async () => {
    // The realistic production failure: the socket exists (proxy alive) but the
    // graph query never returns in time. The hook must NOT stall the edit — it
    // degrades to the static nudge within the 300ms client timeout. This is the
    // never-stall contract proven end-to-end through `runPreEditHookAsync`, not
    // just at the `queryBlastRadius` layer.
    tmp = mkdtempSync(join(tmpdir(), "ur-wedged-"));
    mkdirSync(join(tmp, ".unerr", "state"), { recursive: true });
    const sockPath = join(tmp, ".unerr", "state", "proxy.sock");
    // Reply far slower than DEFAULT_BLAST_RADIUS_TIMEOUT_MS (300ms).
    const server = createServer((socket) => {
      socket.on("data", () => {
        setTimeout(() => {
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { warnings: [sampleWarning] } })}\n`
          );
        }, 2000);
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    process.chdir(tmp);

    try {
      const start = Date.now();
      const out = await runPreEditHookAsync(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: {
            file_path: "src/pay.ts",
            old_string: "export function pay(a) {",
            new_string: "export function pay(a, b) {",
          },
        })
      );
      const elapsed = Date.now() - start;
      // Returned promptly (well under the proxy's 2s reply) — never stalled.
      expect(elapsed).toBeLessThan(1500);
      expect(() => JSON.parse(out)).not.toThrow();
      expect(out).toContain("get_references");
      expect(out).not.toContain("caller(s) at risk");
    } finally {
      server.close();
    }
  });
});
