/**
 * Tests for SIGNAL_PREFIX_LEGEND — Fix F (prefix semantic split).
 * Asserts the legend documents the two-register pattern:
 *   - ur|<tag> is reserved for FACTS (ctx, rsk, fct)
 *   - COMMANDS use bare imperatives (CALL / RUN / MUST / DO NOT / STEP-N)
 */

import { describe, expect, it } from "vitest";
import { SIGNAL_PREFIX_LEGEND } from "../proxy/response-envelope.js";

describe("SIGNAL_PREFIX_LEGEND (Fix F)", () => {
  it("names every wire tag (act / ctx / rsk / fct)", () => {
    for (const tag of ["act", "ctx", "rsk", "fct"]) {
      expect(SIGNAL_PREFIX_LEGEND).toContain(tag);
    }
  });

  it("documents the two-register pattern (Fix F)", () => {
    expect(SIGNAL_PREFIX_LEGEND).toMatch(/two-register pattern/i);
    expect(SIGNAL_PREFIX_LEGEND).toMatch(/bare imperative/i);
  });

  it("preserves ur|act for backward compatibility", () => {
    expect(SIGNAL_PREFIX_LEGEND).toMatch(/backward compatibility/i);
  });

  it("names RFC 2119 imperative verbs (Fix C alignment)", () => {
    const verbs = ["CALL", "MUST", "DO NOT"];
    for (const v of verbs) {
      expect(SIGNAL_PREFIX_LEGEND).toContain(v);
    }
  });
});
