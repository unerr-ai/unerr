/**
 * Cross-repo (workspace) refusal = SILENT yield (Issue 1, confirmed 2026-06-22)
 * + partial fan-out signal line.
 *
 * When a free-tier account asks for scope:'workspace', the daemon refuses the
 * peer fan-out and query-router stamps `meta.workspace_refused` (kept as an
 * internal/telemetry field). Per the settled design the agent sees NO line at
 * all — the call already ran home-only, so `buildSignalPrefix` must NOT render
 * the upgrade message. The wall-hit is measured server-side instead
 * (`cross_repo_access {refused}` + the Issue 8 `cross_repo_yielded_free`
 * savings event). When some peers are unreachable, query-router stamps
 * `meta.workspace` with `partial:true`, which DOES surface as a `ur|ctx`
 * incompleteness note (a real correctness warning, not an upsell).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_PRO_ONLY_MESSAGE } from "../daemon/peers.js";
import { buildSignalPrefix } from "../proxy/response-envelope.js";
import { resetSignalDedupSingleton } from "../proxy/signal-dedup.js";

describe("workspace refusal yields silently (Issue 1)", () => {
  beforeEach(() => {
    resetSignalDedupSingleton();
  });

  it("emits NO agent-facing line for a refused workspace call", () => {
    const prefix = buildSignalPrefix(
      { workspace_refused: WORKSPACE_PRO_ONLY_MESSAGE },
      undefined,
      null
    );
    // Silent to the coding agent — no upgrade nudge, no error surface at all.
    expect(prefix).toBe("");
    expect(prefix).not.toContain(WORKSPACE_PRO_ONLY_MESSAGE);
    expect(prefix).not.toContain("unerr login");
  });

  it("emits nothing for an empty or absent refusal", () => {
    expect(buildSignalPrefix({ workspace_refused: "" }, undefined, null)).toBe(
      ""
    );
    expect(buildSignalPrefix({}, undefined, null)).toBe("");
  });
});

describe("workspace partial fan-out note (Sprint 5.2)", () => {
  beforeEach(() => {
    resetSignalDedupSingleton();
  });

  it("renders a ur|ctx note with the peer count when partial", () => {
    const prefix = buildSignalPrefix(
      { workspace: { peers: 2, partial: true } },
      undefined,
      null
    );
    expect(prefix).toContain("ur|ctx ");
    expect(prefix).toContain("cross-repo references partial");
    expect(prefix).toContain("2 peer repos answered");
    // Imperative, names the tool to re-run; no hedge verbs.
    expect(prefix).toContain("re-run get_references({scope:'workspace'})");
    expect(prefix).not.toMatch(/\bconsider\b|\bverify\b|\breview\b|\bcheck\b/i);
  });

  it("emits nothing when the fan-out completed (partial:false)", () => {
    const prefix = buildSignalPrefix(
      { workspace: { peers: 3, partial: false } },
      undefined,
      null
    );
    expect(prefix).not.toContain("cross-repo references partial");
  });

  it("re-fires when the peer count changes", () => {
    buildSignalPrefix(
      { workspace: { peers: 1, partial: true } },
      undefined,
      null
    );
    const next = buildSignalPrefix(
      { workspace: { peers: 4, partial: true } },
      undefined,
      null
    );
    expect(next).toContain("4 peer repos answered");
  });
});
