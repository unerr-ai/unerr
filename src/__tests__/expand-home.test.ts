/**
 * `~` expansion in tool path arguments (regression 6a).
 *
 * file_read({file_path:'~/.zshrc'}) used to resolve to `<repo>/~/.zshrc` →
 * "File not found". Every cwd-relative resolver in the coding tools now goes
 * through resolveWithHome.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runFileReadForRouter } from "../tools/coding/file-read-protocol.js";
import { expandHome, resolveWithHome } from "../utils/expand-home.js";

describe("expandHome", () => {
  it("expands a bare ~ to the home directory", () => {
    expect(expandHome("~")).toBe(homedir());
  });

  it("expands a leading ~/ segment", () => {
    expect(expandHome("~/.zshrc")).toBe(join(homedir(), ".zshrc"));
    expect(expandHome("~/projects/app/src/index.ts")).toBe(
      join(homedir(), "projects/app/src/index.ts")
    );
  });

  it("leaves non-tilde and mid-path tildes untouched", () => {
    expect(expandHome("src/a.ts")).toBe("src/a.ts");
    expect(expandHome("/abs/path.ts")).toBe("/abs/path.ts");
    expect(expandHome("src/~backup/a.ts")).toBe("src/~backup/a.ts");
    // ~user form is NOT expanded (shell-only feature, ambiguous in-process)
    expect(expandHome("~root/x")).toBe("~root/x");
  });
});

describe("resolveWithHome", () => {
  it("resolves ~/ against home, not cwd", () => {
    expect(resolveWithHome("/some/repo", "~/.zshrc")).toBe(
      join(homedir(), ".zshrc")
    );
  });

  it("resolves plain relative paths against cwd as before", () => {
    expect(resolveWithHome("/some/repo", "src/a.ts")).toBe(
      "/some/repo/src/a.ts"
    );
  });
});

describe("file_read tilde regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "unerr-tilde-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not resolve ~ under the repo root", async () => {
    // A repo containing a literal "~" directory must NOT shadow the home
    // expansion: ~/no-such-file resolves to $HOME, so the error (or content)
    // names a home path, never `<repo>/~/...`.
    writeFileSync(join(dir, "real.ts"), "export const x = 1;\n");
    const out = await runFileReadForRouter(
      { file_path: "~/unerr-no-such-file-6a.txt" },
      { cwd: dir, graph: null }
    );
    const body = JSON.stringify(out.content);
    expect(body).not.toContain(join(dir, "~"));
    expect(body).toContain(join(homedir(), "unerr-no-such-file-6a.txt"));
  });
});
