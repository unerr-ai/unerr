/**
 * Layer 8 §5.1 (SC-C.2): the comment-drift nudge.
 *
 * When the focus entity carries a stale @sem/doc annotation (body moved, comment
 * did not — the C.1 predicate set status='stale'), query-router stamps
 * `meta.comment_drift` and `buildSignalPrefix` renders a once-per-episode
 * `ur|ctx` nudge naming the entity + file:line. These tests pin the wire shape,
 * the six-rule obedience, and the dedup behavior.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildSignalPrefix } from "../proxy/response-envelope.js";
import { resetSignalDedupSingleton } from "../proxy/signal-dedup.js";

const META = {
  comment_drift: {
    entityKey: "e:validateToken",
    name: "validateToken",
    file: "src/auth/token.ts",
    line: 41,
  },
};

describe("comment-drift nudge (SC-C.2)", () => {
  beforeEach(() => {
    resetSignalDedupSingleton();
  });

  it("renders a ur|ctx line naming the entity + file:line", () => {
    const prefix = buildSignalPrefix(META, undefined, "e:validateToken");
    // Collapses onto the consolidated `ctx` wire bucket.
    expect(prefix).toContain("ur|ctx ");
    expect(prefix).toContain("doc comment on validateToken predates");
    expect(prefix).toContain("src/auth/token.ts:41");
    // Six-rule obedience: imperative verb, no hedge verbs, named noun.
    expect(prefix).toContain(
      "update the prose + @sem line above validateToken"
    );
    expect(prefix).not.toMatch(/\bconsider\b|\bverify\b|\breview\b|\bcheck\b/i);
  });

  it("fires once per staleness episode — a second identical call is suppressed", () => {
    const first = buildSignalPrefix(META, undefined, "e:validateToken");
    expect(first).toContain("ur|ctx ");
    const second = buildSignalPrefix(META, undefined, "e:validateToken");
    // on_change dedup: same (cdr, entity, content) → dropped on the next turn.
    expect(second).not.toContain("doc comment on validateToken predates");
  });

  it("re-fires when the message changes (a fresh edit re-drifts the same entity)", () => {
    buildSignalPrefix(META, undefined, "e:validateToken");
    const moved = {
      comment_drift: { ...META.comment_drift, line: 58 },
    };
    const next = buildSignalPrefix(moved, undefined, "e:validateToken");
    expect(next).toContain("src/auth/token.ts:58");
  });

  it("keeps a separate dedup scope from structural drift on the same entity", () => {
    // Structural drift (dft) and comment drift (cdr) both collapse to ur|ctx,
    // but their semantic tags differ, so one never suppresses the other.
    const prefix = buildSignalPrefix(
      {
        drift: { entityStatus: "modified", branch: "main" },
        comment_drift: META.comment_drift,
      },
      undefined,
      "e:validateToken"
    );
    expect(prefix).toContain("modified on main — re-read before edit");
    expect(prefix).toContain("doc comment on validateToken predates");
    // Two distinct ur|ctx lines.
    expect(prefix.match(/ur\|ctx /g)?.length).toBe(2);
  });

  it("omits the line below a file:0 line number (no spurious :0 suffix)", () => {
    const noLine = {
      comment_drift: { ...META.comment_drift, line: 0 },
    };
    const prefix = buildSignalPrefix(noLine, undefined, "e:validateToken");
    expect(prefix).toContain("in src/auth/token.ts,");
    expect(prefix).not.toContain("token.ts:0");
  });

  it("emits nothing when name or file is missing", () => {
    const partial = {
      comment_drift: { entityKey: "e:x", name: "", file: "", line: 0 },
    };
    const prefix = buildSignalPrefix(partial, undefined, "e:x");
    expect(prefix).not.toContain("predates its current body");
  });

  it("emits nothing when there is no comment_drift meta", () => {
    const prefix = buildSignalPrefix({}, undefined, "e:validateToken");
    expect(prefix).not.toContain("predates");
  });
});
