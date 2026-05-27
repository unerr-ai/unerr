/**
 * P2 — review-gate git-hook installer.
 *
 * Proves the pre-commit/post-commit hooks install with the right contract
 * (exit-code propagation on pre-commit, never-fail on post-commit), are
 * idempotent, append to (never clobber) a user-owned hook, and uninstall
 * cleanly — removing only unerr's marker section.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installReviewGateHooks,
  uninstallReviewGateHooks,
} from "../tracking/review-gate-hooks.js";

describe("review-gate hooks", () => {
  let repo: string;
  let hooksDir: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ur-rgh-"));
    hooksDir = join(repo, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns false when the repo has no .git/hooks dir", () => {
    const bare = mkdtempSync(join(tmpdir(), "ur-rgh-nogit-"));
    try {
      expect(installReviewGateHooks(bare)).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("installs an executable pre-commit hook that propagates the exit code", () => {
    expect(installReviewGateHooks(repo)).toBe(true);

    const pre = join(hooksDir, "pre-commit");
    expect(existsSync(pre)).toBe(true);
    const body = readFileSync(pre, "utf-8");
    expect(body.startsWith("#!/bin/sh")).toBe(true);
    expect(body).toContain("unerr check-commit");
    expect(body).toContain("|| exit $?"); // blocking propagation
    expect(body).toContain("command -v unerr");
    // executable bit set
    expect(statSync(pre).mode & 0o111).toBeGreaterThan(0);
  });

  it("installs a post-commit hook that never fails the commit", () => {
    installReviewGateHooks(repo);
    const post = join(hooksDir, "post-commit");
    expect(existsSync(post)).toBe(true);
    const body = readFileSync(post, "utf-8");
    expect(body).toContain("unerr check-commit --record-verdict");
    expect(body).toContain("|| true"); // post-commit must not block
  });

  it("is idempotent — a second install does not duplicate the section", () => {
    installReviewGateHooks(repo);
    installReviewGateHooks(repo);
    const body = readFileSync(join(hooksDir, "pre-commit"), "utf-8");
    const occurrences = body.split("# unerr-review-gate").length - 1;
    expect(occurrences).toBe(1);
  });

  it("appends to a user-owned hook instead of clobbering it", () => {
    const pre = join(hooksDir, "pre-commit");
    writeFileSync(pre, "#!/bin/sh\necho mine\n", { mode: 0o755 });
    chmodSync(pre, 0o755);

    installReviewGateHooks(repo);
    const body = readFileSync(pre, "utf-8");
    expect(body).toContain("echo mine"); // preserved
    expect(body).toContain("# unerr-review-gate"); // ours appended
  });

  it("uninstall removes a hook that is entirely ours", () => {
    installReviewGateHooks(repo);
    uninstallReviewGateHooks(repo);
    expect(existsSync(join(hooksDir, "pre-commit"))).toBe(false);
    expect(existsSync(join(hooksDir, "post-commit"))).toBe(false);
  });

  it("uninstall keeps a user-owned hook but strips our section", () => {
    const pre = join(hooksDir, "pre-commit");
    writeFileSync(pre, "#!/bin/sh\necho mine\n", { mode: 0o755 });
    installReviewGateHooks(repo);
    uninstallReviewGateHooks(repo);

    expect(existsSync(pre)).toBe(true);
    const body = readFileSync(pre, "utf-8");
    expect(body).toContain("echo mine");
    expect(body).not.toContain("# unerr-review-gate");
  });
});
