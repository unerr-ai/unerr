/**
 * P0.6 — End-to-end firing harness.
 *
 * This is the test that would have caught the original dead-behavior bug: the
 * cascade warning never reached the agent because edits never traversed the
 * code path that computed it. Here we drive the REAL `unerr hook pre-edit`
 * entry (`runPreEditHookAsync`) with a realistic Claude Code PreToolUse Edit
 * payload, against a REAL seeded CozoDB graph served over a REAL Unix-domain
 * socket by the SAME `handleBlastRadiusRequest` the proxy uses — and assert the
 * agent-facing output actually carries the computed caller signal.
 *
 * The only thing not booted is `startProxy` itself; every other link in the
 * firing chain is the production code path:
 *   payload → adapter → postEditHandlerAsync → queryBlastRadius → UDS
 *           → handleBlastRadiusRequest → computeEditImpact → CozoGraphStore
 *           → renderInlineBlastRadius → adapter output.
 *
 * A signature change is a legitimate edit, not an error, so the pre-edit hook
 * never denies; the confirmed caller list rides the POST-edit hook instead.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IncompleteWorkDetector } from "../behaviors/incomplete-work.js";
import { resetHookDedup } from "../hooks/hook-dedup.js";
import {
  runPostEditHook,
  runPostEditHookAsync,
  runPreEditHookAsync,
} from "../hooks/navigation-hooks.js";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initSchema } from "../intelligence/cozo-schema.js";
import { CozoGraphStore } from "../intelligence/local-graph.js";
import {
  BLAST_RADIUS_METHOD,
  handleBlastRadiusRequest,
} from "../proxy/blast-radius-protocol.js";
import { clearEditLog } from "../tracking/session-edit-log.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

async function seedEntity(db: CozoDb, key: string, fp: string): Promise<void> {
  await db.run(
    `?[key, kind, name, file_path] <- [[$key, "function", $key, $fp]]
     :put entities {key => kind, name, file_path}`,
    { key, fp }
  );
  await db.run(
    "?[file_path, entity_key] <- [[$fp, $key]] :put file_index {file_path, entity_key}",
    { key, fp }
  );
}

async function seedCall(db: CozoDb, from: string, to: string): Promise<void> {
  await db.run(
    `?[from_key, to_key, type] <- [[$from, $to, "calls"]]
     :put edges {from_key, to_key, type}`,
    { from, to }
  );
}

/** A Claude Code PreToolUse Edit payload, as it arrives on the hook's stdin. */
function editPayload(
  filePath: string,
  oldString: string,
  newString: string
): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
    },
  });
}

