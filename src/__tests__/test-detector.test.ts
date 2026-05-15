/**
 * Sprint R.8: Test Detector Tests
 *
 * Verifies isTestFile() and resolveTestSubject() work across all supported languages.
 */

import { describe, expect, it } from "vitest";
import {
  isTestFile,
  resolveTestSubject,
} from "../intelligence/indexer/test-detector.js";

describe("Sprint R.8: Test File Detection", () => {
  describe("isTestFile — TypeScript/JavaScript", () => {
    it("detects .test.ts files", () => {
      expect(isTestFile("src/utils/exec.test.ts")).toBe(true);
      expect(isTestFile("src/components/App.test.tsx")).toBe(true);
    });

    it("detects .spec.ts files", () => {
      expect(isTestFile("src/utils/exec.spec.ts")).toBe(true);
      expect(isTestFile("lib/helpers.spec.js")).toBe(true);
    });

    it("detects __tests__ directory", () => {
      expect(isTestFile("src/__tests__/proxy.test.ts")).toBe(true);
      expect(isTestFile("src/__tests__/utils.ts")).toBe(true);
    });

    it("detects test/ directory", () => {
      expect(isTestFile("test/integration/auth.ts")).toBe(true);
      expect(isTestFile("tests/unit/helpers.js")).toBe(true);
    });

    it("rejects source files", () => {
      expect(isTestFile("src/utils/exec.ts")).toBe(false);
      expect(isTestFile("src/proxy/proxy.ts")).toBe(false);
      expect(isTestFile("src/components/App.tsx")).toBe(false);
    });
  });

  describe("isTestFile — Python", () => {
    it("detects test_ prefix", () => {
      expect(isTestFile("tests/test_models.py")).toBe(true);
      expect(isTestFile("test_auth.py")).toBe(true);
    });

    it("detects _test suffix", () => {
      expect(isTestFile("app/models/user_test.py")).toBe(true);
    });

    it("detects conftest.py", () => {
      expect(isTestFile("tests/conftest.py")).toBe(true);
      expect(isTestFile("conftest.py")).toBe(true);
    });

    it("rejects source files", () => {
      expect(isTestFile("app/models/user.py")).toBe(false);
      expect(isTestFile("app/services/auth.py")).toBe(false);
    });
  });

  describe("isTestFile — Go", () => {
    it("detects _test.go suffix", () => {
      expect(isTestFile("pkg/handlers/auth_test.go")).toBe(true);
      expect(isTestFile("internal/db/connection_test.go")).toBe(true);
    });

    it("rejects source files", () => {
      expect(isTestFile("pkg/handlers/auth.go")).toBe(false);
      expect(isTestFile("cmd/main.go")).toBe(false);
    });
  });

  describe("isTestFile — Java", () => {
    it("detects Test suffix", () => {
      expect(isTestFile("src/test/java/com/example/UserServiceTest.java")).toBe(
        true
      );
      expect(isTestFile("com/example/AuthTest.java")).toBe(true);
    });

    it("detects Tests suffix", () => {
      expect(isTestFile("com/example/UserTests.java")).toBe(true);
    });

    it("detects IT suffix (integration test)", () => {
      expect(isTestFile("com/example/AuthIT.java")).toBe(true);
    });

    it("detects src/test/ directory", () => {
      expect(isTestFile("src/test/java/com/example/Helper.java")).toBe(true);
    });

    it("rejects source files", () => {
      expect(isTestFile("src/main/java/com/example/UserService.java")).toBe(
        false
      );
      expect(isTestFile("com/example/models/User.java")).toBe(false);
    });
  });

  describe("isTestFile — Rust", () => {
    it("detects _test.rs suffix", () => {
      expect(isTestFile("src/auth_test.rs")).toBe(true);
    });

    it("detects tests/ directory", () => {
      expect(isTestFile("tests/integration/auth.rs")).toBe(true);
      expect(isTestFile("tests/common.rs")).toBe(true);
    });

    it("rejects source files", () => {
      expect(isTestFile("src/auth.rs")).toBe(false);
      expect(isTestFile("src/lib.rs")).toBe(false);
    });
  });

  describe("isTestFile — Ruby", () => {
    it("detects _spec.rb suffix", () => {
      expect(isTestFile("spec/models/user_spec.rb")).toBe(true);
    });

    it("detects _test.rb suffix", () => {
      expect(isTestFile("test/models/user_test.rb")).toBe(true);
    });

    it("detects spec/ directory", () => {
      expect(isTestFile("spec/helpers/auth.rb")).toBe(true);
    });

    it("rejects source files", () => {
      expect(isTestFile("lib/models/user.rb")).toBe(false);
      expect(isTestFile("app/services/auth.rb")).toBe(false);
    });
  });

  describe("isTestFile — C#", () => {
    it("detects Tests suffix", () => {
      expect(isTestFile("Tests/UserServiceTests.cs")).toBe(true);
    });

    it("detects Test suffix", () => {
      expect(isTestFile("UserServiceTest.cs")).toBe(true);
    });

    it("rejects source files", () => {
      expect(isTestFile("Services/UserService.cs")).toBe(false);
      expect(isTestFile("Models/User.cs")).toBe(false);
    });
  });

  describe("isTestFile — C/C++", () => {
    it("detects _test suffix", () => {
      expect(isTestFile("src/auth_test.cpp")).toBe(true);
      expect(isTestFile("lib/parser_test.c")).toBe(true);
    });

    it("detects test_ prefix", () => {
      expect(isTestFile("test_parser.cpp")).toBe(true);
    });

    it("rejects source files", () => {
      expect(isTestFile("src/auth.cpp")).toBe(false);
      expect(isTestFile("lib/parser.c")).toBe(false);
    });
  });
});

