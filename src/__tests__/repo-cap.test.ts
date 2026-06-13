import { describe, expect, it } from "vitest";
import {
  checkActivateRepo,
  checkRegisterRepo,
} from "../cloud/repo-cap.js";
import { UNLIMITED } from "../cloud/tier-model.js";

describe("checkRegisterRepo", () => {
  it("allows the first repo on free (count 0, limit 1)", () => {
    const v = checkRegisterRepo({ limit: 1, currentCount: 0 });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("ok");
  });

  it("denies the second repo on free (count 1, limit 1)", () => {
    const v = checkRegisterRepo({ limit: 1, currentCount: 1 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("cap_exceeded");
    expect(v.message).toContain("unerr login");
    expect(v.message).toContain("1 repo");
  });

  it("allows unlimited plans regardless of count", () => {
    const v = checkRegisterRepo({ limit: UNLIMITED, currentCount: 99 });
    expect(v.allowed).toBe(true);
  });

  it("allows up to a finite multi-repo limit, denies past it", () => {
    expect(checkRegisterRepo({ limit: 3, currentCount: 2 }).allowed).toBe(true);
    const denied = checkRegisterRepo({ limit: 3, currentCount: 3 });
    expect(denied.allowed).toBe(false);
    expect(denied.message).toContain("3 repos");
  });
});

describe("checkActivateRepo", () => {
  it("allows when nothing is active yet (free)", () => {
    const v = checkActivateRepo({
      limit: 1,
      activePath: null,
      requestedPath: "/a",
    });
    expect(v.allowed).toBe(true);
  });

  it("allows re-activating the same repo that is already active", () => {
    const v = checkActivateRepo({
      limit: 1,
      activePath: "/a",
      requestedPath: "/a",
    });
    expect(v.allowed).toBe(true);
  });

  it("denies a different repo while one is active on free", () => {
    const v = checkActivateRepo({
      limit: 1,
      activePath: "/a",
      requestedPath: "/b",
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("already_active");
    expect(v.message).toContain("/a");
    expect(v.message).toContain("unerr pm stop /a");
  });

  it("allows a different repo when the limit is above 1", () => {
    expect(
      checkActivateRepo({ limit: 5, activePath: "/a", requestedPath: "/b" })
        .allowed
    ).toBe(true);
  });

  it("allows everything when unlimited", () => {
    expect(
      checkActivateRepo({
        limit: UNLIMITED,
        activePath: "/a",
        requestedPath: "/b",
      }).allowed
    ).toBe(true);
  });
});
