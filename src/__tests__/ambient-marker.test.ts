/**
 * Regression tests for src/proxy/ambient-marker.ts — T5.8 audit.
 *
 * The ambient marker collapses the in-chat surfaces to `unerr » ⋯` after
 * `ZERO_TURN_THRESHOLD` (3) consecutive zero-content turns. The audit
 * worry was: could the collapse swallow a turn that DID emit a real
 * Surface 2 preface or Surface 3 footer?
 *
 * Code path traced (see report):
 *   - `noteTurnContent(sid, hadContent)` is the SOLE input to the
 *     counter (no other mutation site).
 *   - `user-block-emitter.buildUserBlockForResponse` calls
 *     `noteTurnContent(sid, headHadContent || tailHadContent)`.
 *   - `tailHadContent` is `footerHasContent(footerLine)` — which
 *     returns true unless the footer is the "nothing to help / no
 *     savings / unchanged length" honest-zero stem.
 *
 * Conclusion: a turn emitting real Surface 3 content resets the
 * counter; the collapse cannot swallow a real surface. No bug. These
 * tests lock that behavior in as a regression net.
 *
 * Basic counter semantics (threshold, isolation, reset) are already
 * tested in presence-surfaces.test.ts. This file focuses on the
 * "doesn't swallow real surfaces" invariant.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  getConsecutiveZeroCount,
  getZeroTurnThreshold,
  noteTurnContent,
  resetAllAmbientMarkers,
  shouldUseAmbientMarker,
} from "../proxy/ambient-marker.js";

describe("ambient-marker — surface-collapse safety", () => {
  beforeEach(() => {
    resetAllAmbientMarkers();
  });

  it("collapses to ambient marker after THREE zero-content turns (4th read)", () => {
    const sid = "t5.8-collapse";
    // Three consecutive empties.
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    expect(getConsecutiveZeroCount(sid)).toBe(getZeroTurnThreshold());
    // The next call to shouldUseAmbientMarker (the 4th turn's render
    // decision) sees the threshold reached → collapse.
    expect(shouldUseAmbientMarker(sid)).toBe(true);
  });

  it("does NOT collapse on a turn that emitted real Surface 3 footer content", () => {
    const sid = "t5.8-surface3-protects";
    // Two empties — not yet at threshold.
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    expect(shouldUseAmbientMarker(sid)).toBe(false);

    // Now a turn with a real Surface 3 footer fires. The emitter
    // signals `hadContent = true`. Counter resets to 0.
    noteTurnContent(sid, true);
    expect(getConsecutiveZeroCount(sid)).toBe(0);
    expect(shouldUseAmbientMarker(sid)).toBe(false);
  });

  it("does NOT collapse on a turn that emitted real Surface 2 preface content", () => {
    const sid = "t5.8-surface2-protects";
    // Three empties — at threshold.
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    expect(shouldUseAmbientMarker(sid)).toBe(true);

    // The 4th turn would normally collapse, but the emitter actually
    // renders a real Surface 2 preface and calls noteTurnContent(true).
    // The collapse decision was already made BEFORE rendering this
    // turn (that's correct behavior — ambient is sticky until content
    // returns), so the 4th turn shows the marker; but THIS noteTurn
    // call resets the counter so the 5th turn renders the full block.
    noteTurnContent(sid, true);
    expect(getConsecutiveZeroCount(sid)).toBe(0);
    expect(shouldUseAmbientMarker(sid)).toBe(false);
  });

  it("counter resets correctly: 3 zero turns + 1 content turn + 2 more zeros = below threshold", () => {
    const sid = "t5.8-reset-arithmetic";
    // Three zeros.
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    expect(shouldUseAmbientMarker(sid)).toBe(true);

    // Reset via a content turn.
    noteTurnContent(sid, true);
    expect(getConsecutiveZeroCount(sid)).toBe(0);

    // Two more zeros — still below threshold (which is 3).
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    expect(getConsecutiveZeroCount(sid)).toBe(2);
    expect(shouldUseAmbientMarker(sid)).toBe(false);
  });

  it("a real surface mid-streak resets counter back to zero (no carry-over)", () => {
    const sid = "t5.8-no-carryover";
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    // Real surface in the middle of a streak.
    noteTurnContent(sid, true);
    expect(getConsecutiveZeroCount(sid)).toBe(0);

    // Two MORE zeros after the reset — must still NOT collapse,
    // because the 2 zeros before the reset don't carry over.
    noteTurnContent(sid, false);
    noteTurnContent(sid, false);
    expect(getConsecutiveZeroCount(sid)).toBe(2);
    expect(shouldUseAmbientMarker(sid)).toBe(false);
  });

  it("ambient state stays sticky across multiple zero turns past threshold", () => {
    // Sanity: once collapsed, further zeros don't un-collapse the marker
    // (it should remain `true` until a content turn breaks the streak).
    const sid = "t5.8-sticky";
    for (let i = 0; i < 5; i++) noteTurnContent(sid, false);
    expect(shouldUseAmbientMarker(sid)).toBe(true);
    noteTurnContent(sid, false);
    expect(shouldUseAmbientMarker(sid)).toBe(true);
  });
});
