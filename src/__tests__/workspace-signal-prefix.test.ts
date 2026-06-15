/**
 * CROSS_REPO_INTELLIGENCE Sprint 5.2: cross-repo (workspace) refusal + partial
 * fan-out signal lines.
 *
 * When a free-tier account asks for scope:'workspace', the daemon refuses the
 * peer fan-out and query-router stamps `meta.workspace_refused` (the upgrade
 * message). When some peers are unreachable, it stamps `meta.workspace` with
 * `partial:true`. `buildSignalPrefix` renders the first as a `ur|fct` upgrade
 * nudge and the second as a `ur|ctx` incompleteness note. These tests pin the
 * wire shape, the six-rule obedience, and the dedup behavior.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_PRO_ONLY_MESSAGE } from "../daemon/peers.js";
import { buildSignalPrefix } from "../proxy/response-envelope.js";
import { resetSignalDedupSingleton } from "../proxy/signal-dedup.js";

describe("workspace refusal nudge (Sprint 5.2)", () => {
  beforeEach(() => {
    resetSignalDedupSingleton();
  });

  it("renders the refusal message verbatim as a ur|fct line", () => {
    const prefix = buildSignalPrefix(
      { workspace_refused: WORKSPACE_PRO_ONLY_MESSAGE },
      undefined,
      null
    );
    expect(prefix).toContain("ur|fct ");
    expect(prefix).toContain(WORKSPACE_PRO_ONLY_MESSAGE);
    // Six-rule obedience: the message names the imperative action, no hedges.
    expect(prefix).toContain("run `unerr login`");
    expect(prefix).not.toMatch(/\bconsider\b|\bverify\b|\breview\b|\bcheck\b/i);
  });

  it("fires once per session — a second identical refusal is suppressed", () => {
    const first = buildSignalPrefix(
      { workspace_refused: WORKSPACE_PRO_ONLY_MESSAGE },
      undefined,
      null
    );
    expect(first).toContain(WORKSPACE_PRO_ONLY_MESSAGE);
    const second = buildSignalPrefix(
      { workspace_refused: WORKSPACE_PRO_ONLY_MESSAGE },
      undefined,
      null
    );
    expect(second).not.toContain(WORKSPACE_PRO_ONLY_MESSAGE);
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
