/**
 * U2 install-manager classifier — table-tested across every manager fixture.
 *
 * Safety contract: ONLY a writable binary install dir or an npm/pnpm-global
 * layout with a writable root (non-Windows) is `self_upgradable`. Homebrew,
 * Scoop, Volta, asdf, nvm, npx, a non-writable path, and npm/pnpm on Windows
 * all degrade to `notify_only`. All inputs are injected — no real filesystem
 * or install.
 */

import { describe, expect, it } from "vitest";
import {
  type InstallManager,
  classifyInstall,
  upgradeCommand,
} from "../update/install-manager.js";

const HOME = "/Users/dev";

/** Classify a fixture path with a writable root unless overridden. */
function classify(
  path: string,
  opts: {
    writable?: boolean;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {}
) {
  return classifyInstall({
    execPath: path,
    realpath: (p) => p, // no symlink resolution in fixtures
    homedir: () => HOME,
    env: opts.env ?? {},
    isWritable: () => opts.writable ?? true,
    platform: opts.platform,
  });
}

describe("classifyInstall — manager detection", () => {
  const cases: { name: string; path: string; manager: InstallManager }[] = [
    {
      name: "npm global (unix prefix)",
      path: "/usr/local/lib/node_modules/@unerr-ai/unerr/dist/cli.js",
      manager: "npm",
    },
    {
      name: "npm global (user prefix)",
      path: `${HOME}/.npm-global/lib/node_modules/@unerr-ai/unerr/dist/cli.js`,
      manager: "npm",
    },
    {
      name: "pnpm global home",
      path: `${HOME}/Library/pnpm/global/5/node_modules/@unerr-ai/unerr/dist/cli.js`,
      manager: "pnpm",
    },
    {
      name: "homebrew cellar",
      path: "/opt/homebrew/Cellar/unerr/0.2.11/libexec/dist/cli.js",
      manager: "homebrew",
    },
    {
      name: "volta",
      path: `${HOME}/.volta/tools/image/packages/@unerr-ai/unerr/dist/cli.js`,
      manager: "volta",
    },
    {
      name: "asdf",
      path: `${HOME}/.asdf/installs/nodejs/20.9.0/lib/node_modules/@unerr-ai/unerr/dist/cli.js`,
      manager: "asdf",
    },
    {
      name: "nvm",
      path: `${HOME}/.nvm/versions/node/v20.9.0/lib/node_modules/@unerr-ai/unerr/dist/cli.js`,
      manager: "nvm",
    },
    {
      name: "npx ephemeral",
      path: `${HOME}/.npm/_npx/abc123/node_modules/@unerr-ai/unerr/dist/cli.js`,
      manager: "npx",
    },
    {
      name: "scoop (path segment)",
      path: "C:/Users/dev/scoop/apps/unerr/current/unerr.exe",
      manager: "scoop",
    },
    {
      name: "binary ~/.unerr/bin",
      path: `${HOME}/.unerr/bin/unerr`,
      manager: "binary",
    },
    {
      // Any unrecognised standalone path (curl|bash fallback, /opt/company, etc.)
      name: "binary bare fallback",
      path: "/opt/company-tools/unerr/cli.js",
      manager: "binary",
    },
  ];

  for (const c of cases) {
    it(`detects ${c.name} → ${c.manager}`, () => {
      expect(classify(c.path).manager).toBe(c.manager);
    });
  }

  it("version managers win over the generic node_modules heuristic", () => {
    // asdf's path also contains /node_modules/ — order must keep it `asdf`.
    expect(
      classify(
        `${HOME}/.asdf/installs/nodejs/20/lib/node_modules/@unerr-ai/unerr/cli.js`
      ).manager
    ).toBe("asdf");
  });

  it("honours env-var roots (PNPM_HOME / VOLTA_HOME)", () => {
    expect(
      classify("/srv/pnpm/store/node_modules/@unerr-ai/unerr/cli.js", {
        env: { PNPM_HOME: "/srv/pnpm" },
      }).manager
    ).toBe("pnpm");
  });

  it("detects binary via UNERR_INSTALL_DIR env", () => {
    expect(
      classify("/custom/bin/unerr", {
        env: { UNERR_INSTALL_DIR: "/custom/bin" },
      }).manager
    ).toBe("binary");
  });

  it("detects binary via XDG_BIN_HOME env", () => {
    expect(
      classify(`${HOME}/.local/bin/unerr`, {
        env: { XDG_BIN_HOME: `${HOME}/.local/bin` },
      }).manager
    ).toBe("binary");
  });

  it("detects scoop via SCOOP env-var root", () => {
    expect(
      classify("D:/Scoop/apps/unerr/unerr.exe", {
        env: { SCOOP: "D:/Scoop" },
      }).manager
    ).toBe("scoop");
  });
});

describe("classifyInstall — upgrade mode gate", () => {
  it("npm global + writable → self_upgradable", () => {
    const r = classify(
      "/usr/local/lib/node_modules/@unerr-ai/unerr/dist/cli.js"
    );
    expect(r.mode).toBe("self_upgradable");
    expect(r.reason).toBeUndefined();
  });

  it("pnpm global + writable → self_upgradable", () => {
    expect(
      classify(
        `${HOME}/Library/pnpm/global/5/node_modules/@unerr-ai/unerr/cli.js`
      ).mode
    ).toBe("self_upgradable");
  });

  it("npm global but NON-writable → notify_only (never sudo)", () => {
    const r = classify(
      "/usr/local/lib/node_modules/@unerr-ai/unerr/dist/cli.js",
      { writable: false }
    );
    expect(r.mode).toBe("notify_only");
    expect(r.reason).toMatch(/not writable/);
  });

  it("homebrew → notify_only even if writable", () => {
    expect(
      classify("/opt/homebrew/Cellar/unerr/0.2.11/libexec/dist/cli.js").mode
    ).toBe("notify_only");
  });

  it("scoop → notify_only", () => {
    const r = classify("C:/Users/dev/scoop/apps/unerr/current/unerr.exe");
    expect(r.mode).toBe("notify_only");
    expect(r.reason).toMatch(/scoop owns this install/);
  });

  it("binary + writable dir → self_upgradable", () => {
    const r = classify(`${HOME}/.unerr/bin/unerr`);
    expect(r.manager).toBe("binary");
    expect(r.mode).toBe("self_upgradable");
    expect(r.reason).toBeUndefined();
  });

  it("binary + non-writable dir → notify_only", () => {
    const r = classify(`${HOME}/.unerr/bin/unerr`, { writable: false });
    expect(r.manager).toBe("binary");
    expect(r.mode).toBe("notify_only");
    expect(r.reason).toMatch(/not writable/);
  });

  it("bare binary fallback + writable → self_upgradable", () => {
    // Anything not matched by a specific channel is treated as a bare binary.
    const r = classify("/opt/company-tools/unerr/cli.js");
    expect(r.manager).toBe("binary");
    expect(r.mode).toBe("self_upgradable");
  });

  it("npm on Windows → notify_only (EBUSY risk)", () => {
    const r = classify(
      "/usr/local/lib/node_modules/@unerr-ai/unerr/dist/cli.js",
      { platform: "win32" }
    );
    expect(r.mode).toBe("notify_only");
    expect(r.reason).toMatch(/Windows/);
  });

  it("pnpm on Windows → notify_only (EBUSY risk)", () => {
    const r = classify(
      `${HOME}/Library/pnpm/global/5/node_modules/@unerr-ai/unerr/cli.js`,
      { platform: "win32" }
    );
    expect(r.mode).toBe("notify_only");
    expect(r.reason).toMatch(/Windows/);
  });

  it("empty path → notify_only (manager unknown)", () => {
    const r = classifyInstall({ execPath: "", realpath: (p) => p });
    expect(r.mode).toBe("notify_only");
    expect(r.manager).toBe("unknown");
  });
});

describe("upgradeCommand — exact per-manager command", () => {
  it("npm gets the global-install form, pinned when version given", () => {
    expect(upgradeCommand("npm", "0.2.13")).toBe(
      "npm install -g @unerr-ai/unerr@0.2.13"
    );
    expect(upgradeCommand("npm")).toBe("npm install -g @unerr-ai/unerr@latest");
  });

  it("pnpm gets the add-g form", () => {
    expect(upgradeCommand("pnpm")).toBe("pnpm add -g @unerr-ai/unerr@latest");
    expect(upgradeCommand("pnpm", "0.4.0")).toBe(
      "pnpm add -g @unerr-ai/unerr@0.4.0"
    );
  });

  it("homebrew → brew upgrade unerr (ignores version spec)", () => {
    expect(upgradeCommand("homebrew")).toBe("brew upgrade unerr");
    expect(upgradeCommand("homebrew", "0.4.0")).toBe("brew upgrade unerr");
  });

  it("scoop → scoop update unerr (ignores version spec)", () => {
    expect(upgradeCommand("scoop")).toBe("scoop update unerr");
    expect(upgradeCommand("scoop", "0.4.0")).toBe("scoop update unerr");
  });

  it("binary → unerr upgrade (ignores version spec)", () => {
    expect(upgradeCommand("binary")).toBe("unerr upgrade");
    expect(upgradeCommand("binary", "0.4.0")).toBe("unerr upgrade");
  });

  it("volta/asdf/nvm/npx/unknown fall back to npm install -g", () => {
    expect(upgradeCommand("volta", "0.2.13")).toBe(
      "npm install -g @unerr-ai/unerr@0.2.13"
    );
    expect(upgradeCommand("asdf")).toBe(
      "npm install -g @unerr-ai/unerr@latest"
    );
    expect(upgradeCommand("nvm")).toBe("npm install -g @unerr-ai/unerr@latest");
    expect(upgradeCommand("npx")).toBe("npm install -g @unerr-ai/unerr@latest");
    expect(upgradeCommand("unknown")).toBe(
      "npm install -g @unerr-ai/unerr@latest"
    );
  });
});
