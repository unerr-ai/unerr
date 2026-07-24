import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectRepoChecks } from "../config/repo-checks.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unerr-repo-checks-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(path: string, data: unknown): void {
  writeFileSync(join(dir, path), JSON.stringify(data), "utf-8");
}

function writeFile(path: string, content: string): void {
  const full = join(dir, path);
  writeFileSync(full, content, "utf-8");
}

describe("detectRepoChecks", () => {
  describe("empty / no manifest", () => {
    it("returns all null in an empty directory", () => {
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: null,
        test: null,
        testAcceptsPath: false,
      });
    });
  });

  describe("Node ecosystem — package manager detection", () => {
    it("prefers packageManager field over any lockfile", () => {
      writeJson("package.json", {
        packageManager: "yarn@4.1.0",
        scripts: { test: "vitest run" },
      });
      writeFile("pnpm-lock.yaml", "");
      const result = detectRepoChecks(dir);
      expect(result.test).toBe("yarn run test");
    });

    it("picks pnpm from pnpm-lock.yaml", () => {
      writeJson("package.json", { scripts: { test: "vitest run" } });
      writeFile("pnpm-lock.yaml", "");
      expect(detectRepoChecks(dir).test).toBe("pnpm run test");
    });

    it("picks yarn from yarn.lock", () => {
      writeJson("package.json", { scripts: { test: "jest" } });
      writeFile("yarn.lock", "");
      expect(detectRepoChecks(dir).test).toBe("yarn run test");
    });

    it("picks bun from bun.lockb", () => {
      writeJson("package.json", { scripts: { test: "bun test" } });
      writeFile("bun.lockb", "");
      expect(detectRepoChecks(dir).test).toBe("bun run test");
    });

    it("picks bun from bun.lock", () => {
      writeJson("package.json", { scripts: { test: "bun test" } });
      writeFile("bun.lock", "");
      expect(detectRepoChecks(dir).test).toBe("bun run test");
    });

    it("picks npm from package-lock.json", () => {
      writeJson("package.json", { scripts: { test: "jest" } });
      writeFile("package-lock.json", "{}");
      expect(detectRepoChecks(dir).test).toBe("npm run test");
    });

    it("defaults to npm when no lockfile and no packageManager field", () => {
      writeJson("package.json", { scripts: { test: "jest" } });
      expect(detectRepoChecks(dir).test).toBe("npm run test");
    });
  });

  describe("Node ecosystem — typecheck script preference order", () => {
    it("prefers a `typecheck` script over `type-check`/`check:types`/`tsc`", () => {
      writeJson("package.json", {
        scripts: {
          typecheck: "tsc --noEmit",
          "type-check": "tsc -p .",
          "check:types": "tsc",
          tsc: "tsc",
        },
      });
      expect(detectRepoChecks(dir).typecheck).toBe("npm run typecheck");
    });

    it("falls back to `type-check` when `typecheck` is absent", () => {
      writeJson("package.json", {
        scripts: { "type-check": "tsc -p .", "check:types": "tsc" },
      });
      expect(detectRepoChecks(dir).typecheck).toBe("npm run type-check");
    });

    it("falls back to `check:types` when neither typecheck nor type-check exist", () => {
      writeJson("package.json", {
        scripts: { "check:types": "tsc", tsc: "tsc" },
      });
      expect(detectRepoChecks(dir).typecheck).toBe("npm run check:types");
    });

    it("falls back to `tsc` script when it's the only named match", () => {
      writeJson("package.json", { scripts: { tsc: "tsc --noEmit" } });
      expect(detectRepoChecks(dir).typecheck).toBe("npm run tsc");
    });

    it("falls back to `<pm> exec tsc --noEmit` when typescript is a devDependency and no script matches", () => {
      writeJson("package.json", {
        scripts: {},
        devDependencies: { typescript: "^5.0.0" },
      });
      writeFile("pnpm-lock.yaml", "");
      expect(detectRepoChecks(dir).typecheck).toBe("pnpm exec tsc --noEmit");
    });

    it("falls back to `<pm> exec tsc --noEmit` when typescript is a dependency", () => {
      writeJson("package.json", {
        scripts: {},
        dependencies: { typescript: "^5.0.0" },
      });
      expect(detectRepoChecks(dir).typecheck).toBe("npm exec tsc --noEmit");
    });

    it("null when no typecheck script and no typescript dependency", () => {
      writeJson("package.json", { scripts: { build: "tsup" } });
      expect(detectRepoChecks(dir).typecheck).toBeNull();
    });
  });

  describe("Node ecosystem — test script preference order + npm default skip", () => {
    it("prefers `test:run` over `test:unit`/`test`", () => {
      writeJson("package.json", {
        scripts: {
          "test:run": "vitest run",
          "test:unit": "jest",
          test: "jest",
        },
      });
      expect(detectRepoChecks(dir).test).toBe("npm run test:run");
    });

    it("falls back to `test:unit` when `test:run` is absent", () => {
      writeJson("package.json", {
        scripts: { "test:unit": "jest", test: "jest" },
      });
      expect(detectRepoChecks(dir).test).toBe("npm run test:unit");
    });

    it("falls back to `test` when neither test:run nor test:unit exist", () => {
      writeJson("package.json", { scripts: { test: "mocha" } });
      expect(detectRepoChecks(dir).test).toBe("npm run test");
    });

    it("skips the npm-default no-op `test` script body", () => {
      writeJson("package.json", {
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      });
      expect(detectRepoChecks(dir).test).toBeNull();
    });

    it("null when no test scripts exist at all", () => {
      writeJson("package.json", { scripts: { build: "tsup" } });
      expect(detectRepoChecks(dir).test).toBeNull();
    });
  });

  describe("Node ecosystem — testAcceptsPath", () => {
    it.each(["vitest run", "jest", "mocha ./test", "ava", "tap"])(
      "true when the test script body mentions %s",
      (body) => {
        writeJson("package.json", { scripts: { test: body } });
        expect(detectRepoChecks(dir).testAcceptsPath).toBe(true);
      }
    );

    it("false when the test script body mentions no known runner", () => {
      writeJson("package.json", { scripts: { test: "./run-tests.sh" } });
      expect(detectRepoChecks(dir).testAcceptsPath).toBe(false);
    });

    it("false when there is no test command at all", () => {
      writeJson("package.json", { scripts: { build: "tsup" } });
      expect(detectRepoChecks(dir).testAcceptsPath).toBe(false);
    });
  });

  describe("Rust", () => {
    it("detects cargo check / cargo test from Cargo.toml", () => {
      writeFile("Cargo.toml", '[package]\nname = "foo"\n');
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: "cargo check",
        test: "cargo test",
        testAcceptsPath: false,
      });
    });
  });

  describe("Go", () => {
    it("detects go vet / go test from go.mod", () => {
      writeFile("go.mod", "module example.com/foo\n\ngo 1.22\n");
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: "go vet ./...",
        test: "go test ./...",
        testAcceptsPath: false,
      });
    });
  });

  describe("Python", () => {
    it("detects pytest when evidenced by pytest.ini", () => {
      writeFile("pytest.ini", "[pytest]\ntestpaths = tests\n");
      const result = detectRepoChecks(dir);
      expect(result.test).toBe("pytest");
      expect(result.testAcceptsPath).toBe(true);
      expect(result.typecheck).toBeNull();
    });

    it("detects pytest when evidenced by pyproject.toml content", () => {
      writeFile(
        "pyproject.toml",
        '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n'
      );
      const result = detectRepoChecks(dir);
      expect(result.test).toBe("pytest");
      expect(result.testAcceptsPath).toBe(true);
    });

    it("detects mypy when evidenced by [tool.mypy] in pyproject.toml", () => {
      writeFile("pyproject.toml", "[tool.mypy]\nstrict = true\n");
      const result = detectRepoChecks(dir);
      expect(result.typecheck).toBe("mypy .");
    });

    it("detects mypy when evidenced by [mypy] in setup.cfg", () => {
      writeFile("setup.cfg", "[mypy]\nstrict = True\n");
      const result = detectRepoChecks(dir);
      expect(result.typecheck).toBe("mypy .");
    });

    it("detects mypy when evidenced by mypy.ini existing", () => {
      writeFile("setup.py", "from setuptools import setup\nsetup()\n");
      writeFile("mypy.ini", "[mypy]\n");
      const result = detectRepoChecks(dir);
      expect(result.typecheck).toBe("mypy .");
    });

    it("matches the Python ecosystem but leaves both null when unevidenced", () => {
      writeFile("setup.py", "from setuptools import setup\nsetup()\n");
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: null,
        test: null,
        testAcceptsPath: false,
      });
    });

    it("matches on tox.ini presence alone but stays unevidenced", () => {
      writeFile("tox.ini", "[tox]\nenvlist = py311\n");
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: null,
        test: null,
        testAcceptsPath: false,
      });
    });
  });

  describe("JVM", () => {
    it("detects Maven from pom.xml", () => {
      writeFile("pom.xml", "<project></project>");
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: "mvn -q compile",
        test: "mvn -q test",
        testAcceptsPath: false,
      });
    });

    it("detects Gradle from build.gradle", () => {
      writeFile("build.gradle", "plugins { id 'java' }\n");
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: "./gradlew build",
        test: "./gradlew test",
        testAcceptsPath: false,
      });
    });

    it("detects Gradle from build.gradle.kts", () => {
      writeFile("build.gradle.kts", "plugins { java }\n");
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: "./gradlew build",
        test: "./gradlew test",
        testAcceptsPath: false,
      });
    });

    it("prefers Maven over Gradle when both manifests exist", () => {
      writeFile("pom.xml", "<project></project>");
      writeFile("build.gradle", "plugins { id 'java' }\n");
      expect(detectRepoChecks(dir).typecheck).toBe("mvn -q compile");
    });
  });

  describe("Makefile fallback", () => {
    it("detects both make check and make test targets", () => {
      writeFile(
        "Makefile",
        "check:\n\tgo vet ./...\n\ntest:\n\tgo test ./...\n"
      );
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: "make check",
        test: "make test",
        testAcceptsPath: false,
      });
    });

    it("detects only a test target when check is absent", () => {
      writeFile("Makefile", "test:\n\techo running tests\n");
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: null,
        test: "make test",
        testAcceptsPath: false,
      });
    });

    it("is not reached when a higher-priority ecosystem manifest exists", () => {
      writeJson("package.json", { scripts: { test: "vitest run" } });
      writeFile("Makefile", "check:\n\techo check\n\ntest:\n\techo test\n");
      expect(detectRepoChecks(dir).test).toBe("npm run test");
    });
  });

  describe("ecosystem precedence", () => {
    it("Node wins over Rust/Go/Python/JVM when multiple manifests are present", () => {
      writeJson("package.json", { scripts: { test: "vitest run" } });
      writeFile("Cargo.toml", '[package]\nname = "foo"\n');
      writeFile("go.mod", "module example.com/foo\n");
      writeFile("pom.xml", "<project></project>");
      const result = detectRepoChecks(dir);
      expect(result.test).toBe("npm run test");
      expect(result.testAcceptsPath).toBe(true);
    });

    it("Rust wins over Go/Python/JVM when Node is absent", () => {
      writeFile("Cargo.toml", '[package]\nname = "foo"\n');
      writeFile("go.mod", "module example.com/foo\n");
      expect(detectRepoChecks(dir).test).toBe("cargo test");
    });
  });

  describe("never throws — unreadable / garbage manifests", () => {
    it("returns all null for a garbage (non-JSON) package.json", () => {
      writeFile("package.json", "{ this is not valid json ][");
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: null,
        test: null,
        testAcceptsPath: false,
      });
    });

    it("returns all null when package.json is a JSON array, not an object", () => {
      writeFile("package.json", "[1, 2, 3]");
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: null,
        test: null,
        testAcceptsPath: false,
      });
    });

    it("returns all null when package.json is unreadable (a directory, not a file)", () => {
      mkdirSync(join(dir, "package.json"));
      expect(detectRepoChecks(dir)).toEqual({
        typecheck: null,
        test: null,
        testAcceptsPath: false,
      });
    });

    it("never throws even for a nonexistent cwd", () => {
      const missing = join(dir, "does-not-exist");
      expect(() => detectRepoChecks(missing)).not.toThrow();
      expect(detectRepoChecks(missing)).toEqual({
        typecheck: null,
        test: null,
        testAcceptsPath: false,
      });
    });
  });
});
