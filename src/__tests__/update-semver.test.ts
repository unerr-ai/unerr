import { describe, expect, it } from "vitest";
import {
  classifyUpdate,
  comparePrerelease,
  compareSemver,
  isNewerStable,
  parseSemver,
} from "../update/semver.js";

describe("comparePrerelease", () => {
  it("both null → 0", () => {
    expect(comparePrerelease(null, null)).toBe(0);
  });

  it("null (stable) beats any prerelease", () => {
    expect(comparePrerelease(null, "beta.1")).toBe(1);
    expect(comparePrerelease("beta.1", null)).toBe(-1);
    expect(comparePrerelease(null, "alpha")).toBe(1);
    expect(comparePrerelease(null, "rc.1")).toBe(1);
  });

  it("numeric identifiers compare numerically", () => {
    expect(comparePrerelease("1", "2")).toBe(-1);
    expect(comparePrerelease("2", "1")).toBe(1);
    expect(comparePrerelease("10", "9")).toBe(1);
  });

  it("numeric < alphanumeric (semver §11.4.1)", () => {
    expect(comparePrerelease("1", "alpha")).toBe(-1);
    expect(comparePrerelease("alpha", "1")).toBe(1);
  });

  it("alphanumeric identifiers compare lexicographically", () => {
    expect(comparePrerelease("alpha", "beta")).toBe(-1);
    expect(comparePrerelease("beta", "alpha")).toBe(1);
    expect(comparePrerelease("beta", "beta")).toBe(0);
  });

  it("longer list wins when prior identifiers are equal", () => {
    expect(comparePrerelease("beta.1", "beta")).toBe(1);
    expect(comparePrerelease("beta", "beta.1")).toBe(-1);
    expect(comparePrerelease("1.2.3", "1.2")).toBe(1);
  });

  it("multi-part left-to-right comparison", () => {
    expect(comparePrerelease("beta.1", "beta.2")).toBe(-1);
    expect(comparePrerelease("beta.2", "beta.1")).toBe(1);
    expect(comparePrerelease("beta.1", "beta.1")).toBe(0);
    expect(comparePrerelease("alpha.1", "beta.1")).toBe(-1);
    expect(comparePrerelease("rc.1", "rc.2")).toBe(-1);
  });

  it("semver.org §11 example ordering: 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0", () => {
    const order: (string | null)[] = [
      "alpha",
      "alpha.1",
      "alpha.beta",
      "beta",
      "beta.2",
      "beta.11",
      "rc.1",
      null,
    ];
    for (let i = 0; i < order.length - 1; i++) {
      expect(comparePrerelease(order[i] ?? null, order[i + 1] ?? null)).toBe(
        -1
      );
      expect(comparePrerelease(order[i + 1] ?? null, order[i] ?? null)).toBe(1);
    }
  });
});

describe("compareSemver", () => {
  const v = (s: string) => {
    const r = parseSemver(s);
    if (!r) throw new Error(`bad semver: ${s}`);
    return r;
  };

  it("stable version ordering", () => {
    expect(compareSemver(v("1.0.0"), v("1.0.0"))).toBe(0);
    expect(compareSemver(v("1.0.1"), v("1.0.0"))).toBe(1);
    expect(compareSemver(v("1.0.0"), v("1.0.1"))).toBe(-1);
    expect(compareSemver(v("2.0.0"), v("1.9.9"))).toBe(1);
  });

  it("stable beats prerelease with same core", () => {
    expect(compareSemver(v("1.0.0"), v("1.0.0-beta.1"))).toBe(1);
    expect(compareSemver(v("1.0.0-beta.1"), v("1.0.0"))).toBe(-1);
    expect(compareSemver(v("0.4.0"), v("0.4.0-beta.1"))).toBe(1);
  });

  it("prerelease ordering with equal core", () => {
    expect(compareSemver(v("0.4.0-beta.1"), v("0.4.0-beta.2"))).toBe(-1);
    expect(compareSemver(v("0.4.0-beta.2"), v("0.4.0-beta.1"))).toBe(1);
    expect(compareSemver(v("0.4.0-beta.1"), v("0.4.0-beta.1"))).toBe(0);
    expect(compareSemver(v("0.4.0-alpha"), v("0.4.0-beta"))).toBe(-1);
  });

  it("core diff overrides prerelease", () => {
    expect(compareSemver(v("0.5.0-alpha"), v("0.4.0-beta.99"))).toBe(1);
    expect(compareSemver(v("1.0.0-rc.1"), v("0.9.9"))).toBe(1);
  });
});

