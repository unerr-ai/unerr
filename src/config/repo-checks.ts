/**
 * Detects a target repo's typecheck/test commands at install time so
 * installed sub-agent instructions can name the repo's real verify commands
 * (e.g. `cargo check`, `go test ./...`) instead of a hardcoded
 * `pnpm run typecheck`. Sync reads of repo-root manifest files only —
 * bounded, no recursive scan — and never throws: any read/parse failure
 * yields an all-null result rather than blocking install.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Detected check commands for the repo unerr is being installed into —
 * consumed by installed sub-agent instructions to name the repo's real
 * verify commands instead of a hardcoded `pnpm run typecheck`.
 */
export interface RepoChecks {
  /** Full command string, e.g. "pnpm run typecheck", "cargo check", "go vet ./...". null = none detected. */
  typecheck: string | null;
  /** Full command string, e.g. "pnpm run test:run", "pytest", "cargo test". null = none detected. */
  test: string | null;
  /** True when the test command accepts a file/path argument appended after it (vitest/jest/pytest/go test). */
  testAcceptsPath: boolean;
}

const NULL_CHECKS: Readonly<RepoChecks> = {
  typecheck: null,
  test: null,
  testAcceptsPath: false,
};

type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

const NODE_LOCKFILE_PM: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

const NPM_DEFAULT_TEST_BODY = /^echo\s+["']?Error:\s*no test specified/i;
const JS_TEST_RUNNER = /\b(?:vitest|jest|mocha|ava|tap)\b/;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, string>;
  }
  return {};
}

function detectPackageManager(
  cwd: string,
  pkg: Record<string, unknown>
): PackageManager {
  const pmField = pkg.packageManager;
  if (typeof pmField === "string") {
    const prefix = pmField.split("@")[0];
    if (
      prefix === "pnpm" ||
      prefix === "yarn" ||
      prefix === "bun" ||
      prefix === "npm"
    ) {
      return prefix;
    }
  }
  for (const [lockfile, pm] of NODE_LOCKFILE_PM) {
    if (existsSync(join(cwd, lockfile))) return pm;
  }
  return "npm";
}

/** Node/JS ecosystem — matched by `package.json` existing (regardless of
 *  whether it parses). Package manager: `packageManager` field prefix, else
 *  lockfile sniff, else npm. Typecheck: first named script among
 *  typecheck/type-check/check:types/tsc, else `<pm> exec tsc --noEmit` when
 *  `typescript` is a dependency. Test: first named script among
 *  test:run/test:unit/test (skipping the npm-default no-op `test` body). */
function detectNode(cwd: string): RepoChecks | null {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;

  const raw = readText(pkgPath);
  if (raw === null) return { ...NULL_CHECKS };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...NULL_CHECKS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...NULL_CHECKS };
  }
  const pkg = parsed as Record<string, unknown>;

  const pm = detectPackageManager(cwd, pkg);
  const scripts = asStringRecord(pkg.scripts);
  const deps = asStringRecord(pkg.dependencies);
  const devDeps = asStringRecord(pkg.devDependencies);

  let typecheck: string | null = null;
  for (const name of ["typecheck", "type-check", "check:types", "tsc"]) {
    const body = scripts[name];
    if (typeof body === "string" && body.length > 0) {
      typecheck = `${pm} run ${name}`;
      break;
    }
  }
  if (!typecheck && ("typescript" in deps || "typescript" in devDeps)) {
    typecheck = `${pm} exec tsc --noEmit`;
  }

  let test: string | null = null;
  let testAcceptsPath = false;
  for (const name of ["test:run", "test:unit", "test"]) {
    const body = scripts[name];
    if (typeof body !== "string" || body.length === 0) continue;
    if (name === "test" && NPM_DEFAULT_TEST_BODY.test(body.trim())) continue;
    test = `${pm} run ${name}`;
    testAcceptsPath = JS_TEST_RUNNER.test(body);
    break;
  }

  return { typecheck, test, testAcceptsPath };
}

/** Rust ecosystem — matched by `Cargo.toml` existing. Fixed commands, no
 *  further evidence needed. */
function detectRust(cwd: string): RepoChecks | null {
  if (!existsSync(join(cwd, "Cargo.toml"))) return null;
  return {
    typecheck: "cargo check",
    test: "cargo test",
    testAcceptsPath: false,
  };
}

/** Go ecosystem — matched by `go.mod` existing. Fixed commands, no further
 *  evidence needed. */
