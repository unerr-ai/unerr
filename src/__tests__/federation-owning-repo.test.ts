import { describe, expect, it } from "vitest";
import {
  type OwningRepoCandidate,
  resolveOwningRepo,
} from "../intelligence/federation/owning-repo.js";

function cand(path: string, repoId = path): OwningRepoCandidate {
  return { repoId, label: path.split("/").pop() ?? path, path };
}

describe("resolveOwningRepo", () => {
  const peers = [cand("/work/svc"), cand("/work/lib")];

  it("returns home when the path is under the home root", () => {
    const r = resolveOwningRepo("/work/app/src/a.ts", "/work/app", peers);
    expect(r.owner).toBe("home");
  });

  it("returns home when the path IS the home root", () => {
    const r = resolveOwningRepo("/work/app", "/work/app", peers);
    expect(r.owner).toBe("home");
  });

  it("routes a path under a peer root to that peer", () => {
    const r = resolveOwningRepo("/work/svc/src/x.ts", "/work/app", peers);
    expect(r.owner).toBe("peer");
    if (r.owner !== "peer") throw new Error("expected peer");
    expect(r.peer.path).toBe("/work/svc");
  });

  it("does not match a sibling whose name is a prefix of the path segment", () => {
    // /work/svc must NOT own /work/svc-extra (boundary-safe prefix check).
    const r = resolveOwningRepo("/work/svc-extra/x.ts", "/work/app", [
      cand("/work/svc"),
    ]);
    expect(r.owner).toBe("unknown");
  });

  it("picks the longest matching root for nested repos", () => {
    const nested = [cand("/work"), cand("/work/svc")];
    const r = resolveOwningRepo("/work/svc/src/x.ts", "/elsewhere", nested);
    expect(r.owner).toBe("peer");
    if (r.owner !== "peer") throw new Error("expected peer");
    expect(r.peer.path).toBe("/work/svc");
  });

  it("prefers home over a peer when home is the longer (more specific) root", () => {
    // home /work/app/sub is deeper than peer /work → home wins for its files.
    const r = resolveOwningRepo("/work/app/sub/x.ts", "/work/app/sub", [
      cand("/work"),
    ]);
    expect(r.owner).toBe("home");
  });

  it("returns unknown when no root contains the path", () => {
    const r = resolveOwningRepo("/tmp/orphan/x.ts", "/work/app", peers);
    expect(r.owner).toBe("unknown");
  });

  it("treats a relative path as home-relative (never a peer)", () => {
    // resolve() makes it cwd-relative; it will not match an absolute peer root.
    const r = resolveOwningRepo("src/a.ts", "/work/app", peers);
    expect(r.owner).not.toBe("peer");
  });
});
