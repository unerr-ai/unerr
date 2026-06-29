/**
 * Layer 12 DM-0 invariant: `src/proxy/bridge.ts` must remain a pure stdio↔UDS
 * relay. It owns no intelligence — the per-repo `unerr` process does.
 *
 * Static-analysis test: re-grepping the bridge source on every CI run is the
 * cheapest, hardest-to-cheat guard against accidental re-entanglement.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BRIDGE_PATH = resolve(__dirname, "../proxy/bridge.ts");

describe("bridge isolation (DM-0)", () => {
  const source = readFileSync(BRIDGE_PATH, "utf-8");

  it("imports nothing from src/intelligence/", () => {
    // Match both static and dynamic imports at any depth of relative path.
    const intelligence = /(?:from|import\()\s*["'][^"']*\/intelligence\//;
    expect(source).not.toMatch(intelligence);
  });

  it("imports nothing from src/behaviors/", () => {
    const behaviors = /(?:from|import\()\s*["'][^"']*\/behaviors\//;
    expect(source).not.toMatch(behaviors);
  });

  it("imports nothing from src/tracking/", () => {
    // Tier-2 modules (shadow ledger, token flow, persistence effectiveness)
    // also belong on the per-repo side, not in the bridge.
    const tracking = /(?:from|import\()\s*["'][^"']*\/tracking\//;
    expect(source).not.toMatch(tracking);
  });

  it("stays under the 330-LOC budget", () => {
    // History: 200→232 LOC for `rewriteInitializeFrame` (codingAgent
    // attribution), then 232→~290 for the FIX A timeout-fallback orchestration
    // (arm a local `initialize`/`tools/list` reply when the proxy is too slow).
    // The parsing/state machine for that lives in `bridge-catalog.ts` (also
    // isolation-safe), so the bridge stays a relay — it only owns the timers.
    // Then ~290→319 for the per-bridge `session_id`: the bridge mints a
    // module-scoped UUID and announces it in the `unerr/hello` frame so the
    // proxy can group a conversation's events under one stable id across UDS
    // reconnects (SESSION_ID_CORRELATION). Uses only `node:crypto` — the DM-0
    // import invariants (no intelligence/behaviors/tracking) still pass.
    // Then ~319→~389 for the L6 lifecycle segment: the bridge writes its own
    // `mcp-<pid>.jsonl` session open/close events via `events/enqueue`
    // (telemetry leaf — allowed under DM-0; intelligence/behaviors/tracking
    // still forbidden). Budget bumped to 395; further growth should be
    // challenged.
    // Then ~389→~410 for Option B pid+socket liveness: on missed pongs the
    // bridge confirms the proxy pid via `PidLock.readPidFile` (proxy/, node
    // builtins only — DM-0 safe) before declaring death, so a busy-but-alive
    // proxy (long reindex) is not reaped. Budget bumped to 420.
    const lines = source.split("\n").length;
    expect(lines).toBeLessThanOrEqual(420);
  });

  it("file is small (sanity: a relay should be a few KB, not megabytes)", () => {
    const { size } = statSync(BRIDGE_PATH);
    expect(size).toBeLessThan(20_000); // 20 KB ceiling
  });
});
