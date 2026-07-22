/**
 * P1 — Post-edit review UDS client + degradation.
 *
 * Two layers:
 *  1. `queryReviewEdit` against a fake UDS server: success, no-socket, timeout,
 *     and server-error all obey the never-throw / never-stall contract.
 *  2. `runPostEditHookAsync` degradation: with no proxy socket in cwd it falls
 *     back to the co-change nudge and emits valid JSON (exit 0) — proving a
 *     down/absent proxy never makes editing worse.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPostEditHookAsync } from "../hooks/navigation-hooks.js";
import { queryReviewEdit } from "../hooks/review-client.js";
import { MIN_USEFUL_ENTITIES } from "../intelligence/graph-readiness.js";
import { REVIEW_EDIT_METHOD } from "../proxy/review-protocol.js";

function shortSockPath(): string {
  return join(
    tmpdir(),
    `ur-r-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  );
}

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
            req.method === REVIEW_EDIT_METHOD
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

const sampleFinding = {
  checkerId: "breaking_callers",
  tier: 1,
  severity: "high",
  anchor: { kind: "e", value: "k_pay" },
  title: "parameter_added on pay — 3 caller(s) now mismatch",
  evidence: ["src/checkout.ts:4 checkout calls pay"],
  action: "call get_references({key:'k_pay', direction:'callers'})",
  needsModel: false,
};

describe("queryReviewEdit (UDS client)", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("returns null immediately when no socket file exists", async () => {
    const res = await queryReviewEdit(
      { file_path: "src/pay.ts" },
      { sockPath: shortSockPath() }
    );
    expect(res).toBeNull();
  });

  it("returns the proxy result on a successful round-trip", async () => {
    const { sockPath, server } = await startFakeProxy({
      result: { findings: [sampleFinding], suppressed: 1, clean: false },
    });
    servers.push(server);
    const res = await queryReviewEdit(
      { file_path: "src/pay.ts", old_content: "a", new_content: "b" },
      { sockPath }
    );
    expect(res?.clean).toBe(false);
    expect(res?.findings).toHaveLength(1);
    expect(res?.findings[0]!.checkerId).toBe("breaking_callers");
    expect(res?.suppressed).toBe(1);
  });

  it("returns null when the proxy is slower than the timeout", async () => {
    const { sockPath, server } = await startFakeProxy(
      { result: { findings: [], suppressed: 0, clean: true } },
      { delayMs: 300 }
    );
    servers.push(server);
    const res = await queryReviewEdit(
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
    const res = await queryReviewEdit(
      { file_path: "src/pay.ts" },
      { sockPath }
    );
    expect(res).toBeNull();
  });
});

describe("runPostEditHookAsync degradation (no proxy in cwd)", () => {
  const origCwd = process.cwd();
  let tmp: string | null = null;

  afterEach(() => {
    process.chdir(origCwd);
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it("falls back to the co-change nudge and emits valid JSON when no proxy socket exists", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ur-rev-nodir-"));
    // runPostEditHookAsync's co-change enrichment only fires when
    // readGraphReadiness(cwd) is ready, so seed the temp dir with a
    // graph-ready fixture before chdir'ing into it.
    const unerrDir = join(tmp, ".unerr");
    mkdirSync(join(unerrDir, "state"), { recursive: true });
    writeFileSync(join(unerrDir, "config.json"), "{}");
    writeFileSync(join(unerrDir, "graph.db"), "");
    writeFileSync(
      join(unerrDir, "state", "graph-stats.json"),
      JSON.stringify({
        entities: MIN_USEFUL_ENTITIES + 500,
        edges: 10,
        rules: 1,
        indexedAt: new Date().toISOString(),
      })
    );
    process.chdir(tmp);

    const stdin = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: {
        // Unique path so the once-per-file dedup never suppresses this emit.
        file_path: `src/rev-degrade-${Date.now()}.ts`,
        old_string: "export function pay(a) {",
        new_string: "export function pay(a, b) {",
      },
    });

    const out = await runPostEditHookAsync(stdin);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed).toBeTypeOf("object");
    // The co-change fact nudge — degradation target, NOT review findings.
    expect(out).toContain("get_references");
    expect(out).not.toContain("ur|rsk");
  });
});