describe("Sprint R.8: resolveTestSubject", () => {
  const projectFiles = new Set([
    "src/utils/exec.ts",
    "src/proxy/proxy.ts",
    "src/exec.ts",
    "src/__tests__/exec.test.ts",
    "pkg/handlers/auth.go",
    "pkg/handlers/auth_test.go",
    "app/models/user.py",
    "user.py",
    "tests/test_user.py",
    "src/main/java/com/example/UserService.java",
    "src/test/java/com/example/UserServiceTest.java",
    "lib/models/user.rb",
    "models/user.rb",
    "spec/models/user_spec.rb",
  ]);

  it("resolves TS test → source (same dir)", () => {
    expect(resolveTestSubject("src/utils/exec.test.ts", projectFiles)).toBe(
      "src/utils/exec.ts"
    );
  });

  it("resolves TS test → source (__tests__ dir → parent)", () => {
    // __tests__/exec.test.ts → parent dir is src/, so resolves to src/exec.ts
    expect(resolveTestSubject("src/__tests__/exec.test.ts", projectFiles)).toBe(
      "src/exec.ts"
    );
  });

  it("resolves Go test → source", () => {
    expect(resolveTestSubject("pkg/handlers/auth_test.go", projectFiles)).toBe(
      "pkg/handlers/auth.go"
    );
  });

  it("resolves Python test_ prefix → source (parent dir)", () => {
    // tests/test_user.py → tries tests/user.py then user.py (parent strip)
    expect(resolveTestSubject("tests/test_user.py", projectFiles)).toBe(
      "user.py"
    );
  });

  it("resolves Java Test suffix → source (Maven convention)", () => {
    // src/test/java/... → src/main/java/...
    expect(
      resolveTestSubject(
        "src/test/java/com/example/UserServiceTest.java",
        projectFiles
      )
    ).toBe("src/main/java/com/example/UserService.java");
  });

  it("resolves Ruby _spec → source (spec/ → lib/)", () => {
    // spec/models/user_spec.rb → tries models/user.rb (strip spec/)
    expect(resolveTestSubject("spec/models/user_spec.rb", projectFiles)).toBe(
      "models/user.rb"
    );
  });

  it("returns null for unresolvable", () => {
    expect(resolveTestSubject("test/unknown_test.go", projectFiles)).toBeNull();
  });
});
