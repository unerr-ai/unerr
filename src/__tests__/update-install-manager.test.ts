/**
 * U2 install-manager classifier — table-tested across every manager fixture.
 *
 * The safety contract: ONLY an npm/pnpm-global layout with a writable root is
 * `self_upgradable`; Homebrew, Volta, asdf, nvm, npx, a non-writable root, and
 * any ambiguous path all degrade to `notify_only` with the correct per-manager
 * upgrade command. All inputs are injected — no real filesystem or install.
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
  opts: { writable?: boolean; env?: NodeJS.ProcessEnv } = {}
) {
  return classifyInstall({
    execPath: path,
    realpath: (p) => p, // no symlink resolution in fixtures
    homedir: () => HOME,
    env: opts.env ?? {},
    isWritable: () => opts.writable ?? true,
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
      name: "unknown / bundled",
      path: "/opt/company-tools/unerr/cli.js",
      manager: "unknown",
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
      classify(`${HOME}/Library/pnpm/global/5/node_modules/@unerr-ai/unerr/cli.js`)
        .mode
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

  it("unknown / empty path → notify_only", () => {
    expect(classify("/opt/company-tools/unerr/cli.js").mode).toBe("notify_only");
    expect(
      classifyInstall({ execPath: "", realpath: (p) => p }).mode
    ).toBe("notify_only");
  });
});

describe("upgradeCommand — exact per-manager command", () => {
  it("npm/pnpm get the global-install form, pinned when version given", () => {
    expect(upgradeCommand("npm", "0.2.13")).toBe(
      "npm install -g @unerr-ai/unerr@0.2.13"
    );
    expect(upgradeCommand("pnpm")).toBe("pnpm add -g @unerr-ai/unerr@latest");
  });

  it("homebrew / volta get their native upgrade", () => {
    expect(upgradeCommand("homebrew")).toBe("brew upgrade unerr");
    expect(upgradeCommand("volta", "0.2.13")).toBe(
      "volta install @unerr-ai/unerr@0.2.13"
    );
  });
});