function detectGo(cwd: string): RepoChecks | null {
  if (!existsSync(join(cwd, "go.mod"))) return null;
  return {
    typecheck: "go vet ./...",
    test: "go test ./...",
    testAcceptsPath: false,
  };
}

/** Python ecosystem — matched by any of pyproject.toml/setup.py/setup.cfg/
 *  pytest.ini/tox.ini existing. Each command is further evidence-gated
 *  independently: `pytest` only when pytest.ini exists or pyproject.toml's
 *  content mentions "pytest"; `mypy .` only when mypy.ini exists or
 *  pyproject.toml/setup.cfg content carries a `[tool.mypy]`/`[mypy]`
 *  section. Unevidenced fields stay null even though the ecosystem matched. */
function detectPython(cwd: string): RepoChecks | null {
  const pyprojectPath = join(cwd, "pyproject.toml");
  const setupCfgPath = join(cwd, "setup.cfg");

  const hasPyproject = existsSync(pyprojectPath);
  const hasSetupPy = existsSync(join(cwd, "setup.py"));
  const hasSetupCfg = existsSync(setupCfgPath);
  const hasPytestIni = existsSync(join(cwd, "pytest.ini"));
  const hasToxIni = existsSync(join(cwd, "tox.ini"));

  if (
    !hasPyproject &&
    !hasSetupPy &&
    !hasSetupCfg &&
    !hasPytestIni &&
    !hasToxIni
  ) {
    return null;
  }

  const pyprojectContent = hasPyproject ? (readText(pyprojectPath) ?? "") : "";
  const setupCfgContent = hasSetupCfg ? (readText(setupCfgPath) ?? "") : "";

  const pytestEvidenced = hasPytestIni || pyprojectContent.includes("pytest");
  const mypyEvidenced =
    existsSync(join(cwd, "mypy.ini")) ||
    pyprojectContent.includes("[tool.mypy]") ||
    pyprojectContent.includes("[mypy]") ||
    setupCfgContent.includes("[tool.mypy]") ||
    setupCfgContent.includes("[mypy]");

  return {
    typecheck: mypyEvidenced ? "mypy ." : null,
    test: pytestEvidenced ? "pytest" : null,
    testAcceptsPath: pytestEvidenced,
  };
}

/** JVM ecosystem — Maven (`pom.xml`) checked before Gradle
 *  (`build.gradle`/`build.gradle.kts`). Fixed commands, no further evidence
 *  needed. */
function detectJvm(cwd: string): RepoChecks | null {
  if (existsSync(join(cwd, "pom.xml"))) {
    return {
      typecheck: "mvn -q compile",
      test: "mvn -q test",
      testAcceptsPath: false,
    };
  }
  if (
    existsSync(join(cwd, "build.gradle")) ||
    existsSync(join(cwd, "build.gradle.kts"))
  ) {
    return {
      typecheck: "./gradlew build",
      test: "./gradlew test",
      testAcceptsPath: false,
    };
  }
  return null;
}

const MAKEFILE_TEST_TARGET = /^test\s*:/m;
const MAKEFILE_CHECK_TARGET = /^check\s*:/m;

/** Makefile fallback — only reached when no other ecosystem matched. Looks
 *  for top-level `test:`/`check:` targets; anything else in the file is
 *  ignored. */
function detectMakefile(cwd: string): RepoChecks | null {
  const path = join(cwd, "Makefile");
  if (!existsSync(path)) return null;
  const content = readText(path) ?? "";
  return {
    typecheck: MAKEFILE_CHECK_TARGET.test(content) ? "make check" : null,
    test: MAKEFILE_TEST_TARGET.test(content) ? "make test" : null,
    testAcceptsPath: false,
  };
}

/**
 * Detect a target repo's typecheck/test commands from root manifest files
 * (package.json, Cargo.toml, go.mod, pyproject.toml/setup.py/setup.cfg/
 * pytest.ini/tox.ini, pom.xml, build.gradle[.kts], Makefile) so install-time
 * instructions can name the repo's real commands. Checks ecosystems in a
 * fixed order and returns the first match; sync, bounded, and never throws
 * — any read/parse failure anywhere in the chain yields an all-null result.
 */
export function detectRepoChecks(cwd: string): RepoChecks {
  try {
    return (
      detectNode(cwd) ??
      detectRust(cwd) ??
      detectGo(cwd) ??
      detectPython(cwd) ??
      detectJvm(cwd) ??
      detectMakefile(cwd) ?? { ...NULL_CHECKS }
    );
  } catch {
    return { ...NULL_CHECKS };
  }
}
