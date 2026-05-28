/**
 * Persistence-pattern regression guard.
 *
 * AV/EDR scanners flagged @unerr-ai/unerr@0.1.6 for installing a boot-time
 * launch unit. The fix was structural: remove all "register at boot"
 * mechanisms entirely. The process manager is now lazily auto-spawned by
 * the MCP bridge on first contact and exits after 30 minutes idle — same
 * lifecycle pattern as tsserver / rust-analyzer / esbuild. No LaunchAgent
 * plist, no systemd user unit, no Windows scheduled task, no Startup
 * folder drop, ever.
 *
 * This file pins the source-level contract so the boot-persistence pattern
 * can't quietly come back. It walks the entire `src/` tree and bans any
 * reference to platform-specific scheduler paths or APIs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(thisDir, "..", "..");
const srcRoot = join(repoRoot, "src");

const readSrc = (rel: string) =>
  readFileSync(join(repoRoot, "src", rel), "utf-8");

/** Strip comments so guards match real code, not the docs describing them. */
const readCode = (rel: string): string => {
  const raw = readSrc(rel);
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
};

/** Walk every .ts file under src/ (with comments stripped). */
function* walkTsSources(
  dir: string
): Generator<{ path: string; code: string }> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTsSources(full);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    // Skip the guard itself — it intentionally names the banned tokens.
    if (full.endsWith("persistence-pattern-guard.test.ts")) continue;
    const rel = full.slice(srcRoot.length + 1);
    const raw = readFileSync(full, "utf-8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    yield { path: rel, code };
  }
}

describe("persistence-pattern regression guard", () => {
  it("deleted boot-persistence modules stay deleted", () => {
    // These were the legacy autostart modules. They have no replacement —
    // boot persistence is gone entirely.
    const gone = [
      "daemon/autostart.ts",
      "daemon/platform-macos.ts",
      "daemon/platform-linux.ts",
      "daemon/platform-windows.ts",
      "daemon/resolve-exec.ts",
      "daemon/bootstrap.ts",
      "daemon/version-checker.ts",
    ];
    for (const rel of gone) {
      expect(existsSync(join(srcRoot, rel))).toBe(false);
    }
  });

  it("no source file installs a LaunchAgent / launchd plist", () => {
    for (const { path, code } of walkTsSources(srcRoot)) {
      // It's OK for the shell-output classifier to recognise the read-only
      // `launchctl list` / `launchctl print` commands. What's banned is
      // *installing* one, which uses load/bootstrap/enable subcommands.
      expect(
        code,
        `${path} must not invoke launchctl load|bootstrap|enable`
      ).not.toMatch(/launchctl\s+(load|bootstrap|enable|kickstart)/);
      expect(
        code,
        `${path} must not reference LaunchAgents/launchd plist paths`
      ).not.toMatch(/LaunchAgents/);
      expect(code, `${path} must not name a unerr launchd plist`).not.toMatch(
        /com\.unerr[\w.]*\.plist/
      );
    }
  });

  it("no source file installs a systemd user unit", () => {
    for (const { path, code } of walkTsSources(srcRoot)) {
      // The install-shape invocations: enable / link a unit at user scope.
      expect(
        code,
        `${path} must not invoke systemctl --user enable|link`
      ).not.toMatch(/systemctl\s+--user\s+(enable|link|reenable)/);
      expect(
        code,
        `${path} must not write into ~/.config/systemd/user`
      ).not.toMatch(/\.config\/systemd\/user/);
      expect(code, `${path} must not name a unerr systemd unit`).not.toMatch(
        /unerrd?\.service/
      );
    }
  });

  it("no source file references Windows scheduled tasks or Startup folder", () => {
    for (const { path, code } of walkTsSources(srcRoot)) {
      expect(code, `${path} must not invoke schtasks`).not.toMatch(
        /\bschtasks\b/
      );
      expect(code, `${path} must not reference the Startup folder`).not.toMatch(
        /Start Menu\\\\Programs\\\\Startup/
      );
      expect(code, `${path} must not drop a startup .cmd`).not.toMatch(
        /[Ss]tartup\\\\unerrd?\.cmd/
      );
      expect(
        code,
        `${path} must not name a scheduled-task XML helper`
      ).not.toMatch(/installScheduledTask|installStartupCmd/);
    }
  });

  it("install/uninstall commands carry no boot-persistence machinery", () => {
    const install = readCode("commands/install.ts");
    expect(install).not.toMatch(/autoInstallIfNeeded\s*\(/);
    expect(install).not.toMatch(/installForCurrentPlatform/);
    expect(install).not.toMatch(/from\s+["']\.\.\/daemon\/platform-/);
    expect(install).not.toMatch(/from\s+["']\.\.\/daemon\/autostart/);

    const uninstall = readCode("commands/uninstall.ts");
    expect(uninstall).not.toMatch(/uninstallForCurrentPlatform/);
    expect(uninstall).not.toMatch(/from\s+["']\.\.\/daemon\/platform-/);
    expect(uninstall).not.toMatch(/from\s+["']\.\.\/daemon\/autostart/);
    // --autostart removal was deleted; reintroducing it is a regression.
    expect(uninstall).not.toMatch(/--autostart/);
  });

  it("pm command exposes no enable-autostart / disable-autostart subcommands", () => {
    const pm = readCode("commands/pm.ts");
    expect(pm).not.toMatch(/enable-autostart/);
    expect(pm).not.toMatch(/disable-autostart/);
    expect(pm).not.toMatch(/autostart-status/);
    expect(pm).not.toMatch(/installAutostart/);
  });

  it("the bridge auto-spawns via spawn-lock, not a boot unit", () => {
    const cli = readSrc("entrypoints/cli.ts");
    expect(cli).toContain("tryAcquireSpawnLock");
    expect(cli).toContain("spawn-lock.js");
    expect(cli).toContain('"pm", "start", "--detached"');
    // The spawn must be detached & ignore stdio — same shape as tsserver.
    expect(cli).toContain("detached: true");
    expect(cli).toContain('stdio: "ignore"');
  });

  it("npm tarball ships the inlined dashboard but excludes test artifacts, loose JS chunks, and screenshot bloat", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf-8")
    ) as { files: string[] };
    expect(pkg.files).toContain("!dist/__tests__/**");
    // Dashboard ships as a single self-contained HTML (vite-plugin-singlefile):
    // all JS + CSS inlined, so no standalone minified .js chunks reach the tarball.
    expect(pkg.files).toContain("dist/ui/index.html");
    expect(pkg.files).not.toContain("!dist/ui/**");
    // Loose minified JS chunks + screenshot/marketing assets must never ship —
    // they bloat the tarball and trip AV/EDR base64 / packaged-binary heuristics.
    expect(pkg.files).toContain("!dist/ui/assets/**");
    expect(pkg.files).toContain("!dist/ui/screenshots/**");
  });
});