describe("classifyUpdate — stable channel (default, backward compat)", () => {
  it("prerelease latest → none", () => {
    expect(classifyUpdate("0.3.0", "0.4.0-beta.1")).toBe("none");
    expect(classifyUpdate("0.4.0-beta.1", "0.4.0-beta.2")).toBe("none");
    expect(classifyUpdate("1.0.0", "2.0.0-rc.1")).toBe("none");
  });

  it("downgrade → none", () => {
    expect(classifyUpdate("1.0.0", "0.9.9")).toBe("none");
  });

  it("equal → none", () => {
    expect(classifyUpdate("1.0.0", "1.0.0")).toBe("none");
  });

  it("unparseable → none", () => {
    expect(classifyUpdate("not-a-version", "1.0.0")).toBe("none");
    expect(classifyUpdate("1.0.0", "not-a-version")).toBe("none");
  });

  it("patch upgrade", () => {
    expect(classifyUpdate("1.0.0", "1.0.1")).toBe("patch");
  });

  it("minor upgrade", () => {
    expect(classifyUpdate("1.0.0", "1.1.0")).toBe("minor");
  });

  it("major upgrade", () => {
    expect(classifyUpdate("1.0.0", "2.0.0")).toBe("major");
  });

  it("two-arg call unchanged (no opts argument)", () => {
    expect(classifyUpdate("0.3.5", "0.4.0-beta.1")).toBe("none");
    expect(classifyUpdate("0.3.5", "0.4.0")).toBe("minor");
  });
});

describe("classifyUpdate — beta channel (allowPrerelease: true)", () => {
  const opts = { allowPrerelease: true } as const;

  it("beta.1 → beta.2 on same core = patch", () => {
    expect(classifyUpdate("0.4.0-beta.1", "0.4.0-beta.2", opts)).toBe("patch");
  });

  it("beta → stable on same core = patch", () => {
    expect(classifyUpdate("0.4.0-beta.1", "0.4.0", opts)).toBe("patch");
  });

  it("stable → stable patch", () => {
    expect(classifyUpdate("1.0.0", "1.0.1", opts)).toBe("patch");
  });

  it("stable → beta same core = none (downgrade)", () => {
    // 1.0.0 > 1.0.0-beta.1, so beta.1 is older → none
    expect(classifyUpdate("1.0.0", "1.0.0-beta.1", opts)).toBe("none");
  });

  it("downgrade → none", () => {
    expect(classifyUpdate("0.4.0-beta.2", "0.4.0-beta.1", opts)).toBe("none");
    expect(classifyUpdate("0.4.0", "0.4.0-beta.1", opts)).toBe("none");
    expect(classifyUpdate("1.0.0", "0.9.9", opts)).toBe("none");
  });

  it("equal → none", () => {
    expect(classifyUpdate("0.4.0-beta.1", "0.4.0-beta.1", opts)).toBe("none");
    expect(classifyUpdate("1.0.0", "1.0.0", opts)).toBe("none");
  });

  it("core minor bump with prerelease = minor", () => {
    expect(classifyUpdate("0.3.5", "0.4.0-beta.1", opts)).toBe("minor");
    expect(classifyUpdate("0.4.0-beta.1", "0.5.0-beta.1", opts)).toBe("minor");
  });

  it("core major bump with prerelease = major", () => {
    expect(classifyUpdate("0.4.0-beta.1", "1.0.0-rc.1", opts)).toBe("major");
    expect(classifyUpdate("1.0.0", "2.0.0-beta.1", opts)).toBe("major");
  });

  it("core patch bump with prerelease = patch", () => {
    expect(classifyUpdate("0.4.0-beta.1", "0.4.1-beta.1", opts)).toBe("patch");
  });

  it("unparseable → none", () => {
    expect(classifyUpdate("bad", "0.4.0-beta.2", opts)).toBe("none");
    expect(classifyUpdate("0.4.0-beta.1", "bad", opts)).toBe("none");
  });
});

describe("isNewerStable", () => {
  it("stable semantics unchanged", () => {
    expect(isNewerStable("1.0.0", "1.0.1")).toBe(true);
    expect(isNewerStable("1.0.0", "1.0.0-rc.1")).toBe(false);
    expect(isNewerStable("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerStable("1.0.1", "1.0.0")).toBe(false);
  });
});
