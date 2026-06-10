/**
 * U4 bridge↔daemon version skew policy — the decision brain, table-tested.
 *
 * The bridge is always the on-disk version; the daemon may be stale. The
 * contract: same/ahead/unparseable → `ok` (do nothing), bridge-newer same-major
 * → `converge` (restart the daemon), bridge-newer cross-major → `surface` (never
 * auto-restart across a major). Pure + total — no I/O.
 */

import { describe, expect, it } from "vitest";
import { classifyVersionSkew } from "../update/version-handshake.js";

describe("classifyVersionSkew", () => {
  it("identical versions → ok", () => {
    const d = classifyVersionSkew("0.2.13", "0.2.13");
    expect(d.action).toBe("ok");
  });

  it("daemon AHEAD of bridge → ok (never downgrade the daemon)", () => {
    expect(classifyVersionSkew("0.2.11", "0.2.13").action).toBe("ok");
    expect(classifyVersionSkew("0.2.11", "1.0.0").action).toBe("ok");
  });

  it("bridge newer, same-major patch/minor → converge", () => {
    expect(classifyVersionSkew("0.2.13", "0.2.11").action).toBe("converge");
    expect(classifyVersionSkew("0.3.0", "0.2.11").action).toBe("converge");
  });

  it("bridge newer, cross-major → surface (never auto-restart across a major)", () => {
    const d = classifyVersionSkew("1.0.0", "0.2.13");
    expect(d.action).toBe("surface");
    expect(d.reason).toContain("unerr pm restart");
  });

  it("unparseable version on either side → ok (never act on garbage)", () => {
    expect(classifyVersionSkew("not-a-version", "0.2.13").action).toBe("ok");
    expect(classifyVersionSkew("0.2.13", "").action).toBe("ok");
    expect(classifyVersionSkew("dev", "dev").action).toBe("ok");
  });

  it("carries both versions in the decision for the log line", () => {
    const d = classifyVersionSkew("0.3.0", "0.2.11");
    expect(d.bridge).toBe("0.3.0");
    expect(d.daemon).toBe("0.2.11");
    expect(d.reason).toContain("0.2.11");
    expect(d.reason).toContain("0.3.0");
  });
});
