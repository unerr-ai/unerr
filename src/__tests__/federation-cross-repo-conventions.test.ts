/**
 * CROSS_REPO_INTELLIGENCE Sprint 8.1: peer-convention surfacing on a cross-repo
 * file read. The owning peer returns a {content, peer_conventions} wrapper; the
 * home unwraps the content and lifts the conventions into `_context.signals`
 * labeled by repo. These tests pin the wrapper guard and the signal shape (repo
 * label, adherence in content, `type:"context"` → wire `ur|fct`).
 */

import { describe, expect, it } from "vitest";
import {
  PEER_CONVENTION_FILE_METHODS,
  isRoutedFileContent,
  peerConventionSignals,
} from "../intelligence/federation/cross-repo-conventions.js";
import { signalTag } from "../proxy/response-envelope.js";

describe("cross-repo conventions (Sprint 8.1)", () => {
  it("path-routed file methods are file_read + file_outline", () => {
    expect(PEER_CONVENTION_FILE_METHODS.has("file_read")).toBe(true);
    expect(PEER_CONVENTION_FILE_METHODS.has("file_outline")).toBe(true);
    expect(PEER_CONVENTION_FILE_METHODS.has("search_code")).toBe(false);
  });

  it("isRoutedFileContent accepts the wrapper, rejects bare content", () => {
    expect(isRoutedFileContent({ content: "x", peer_conventions: [] })).toBe(
      true
    );
    expect(isRoutedFileContent({ content: "x" })).toBe(false); // no peer_conventions
    expect(isRoutedFileContent("raw file body")).toBe(false);
    expect(isRoutedFileContent(null)).toBe(false);
    expect(
      isRoutedFileContent({ content: "x", peer_conventions: "nope" })
    ).toBe(false);
  });

  it("builds repo-labeled signals that render as ur|fct", () => {
    const signals = peerConventionSignals(
      [
        {
          id: "p:1",
          name: "stderr logging",
          adherence_pct: 92,
          rule: "log to stderr only",
        },
        {
          id: "r:2",
          name: "named datalog",
          adherence_pct: 40,
          rule: "use named syntax for 4+ cols",
        },
      ],
      "svc"
    );
    expect(signals).toHaveLength(2);
    // Repo label is named (no deictic), adherence is in the content.
    expect(signals[0]?.content).toBe(
      'svc follows "stderr logging" (92% adherence)'
    );
    expect(signals[0]?.action).toBe("log to stderr only");
    // type "context" maps to the fct wire bucket.
    expect(signalTag(signals[0]?.type)).toBe("fct");
    // Higher adherence outranks lower (relevance/confidence track adherence).
    expect(signals[0]?.composite_score).toBeGreaterThan(
      signals[1]?.composite_score ?? Number.POSITIVE_INFINITY
    );
  });

  it("returns no signals for an empty convention set", () => {
    expect(peerConventionSignals([], "svc")).toEqual([]);
  });
});
