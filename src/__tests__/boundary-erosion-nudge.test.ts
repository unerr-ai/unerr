/**
 * Layer 8 §6 (SC-D.3): the boundary-erosion nudge.
 *
 * When the focus entity sits in a low-purity Louvain community (the
 * `community_domains` vote is contested — purity < 0.7, stamped by
 * extractBoundaryErosionMeta), query-router sets `meta.boundary_erosion` and
 * `buildSignalPrefix` renders a once-per-episode `ur|rsk` nudge naming the
 * dominant domain + purity. These tests pin the wire shape, the six-rule
 * obedience, and the dedup behavior.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildSignalPrefix } from "../proxy/response-envelope.js";
import { resetSignalDedupSingleton } from "../proxy/signal-dedup.js";

const META = {
  boundary_erosion: {
    entityKey: "e:chargeCard",
    domain: "payments",
    purity: 0.58,
    communityId: 3,
  },
};

describe("boundary-erosion nudge (SC-D.3)", () => {
  beforeEach(() => {
    resetSignalDedupSingleton();
  });

  it("renders a ur|rsk line naming the domain + purity percent", () => {
    const prefix = buildSignalPrefix(META, undefined, "e:chargeCard");
    // Collapses onto the consolidated `rsk` wire bucket.
    expect(prefix).toContain("ur|rsk ");
    expect(prefix).toContain("is in a contested payments community");
    expect(prefix).toContain("purity 58%");
    expect(prefix).toContain("e:chargeCard");
    // Six-rule obedience: imperative verb + named tool, no hedge verbs.
    expect(prefix).toContain("call get_references({direction:'callers'})");
    expect(prefix).not.toMatch(/\bconsider\b|\bverify\b|\breview\b|\bcheck\b/i);
  });

  it("fires once per purity episode — a second identical call is suppressed", () => {
    const first = buildSignalPrefix(META, undefined, "e:chargeCard");
    expect(first).toContain("ur|rsk ");
    const second = buildSignalPrefix(META, undefined, "e:chargeCard");
    // on_change dedup: same (ber, entity, content) → dropped on the next turn.
    expect(second).not.toContain("is in a contested payments community");
  });

  it("re-fires when the purity shifts (a fresh vote re-contests the community)", () => {
    buildSignalPrefix(META, undefined, "e:chargeCard");
    const shifted = {
      boundary_erosion: { ...META.boundary_erosion, purity: 0.41 },
    };
    const next = buildSignalPrefix(shifted, undefined, "e:chargeCard");
    expect(next).toContain("purity 41%");
  });

  it("keeps a separate dedup scope from entity-risk on the same entity", () => {
    // Entity-risk (rsk) and boundary-erosion (ber) both collapse to ur|rsk,
    // but their semantic tags differ, so one never suppresses the other.
    const prefix = buildSignalPrefix(
      {
        entity_risk: {
          risk_level: "high",
          fan_in: 12,
          fan_out: 4,
          entity_key: "e:chargeCard",
        },
        boundary_erosion: META.boundary_erosion,
      },
      undefined,
      "e:chargeCard"
    );
    expect(prefix).toContain("high blast radius");
    expect(prefix).toContain("is in a contested payments community");
    // Two distinct ur|rsk lines.
    expect(prefix.match(/ur\|rsk /g)?.length).toBe(2);
  });
});