describe("behavior firing — pre-edit cascade end-to-end (P0.6)", () => {
  let db: CozoDb;
  let store: CozoGraphStore;
  let server: Server | null = null;
  let tmpRepo: string | null = null;
  const origCwd = process.cwd();

  beforeEach(async () => {
    db = await createTestDb();
    await initSchema(db);
    store = await CozoGraphStore.create(db);

    // `pay` lives in src/pay.ts; checkout + refund both call it.
    await seedEntity(db, "pay", "src/pay.ts");
    await seedEntity(db, "checkout", "src/checkout.ts");
    await seedEntity(db, "refund", "src/refund.ts");
    await seedCall(db, "checkout", "pay");
    await seedCall(db, "refund", "pay");

    // Boundary check is path-based (declared DM-0 layer rule) — no graph
    // seeding needed: src/proxy/bridge.ts must not import src/intelligence/.

    // A repo cwd with a proxy socket the hook will discover via process.cwd().
    // Keep the base short so the nested sun_path stays under macOS's ~104B cap.
    tmpRepo = mkdtempSync(join(tmpdir(), "ur-e2e-"));
    mkdirSync(join(tmpRepo, ".unerr", "state"), { recursive: true });
    const sockPath = join(tmpRepo, ".unerr", "state", "proxy.sock");

    // Same wiring as the proxy's UDS handler: intercept the blast-radius method.
    server = createNetServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as {
          id?: number;
          method?: string;
          params?: Parameters<typeof handleBlastRadiusRequest>[1];
        };
        if (req.method === BLAST_RADIUS_METHOD) {
          handleBlastRadiusRequest(store, req.params).then((result) => {
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`
            );
          });
        } else {
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601 } })}\n`
          );
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));
    process.chdir(tmpRepo);
    // Deterministic deny-once: reset the file-backed gate so each test's first
    // graph-confirmed cascade reliably DENIES (rather than nudging because a
    // prior test already consumed the once-token for the same key).
    resetHookDedup();
  });

  afterEach(() => {
    process.chdir(origCwd);
    server?.close();
    server = null;
    if (tmpRepo) {
      rmSync(tmpRepo, { recursive: true, force: true });
      tmpRepo = null;
    }
  });

  it("does NOT deny a signature edit — a signature change is a legitimate edit, not an error", async () => {
    const out = await runPreEditHookAsync(
      editPayload(
        "src/pay.ts",
        "export function pay(a) {",
        "export function pay(a, b) {"
      )
    );

    // Valid JSON (never a crash — exit 0 contract).
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    // The guard never blocks a signature change: deny is reserved for errors.
    // No pre-edit cascade at all — the caller list is delivered post-edit.
    expect(parsed.hookSpecificOutput?.permissionDecision ?? "allow").not.toBe(
      "deny"
    );
    expect(out).not.toContain("cascade guard");
    expect(out).not.toContain("Blocked once");
  });

  it("never denies on repeat pre-edits of the same signature change (no deny loop)", async () => {
    const payload = editPayload(
      "src/pay.ts",
      "export function pay(a) {",
      "export function pay(a, b) {"
    );
    const first = JSON.parse(await runPreEditHookAsync(payload));
    const second = JSON.parse(await runPreEditHookAsync(payload));
    expect(first.hookSpecificOutput?.permissionDecision ?? "allow").not.toBe(
      "deny"
    );
    expect(second.hookSpecificOutput?.permissionDecision ?? "allow").not.toBe(
      "deny"
    );
  });

  it("delivers the confirmed caller list via the POST-edit hook", async () => {
    const out = await runPostEditHookAsync(
      editPayload(
        "src/pay.ts",
        "export function pay(a) {",
        "export function pay(a, b) {"
      )
    );
    expect(() => JSON.parse(out)).not.toThrow();
    // renderInlineBlastRadius line: names the changed entity + its CONFIRMED
    // callers (checkout + refund), with no deny and no forced get_references.
    expect(out).toContain("signature change to pay");
    expect(out).toContain("2 caller(s) to update");
    expect(out).toContain("checkout");
    expect(out).toContain("refund");
  });

  it("passes through silently when the edit changes no signature with callers", async () => {
    // Editing a string literal / comment — no function signature → engine
    // returns no warnings → generic static nudge was REMOVED (measured ~105
    // fires/5 sessions vs 1 get_references call) → passthrough.
    const out = await runPreEditHookAsync(
      editPayload("src/pay.ts", "const RETRIES = 3;", "const RETRIES = 5;")
    );
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toContain("caller(s) at risk");
    expect(out).toBe("{}");
  });

  it("injects an architecture-boundary warning when a forbidden cross-layer import is added (P2.1)", async () => {
    // Adding an implementation import from proxy/bridge.ts into intelligence/ —
    // the DM-0 layer rule the boundary engine enforces by default. No signature
    // changes → cascade is silent; only the boundary check fires. Warn, never block.
    const out = await runPreEditHookAsync(
      editPayload(
        "src/proxy/bridge.ts",
        `import { local } from "./local.js";`,
        `import { local } from "./local.js";\nimport { computeEditImpact } from "../intelligence/edit-impact.js";`
      )
    );

    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toContain("architecture boundary");
    expect(out).toContain("src/proxy/bridge.ts");
    expect(out).toContain("src/intelligence/");
    expect(out).toContain("../intelligence/edit-impact.js");
    // Advisory only — the static cascade phrasing must not appear.
    expect(out).not.toContain("caller(s) at risk");
  });

  // Regression (the test-reality gap that let the bug ship): real Claude Code
  // PreToolUse `tool_input.file_path` is ALWAYS absolute, but every test above
  // sent a repo-relative path — so none exercised the absolute → repo-relative
  // normalization the handler must do, and the graph-backed signal silently
  // died on every real edit. These two drive the hook with an ABSOLUTE path
  // (built from the resolved cwd so it shares the proxy's root, as in real use)
  // and assert the cascade + boundary signals still fire end-to-end.
  it("delivers the cascade caller list for an ABSOLUTE file_path (real Claude Code shape)", async () => {
    const out = await runPostEditHookAsync(
      editPayload(
        join(process.cwd(), "src/pay.ts"),
        "export function pay(a) {",
        "export function pay(a, b) {"
      )
    );
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toContain("2 caller(s) to update"); // checkout + refund
    expect(out).toContain("checkout"); // callers listed inline, not fetched
  });

  it("fires the boundary signal for an ABSOLUTE file_path (real Claude Code shape)", async () => {
    const out = await runPreEditHookAsync(
      editPayload(
        join(process.cwd(), "src/proxy/bridge.ts"),
        `import { local } from "./local.js";`,
        `import { local } from "./local.js";\nimport { computeEditImpact } from "../intelligence/edit-impact.js";`
      )
    );
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toContain("architecture boundary");
    expect(out).toContain("src/intelligence/");
  });

  it("passes through silently for a signature change on a function with no callers", async () => {
    // `refund` has no callers in the graph → below threshold → no warning →
    // silent passthrough (the guard informs only when there are callers to fix).
    const out = await runPreEditHookAsync(
      editPayload(
        "src/refund.ts",
        "export function refund(a) {",
        "export function refund(a, b) {"
      )
    );
    expect(out).not.toContain("caller(s) at risk");
    expect(out).toBe("{}");
  });

  it("records edits via the post-edit hook and flags un-updated callers at session end (P2.2)", async () => {
    const unerrDir = join(tmpRepo!, ".unerr");
    clearEditLog(unerrDir); // fresh session

    // The agent changes pay's signature — recorded by the post-edit hook — but
    // never edits checkout.ts or refund.ts (its callers).
    runPostEditHook(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: "src/pay.ts",
          old_string: "export function pay(a) {",
          new_string: "export function pay(a, b) {",
        },
      })
    );

    // Session end: reconcile the recorded edits against the warm graph.
    const detector = new IncompleteWorkDetector();
    detector.attachGraph(store);
    detector.setUnerrDir(unerrDir);
    await detector.onSessionEnd({
      toolName: "__session_end__",
      args: {},
      sessionId: "test",
    });

    // The flag is persisted for the next session's resume to surface (P3.3).
    const items = IncompleteWorkDetector.readPersistedItems(unerrDir);
    const broken = items.find((i) => i.type === "broken_callers");
    expect(broken).toBeDefined();
    expect(broken!.entity).toContain("pay");
    expect(broken!.remaining).toEqual(
      expect.arrayContaining([
        "src/checkout.ts:checkout",
        "src/refund.ts:refund",
      ])
    );
  });
});
