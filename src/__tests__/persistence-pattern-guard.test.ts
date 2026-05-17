/**
 * Persistence-pattern regression guard.
 *
 * AV/EDR scanners flagged @unerr-ai/unerr@0.1.6 for two specific patterns:
 *   1. silent install of a boot-time launch unit from `unerr install <agent>`
 *   2. Windows %APPDATA%\...\Startup\ .cmd-drop persistence fallback
 *
 * These tests pin the source-level contract so the patterns can't quietly
 * come back. They use static reads rather than mocks because the contract
 * we care about is "this code is not in the source", not "this code wasn't
 * called this turn".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(thisDir, "..", "..");
const readSrc = (rel: string) =>
  readFileSync(join(repoRoot, "src", rel), "utf-8");

/**
 * Read source with comments stripped, so the regex guards below match real
 * code only and not the explanatory comments that *describe* the patterns
 * we're banning.
 */
const readCode = (rel: string): string => {
  const raw = readSrc(rel);
  // Drop /* ... */ blocks, then drop // line tails. Crude but enough for
  // banning identifier-shaped tokens.
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
};

describe("persistence-pattern regression guard", () => {
  it("runInstall does not call autoInstallIfNeeded", () => {
    const src = readSrc("commands/install.ts");
    // The pre-fix code imported and awaited autoInstallIfNeeded inside
    // runInstall step 7. Surface any reintroduction immediately.
    expect(src).not.toMatch(/autoInstallIfNeeded\s*\(/);
  });

  it("runInstall imports the read-only sentinel check only", () => {
    const src = readSrc("commands/install.ts");
    // It's fine to import isAutostartInstalled (read-only); not fine to
    // import the installer or platform modules from install.ts.
    expect(src).not.toMatch(/from\s+["']\.\.\/daemon\/platform-/);
    expect(src).not.toMatch(/installForCurrentPlatform/);
  });

  it("Windows platform module has no Startup-folder drop", () => {
    const src = readCode("daemon/platform-windows.ts");
    // The classic scanner-flagged pattern: drop a .cmd into Startup.
    expect(src).not.toMatch(/Start Menu/);
    expect(src).not.toMatch(/[Ss]tartup\\unerrd?\.cmd/);
    expect(src).not.toMatch(/unerrd\.cmd/);
    expect(src).not.toMatch(/installStartupCmd/);
  });

  it("Windows platform module does not derive exec from process.argv[1]", () => {
    const src = readCode("daemon/platform-windows.ts");
    // Inline argv lookups are the "exec path influenced by runtime
    // invocation" red flag scanners specifically cite.
    expect(src).not.toMatch(/process\.argv\[1\]/);
    expect(src).not.toMatch(/where unerr/);
  });

  it("macOS platform module does not derive exec from process.argv[1]", () => {
    const src = readCode("daemon/platform-macos.ts");
    expect(src).not.toMatch(/process\.argv\[1\]/);
    expect(src).not.toMatch(/which unerr/);
  });

  it("Linux platform module does not derive exec from process.argv[1]", () => {
    const src = readCode("daemon/platform-linux.ts");
    expect(src).not.toMatch(/process\.argv\[1\]/);
    expect(src).not.toMatch(/which unerr/);
  });

  it("Windows scheduled task uses /XML form with author metadata", () => {
    const src = readSrc("daemon/platform-windows.ts");
    expect(src).toMatch(/schtasks\s+\/Create\s+\/TN.*\/XML/);
    expect(src).toMatch(/<Author>/);
    expect(src).toMatch(/<RegistrationInfo>/);
    expect(src).toMatch(/LeastPrivilege/);
  });

  it("npm tarball excludes test artifacts and dashboard bundle", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf-8")
    ) as { files: string[] };
    expect(pkg.files).toContain("!dist/__tests__/**");
    expect(pkg.files).toContain("!dist/ui/**");
  });
});
